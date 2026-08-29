"""密码哈希公共模块（PBKDF2-HMAC-SHA256，无外部依赖）。

注册/登录/密码重置/超管重置密码共用此模块，避免跨模块 import 私有函数。
"""

from __future__ import annotations

import hashlib
import os
import secrets

_PBKDF2_ITERATIONS = 100000
_SALT_SIZE = 16


def hash_password(password: str) -> str:
    """PBKDF2 密码哈希，返回 salt:hash 格式。"""
    salt = os.urandom(_SALT_SIZE)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"{salt.hex()}:{dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """验证密码。"""
    try:
        salt_hex, hash_hex = stored.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
        return secrets.compare_digest(dk, expected)
    except (ValueError, AttributeError):
        return False
