"""Store 基础层：连接管理、Schema 初始化、迁移、ConfigCache。"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

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
    """Store 基类：管理 SQLite 连接、Schema 初始化和迁移。"""

    def __init__(self, db_path: str = "quotation.db") -> None:
        self.db_path = db_path
        self.cache = ConfigCache()

    def connect(self) -> sqlite3.Connection:
        """创建 SQLite 连接。

        SQLite URI 模式：如果 db_path 是 :memory:，用临时文件替代
        （共享内存模式在多线程 TestClient 下不稳定，文件 DB 是最可靠的）
        """
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
                """
            )
            self._migrate_add_company_id_if_missing(conn)
            conn.commit()
        self._migrate_add_access_tokens()

    @staticmethod
    def _migrate_add_company_id_if_missing(conn: sqlite3.Connection) -> None:
        """迁移：旧表补 company_id 列。"""
        for table in ("quotation_configs", "quotation_items", "audit_events"):
            try:
                cols = [row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()]
                if "company_id" not in cols:
                    conn.execute(
                        f"ALTER TABLE {table} ADD COLUMN company_id text not null default 'default'"
                    )
            except sqlite3.OperationalError:
                pass

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
