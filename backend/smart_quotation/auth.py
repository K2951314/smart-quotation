"""客户认证模块：密码哈希、令牌管理、FastAPI 依赖。

使用 stdlib 实现，零外部依赖：
- 密码：pbkdf2_hmac(sha256, 200k 迭代) + 每用户独立 salt
- 令牌：secrets.token_urlsafe(32) 不透明令牌，DB 存 sha256 哈希
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import Header, HTTPException


def hash_password(password: str) -> tuple[str, str]:
    """哈希密码，返回 (hash_hex, salt_hex)。"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return dk.hex(), salt.hex()


def verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    """验证密码是否匹配。"""
    salt = bytes.fromhex(salt_hex)
    expected = bytes.fromhex(hash_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return secrets.compare_digest(dk, expected)


def new_token() -> str:
    """生成新的不透明令牌（明文，返回给客户端）。"""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """计算令牌的 sha256 哈希（存 DB）。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def expires_in(days: int = 7) -> str:
    """返回 N 天后的 ISO 时间。"""
    from datetime import timedelta

    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def customer_dep(store):
    """FastAPI 依赖：从 X-Customer-Token 头解析当前客户。

    返回 dict: {customer_id, company_id, customer (完整行)}
    失败抛 401。
    """
    def _dep(x_customer_token: str | None = Header(None, alias="X-Customer-Token")):
        if not x_customer_token:
            raise HTTPException(status_code=401, detail="missing customer token")
        token_h = hash_token(x_customer_token)
        session = store.get_session_by_token(token_h)
        if not session:
            raise HTTPException(status_code=401, detail="无效或过期的令牌")
        customer = store.get_customer(session["customer_id"])
        if not customer or customer["status"] != "active":
            raise HTTPException(status_code=401, detail="账号已被禁用")
        if session["company_id"] != customer["company_id"]:
            raise HTTPException(status_code=401, detail="会话租户不匹配")
        # 更新 last_used_at
        store.touch_session(token_h)
        return {
            "customer_id": customer["id"],
            "company_id": customer["company_id"],
            "customer": customer,
            "token_hash": token_h,
        }

    return _dep
