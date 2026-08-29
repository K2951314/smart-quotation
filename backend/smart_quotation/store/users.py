"""用户管理：注册用户 CRUD、账号级档位、启停、迁移、密码重置。

UsersMixin 提供超管用户管理所需的 store 层方法。
认证（注册/登录/JWT）在 api/routes_auth.py，密码哈希在 api/passwords.py。
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID


def _get_integrity_errors():
    try:
        from psycopg2 import errors as _pg_errors
        return (sqlite3.IntegrityError, _pg_errors.UniqueViolation)
    except ImportError:
        return sqlite3.IntegrityError


_IntegrityError = _get_integrity_errors()

# 公开别名：API 层捕获注册并发竞态（同邮箱撞 unique 约束 → 409）用
IntegrityError = _IntegrityError

# is_active 缓存 TTL：require_admin_api 每请求校验，PG 部署下省一次跨网络往返。
# 停用用户/删除公司的写路径会主动失效缓存，最坏延迟 = 本 TTL。
_USER_ACTIVE_CACHE_TTL = 60.0


def _hash_token(token: str) -> str:
    """reset_token 存库哈希（SHA-256 hex）。

    明文 token 只出现在重置邮件/日志里；DB 备份或只读注入泄露 reset_token
    列也无法直接构造重置链接。查询侧（get/consume by token）同样先哈希再比对。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class UsersMixin:
    """用户管理：列表、详情、档位分配、启停、公司迁移、超管重置密码。"""

    def list_users(
        self,
        *,
        search: str = "",
        plan: str = "",
        company_id: str = "",
        is_active: bool | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """列出用户（超管用）。返回 (users, total)。

        LEFT JOIN companies 取公司名，支持按邮箱/档位/公司/状态筛选。
        is_active 兼容 SQLite(0/1) 与 PG(bool)：传 Python bool 由适配器处理。
        """
        where = []
        params: list[Any] = []
        if search:
            where.append("u.email LIKE ?")
            params.append(f"%{search}%")
        if plan == "inherit":
            # 「继承公司」= 账号级 plan 未设置（NULL），回退公司级
            where.append("u.plan IS NULL")
        elif plan:
            where.append("u.plan = ?")
            params.append(plan)
        if company_id:
            where.append("u.company_id = ?")
            params.append(company_id)
        if is_active is not None:
            where.append("u.is_active = ?")
            params.append(is_active)
        where_clause = (" WHERE " + " AND ".join(where)) if where else ""

        with closing(self.connect()) as conn:
            total = conn.execute(
                f"SELECT COUNT(*) AS n FROM users u{where_clause}", params
            ).fetchone()["n"]
            rows = conn.execute(
                f"""
                SELECT u.id, u.email, u.company_id, u.plan, u.plan_expires_at, u.is_active,
                       u.created_at, u.last_login_at,
                       c.name AS company_name
                FROM users u
                LEFT JOIN companies c ON u.company_id = c.id
                {where_clause}
                ORDER BY u.created_at DESC
                LIMIT ? OFFSET ?
                """,
                params + [limit, offset],
            ).fetchall()

        users = []
        for r in rows:
            users.append({
                "id": r["id"],
                "email": r["email"],
                "company_id": r["company_id"],
                "company_name": r["company_name"],
                "plan": r["plan"],
                "plan_expires_at": r["plan_expires_at"],
                "is_active": bool(r["is_active"]),
                "created_at": r["created_at"],
                "last_login_at": r["last_login_at"],
            })
        return users, total

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        """获取单个用户，不存在返回 None。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT id, email, company_id, plan, plan_expires_at, is_active,
                       created_at, last_login_at
                FROM users WHERE id = ?
                """,
                (user_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "email": row["email"],
            "company_id": row["company_id"],
            "plan": row["plan"],
            "plan_expires_at": row["plan_expires_at"],
            "is_active": bool(row["is_active"]),
            "created_at": row["created_at"],
            "last_login_at": row["last_login_at"],
        }

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        """按邮箱查用户（密码找回用，含 reset_token/is_active）。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT id, email, company_id, password_hash, plan, is_active,
                       reset_token, reset_expires, created_at, last_login_at
                FROM users WHERE email = ?
                """,
                (email,),
            ).fetchone()
        if not row:
            return None
        return dict(row)

    def get_user_by_reset_token(self, token: str) -> dict[str, Any] | None:
        """按 reset_token 查用户（含 reset_expires 用于过期校验）。

        列里存的是 token 的 SHA-256 哈希，比对前先哈希入参。
        """
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT id, email, company_id, reset_expires
                FROM users WHERE reset_token = ?
                """,
                (_hash_token(token),),
            ).fetchone()
        return dict(row) if row else None

    def update_user(
        self,
        user_id: str,
        *,
        plan: str | None = ...,  # 哨兵：None 表示显式清除，... 表示不改
        plan_expires_at: str | None = ...,  # None=清除（永久），str=ISO 到期时间
        is_active: bool | None = ...,
        company_id: str | None = ...,
        password_hash: str | None = ...,
        reset_token: str | None = ...,
        reset_expires: str | None = ...,
        last_login_at: str | None = ...,
    ) -> dict[str, Any]:
        """更新用户属性。用哨兵 ... 区分「不改」与「显式置 NULL」。

        返回更新后的用户（不含 password_hash）。
        """
        sets = []
        params: list[Any] = []
        if plan is not ...:
            sets.append("plan = ?")
            params.append(plan)
        if plan_expires_at is not ...:
            sets.append("plan_expires_at = ?")
            params.append(plan_expires_at)
        if is_active is not ...:
            sets.append("is_active = ?")
            params.append(is_active)
        if company_id is not ...:
            sets.append("company_id = ?")
            params.append(company_id)
        if password_hash is not ...:
            sets.append("password_hash = ?")
            params.append(password_hash)
        if reset_token is not ...:
            sets.append("reset_token = ?")
            # 非空 token 统一存哈希（与 set_reset_token 一致）
            params.append(_hash_token(reset_token) if reset_token else None)
        if reset_expires is not ...:
            sets.append("reset_expires = ?")
            params.append(reset_expires)
        if last_login_at is not ...:
            sets.append("last_login_at = ?")
            params.append(last_login_at)
        if not sets:
            return self.get_user(user_id) or {}

        params.append(user_id)
        with closing(self.connect()) as conn:
            result = conn.execute(
                f"UPDATE users SET {', '.join(sets)} WHERE id = ?",
                params,
            )
            if result.rowcount == 0:
                raise LookupError(f"用户不存在: {user_id}")
            conn.commit()
        # is_active 变化即时失效缓存（require_admin_api 的 60s TTL 缓存）
        if is_active is not ...:
            self._invalidate_user_active_cache()
        self._mark_db_dirty(immediate=True)
        return self.get_user(user_id) or {}

    def set_reset_token(self, user_id: str, token: str | None, expires: str | None) -> None:
        """设置/清除密码重置令牌。token=None 清除。

        列里存 token 的 SHA-256 哈希——明文只在重置邮件/日志中。
        """
        with closing(self.connect()) as conn:
            result = conn.execute(
                "UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?",
                (_hash_token(token) if token else None, expires, user_id),
            )
            if result.rowcount == 0:
                raise LookupError(f"用户不存在: {user_id}")
            conn.commit()
        self._mark_db_dirty(immediate=True)

    def consume_reset_token(self, token: str, password_hash: str) -> str | None:
        """消费 reset_token 重置密码（原子，防并发复用）。

        成功返回 user_id，token 无效/已被消费返回 None。
        先查 user_id，再 UPDATE ... WHERE reset_token=? AND id=? 检查 rowcount——
        并发场景下第一个请求清空 token，第二个 rowcount=0 被拒。
        列存 token 哈希，比对前先哈希入参。
        """
        token_hash = _hash_token(token)
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT id FROM users WHERE reset_token = ?", (token_hash,)
            ).fetchone()
            if not row:
                conn.commit()
                return None
            user_id = row["id"]
            result = conn.execute(
                """
                UPDATE users
                SET password_hash = ?, reset_token = NULL, reset_expires = NULL
                WHERE id = ? AND reset_token = ?
                """,
                (password_hash, user_id, token_hash),
            )
            if result.rowcount == 0:
                # 并发竞争：token 在 SELECT 后被另一请求消费
                conn.commit()
                return None
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return user_id

    def delete_user(self, user_id: str) -> None:
        """删除用户（注销账号）。其公司不做级联处理——公司及数据保留，
        是否清理由超管在公司管理另行决定（删除公司有活跃用户保护）。
        """
        with closing(self.connect()) as conn:
            result = conn.execute("delete from users where id = ?", (user_id,))
            if result.rowcount == 0:
                raise LookupError(f"用户不存在: {user_id}")
            conn.commit()
        self._invalidate_user_active_cache()
        self._mark_db_dirty(immediate=True)

    def touch_last_login(self, user_id: str) -> None:
        """更新最后登录时间（登录成功时调用）。"""
        with closing(self.connect()) as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (self.now(), user_id),
            )
            conn.commit()
        self._mark_db_dirty(immediate=True)

    def is_user_active(self, user_id: str) -> bool:
        """检查用户是否启用（require_admin_api JWT 校验用，每次请求调）。

        用户不存在也返回 False（已删除/伪造 user_id）。

        60s TTL 进程内缓存：PG 部署下每个 admin 请求省一次跨网络往返。
        停用用户/迁移/删除公司等写路径调用 _invalidate_user_active_cache()
        主动失效，最坏延迟 = TTL（多 Worker 各自缓存，最终一致）。
        缓存放在实例 __dict__（mixin 无 __init__，类属性 dict 会跨实例共享）。
        """
        cache: dict[str, tuple[bool, float]] = self.__dict__.setdefault(
            "_user_active_cache", {}
        )
        now = time.monotonic()
        hit = cache.get(user_id)
        if hit is not None and now - hit[1] < _USER_ACTIVE_CACHE_TTL:
            return hit[0]
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT is_active FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
        active = bool(row and row["is_active"])
        cache[user_id] = (active, now)
        return active

    def _invalidate_user_active_cache(self) -> None:
        """失效 is_active 缓存（任何可能改变 is_active 的写路径后调用）。

        整表清空而非按 user_id 摘除：delete_company 级联停用不知道受影响的
        user_id 列表，而用户量级小，全清成本可忽略。
        """
        cache = self.__dict__.get("_user_active_cache")
        if cache:
            cache.clear()
