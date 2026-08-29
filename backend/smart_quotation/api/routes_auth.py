"""认证路由：注册、登录、用户信息。

认证模式：
  1. ADMIN_API_KEY（超管）：环境变量配置，全平台管理权限
  2. JWT（租户管理员）：注册/登录后获取 JWT，绑定 company_id

JWT 载荷：
  {
    "sub": "<user_id>",       # 用户 ID
    "company_id": "<cid>",    # 公司 ID
    "email": "<email>",       # 邮箱
    "exp": <timestamp>,       # 过期时间
    "iat": <timestamp>        # 签发时间
  }
"""

from __future__ import annotations

import logging
import os
import re
import secrets as _secrets
import time
from contextlib import closing
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request

from ..store import DEFAULT_COMPANY_ID
from ..store.companies import CompanyNameTaken
from ..store.users import IntegrityError
from .auth import AuthContext, _handle_auth_failure, require_admin_api, require_superadmin
from .models import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
)
from .passwords import hash_password, verify_password

logger = logging.getLogger(__name__)

# 简单邮箱格式校验：本地部分 + @ + 域名（至少一个点）。
# 不追求 RFC 完备——目的是挡住空格/换行/缺域名的畸形地址（SMTP 头注入、
# 重置邮件无法投递）；正常用户由前端 type=email 先行校验。
_EMAIL_RE = re.compile(r"^[\w.+-]+@[\w-]+(\.[\w-]+)+$")
_EMAIL_MAX_LEN = 254  # RFC 5321 单行上限

# JWT 配置（由 factory.py 启动时通过 configure_jwt() 注入）
# 绝不在源码中硬编码密钥——已知弱密钥可被攻击者伪造任意 JWT。
_JWT_SECRET = ""
_JWT_ALGORITHM = "HS256"
_JWT_EXPIRE_HOURS = 24 * 7  # 7 天


def configure_jwt(secret: str) -> None:
    """由 factory.py 启动时调用，注入 JWT 密钥。

    密钥来源：load_jwt_secret()（生产强制设置，开发随机生成）。
    未调用此函数时 _decode_jwt 返回 None，所有 JWT 被拒绝。
    """
    global _JWT_SECRET
    _JWT_SECRET = secret


def _create_jwt(user_id: str, company_id: str, email: str) -> str:
    """签发 JWT。未配置密钥时抛 RuntimeError（不应发生——factory 已校验）。"""
    if not _JWT_SECRET:
        raise RuntimeError("JWT_SECRET 未配置，请检查 factory.py 启动流程")
    now = int(time.time())
    payload = {
        "sub": user_id,
        "company_id": company_id,
        "email": email,
        "iat": now,
        "exp": now + _JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, _JWT_SECRET, algorithm=_JWT_ALGORITHM)


def _decode_jwt(token: str) -> dict[str, Any] | None:
    """解码 JWT，验证失败或未配置密钥时返回 None。"""
    if not _JWT_SECRET:
        return None
    try:
        return jwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def get_jwt_user(request: Request) -> dict[str, Any] | None:
    """从请求头提取并验证 JWT，返回用户信息或 None。

    用于 require_admin_api 的补充：如果 Bearer token 是 JWT 而非 ADMIN_API_KEY，
    则验证 JWT 并返回用户信息。
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    return _decode_jwt(token)


def register(app) -> None:
    """注册认证路由。"""
    store = app.state.store

    @app.post("/api/auth/register")
    async def register_user(payload: RegisterRequest, request: Request) -> dict[str, Any]:
        """注册：创建租户管理员账号 + 公司。

        安全策略：
        - IP 级限流（复用 AuthContext 60s/30 次），防批量注册撑爆数据库
        - License 公司数量上限检查（部署授权，面向供应商）
        - 注册即数据源管理员：创建的公司带 is_admin=true + owner_user_id，
          注册用户自助管理自己的配置/数据/折扣，可自建更多公司（受账号
          max_companies 配额）和添加子账号（受 max_users 配额）。
          公司不冻结 plan 快照：无 meta.plan 时回退 owner 账号的订阅档位
          （注册用户默认无 plan → free，fail-closed；账号升级自动跟随）。
        - 密码至少 8 位（与前端 minlength=8 对齐）
        """
        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"register:{client_ip}")

        email = payload.email.strip().lower()
        company_name = payload.company_name.strip()
        if not email or not company_name:
            raise HTTPException(status_code=422, detail="邮箱和公司名不能为空")
        if not _EMAIL_RE.match(email) or len(email) > _EMAIL_MAX_LEN:
            raise HTTPException(status_code=422, detail="邮箱格式不正确")
        if len(payload.password) < 8:
            raise HTTPException(status_code=422, detail="密码至少 8 位")

        # License 检查：注册即创建公司，不能超过授权上限
        # fail-closed：无有效 license 时 get_quota 回退免费档（max_companies=1/max_users=1）
        from ..license import get_quota
        max_companies = int(get_quota("max_companies", 1))
        if max_companies >= 0:
            current = [c for c in store.list_companies() if c["id"] != DEFAULT_COMPANY_ID]
            if len(current) >= max_companies:
                raise HTTPException(
                    status_code=402,
                    detail=f"已达到 license 授权上限（{max_companies} 家公司），请联系供应商升级。",
                )
            # max_users 全局上限：所有注册用户不能超过 license 授权
            # （每公司 1 个注册用户时等价于 max_companies，但防止未来
            #   开放「邀请用户加入已有公司」后无限制注册）
            max_users = int(get_quota("max_users", -1))
            if max_users > 0:
                with closing(store.connect()) as conn:
                    total_users = conn.execute("select count(*) as n from users").fetchone()["n"]
                if total_users >= max_users:
                    raise HTTPException(
                        status_code=402,
                        detail=f"已达到用户数上限（{max_users} 个），请联系供应商升级。",
                    )

        # 检查邮箱唯一性
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id from users where email = ?", (email,)
            ).fetchone()
            if row:
                raise HTTPException(status_code=409, detail="该邮箱已注册")

        # 公司名去重：已有公司名不能再被其他账号注册（防冒充/混淆）
        if store.get_company_by_name(company_name):
            raise HTTPException(status_code=409, detail="该公司名已被注册，请换一个名称")

        # 生成 company_id：slugify 公司名 + 随机后缀
        slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]", "-", company_name).strip("-").lower()[:20]
        if not slug:
            slug = "company"
        company_id = f"{slug}-{_secrets.token_hex(4)}"
        user_id = _secrets.token_urlsafe(16)

        # 创建公司：注册用户即自己公司的数据源管理员（is_admin=true + owner_user_id）
        register_meta = {
            "created_by": "register",
            "is_admin": True,
            "owner_user_id": user_id,
            # 不写 plan 快照：无 plan 回退 owner 账号档位（注册用户无 plan → free）
        }
        try:
            store.create_company(
                company_id=company_id,
                name=company_name,
                meta=register_meta,
            )
        except CompanyNameTaken as exc:
            # 竞态：预检查后另一请求抢先注册了同名公司
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError:
            # 仅 ID 冲突（slug+随机后缀撞车）：换后缀重试
            company_id = f"{slug}-{_secrets.token_hex(6)}"
            try:
                store.create_company(
                    company_id=company_id,
                    name=company_name,
                    meta=register_meta,
                )
            except CompanyNameTaken as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

        # 创建用户（user_id 已在创建公司前生成——公司 meta.owner_user_id 引用它）
        password_hash = hash_password(payload.password)
        try:
            with closing(store.connect()) as conn:
                conn.execute(
                    "insert into users(id, email, password_hash, company_id, created_at) values(?, ?, ?, ?, ?)",
                    (user_id, email, password_hash, company_id, store.now()),
                )
                conn.commit()
        except IntegrityError:
            # 并发竞态：SELECT 检查后另一请求抢先注册了同邮箱，撞 unique 约束。
            # 回滚刚建的公司，防孤立公司占用 license 的 max_companies 额度。
            try:
                store.delete_company(company_id)
            except (LookupError, ValueError):
                pass
            raise HTTPException(status_code=409, detail="该邮箱已注册")

        store._mark_db_dirty(immediate=True)

        token = _create_jwt(user_id, company_id, email)
        logger.info("注册成功: email=%s, company_id=%s", email, company_id)
        return {
            "token": token,
            "user": {"id": user_id, "email": email, "company_id": company_id},
            "company": {"id": company_id, "name": company_name},
        }

    @app.post("/api/auth/login")
    async def login_user(payload: LoginRequest, request: Request) -> dict[str, Any]:
        """登录：邮箱 + 密码 → JWT。

        安全策略：
        - IP 级限流（独立 login: 桶，不与页面加载请求共享预算）
        - 登录失败走 _handle_auth_failure（持久化失败计数，防暴力破解）
        """
        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        # 独立桶：登录不能与页面加载的 admin API 请求共享 ip: 预算
        auth_ctx.check_rate_limit(f"login:{client_ip}")

        email = payload.email.strip().lower()
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id, email, password_hash, company_id, is_active from users where email = ?",
                (email,),
            ).fetchone()
        # 停用账号(is_active=0)走相同失败路径，防邮箱枚举
        if not row or not row["is_active"] or not verify_password(payload.password, row["password_hash"]):
            _handle_auth_failure(auth_ctx, client_ip, 401, "邮箱或密码错误")

        token = _create_jwt(row["id"], row["company_id"], row["email"])
        # 更新最后登录时间（不阻塞登录流程，失败仅记日志）
        try:
            store.touch_last_login(row["id"])
        except Exception:  # noqa: BLE001
            logger.debug("更新 last_login_at 失败", exc_info=True)
        return {
            "token": token,
            "user": {
                "id": row["id"],
                "email": row["email"],
                "company_id": row["company_id"],
            },
        }

    @app.post("/api/auth/forgot-password")
    async def forgot_password(payload: ForgotPasswordRequest, request: Request) -> dict[str, Any]:
        """发起密码找回。

        安全策略：
        - IP 级限流（防邮件轰炸）
        - 无论邮箱是否存在都返回相同成功响应（防邮箱枚举）
        - is_active=0 的账号静默不发邮件
        - 未配置 SMTP / SQ_DEV=1 时链接打印到日志（降级，不阻塞）
        """
        from ..mailer import send_password_reset_email, get_app_url, is_mail_configured

        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"forgot:{client_ip}")

        email = payload.email.strip().lower()
        if not email:
            raise HTTPException(status_code=422, detail="邮箱不能为空")
        # 畸形邮箱直接走统一响应：不查库、不发邮件，也不泄露格式校验结果
        if not _EMAIL_RE.match(email) or len(email) > _EMAIL_MAX_LEN:
            return {"ok": True, "message": "如果该邮箱已注册，重置链接已发送"}

        # 查用户——存在且启用才发邮件，但不泄露是否存在
        user = store.get_user_by_email(email)
        if user and user.get("is_active"):
            token = _secrets.token_urlsafe(32)
            from datetime import datetime, timedelta, timezone
            expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
            store.set_reset_token(user["id"], token, expires)
            reset_url = f"{get_app_url()}/admin/reset-password.html?token={token}"
            # 邮件发送用线程池，不阻塞事件循环；失败仅记日志（已存 token，用户仍可重置）
            try:
                from fastapi.concurrency import run_in_threadpool
                await run_in_threadpool(send_password_reset_email, email, reset_url)
            except Exception:  # noqa: BLE001
                logger.warning("密码重置邮件发送异常: %s", email, exc_info=True)
            logger.info("密码重置链接已生成: email=%s mail_configured=%s", email, is_mail_configured())

        # 统一响应，防枚举
        return {"ok": True, "message": "如果该邮箱已注册，重置链接已发送"}

    @app.post("/api/auth/reset-password")
    async def reset_password(payload: ResetPasswordRequest, request: Request) -> dict[str, Any]:
        """用 reset_token 重置密码。

        安全策略：
        - 密码至少 8 位（与注册一致）
        - token 一次性（消费后清空）
        - token 30 分钟过期
        - 并发竞争防护（UPDATE WHERE token 检查 rowcount）
        - 不泄露 token 是否有效（无效/过期统一 401）
        """
        from datetime import datetime, timezone

        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"reset:{client_ip}")

        if len(payload.password) < 8:
            raise HTTPException(status_code=422, detail="密码至少 8 位")

        user = store.get_user_by_reset_token(payload.token)
        if not user:
            _handle_auth_failure(auth_ctx, client_ip, 401, "无效或已过期的重置链接")
        # 过期校验
        expires_str = user.get("reset_expires")
        if not expires_str:
            _handle_auth_failure(auth_ctx, client_ip, 401, "无效或已过期的重置链接")
        try:
            expires_dt = datetime.fromisoformat(expires_str)
            if expires_dt.tzinfo is None:
                expires_dt = expires_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > expires_dt:
                # 过期则清空 token，防残留
                store.set_reset_token(user["id"], None, None)
                _handle_auth_failure(auth_ctx, client_ip, 401, "无效或已过期的重置链接")
        except (ValueError, TypeError):
            _handle_auth_failure(auth_ctx, client_ip, 401, "无效或已过期的重置链接")

        new_hash = hash_password(payload.password)
        updated_id = store.consume_reset_token(payload.token, new_hash)
        if not updated_id:
            # 并发竞争或已被消费
            _handle_auth_failure(auth_ctx, client_ip, 401, "无效或已过期的重置链接")

        # 审计
        try:
            with closing(store.connect()) as conn:
                store.audit(conn, updated_id, "password_reset", "user", updated_id, {"via": "token"})
                conn.commit()
        except Exception:  # noqa: BLE001
            logger.debug("审计写入失败", exc_info=True)

        logger.info("密码已重置: user_id=%s", updated_id)
        return {"ok": True, "message": "密码已重置，请使用新密码登录"}

    @app.post("/api/auth/change-password")
    async def change_password(payload: ChangePasswordRequest, request: Request) -> dict[str, Any]:
        """登录用户自助修改密码（JWT 认证）。

        安全策略：
        - 仅 JWT 用户可用（超管 API Key 不对应 users 行，无"当前密码"概念）
        - 校验旧密码：会话被劫持时攻击者仍需知道旧密码才能改密
        - 旧密码错误走 _handle_auth_failure（持久化失败计数，防暴力猜测）
        - 新密码至少 8 位；成功后清除未消费的 reset_token（防旧重置链接绕过旧密码）
        - 停用账号拒绝改密（与登录门控一致）
        - 无状态 JWT 无法吊销：改密后当前 token 仍有效至自然过期
        """
        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"chgpw:{client_ip}")

        user = get_jwt_user(request)
        if not user:
            raise HTTPException(status_code=401, detail="无效或过期的令牌")
        if len(payload.new_password) < 8:
            raise HTTPException(status_code=422, detail="新密码至少 8 位")

        user_id = user["sub"]
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id, password_hash, is_active from users where id = ?",
                (user_id,),
            ).fetchone()
        # 用户不存在（已删除/伪造 JWT）或已停用：统一按认证失败处理
        if not row or not row["is_active"]:
            _handle_auth_failure(auth_ctx, client_ip, 401, "无效或过期的令牌")
        if not verify_password(payload.old_password, row["password_hash"]):
            _handle_auth_failure(auth_ctx, client_ip, 401, "旧密码错误")

        store.update_user(
            user_id,
            password_hash=hash_password(payload.new_password),
            reset_token=None,
            reset_expires=None,
        )

        # 审计
        try:
            with closing(store.connect()) as conn:
                store.audit(conn, user_id, "password_change", "user", user_id, {"via": "self"})
                conn.commit()
        except Exception:  # noqa: BLE001
            logger.debug("审计写入失败", exc_info=True)

        logger.info("用户已修改密码: user_id=%s", user_id)
        return {"ok": True, "message": "密码已修改"}

    @app.get("/api/auth/profile")
    async def get_profile(request: Request) -> dict[str, Any]:
        """获取当前用户信息（JWT 认证）。"""
        user = get_jwt_user(request)
        if not user:
            raise HTTPException(status_code=401, detail="无效或过期的令牌")
        return {
            "user": {
                "id": user["sub"],
                "email": user["email"],
                "company_id": user["company_id"],
            }
        }

    @app.get("/api/auth/session")
    async def get_session(auth: dict[str, Any] = Depends(require_admin_api)) -> dict[str, Any]:
        """获取当前会话信息（所有认证用户可访问）。

        返回统一的会话上下文，供前端显示角色、档位、功能权限：
        - role: "superadmin" | "tenant" | "dev"
        - plan: "free" | "pro" | "team"（当前会话的订阅档位，推荐字段名）
        - tier: 同 plan 的向后兼容别名（tier 在本系统另有「利润率分组」含义，勿混用）
        - features: 授权功能列表
        - quota: 配额数字对象（供前端做前置阻断，如 max_brands/max_skus 等）
        - is_dev: 是否开发模式
        - email / company_id: JWT 用户才有

        与 /api/license/info 的区别：
        - /api/license/info 需超管权限，返回完整 license 详情（customer、过期时间）
        - /api/auth/session 所有认证用户可访问，只返回安全子集（plan + features + quota）
        """
        from ..license import (
            verify_license, get_dev_tier_override, get_admin_preview_override,
            get_quota, get_plan_quota, TIER_PRESETS,
        )
        license_payload = verify_license()
        is_dev = os.environ.get("SQ_DEV", "0") == "1"
        admin_preview = get_admin_preview_override()

        # 解析当前会话的订阅档位（优先级从高到低）：
        # 1. 超管档位预览（_admin_preview_override）—超管用 /api/admin/preview-tier 设置
        # 2. 开发模式 tier 覆盖（_dev_tier_override）—仅 SQ_DEV=1
        # 3. tenant（JWT 用户）→ 其公司的 plan
        # 4. superadmin/dev → 全局 license 的 tier（部署总授权）
        # 5. free（fail-closed）
        preview_plan = None
        if admin_preview and auth["role"] in ("superadmin", "dev"):
            plan = admin_preview
            preview_plan = admin_preview
        elif is_dev and get_dev_tier_override() is not None:
            plan = get_dev_tier_override()
        else:
            auth_company_id = auth.get("company_id")
            auth_user_id = auth.get("user_id")
            # 账号级 plan 优先（users.plan），回退公司级，再回退 license tier
            if auth_user_id:
                plan = store.resolve_user_plan(auth_user_id, auth_company_id)
            elif auth_company_id:
                plan = store.resolve_subscription_plan(auth_company_id)
            elif license_payload:
                plan = license_payload.get("tier", "free")
            else:
                plan = "free"
        if plan not in TIER_PRESETS:
            plan = "free"

        tier = plan
        features = list(TIER_PRESETS[plan].get("features", []))

        # 返回配额供前端做前置阻断：max_companies/max_users 是部署总授权（全局 license），
        # 其余（SKU/品牌/版本/库存/水印）按当前公司的订阅档位（plan）
        quota = {
            "max_companies": get_quota("max_companies", 1),
            "max_users": get_quota("max_users", 1),
            "max_skus": get_plan_quota(plan, "max_skus", 500),
            "max_brands": get_plan_quota(plan, "max_brands", 2),
            "max_config_revisions": get_plan_quota(plan, "max_config_revisions", 3),
            "stock_query_daily_limit": get_plan_quota(plan, "stock_query_daily_limit", 0),
            "audit_log_days": get_plan_quota(plan, "audit_log_days", 7),
            "watermark": get_plan_quota(plan, "watermark", True),
        }

        # JWT 用户的 email/company_id 已由 require_admin_api 解码并放入 auth context
        email = auth.get("email") if auth["role"] == "tenant" else None
        company_id = auth.get("company_id") if auth["role"] == "tenant" else None

        # 订阅到期时间（租户可见自己的订阅状态；注意 resolve_user_plan
        # 过期后会回退公司级——这里查的是列上的原始到期时间，已过期的
        # 订阅前端可显示「已过期」而非隐藏）
        plan_expires_at = None
        if auth.get("user_id"):
            try:
                user_row = store.get_user(auth["user_id"])
                plan_expires_at = user_row.get("plan_expires_at") if user_row else None
            except Exception:  # noqa: BLE001
                logger.debug("查询订阅到期失败", exc_info=True)

        return {
            "role": auth["role"],
            "is_dev": is_dev,
            "plan": plan,
            "plan_expires_at": plan_expires_at,
            "tier": tier,
            "features": features,
            "quota": quota,
            "email": email,
            "company_id": company_id,
            "user_id": auth.get("user_id"),
            "preview_plan": preview_plan,
            "dev_tier_override": get_dev_tier_override() if is_dev else None,
        }

    @app.post("/api/dev/set-tier")
    async def dev_set_tier(
        payload: dict[str, Any],
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        """开发模式 tier 覆盖（仅 SQ_DEV=1 时生效）。

        用于本地测试不同订阅档位——无需重启后端，POST 即可切换。
        生产环境调用返回 403。

        请求体：{"tier": "free" | "pro" | "team" | null}
        """
        is_dev = os.environ.get("SQ_DEV", "0") == "1"
        if not is_dev:
            raise HTTPException(status_code=403, detail="此端点仅在开发模式（SQ_DEV=1）下可用")

        from ..license import set_dev_tier_override, TIER_PRESETS
        tier = payload.get("tier")
        if tier is not None and tier not in TIER_PRESETS:
            raise HTTPException(
                status_code=422,
                detail=f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}",
            )
        success = set_dev_tier_override(tier)
        if not success:
            raise HTTPException(status_code=403, detail="设置失败（非开发模式）")

        from ..license import verify_license
        new_payload = verify_license(force=True)
        return {
            "ok": True,
            "tier": tier,
            "message": f"已切换到 {tier or '默认（无覆盖）'} 档位" if tier else "已清除 tier 覆盖，恢复默认",
            "features": new_payload.get("features", []) if new_payload else [],
        }

    @app.post("/api/admin/preview-tier", dependencies=[Depends(require_superadmin)])
    async def admin_preview_tier(payload: dict[str, Any]) -> dict[str, Any]:
        """超管档位预览（不要求 SQ_DEV=1，生产环境可用）。

        用于生产环境超管预览不同档位的功能门控和配额限制——
        不影响真实 license 校验，只影响 /api/auth/session 返回的 plan/quota/features。

        与 /api/dev/set-tier 的区别：
        - /api/dev/set-tier 仅 SQ_DEV=1 时可用（本地开发专用）
        - /api/admin/preview-tier 生产环境可用（超管专用）
        - 两者都是内存级覆盖，重启后端后失效

        请求体：{"tier": "free" | "pro" | "team" | null}
        """
        from ..license import set_admin_preview_override, TIER_PRESETS, verify_license
        tier = payload.get("tier")
        if tier is not None and tier not in TIER_PRESETS:
            raise HTTPException(
                status_code=422,
                detail=f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}",
            )
        set_admin_preview_override(tier)
        new_payload = verify_license(force=True)
        return {
            "ok": True,
            "tier": tier,
            "message": f"已预览 {tier or '默认（真实 license 档位）'} 档位" if tier else "已清除档位预览，恢复真实 license 档位",
            "features": new_payload.get("features", []) if new_payload else [],
        }