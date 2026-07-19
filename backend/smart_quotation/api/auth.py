"""认证依赖与频率限制。

认证模式：
  - require_admin_api:      Admin API Key 验证（Bearer token），保护所有 admin 路由
  - require_company_access: 公司级访问验证，返回 "admin" 或 "company" 角色
  - verify_stock_key:       三菱库存查询专用 key 验证（独立的 STOCK_QUERY_KEY）

频率限制：
  - check_rate_limit:       内存级 60s/30 次（保护公开端点）
  - check_auth_rate_limit:  SQLite 持久化 5min/20 次（防暴力破解）

共享状态通过 app.state.auth (AuthContext) 传递，路由函数通过 request.app.state 访问。
"""

from __future__ import annotations

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
        dq = self.rate_limiter[client_id]
        while dq and now - dq[0] > self.RATE_WINDOW_SEC:
            dq.popleft()
        if len(dq) >= self.RATE_MAX_HITS:
            raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
        dq.append(now)

    def check_auth_rate_limit(self, client_key: str) -> None:
        """检查认证失败次数（SQLite 持久化，跨 Worker 共享）。"""
        now_ts = time.time()
        if now_ts - self._last_cleanup > 3600:
            try:
                self.store.cleanup_security_events(max_age_hours=1)
                self._last_cleanup = now_ts
            except Exception:
                pass
        count = self.store.count_security_events("auth_failure", client_key, self.AUTH_FAIL_WINDOW_SEC)
        if count >= self.AUTH_FAIL_MAX_HITS:
            raise HTTPException(status_code=429, detail="认证失败次数过多，请稍后再试")

    def record_auth_failure(self, client_key: str) -> None:
        """记录一次认证失败到 SQLite。"""
        try:
            self.store.record_security_event("auth_failure", client_key)
        except Exception:
            pass

    def get_client_id(self, request: Request) -> str:
        """提取客户端标识：优先 X-Stock-Key，回退到直连 IP。

        安全策略：不信任 X-Forwarded-For（可伪造），用直连 IP。
        """
        stock_key = (request.headers.get("x-stock-key", "") or
                     request.headers.get("authorization", "").replace("Bearer ", "", 1)).strip()
        if stock_key:
            return f"key:{stock_key[:8]}"
        return f"ip:{request.client.host if request.client else 'unknown'}"


# ─── FastAPI 依赖函数 ──────────────────────────────────────────

def require_admin_api(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(admin_security),
) -> None:
    """验证 admin 后台 API key。使用 compare_digest 防时序攻击。"""
    auth: AuthContext = request.app.state.auth
    client_ip = request.client.host if request.client else "unknown"
    if not auth.is_dev:
        auth.check_auth_rate_limit(client_ip)
    if not credentials or not credentials.credentials:
        if not auth.is_dev:
            auth.record_auth_failure(client_ip)
        raise HTTPException(status_code=401, detail="authentication required")
    if not secrets.compare_digest(credentials.credentials, auth.admin_api_key):
        if not auth.is_dev:
            auth.record_auth_failure(client_ip)
        raise HTTPException(status_code=401, detail="authentication required")


def require_company_access(
    request: Request,
    company_id: str = Query(DEFAULT_COMPANY_ID),
) -> str:
    """验证调用者是否有权访问指定公司的数据。返回 "admin" 或 "company" 角色。

    认证方式（按优先级）：
    1. Admin API Key（Authorization: Bearer xxx）— 管理员可访问任何公司
    2. 公司访问令牌（X-Company-Token 头）— 仅限指定公司

    安全策略：
    - 对所有调用方（含 admin）执行频率限制，防止公开端点被暴力请求或 DoS
    - 限流粒度：按 client_id（IP 或 token 前缀），60s/30 次
    """
    auth: AuthContext = request.app.state.auth
    client_ip = request.client.host if request.client else "unknown"
    if not auth.is_dev:
        auth.check_auth_rate_limit(client_ip)

    # 优先检查 Admin API Key
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        provided_key = auth_header[7:].strip()
        if provided_key and secrets.compare_digest(provided_key, auth.admin_api_key):
            # admin 角色也限流（防 Admin API Key 泄露后被刷）
            auth.check_rate_limit(auth.get_client_id(request))
            return "admin"
        if not auth.is_dev:
            auth.record_auth_failure(client_ip)

    # 检查公司访问令牌
    provided_token = request.headers.get("x-company-token", "").strip()
    if provided_token:
        if auth.store.verify_company_token(company_id, provided_token):
            # 管理员公司（meta.is_admin=true）通过令牌访问时也返回 admin 角色，
            # 这样前端能看到完整数据（面价、折扣规则）。
            try:
                company = auth.store.get_company(company_id)
                if (company.get("meta") or {}).get("is_admin"):
                    auth.check_rate_limit(auth.get_client_id(request))
                    return "admin"
            except LookupError:
                pass
            # company 角色限流（防令牌泄露后被刷）
            auth.check_rate_limit(auth.get_client_id(request))
            return "company"
        else:
            if not auth.is_dev:
                auth.record_auth_failure(client_ip)
            raise HTTPException(status_code=403, detail="authentication failed")

    # 无任何凭证
    if auth.is_dev:
        # 本地开发模式仍限流（防脚本失控）
        auth.check_rate_limit(auth.get_client_id(request))
        return "company"
    raise HTTPException(status_code=401, detail="authentication required")


def verify_stock_key(request: Request) -> None:
    """校验三菱库存查询 key。

    认证优先级：
    1. X-Stock-Key 头（专用库存查询 key）
    2. Authorization: Bearer 头（兼容前端旧实现）
    3. X-Company-Token 头（已登录的公司用户直接放行，无需单独输入 stock-key）

    安全策略：
    - 使用独立的 STOCK_QUERY_KEY，不复用 ADMIN_API_KEY。
    - STOCK_QUERY_KEY 未设置时，拒绝所有库存查询请求（503）。
    - 本地开发（SQ_DEV=1）时回退到 admin key，但打印警告。
    """
    auth: AuthContext = request.app.state.auth
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
    # 回退：已登录的公司用户（有效 X-Company-Token）直接放行
    if not provided:
        company_token = request.headers.get("x-company-token", "").strip()
        if company_token:
            company_id = request.query_params.get("company_id", DEFAULT_COMPANY_ID)
            if auth.store.verify_company_token(company_id, company_token):
                return
            raise HTTPException(status_code=403, detail="authentication failed")
    if not provided:
        raise HTTPException(status_code=401, detail="missing stock query key (X-Stock-Key)")

    expected = auth.stock_query_key if auth.stock_query_key else (auth.admin_api_key if auth.is_dev else "")
    if not expected or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid stock query key")
