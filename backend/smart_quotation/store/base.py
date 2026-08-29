"""Store 基础层：连接管理、Schema 初始化、迁移、ConfigCache。

双数据库模式：
  - DATABASE_URL 已设置 → PostgreSQL（生产/SaaS 模式）
  - SQ_DEV=1 → SQLite（本地开发/测试模式）
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .pg_adapter import PG_SCHEMA, PGConnection, is_pg_mode, acquire_connection

# 默认 company_id：兼容单租户场景。老代码不传 company_id 时自动归到此值。
DEFAULT_COMPANY_ID = "default"

# 敏感字段名：company 角色下必须脱敏（移除）。
# 除了面价和折扣，还包含常见的成本/采购价/利润字段，
# 防止 admin 上传含成本列的 Excel 时意外泄露给客户。
# admin 可通过 config.security.sensitive_fields 覆盖此默认集。
SENSITIVE_FIELDS = {
    "face_price",
    "discount_percent",
    "discount",
    "cost",
    "cost_price",
    "purchase_price",
    "supplier_price",
    "margin",
    "margin_percent",
    "profit_margin",
    "base_price",
    "进价",
    "成本",
    "采购价",
}


class ConfigCache:
    """简单的内存缓存，避免重复读取已发布配置。"""

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}

    def get(self, key: str, loader):
        if key not in self._cache:
            self._cache[key] = loader()
        return self._cache[key]

    def invalidate(self) -> None:
        self._cache.clear()


class StoreBase:
    """Store 基类：管理数据库连接（PG/SQLite 双模式）、Schema 初始化和迁移。"""

    def __init__(self, db_path: str = "quotation.db") -> None:
        self.db_path = db_path
        self.cache = ConfigCache()
        # 备份管理器（可选）：admin 数据变更后调用 mark_dirty() 触发按需备份。
        # 由 factory.create_app 在启动时注入。未注入时为 None，写操作零开销。
        self._backup_manager = None
        # 数据库模式：PG（生产）或 SQLite（本地开发/测试）
        self._is_pg = is_pg_mode()

    def set_backup_manager(self, manager) -> None:
        """注入备份管理器。factory.create_app 在创建 store 后调用。"""
        self._backup_manager = manager

    def _mark_db_dirty(self, immediate: bool = False) -> None:
        """通知备份管理器数据库有变更。未注入时为空操作（零开销）。"""
        mgr = self._backup_manager
        if mgr is not None:
            if immediate:
                mgr.mark_critical_dirty()
            else:
                mgr.mark_dirty()

    def connect(self):
        """创建数据库连接（PostgreSQL 或 SQLite）。

        模式选择：
        - DATABASE_URL 已设置 → PostgreSQL 连接池
        - 否则 → SQLite 文件（或 :memory: 临时文件）
        """
        if self._is_pg:
            conn = acquire_connection()
            return PGConnection(conn)

        # SQLite 模式（本地开发/测试）
        if self.db_path == ":memory:":
            if not hasattr(self, "_tmp_db_path"):
                fd, path = tempfile.mkstemp(suffix=".db", prefix="sq_test_")
                os.close(fd)
                self._tmp_db_path = path
            conn = sqlite3.connect(self._tmp_db_path)
        else:
            conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL 模式：多写入者场景下减少锁冲突
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA busy_timeout = 5000")
        except sqlite3.OperationalError:
            pass  # 临时文件或只读场景可能不支持 WAL
        return conn

    def init_schema(self) -> None:
        """初始化数据库 Schema（幂等）。"""
        if self._is_pg:
            with closing(self.connect()) as conn:
                conn.executescript(PG_SCHEMA)
                conn.commit()
            self._migrate_add_access_tokens()
            self._migrate_pg_add_user_columns()
            self._migrate_standalone_companies_to_admin()
            self._migrate_repair_orphan_users()
            self._migrate_backfill_company_owner()
            self._migrate_unfreeze_machine_plans()
            return

        # SQLite 模式
        with closing(self.connect()) as conn:
            conn.executescript(
                """
                create table if not exists companies (
                    id text primary key,
                    name text not null,
                    created_at text not null,
                    meta_json text default '{}'
                );

                create table if not exists quotation_configs (
                    id integer primary key autoincrement,
                    company_id text not null default 'default',
                    revision text not null,
                    status text not null,
                    config_json text not null,
                    created_by text,
                    published_at text,
                    created_at text not null,
                    unique(company_id, revision)
                );
                create index if not exists idx_configs_company_status
                    on quotation_configs(company_id, status);

                create table if not exists quotation_items (
                    id integer primary key autoincrement,
                    company_id text not null default 'default',
                    data_revision text not null,
                    item_key text not null,
                    fields_json text not null
                );
                create index if not exists idx_items_company_revision
                    on quotation_items(company_id, data_revision);

                create table if not exists audit_events (
                    id integer primary key autoincrement,
                    company_id text default 'default',
                    actor_id text,
                    action text not null,
                    target_type text not null,
                    target_id text,
                    payload_json text not null,
                    created_at text not null
                );
                create index if not exists idx_audit_company
                    on audit_events(company_id, id);

                create table if not exists security_events (
                    id integer primary key autoincrement,
                    event_type text not null,
                    client_key text not null,
                    created_at text not null
                );
                create index if not exists idx_security_key_time
                    on security_events(client_key, created_at);

                create table if not exists users (
                    id text primary key,
                    email text not null unique,
                    password_hash text not null,
                    company_id text not null,
                    created_at text not null
                );
                create index if not exists idx_users_email
                    on users(email);
                create index if not exists idx_users_company
                    on users(company_id);
                """
            )
            self._migrate_add_company_id_if_missing(conn)
            self._migrate_add_user_columns_if_missing(conn)
            conn.commit()
        self._migrate_add_access_tokens()
        self._migrate_standalone_companies_to_admin()
        self._migrate_repair_orphan_users()
        self._migrate_backfill_company_owner()
        self._migrate_unfreeze_machine_plans()

    @staticmethod
    def _migrate_add_company_id_if_missing(conn) -> None:
        """迁移：旧表补 company_id 列（SQLite 专用，PG schema 已内置）。"""
        for table in ("quotation_configs", "quotation_items", "audit_events"):
            try:
                cols = [row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()]
                if "company_id" not in cols:
                    conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN company_id text not null default 'default'"
                    )
            except sqlite3.OperationalError:
                pass

    @staticmethod
    def _migrate_add_user_columns_if_missing(conn) -> None:
        """迁移：users 表补 reset_token/reset_expires/last_login_at/plan/is_active 列。

        支持密码找回（reset_token/reset_expires）、最后登录记录（last_login_at）、
        账号级订阅档位（plan，NULL=回退公司级 + plan_expires_at 到期时间）、账号启停（is_active）。
        """
        try:
            cols = [row["name"] for row in conn.execute("pragma table_info(users)").fetchall()]
        except sqlite3.OperationalError:
            return  # users 表不存在（init_schema 已建表，理论不触发）
        additions = [
            ("reset_token", "text"),
            ("reset_expires", "text"),
            ("last_login_at", "text"),
            ("plan", "text"),
            ("plan_expires_at", "text"),
            ("is_active", "integer not null default 1"),
        ]
        for col_name, col_type in additions:
            if col_name not in cols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col_name} {col_type}")

    def _migrate_pg_add_user_columns(self) -> None:
        """PG 迁移：users 表补列（幂等，参照 SQLite 版本）。"""
        with closing(self.connect()) as conn:
            cols = [
                row["column_name"]
                for row in conn.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
                ).fetchall()
            ]
            additions = [
                ("reset_token", "TEXT"),
                ("reset_expires", "TEXT"),
                ("last_login_at", "TEXT"),
                ("plan", "TEXT"),
                ("plan_expires_at", "TEXT"),
                ("is_active", "BOOLEAN NOT NULL DEFAULT TRUE"),
            ]
            for col_name, col_type in additions:
                if col_name not in cols:
                    conn.execute(f'ALTER TABLE users ADD COLUMN {col_name} {col_type}')
            conn.commit()

    def _migrate_standalone_companies_to_admin(self) -> None:
        """迁移：历史「独立公司」（无 is_admin、无 parent、非 default）升级为数据源管理员。

        背景：「注册即数据源管理员」（meta.is_admin=true + plan=free）成为唯一
        账号形态后，独立公司概念已废弃。此迁移把旧版注册产生的公司一次性
        升级，使历史账号的公司在公司树可见、可管理——否则其登录后无公司可用。
        幂等：已有 is_admin 或 parent 的公司跳过；default（系统租户）不动；
        已有 plan 不覆盖（付费档不降级）。
        """
        with closing(self.connect()) as conn:
            rows = conn.execute("select id, meta_json from companies").fetchall()
            migrated: list[str] = []
            for r in rows:
                if r["id"] == DEFAULT_COMPANY_ID:
                    continue
                meta = json.loads(r["meta_json"] or "{}")
                if meta.get("is_admin") or meta.get("parent_company_id"):
                    continue
                meta["is_admin"] = True
                # fail-closed：无 plan 的管理员公司会回退继承部署 license 档位
                meta.setdefault("plan", "free")
                meta["migrated_from_standalone"] = True
                conn.execute(
                    "update companies set meta_json = ? where id = ?",
                    (json.dumps(meta, ensure_ascii=False), r["id"]),
                )
                migrated.append(r["id"])
            conn.commit()
        if migrated:
            self.cache.invalidate()
            import logging as _logging
            _logging.getLogger(__name__).info(
                "已将 %d 家历史独立公司升级为数据源管理员（is_admin=true, plan=free）: %s",
                len(migrated), ", ".join(migrated),
            )
    def _migrate_repair_orphan_users(self) -> None:
        """自愈：修复 company_id 指向不存在公司的孤儿用户。

        不变量：每个用户必须始终有有效公司。无论公司行因何丢失（误删、
        备份回灌、库替换），启动时检测 user.company_id 不在 companies 表的
        孤儿用户，按注册语义重建公司（is_admin=true + plan=free）——
        历史账号登录即可用，无需人工干预。幂等：公司存在即跳过。
        company_id 为空的用户生成新公司并回写。
        """
        with closing(self.connect()) as conn:
            existing = {r["id"] for r in conn.execute("select id from companies").fetchall()}
            users = conn.execute("select id, email, company_id from users").fetchall()
            created: list[str] = []
            regen_users = 0
            for u in users:
                cid = (u["company_id"] or "").strip()
                if cid and cid in existing:
                    continue
                if not cid:
                    # 空公司 ID：从邮箱 local-part 生成 slug + 随机后缀
                    local = (u["email"] or "user").split("@")[0]
                    slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]", "-", local).strip("-").lower()[:20] or "user"
                    cid = f"{slug}-{secrets.token_hex(4)}"
                    conn.execute(
                        "update users set company_id = ? where id = ?", (cid, u["id"])
                    )
                    regen_users += 1
                if cid not in existing:
                    conn.execute(
                        "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                        (cid, cid, self.now(), json.dumps(
                            {"is_admin": True, "plan": "free", "created_by": "repair"},
                            ensure_ascii=False,
                        )),
                    )
                    existing.add(cid)
                    created.append(cid)
            if created or regen_users:
                conn.commit()
                self.cache.invalidate()
                logging.getLogger(__name__).warning(
                    "孤儿用户自愈：重建了 %d 家丢失的公司记录 %s（is_admin=true, plan=free），"
                    "为 %d 个用户生成了新公司 ID",
                    len(created), ", ".join(created), regen_users,
                )

    def _migrate_backfill_company_owner(self) -> None:
        """回填所有权：register/repair 创建的公司补 meta.owner_user_id。

        账号配额（max_companies/子账号 seats）按所有权计数；历史公司
        没有该标记时从「指向该公司的最早用户」反查回填。幂等：已有 owner 跳过。
        """
        with closing(self.connect()) as conn:
            companies = conn.execute(
                "select id, meta_json from companies where id != ?",
                (DEFAULT_COMPANY_ID,),
            ).fetchall()
            users = conn.execute(
                "select id, email, company_id, created_at from users order by created_at asc"
            ).fetchall()
            # 每家公司最早的用户（register/repair 公司才回填——成员公司无 owner）
            earliest_user: dict[str, str] = {}
            for u in users:
                cid = (u["company_id"] or "").strip()
                if cid and cid not in earliest_user:
                    earliest_user[cid] = u["id"]
            changed = 0
            for c in companies:
                try:
                    meta = json.loads(c["meta_json"] or "{}")
                except json.JSONDecodeError:
                    continue
                if meta.get("owner_user_id"):
                    continue
                if meta.get("created_by") not in ("register", "repair"):
                    continue
                owner = earliest_user.get(c["id"])
                if not owner:
                    continue
                meta["owner_user_id"] = owner
                conn.execute(
                    "update companies set meta_json = ? where id = ?",
                    (json.dumps(meta, ensure_ascii=False), c["id"]),
                )
                changed += 1
            if changed:
                conn.commit()
                self.cache.invalidate()
                logging.getLogger(__name__).info(
                    "已为 %d 家公司回填所有权（owner_user_id）", changed
                )

    def _migrate_unfreeze_machine_plans(self) -> None:
        """解冻机器写入的 plan=free 快照，恢复账号档位跟随。

        原则：公司 meta.plan 只允许「超管显式覆盖」（plan_source=superadmin）
        一种存在形式；迁移/自愈/早期注册机器写入的 plan=free 会压住 owner
        账号档位链（账号升级后公司卡在免费版）。有 owner 且快照为 free 且
        非超管显式设置 → 移除 plan 回退 owner 链。幂等；pro/team 快照视为
        显式分配不动。
        """
        with closing(self.connect()) as conn:
            companies = conn.execute("select id, meta_json from companies").fetchall()
            unfrozen: list[str] = []
            for c in companies:
                try:
                    meta = json.loads(c["meta_json"] or "{}")
                except json.JSONDecodeError:
                    continue
                if not meta.get("owner_user_id"):
                    continue
                if meta.get("plan") != "free":
                    continue
                if meta.get("plan_source") == "superadmin":
                    continue  # 超管显式指定 free：尊重
                meta.pop("plan", None)
                meta.pop("plan_source", None)
                conn.execute(
                    "update companies set meta_json = ? where id = ?",
                    (json.dumps(meta, ensure_ascii=False), c["id"]),
                )
                unfrozen.append(c["id"])
            if unfrozen:
                conn.commit()
                self.cache.invalidate()
                logging.getLogger(__name__).info(
                    "已解冻 %d 家公司的机器默认 plan=free（恢复账号档位跟随）: %s",
                    len(unfrozen), ", ".join(unfrozen),
                )

    def _migrate_add_access_tokens(self) -> None:
        """迁移：为已有公司生成访问令牌（如果缺失）。

        同时为 default 公司自动创建记录并生成令牌（如果不存在）。
        迁移 v2：为所有令牌补充 token_created_at（用于过期检查）。
        """
        import secrets as _secrets
        now_iso = datetime.now(timezone.utc).isoformat()
        with closing(self.connect()) as conn:
            default_row = conn.execute(
                "select id, meta_json from companies where id = 'default'"
            ).fetchone()
            if not default_row:
                default_meta = {"access_token": _secrets.token_urlsafe(32), "token_created_at": now_iso}
                conn.execute(
                    "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                    ("default", "默认", self.now(), json.dumps(default_meta, ensure_ascii=False)),
                )
            else:
                try:
                    meta = json.loads(default_row["meta_json"] or "{}")
                except json.JSONDecodeError:
                    meta = {}
                changed = False
                if not meta.get("access_token"):
                    meta["access_token"] = _secrets.token_urlsafe(32)
                    changed = True
                if not meta.get("token_created_at"):
                    meta["token_created_at"] = now_iso
                    changed = True
                if changed:
                    conn.execute(
                        "update companies set meta_json = ? where id = ?",
                        (json.dumps(meta, ensure_ascii=False), "default"),
                    )

            rows = conn.execute(
                "select id, meta_json from companies where id != 'default'"
            ).fetchall()
            for row in rows:
                try:
                    meta = json.loads(row["meta_json"] or "{}")
                except json.JSONDecodeError:
                    meta = {}
                changed = False
                if not meta.get("access_token"):
                    meta["access_token"] = _secrets.token_urlsafe(32)
                    changed = True
                if not meta.get("token_created_at"):
                    meta["token_created_at"] = now_iso
                    changed = True
                if changed:
                    conn.execute(
                        "update companies set meta_json = ? where id = ?",
                        (json.dumps(meta, ensure_ascii=False), row["id"]),
                    )
            conn.commit()

    def now(self) -> str:
        """返回当前 UTC 时间的 ISO 格式字符串。"""
        return datetime.now(timezone.utc).isoformat()
