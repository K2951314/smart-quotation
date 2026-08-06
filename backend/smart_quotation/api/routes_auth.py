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

import hashlib
import json
import logging
import os
import secrets as _secrets
import time
from contextlib import closing
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request

from ..store import DEFAULT_COMPANY_ID
from .auth import AuthContext, _handle_auth_failure, require_admin_api
from .models import LoginRequest, RegisterRequest

logger = logging.getLogger(__name__)

# JWT 配置（由 factory.py 启动时通过 configure_jwt() 注入）
# 绝不在源码中硬编码密钥——已知弱密钥可被攻击者伪造任意 JWT。
_JWT_SECRET = ""
_JWT_ALGORITHM = "HS256"
_JWT_EXPIRE_HOURS = 24 * 7  # 7 天

# 密码哈希：PBKDF2-HMAC-SHA256（无外部依赖，安全性足够 MVP）
_PBKDF2_ITERATIONS = 100000
_SALT_SIZE = 16


def _hash_password(password: str) -> str:
    """PBKDF2 密码哈希，返回 salt:hash 格式。"""
    salt = os.urandom(_SALT_SIZE)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{salt.hex()}:{dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    """验证密码。"""
    try:
        salt_hex, hash_hex = stored.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
        return _secrets.compare_digest(dk, expected)
    except (ValueError, AttributeError):
        return False


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
        - License 公司数量上限检查
        - 注册的公司不设 is_admin=True（is_admin 是配置继承标志，
          不是角色标志；注册租户是独立公司，不是管理员公司）
        - 密码至少 8 位（与前端 minlength=8 对齐）
        """
        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"register:{client_ip}")

        email = payload.email.strip().lower()
        company_name = payload.company_name.strip()
        if not email or not company_name:
            raise HTTPException(status_code=422, detail="邮箱和公司名不能为空")
        if len(payload.password) < 8:
            raise HTTPException(status_code=422, detail="密码至少 8 位")

        # License 检查：注册即创建公司，不能超过授权上限
        from ..license import verify_license
        license_payload = verify_license()
        if license_payload is not None:
            max_companies = int(license_payload.get("max_companies", 1))
            current = [c for c in store.list_companies() if c["id"] != DEFAULT_COMPANY_ID]
            if len(current) >= max_companies:
                raise HTTPException(
                    status_code=402,
                    detail=f"已达到 license 授权上限（{max_companies} 家公司），请联系供应商升级。",
                )

        # 检查邮箱唯一性
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id from users where email = ?", (email,)
            ).fetchone()
            if row:
                raise HTTPException(status_code=409, detail="该邮箱已注册")

        # 生成 company_id：slugify 公司名 + 随机后缀
        import re
        slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]", "-", company_name).strip("-").lower()[:20]
        if not slug:
            slug = "company"
        company_id = f"{slug}-{_secrets.token_hex(4)}"

        # 创建公司（不设 is_admin——注册租户是独立公司，不是管理员公司）
        try:
            store.create_company(
                company_id=company_id,
                name=company_name,
                meta={"created_by": "register"},
            )
        except ValueError:
            company_id = f"{slug}-{_secrets.token_hex(6)}"
            store.create_company(
                company_id=company_id,
                name=company_name,
                meta={"created_by": "register"},
            )

        # 创建用户
        user_id = _secrets.token_urlsafe(16)
        password_hash = _hash_password(payload.password)
        with closing(store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) values(?, ?, ?, ?, ?)",
                (user_id, email, password_hash, company_id, store.now()),
            )
            conn.commit()

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
        - IP 级限流（复用 AuthContext 60s/30 次）
        - 登录失败走 _handle_auth_failure（持久化失败计数，防暴力破解）
        """
        auth_ctx: AuthContext = app.state.auth
        client_ip = request.client.host if request.client else "unknown"
        auth_ctx.check_rate_limit(f"ip:{client_ip}")

        email = payload.email.strip().lower()
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id, email, password_hash, company_id from users where email = ?",
                (email,),
            ).fetchone()
        if not row or not _verify_password(payload.password, row["password_hash"]):
            _handle_auth_failure(auth_ctx, client_ip, 401, "邮箱或密码错误")

        token = _create_jwt(row["id"], row["company_id"], row["email"])
        return {
            "token": token,
            "user": {
                "id": row["id"],
                "email": row["email"],
                "company_id": row["company_id"],
            },
        }

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