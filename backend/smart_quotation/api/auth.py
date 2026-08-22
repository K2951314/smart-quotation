"""认证依赖与频率限制。

认证模式：
  - require_admin_api:      Admin API Key 验证（Bearer token），保护所有 admin 路由
  - require_company_access: 公司级访问验证，返回 (role, effective_company_id) 元组
  - verify_stock_key:       三菱库存查询专用 key 验证（独立的 STOCK_QUERY_KEY）

频率限制：
  - check_rate_limit:       内存级 60s/30 次（保护公开端点）
  - check_auth_rate_limit:  SQLite 持久化 5min/20 次（防暴力破解）

共享状态通过 app.state.auth (AuthContext) 传递，路由函数通过 request.app.state 访问。
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ..store import DEFAULT_COMPANY_ID, QuotationStore

logger = logging.getLogger(__name__)

# 模块级 HTTPBearer scheme（无状态，仅提取 Authorization 头）
admin_security = HTTPBearer(auto_error=False)


def load_admin_api_key() -> str:
    """加载并校验 ADMIN_API_KEY。

    安全策略：
    - 生产环境必须显式设置 ADMIN_API_KEY 环境变量，且不得使用已知弱值。
    - 本地开发可通过 SQ_DEV=1 跳过强校验，自动回退到弱默认值。
    - 任何场景下都使用 secrets.compare_digest 做比较，防时序攻击。
    """
    key = os.environ.get("ADMIN_API_KEY", "").strip()
    weak_defaults = {"", "admin-secret-key", "admin", "password", "123456", "change-me"}
    is_dev = os.environ.get("SQ_DEV", "0") == "1"

    if key in weak_defaults:
        if is_dev:
            logger.warning("ADMIN_API_KEY 未设置，使用弱默认值 'admin-secret-key'（仅限本地开发）")
            return "admin-secret-key"
        raise RuntimeError(
            "ADMIN_API_KEY 未设置或使用了弱默认值。\n"
            "请设置一个足够强的随机字符串作为 ADMIN_API_KEY 环境变量。\n"
            "本地开发可在启动前执行：set SQ_DEV=1 跳过此校验。"
        )
    if len(key) < 16:
        if is_dev:
            logger.warning("ADMIN_API_KEY 长度只有 %d 字符，建议至少 32 字符", len(key))
        else:
            raise RuntimeError(
                f"ADMIN_API_KEY 长度只有 {len(key)} 字符，至少需要 16 字符。\n"
                "建议使用：python -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )
    return key


def load_jwt_secret() -> str:
    """加载并校验 JWT_SECRET（与 load_admin_api_key 对齐）。

    安全策略：
    - 生产环境必须显式设置 JWT_SECRET（≥32 字符），否则拒绝启动。
    - 本地开发（SQ_DEV=1）生成随机密钥（每次重启变化，JWT 不跨会话持久）。
    - 绝不在源码中硬编码密钥——已知弱密钥可被攻击者伪造任意 JWT。
    """
    key = os.environ.get("JWT_SECRET", "").strip()
    is_dev = os.environ.get("SQ_DEV", "0") == "1"
    if not key:
        if is_dev:
            logger.warning("JWT_SECRET 未设置，开发模式生成随机密钥（重启后失效）")
            return "dev-" + secrets.token_hex(32)
        raise RuntimeError(
            "JWT_SECRET 未设置。注册/登录功能需要 JWT 密钥（至少 32 字符）。\n"
            "生成方式：python -c \"import secrets; print(secrets.token_urlsafe(32))\"\n"
            "本地开发可设 SQ_DEV=1 跳过此校验。"
        )
    if len(key) < 32 and not is_dev:
        raise RuntimeError(f"JWT_SECRET 长度只有 {len(key)} 字符，至少需要 32 字符。")
    if len(key) < 32:
        logger.warning("JWT_SECRET 长度只有 %d 字符，建议至少 32 字符", len(key))
    return key


class AuthContext:
    """认证上下文：封装认证所需的共享状态，存储在 app.state.auth 中。"""

    def __init__(self, store: QuotationStore, admin_api_key: str, stock_query_key: str, is_dev: bool) -> None:
        self.store = store
        self.admin_api_key = admin_api_key
        self.stock_query_key = stock_query_key
        self.is_dev = is_dev

        # 内存级频率限制器（单 Worker 级别）
        self.rate_limiter: dict[str, deque[float]] = defaultdict(deque)
        self.RATE_WINDOW_SEC = 60
        self.RATE_MAX_HITS = 30

        # SQLite 持久化认证失败追踪
        self.AUTH_FAIL_WINDOW_SEC = 300
        self.AUTH_FAIL_MAX_HITS = 20
        self._last_cleanup = 0.0

    def check_rate_limit(self, client_id: str) -> None:
        """检查 60 秒窗口内请求次数，超过 RATE_MAX_HITS 则拒绝。"""
        now = time.monotonic()
        # 防内存无界增长：极端情况下（攻击者伪造大量不同 key 头）直接清空重建
        if len(self.rate_limiter) > 100_000:
            self.rate_limiter.clear()
        dq = self.rate_limiter[client_id]
        while dq and now - dq[0] > self.RATE_WINDOW_SEC:
            dq.popleft()
        if len(dq) >= self.RATE_MAX_HITS:
            raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
        dq.append(now)

    def check_auth_rate_limit(self, client_key: str) -> None:
        """检查认证失败次数（SQLite 持久化，跨 Worker 共享）。

        注意：此处 DB 查询若失败（如瞬时连接中断），仅跳过限流检查，
        绝不可把本应返回的 401/429 变成 500——否则 DB 抖动会让所有
        受保护请求都 500（掩盖真实鉴权结果）。限流是 DoS 防护，fail-open 可接受。
        """
        now_ts = time.time()
        if now_ts - self._last_cleanup > 3600:
            try:
                self.store.cleanup_security_events(max_age_hours=1)
                self._last_cleanup = now_ts
            except Exception:
                pass
        try:
            count = self.store.count_security_events("auth_failure", client_key, self.AUTH_FAIL_WINDOW_SEC)
        except Exception:
            # DB 不可用时跳过限流，不阻断正常鉴权流程
            return
        if count >= self.AUTH_FAIL_MAX_HITS:
            raise HTTPException(status_code=429, detail="认证失败次数过多，请稍后再试")

    def record_auth_failure(self, client_key: str) -> None:
        """记录一次认证失败到 SQLite。"""
        try:
            self.store.record_security_event("auth_failure", client_key)
        except Exception:
            pass

    def get_client_id(self, request: Request) -> str:
        """提取客户端标识：优先凭据哈希，回退到直连 IP。

        安全策略：
        - 不信任 X-Forwarded-For（可伪造），用直连 IP。
          生产部署需在 uvicorn 启动参数加 --forwarded-allow-ips，
          由平台边缘代理写入真实客户端 IP（见 Procfile）。
        - 凭据取 SHA-256 哈希前缀而非原始前缀：防止攻击者用任意伪造的
          X-Stock-Key 头制造无界限流桶条目，也避免在内存中保留凭据片段。
        """
        stock_key = (request.headers.get("x-stock-key", "") or
                     request.headers.get("authorization", "").replace("Bearer ", "", 1)).strip()
        if stock_key:
            digest = hashlib.sha256(stock_key.encode("utf-8")).hexdigest()[:12]
            return f"key:{digest}"
        return f"ip:{request.client.host if request.client else 'unknown'}"


# ─── FastAPI 依赖函数 ──────────────────────────────────────────

def _handle_auth_failure(auth: AuthContext, client_ip: str, status_code: int, detail: str) -> None:
    """认证失败的统一处理：先查持久化失败计数（超限 429），再记录本次失败。

    关键顺序：只有凭证校验失败才会走到这里。持有有效凭证的合法用户
    永远不会被他人的失败计数锁定（防"共享代理 IP 被锁 → 全站 DoS"）。
    """
    if not auth.is_dev:
        auth.check_auth_rate_limit(client_ip)
        auth.record_auth_failure(client_ip)
    raise HTTPException(status_code=status_code, detail=detail)


def require_admin_api(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(admin_security),
) -> dict[str, Any]:
    """验证 admin 后台 API key 或 JWT，返回认证上下文。

    认证优先级：
    1. ADMIN_API_KEY（超管）：Bearer token 与 ADMIN_API_KEY 比较 → role="superadmin"
    2. JWT（租户管理员）：解码 JWT，验证签名和过期时间 → role="tenant"
    3. 开发模式（SQ_DEV=1）：宽松跳过 → role="dev"

    返回值供 resolve_company_id / require_superadmin 做租户隔离。
    使用 compare_digest 防时序攻击。
    """
    auth: AuthContext = request.app.state.auth
    client_ip = request.client.host if request.client else "unknown"
    # 内存级 IP 限流先于认证检查——挡住无凭证洪水请求，避免每次都查 DB
    auth.check_rate_limit(f"ip:{client_ip}")
    if not credentials or not credentials.credentials:
        _handle_auth_failure(auth, client_ip, 401, "authentication required")

    token = credentials.credentials

    # 1. ADMIN_API_KEY（超管）
    if secrets.compare_digest(token, auth.admin_api_key):
        return {"role": "superadmin"}

    # 2. JWT（租户管理员）
    try:
        from .routes_auth import _decode_jwt
        payload = _decode_jwt(token)
        if payload and "sub" in payload and "company_id" in payload:
            return {
                "role": "tenant",
                "company_id": payload["company_id"],
                "email": payload.get("email", ""),
                "user_id": payload.get("sub", ""),
            }
    except Exception:
        pass

    # 3. 开发模式兜底
    if auth.is_dev:
        logger.debug("开发模式：宽松认证")
        return {"role": "dev", "company_id": "default"}

    _handle_auth_failure(auth, client_ip, 401, "authentication required")


def require_superadmin(auth: dict[str, Any] = Depends(require_admin_api)) -> dict[str, Any]:
    """要求超管权限。租户用户得到 403。

    用于公司创建/删除、令牌轮换等平台级操作——
    租户管理员不应能创建或删除其他公司。
    """
    if auth["role"] != "superadmin":
        raise HTTPException(status_code=403, detail="此操作需要平台管理员权限")
    return auth


def resolve_company_id(
    company_id: str = Query(DEFAULT_COMPANY_ID),
    auth: dict[str, Any] = Depends(require_admin_api),
) -> str:
    """解析有效 company_id（租户隔离核心）。

    - 超管（ADMIN_API_KEY）：使用请求参数中的 company_id，可访问任意公司
    - 租户（JWT）：强制使用 JWT 中的 company_id，忽略请求参数
    - 开发模式：使用请求参数（向后兼容）

    所有接受 company_id 查询参数的 admin 路由都应使用此依赖，
    替代直接 Query(DEFAULT_COMPANY_ID)，确保 JWT 用户无法越权访问其他公司。
    """
    if auth["role"] == "tenant":
        return auth["company_id"]
    return company_id


def require_company_access(
    request: Request,
    company_id: str = Query(DEFAULT_COMPANY_ID),
) -> tuple[str, str]:
    """验证调用者是否有权访问指定公司的数据。

    返回 (role, effective_company_id)：
    - role: "admin" 或 "company"
    - effective_company_id: 实际应取数的公司 ID

    认证方式（按优先级）：
    1. Admin API Key（Authorization: Bearer xxx）— 管理员可访问任何公司
    2. 公司访问令牌（X-Company-Token 头）— 仅限指定公司

    安全策略：
    - 对所有调用方（含 admin）执行频率限制，防止公开端点被暴力请求或 DoS
    - 限流粒度：按 client_id（IP 或凭据哈希前缀），60s/30 次
    - 持久化失败计数只在凭证校验失败后检查/记录，合法用户不被他人锁定
    - 当 company_id 为默认值且提供公司令牌时，用 token 反查出的真实公司 ID
      作为 effective_company_id 返回。调用方必须用 effective_company_id 取数，
      否则持有令牌的租户可通过漏传 company_id 读取 default 公司的数据。
    """
    auth: AuthContext = request.app.state.auth
    client_ip = request.client.host if request.client else "unknown"
    # 内存级 IP 限流先于认证检查——挡住无凭证洪水请求，避免每次都查 DB
    auth.check_rate_limit(f"ip:{client_ip}")

    credential_failed = False

    # 优先检查 Admin API Key
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided_key = auth_header[7:].strip()
        if provided_key and secrets.compare_digest(provided_key, auth.admin_api_key):
            # admin 角色也限流（防 Admin API Key 泄露后被刷）
            auth.check_rate_limit(auth.get_client_id(request))
            return "admin", company_id
        credential_failed = True

    # 检查公司访问令牌
    provided_token = request.headers.get("x-company-token", "").strip()
    if provided_token:
        # 兜底：前端请求 bundle/version.json 时可能漏传 company_id（默认 default），
        # 用 token 反查真实公司，避免非 default 公司的 token 用 default 校验失败 → 403
        effective_company_id = company_id
        if company_id == DEFAULT_COMPANY_ID:
            found = auth.store.find_company_by_token(provided_token)
            if found:
                effective_company_id = found
        if auth.store.verify_company_token(effective_company_id, provided_token):
            # 管理员公司（meta.is_admin=true）通过令牌访问时也返回 admin 角色，
            # 这样前端能看到完整数据（面价、折扣规则）。
            try:
                company = auth.store.get_company(effective_company_id)
                if (company.get("meta") or {}).get("is_admin"):
                    auth.check_rate_limit(auth.get_client_id(request))
                    return "admin", effective_company_id
            except LookupError:
                pass
            # company 角色限流（防令牌泄露后被刷）
            auth.check_rate_limit(auth.get_client_id(request))
            return "company", effective_company_id
        credential_failed = True

    if credential_failed:
        _handle_auth_failure(auth, client_ip, 403, "authentication failed")

    # 无任何凭证
    if auth.is_dev:
        # 本地开发模式仍限流（防脚本失控）。
        # 无凭证兜底返回 admin：SQ_DEV 仅限本地开发，数据皆为开发者自己的；
        # 若返回 company，本地开发的管理员视图会因脱敏包缺 face_price 而价格显示 0。
        # 测试 company 视角请显式携带公司 token（走凭证分支，不经此兜底）。
        auth.check_rate_limit(auth.get_client_id(request))
        return "admin", company_id
    raise HTTPException(status_code=401, detail="authentication required")


def verify_stock_key(request: Request) -> str:
    """校验三菱库存查询 key，返回配额归属键（quota_key）。

    认证优先级：
    1. X-Stock-Key 头（专用库存查询 key）→ quota_key = 'stock-key'
    2. Authorization: Bearer 头（admin key）→ quota_key = 'admin'
    3. X-Company-Token 头（已登录公司用户）→ quota_key = company_id

    返回的 quota_key 用于日配额统计（routes_stock.py 检查 count_stock_queries_today）。

    安全策略：
    - 使用独立的 STOCK_QUERY_KEY，不复用 ADMIN_API_KEY。
    - STOCK_QUERY_KEY 未设置时，拒绝所有库存查询请求（503）。
    - 本地开发（SQ_DEV=1）时回退到 admin key，但打印警告。
    """
    auth: AuthContext = request.app.state.auth
    client_ip = request.client.host if request.client else "unknown"
    # 入口先做内存级 IP 限流（与其他端点策略一致），挡住无凭证洪水请求
    auth.check_rate_limit(f"ip:{client_ip}")
    if not auth.stock_query_key:
        if not auth.is_dev:
            raise HTTPException(
                status_code=503,
                detail="库存查询功能未配置。请设置 STOCK_QUERY_KEY 环境变量（不要使用 ADMIN_API_KEY）。"
            )
    provided = request.headers.get("x-stock-key", "").strip()
    if not provided:
        auth_header = request.headers.get("authorization", "").lower()
        if auth_header.startswith("bearer "):
            provided = auth_header[7:].strip()
    # 回退：已登录的公司用户（有效 X-Company-Token）→ 返回 company_id 用于公司级配额
    if not provided:
        company_token = request.headers.get("x-company-token", "").strip()
        if company_token:
            company_id = request.query_params.get("company_id", DEFAULT_COMPANY_ID)
            # 兜底：前端可能漏传 company_id，用 token 反查真实公司
            if company_id == DEFAULT_COMPANY_ID:
                found = auth.store.find_company_by_token(company_token)
                if found:
                    company_id = found
            if auth.store.verify_company_token(company_id, company_token):
                return company_id
            _handle_auth_failure(auth, client_ip, 403, "authentication failed")
    if not provided:
        raise HTTPException(status_code=401, detail="missing stock query key (X-Stock-Key)")

    expected = auth.stock_query_key if auth.stock_query_key else (auth.admin_api_key if auth.is_dev else "")
    if not expected or not secrets.compare_digest(provided, expected):
        _handle_auth_failure(auth, client_ip, 401, "invalid stock query key")
    # admin key 与 stock-key 共享 'stock-key' 配额（避免 admin key 滥用）
    return "stock-key"
