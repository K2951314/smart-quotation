"""安全事件（跨 Worker 共享的频率限制 / 暴力破解防护）。"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone


class SecurityMixin:
    """安全事件记录与查询（SQLite 持久化，跨 Worker 共享）。"""

    def record_security_event(self, event_type: str, client_key: str) -> None:
        """记录一次安全事件（如认证失败）。"""
        now_iso = datetime.now(timezone.utc).isoformat()
        with closing(self.connect()) as conn:
            conn.execute(
                "insert into security_events(event_type, client_key, created_at) values(?, ?, ?)",
                (event_type, client_key, now_iso),
            )
            conn.commit()

    def count_security_events(self, event_type: str, client_key: str, window_seconds: int) -> int:
        """统计指定时间窗口内的安全事件数量。"""
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select count(*) as cnt from security_events where event_type = ? and client_key = ? and created_at > ?",
                (event_type, client_key, cutoff),
            ).fetchone()
        return row["cnt"] if row else 0

    def cleanup_security_events(self, max_age_hours: int = 24) -> int:
        """清理过期的安全事件记录。返回删除条数。"""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max_age_hours)).isoformat()
        with closing(self.connect()) as conn:
            cursor = conn.execute("delete from security_events where created_at < ?", (cutoff,))
            conn.commit()
            return cursor.rowcount
