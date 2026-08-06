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
from .auth import require_admin_api
from .models import LoginRequest, RegisterRequest

logger = logging.getLogger(__name__)

# JWT 配置
_JWT_SECRET = os.environ.get("JWT_SECRET", "")
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


def _create_jwt(user_id: str, company_id: str, email: str) -> str:
    """签发 JWT。"""
    if not _JWT_SECRET:
        # 开发模式：用随机密钥（每次重启变化，仅用于本地）
        secret = "dev-only-insecure-key-" + "x" * 16
    else:
        secret = _JWT_SECRET
    now = int(time.time())
    payload = {
        "sub": user_id,
        "company_id": company_id,
        "email": email,
        "iat": now,
        "exp": now + _JWT_EXPIRE_HOURS * 3600,
    }
    return jwt.encode(payload, secret, algorithm=_JWT_ALGORITHM)


def _decode_jwt(token: str) -> dict[str, Any] | None:
    """解码 JWT，验证失败返回 None。"""
    if not _JWT_SECRET:
        secret = "dev-only-insecure-key-" + "x" * 16
    else:
        secret = _JWT_SECRET
    try:
        return jwt.decode(token, secret, algorithms=[_JWT_ALGORITHM])
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
    async def register_user(payload: RegisterRequest) -> dict[str, Any]:
        """注册：创建租户管理员账号 + 公司。

        流程：
        1. 验证邮箱唯一性
        2. 生成 company_id（基于公司名 slugify）
        3. 创建公司（meta.is_admin=true，自动生成 access_token）
        4. 创建用户记录（password_hash）
        5. 签发 JWT 返回
        """
        email = payload.email.strip().lower()
        company_name = payload.company_name.strip()
        if not email or not company_name:
            raise HTTPException(status_code=422, detail="邮箱和公司名不能为空")
        if len(payload.password) < 6:
            raise HTTPException(status_code=422, detail="密码至少 6 位")

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

        # 创建公司
        try:
            store.create_company(
                company_id=company_id,
                name=company_name,
                meta={"is_admin": True, "created_by": "register"},
            )
        except ValueError:
            # company_id 冲突，重试
            company_id = f"{slug}-{_secrets.token_hex(6)}"
            store.create_company(
                company_id=company_id,
                name=company_name,
                meta={"is_admin": True, "created_by": "register"},
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
    async def login_user(payload: LoginRequest) -> dict[str, Any]:
        """登录：邮箱 + 密码 → JWT。"""
        email = payload.email.strip().lower()
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id, email, password_hash, company_id from users where email = ?",
                (email,),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="邮箱或密码错误")
        if not _verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="邮箱或密码错误")

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


# 导出供 auth.py 使用
_decode_jwt = _decode_jwt
get_jwt_user = get_jwt_user
