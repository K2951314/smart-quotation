"""SQLite 数据库备份到 Supabase Storage。

解决 Railway 免费版无持久化 Volume 的问题：每次重新部署容器文件系统重置，
SQLite 文件丢失。本模块在启动时从 Supabase Storage 下载备份，运行期间定期上传。

安全：SQLite 含公司令牌、客户密码哈希等敏感数据，必须用 private bucket +
service role key（不是 anon key）。service role key 拥有完整存储访问权限，
只能放在后端环境变量，绝不能暴露给前端。
"""

from __future__ import annotations

import logging
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _get_backup_config() -> Optional[tuple[str, str, str, str]]:
    """读取备份配置。

    返回 (supabase_url, service_key, bucket, remote_path) 或 None（未配置时）。
    """
    url = os.environ.get("SQ_SUPABASE_BASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SQ_SUPABASE_SERVICE_KEY", "").strip()
    bucket = os.environ.get("DB_BACKUP_BUCKET", "sq-db-backup")
    path = os.environ.get("DB_BACKUP_PATH", "quotation.db")
    if not url or not key:
        return None
    return (url, key, bucket, path)


def download_db(local_path: str) -> bool:
    """从 Supabase Storage 下载 SQLite 备份到 local_path。

    使用临时文件 + os.replace 原子写入，避免下载/写入中途失败留下损坏文件。

    Returns:
        True 下载成功；False 下载失败或未配置（调用方应继续用空数据库启动）。
    """
    cfg = _get_backup_config()
    if not cfg:
        logger.info("DB backup skipped: SQ_SUPABASE_BASE_URL or SQ_SUPABASE_SERVICE_KEY not set")
        return False

    url, key, bucket, remote_path = cfg
    download_url = f"{url}/storage/v1/object/{bucket}/{remote_path}"
    req = urllib.request.Request(
        download_url,
        method="GET",
        headers={
            "apikey": key,
            "authorization": f"Bearer {key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        # 校验 SQLite 文件签名，避免 Supabase 返回错误响应/损坏数据时写入坏库导致启动崩溃
        if data[:16] != b"SQLite format 3\x00":
            logger.warning("DB backup download returned non-SQLite data (%d bytes); ignoring", len(data))
            return False
        # 确保父目录存在
        parent = Path(local_path).parent
        parent.mkdir(parents=True, exist_ok=True)
        # 原子写入：先写临时文件，成功后 rename
        tmp_path = f"{local_path}.tmp"
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(tmp_path, local_path)
        logger.info("DB backup restored from Supabase (%d bytes)", len(data))
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            logger.info("No DB backup in Supabase yet (first deploy), starting fresh")
        else:
            logger.warning("DB backup download failed: HTTP %d", exc.code)
        # 清理可能的临时文件
        try:
            os.remove(f"{local_path}.tmp")
        except OSError:
            pass
        return False
    except Exception as exc:
        logger.warning("DB backup download error: %s", exc)
        try:
            os.remove(f"{local_path}.tmp")
        except OSError:
            pass
        return False


def _wal_checkpoint(local_path: str) -> None:
    """SQLite WAL 检查点：把 WAL 日志合并到主数据库文件，确保备份一致性。"""
    try:
        conn = sqlite3.connect(local_path)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
    except Exception as exc:
        logger.warning("WAL checkpoint failed (backup may be slightly stale): %s", exc)


def upload_db(local_path: str) -> bool:
    """上传 SQLite 到 Supabase Storage。

    上传前先做 WAL 检查点，确保所有未提交到主文件的 WAL 日志被合并。

    Returns:
        True 上传成功；False 上传失败、文件不存在或未配置。
    """
    cfg = _get_backup_config()
    if not cfg:
        return False
    if not os.path.exists(local_path):
        return False

    url, key, bucket, remote_path = cfg

    # WAL 检查点：确保备份的是完整数据库（含最新写入）
    _wal_checkpoint(local_path)

    try:
        with open(local_path, "rb") as f:
            data = f.read()
    except Exception as exc:
        logger.warning("DB backup read failed: %s", exc)
        return False

    upload_url = f"{url}/storage/v1/object/{bucket}/{remote_path}"
    req = urllib.request.Request(
        upload_url,
        data=data,
        method="PUT",
        headers={
            "apikey": key,
            "authorization": f"Bearer {key}",
            "content-type": "application/octet-stream",
            "x-upsert": "true",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        logger.info("DB backup uploaded to Supabase (%d bytes)", len(data))
        return True
    except urllib.error.HTTPError as exc:
        logger.warning("DB backup upload failed: HTTP %d %s", exc.code, exc.reason)
        return False
    except Exception as exc:
        logger.warning("DB backup upload error: %s", exc)
        return False


def _latest_mtime(db_path: str) -> float:
    """返回 SQLite 主文件 + -wal + -shm 中最新的 mtime，用于检测是否有新写入。

    关键：在 WAL 模式下，写入先落到 -wal 文件，主文件 mtime 不随每次写入更新。
    若只监控主文件 mtime 会漏掉写入、导致备份线程永不触发、重新部署丢数据。
    因此必须同时监控 -wal / -shm 文件。DELETE 模式下无 -wal/-shm，自动退化为主文件。
    """
    best = 0.0
    for candidate in (db_path, db_path + "-wal", db_path + "-shm"):
        try:
            m = os.path.getmtime(candidate)
        except OSError:
            continue
        if m > best:
            best = m
    return best
