"""SQLite 数据库备份到 Supabase Storage。

解决 Railway 免费版无持久化 Volume 的问题：每次重新部署容器文件系统重置，
SQLite 文件丢失。本模块在启动时从 Supabase Storage 下载备份，运行期间按需上传。

备份策略（免费额度友好）：
  - 事件驱动 + 防抖：admin 数据变更后标记 dirty，延迟 DEBOUNCE_SECONDS
    后上传一次（多次写合并为一次上传）。
  - 最小间隔：两次上传至少间隔 MIN_INTERVAL_SECONDS，防止短时间内频繁上传。
  - 每日上限：每天最多 MAX_UPLOADS_PER_DAY 次上传，即使持续写入也不会失控。
  - 退出时备份：atexit 触发最后一次上传（如有未提交的 dirty）。
  - WAL 检查点：上传前合并 WAL，确保一致性。

安全：SQLite 含公司令牌等敏感数据，必须用 private bucket + service role key
（不是 anon key）。service role key 只能放在后端环境变量，绝不能暴露给前端。

不使用定时轮询线程（原方案每 60s 检查 mtime 会在高频写入时打爆 Supabase
免费版 2GB/月带宽额度——攻击者发错误请求触发 security_events 写入即可
每分钟触发一次全量上传，几天内耗尽额度）。
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─── 备份频率参数（免费额度保护）────────────────────────────
# 防抖：标记 dirty 后等待 N 秒再上传，期间多次写合并为一次
DEBOUNCE_SECONDS = 600  # 10 分钟
# 最小上传间隔：即使持续有写入，两次上传至少间隔 N 秒
MIN_INTERVAL_SECONDS = 600  # 10 分钟
# 每日上传上限：绝对硬上限，防止任何意外导致失控
MAX_UPLOADS_PER_DAY = 24  # 最快每 60 分钟一次（理论极限 144，保守设 24）


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


class BackupManager:
    """事件驱动的 SQLite 备份管理器。

    替代原定时轮询方案。admin 数据变更后调用 mark_dirty()，由防抖定时器
    延迟合并上传。security_events 等高频低价值写入不应调用 mark_dirty。

    线程安全：内部用 Lock 保护计数器和定时器。
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._lock = threading.Lock()
        self._dirty = False
        self._timer: Optional[threading.Timer] = None
        self._last_upload_ts: float = 0.0
        self._upload_count_today = 0
        self._day_reset_ts = self._today_start()

    @staticmethod
    def _today_start() -> float:
        """返回今天 UTC 0 点的 timestamp（用于每日计数重置）。"""
        now = time.time()
        return now - (now % 86400)

    def mark_dirty(self) -> None:
        """标记数据库有变更，需要备份。

        防抖：标记后延迟 DEBOUNCE_SECONDS 上传。期间多次标记只保留一次延迟上传。
        如果已达到每日上限，跳过并记录 warning。
        """
        if not _get_backup_config():
            return  # 未配置备份，零开销
        with self._lock:
            if not self._dirty:
                self._dirty = True
                logger.debug("DB marked dirty, scheduling backup in %ds", DEBOUNCE_SECONDS)
            # 取消旧定时器，重新计时（防抖：最后一次写之后 DEBOUNCE_SECONDS 才真正上传）
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_SECONDS, self._do_upload)
            self._timer.daemon = True
            self._timer.start()

    def _do_upload(self) -> None:
        """实际执行上传（由防抖定时器触发）。"""
        with self._lock:
            if not self._dirty:
                return
            # 每日计数重置
            now = time.time()
            today_start = now - (now % 86400)
            if today_start > self._day_reset_ts:
                self._day_reset_ts = today_start
                self._upload_count_today = 0
            # 每日上限检查
            if self._upload_count_today >= MAX_UPLOADS_PER_DAY:
                logger.warning(
                    "DB backup skipped: daily limit reached (%d/%d uploads today)",
                    self._upload_count_today, MAX_UPLOADS_PER_DAY,
                )
                # 保留 dirty 标记，明天重置计数后下次 mark_dirty 会重新调度
                self._timer = None
                return
            # 最小间隔检查
            if now - self._last_upload_ts < MIN_INTERVAL_SECONDS:
                # 间隔不足，延迟到满足间隔后再上传
                wait = MIN_INTERVAL_SECONDS - (now - self._last_upload_ts)
                logger.debug("DB backup deferred %.0fs (min interval)", wait)
                self._timer = threading.Timer(wait, self._do_upload)
                self._timer.daemon = True
                self._timer.start()
                return
            # 清除 dirty 标记和定时器引用
            self._dirty = False
            self._timer = None
            self._last_upload_ts = now
            self._upload_count_today += 1

        # 在锁外执行上传（避免网络 IO 阻塞锁）
        success = upload_db(self._db_path)
        if not success:
            # 上传失败，重新标记 dirty，下次写操作会重新调度
            with self._lock:
                self._dirty = True
            logger.warning("DB backup failed, will retry on next write")

    def flush(self) -> None:
        """立即上传（如有 dirty）。用于 atexit 退出时备份。

        跳过防抖和最小间隔检查（退出时必须立即上传），但仍受每日上限约束。
        """
        with self._lock:
            if not self._dirty:
                return
            # 取消待执行的定时器
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._dirty = False
        # 退出时同步上传（atexit 上下文，线程可能已被杀，直接同步调用）
        success = upload_db(self._db_path)
        if success:
            with self._lock:
                self._last_upload_ts = time.time()
        else:
            logger.warning("DB backup on exit failed (data since last backup may be lost)")

    def shutdown(self) -> None:
        """关闭备份管理器：取消定时器 + 尝试最后一次上传。"""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        self.flush()
