"""PostgreSQL 适配器：提供与 sqlite3 兼容的接口，实现双数据库模式。

当 DATABASE_URL 环境变量设置时，自动切换到 PostgreSQL 模式。
未设置时，回退到 SQLite（本地开发模式，SQ_DEV=1）。

核心设计：
  - PGConnection 包装 psycopg2 连接，提供与 sqlite3.Connection 相同的方法签名
  - ? 占位符自动翻译为 %s
  - executescript() 按分号拆分执行，跳过 PRAGMA
  - total_changes 累计 rowcount，模拟 SQLite 的连接级变更计数
  - RealDictCursor 提供与 sqlite3.Row 相同的 dict-like 行访问
  - psycopg2 采用懒加载，仅在 PG 模式下 import（SQLite 模式零依赖）
"""

from __future__ import annotations

import os
from typing import Any

# PostgreSQL Schema（与 SQLite schema 对齐，语法适配 PG）
PG_SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS quotation_configs (
    id SERIAL PRIMARY KEY,
    company_id TEXT NOT NULL DEFAULT 'default',
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_by TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(company_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_configs_company_status
    ON quotation_configs(company_id, status);

CREATE TABLE IF NOT EXISTS quotation_items (
    id SERIAL PRIMARY KEY,
    company_id TEXT NOT NULL DEFAULT 'default',
    data_revision TEXT NOT NULL,
    item_key TEXT NOT NULL,
    fields_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_company_revision
    ON quotation_items(company_id, data_revision);

CREATE TABLE IF NOT EXISTS audit_events (
    id SERIAL PRIMARY KEY,
    company_id TEXT DEFAULT 'default',
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_company
    ON audit_events(company_id, id);

CREATE TABLE IF NOT EXISTS security_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    client_key TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_key_time
    ON security_events(client_key, created_at);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    company_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reset_token TEXT,
    reset_expires TEXT,
    last_login_at TEXT,
    plan TEXT,
    plan_expires_at TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
"""


def is_pg_mode() -> bool:
    """判断是否为 PostgreSQL 模式。

    DATABASE_URL 必须以 postgres:// 或 postgresql:// 开头才认定为 PG 模式。
    file: 开头的视为 SQLite（兼容已有环境变量配置）。
    """
    url = os.environ.get("DATABASE_URL", "").strip().lower()
    return url.startswith("postgres://") or url.startswith("postgresql://")


# 模块级连接池（懒初始化）
_pg_pool = None


def get_pg_pool():
    """获取或初始化 PG 连接池。"""
    global _pg_pool
    if _pg_pool is None:
        from psycopg2.pool import SimpleConnectionPool
        db_url = os.environ["DATABASE_URL"].strip()
        _pg_pool = SimpleConnectionPool(1, 10, db_url)
    return _pg_pool


def _connection_alive(conn) -> bool:
    """探测连接是否仍然可用（应对 Railway/云 PG 空闲回收、服务端重启）。"""
    if conn is None or getattr(conn, "closed", 1):
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception:
        return False


def acquire_connection(max_retries: int = 3):
    """从连接池取一个经过存活探测的连接，失败自动重试/换连接。

    SimpleConnectionPool 不在 getconn 时做健康检查，云数据库（Railway/Supabase）
    常因空闲超时被服务端关闭连接，导致「启动正常、首个请求 500」的典型故障：
    启动时建连成功，请求到来时池里那条连接已被服务端回收，psycopg2 拿到死连接，
    首条 SQL 直接抛 OperationalError。
    这里在取连接时探活，发现死连接立即丢弃并从池里换一个；getconn 本身抛错
    （如连接被服务端拒绝、池耗尽）也捕获后重试，避免把底层异常直接漏成 500。
    """
    pool = get_pg_pool()
    last_exc: Exception | None = None
    for _ in range(max_retries):
        try:
            conn = pool.getconn()
        except Exception as exc:  # 建连失败（网络/服务端拒绝/池耗尽）
            last_exc = exc
            continue
        if _connection_alive(conn):
            return conn
        # 死连接：丢弃后下次循环重建
        try:
            pool.putconn(conn, close=True)
        except Exception:
            pass
        last_exc = RuntimeError("PostgreSQL 连接存活探测失败（可能已被服务端回收）")
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("无法从连接池获取可用 PostgreSQL 连接")


class PGConnection:
    """psycopg2 连接包装器，提供 sqlite3.Connection 兼容接口。

    透明处理：
    - ? → %s 占位符翻译
    - executescript() 按分号拆分执行
    - total_changes 累计 rowcount
    - RealDictCursor 提供 dict-like 行访问（与 sqlite3.Row 对齐）
    """

    def __init__(self, conn) -> None:
        self._conn = conn
        self._total_changes = 0

    def _get_cursor(self, dict_mode=True):
        from psycopg2.extras import RealDictCursor
        if dict_mode:
            return self._conn.cursor(cursor_factory=RealDictCursor)
        return self._conn.cursor()

    def execute(self, sql: str, params: tuple | list | None = None):
        if params is not None:
            sql = sql.replace("?", "%s")
            cursor = self._get_cursor(dict_mode=True)
            cursor.execute(sql, tuple(params))
        else:
            cursor = self._get_cursor(dict_mode=True)
            cursor.execute(sql)
        # 累计写操作变更行数（与 SQLite total_changes 语义对齐）
        stripped = sql.strip().upper()
        if stripped.startswith(("INSERT", "UPDATE", "DELETE")) and cursor.rowcount > 0:
            self._total_changes += cursor.rowcount
        return cursor

    def executemany(self, sql: str, params_list):
        sql = sql.replace("?", "%s")
        cursor = self._get_cursor(dict_mode=False)
        cursor.executemany(sql, list(params_list))
        if cursor.rowcount > 0:
            self._total_changes += cursor.rowcount
        return cursor

    def executescript(self, sql: str):
        """按分号拆分执行多条语句，跳过 PRAGMA（PG 不支持）。"""
        cursor = self._get_cursor(dict_mode=False)
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            upper = stmt.upper()
            # 跳过 PRAGMA 语句（PG 不支持）
            if upper.startswith("PRAGMA"):
                continue
            cursor.execute(stmt)
        return cursor

    def commit(self):
        self._conn.commit()

    def close(self):
        # 归还连接池前先 rollback，确保脏事务不污染下一个使用者
        try:
            self._conn.rollback()
        except Exception:
            pass  # 连接已损坏等异常忽略
        if _pg_pool is not None:
            # 连接已失效（服务端回收/重启）则直接丢弃，避免把死连接放回池里
            # 毒害后续请求（否则下一次 getconn 拿到死连接又会 500）
            try:
                if getattr(self._conn, "closed", 1):
                    _pg_pool.putconn(self._conn, close=True)
                else:
                    _pg_pool.putconn(self._conn)
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
        else:
            try:
                self._conn.close()
            except Exception:
                pass

    @property
    def total_changes(self) -> int:
        return self._total_changes
