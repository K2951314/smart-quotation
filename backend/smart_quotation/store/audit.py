"""审计日志：记录和查询操作事件。"""

from __future__ import annotations

import json
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID


class AuditMixin:
    """审计事件记录（所有数据变更操作自动留痕）。"""

    def audit(
        self,
        conn,
        actor_id: str | None,
        action: str,
        target_type: str,
        target_id: str | None,
        payload: dict[str, Any],
        company_id: str = DEFAULT_COMPANY_ID,
        ip_address: str | None = None,
    ) -> None:
        """记录一条审计事件（在同一事务的 conn 上执行）。"""
        audit_payload = dict(payload) if isinstance(payload, dict) else {"data": payload}
        if ip_address:
            audit_payload["_ip"] = ip_address
        conn.execute(
            """
            insert into audit_events(company_id, actor_id, action, target_type, target_id, payload_json, created_at)
            values(?, ?, ?, ?, ?, ?, ?)
            """,
            (company_id, actor_id, action, target_type, target_id, json.dumps(audit_payload, ensure_ascii=False), self.now()),
        )

    def list_audit(
        self, limit: int = 50, company_id: str = DEFAULT_COMPANY_ID, days: int | None = None
    ) -> list[dict[str, Any]]:
        """查询审计日志（按 ID 降序，最多 limit 条）。

        days 参数：只返回最近 N 天的日志（None 表示不过滤）。

        成员公司的审计事件写入时已归一为数据归属公司（parent），
        查询时同样归一，否则成员公司查不到自己的操作记录。
        """
        company_id = self.resolve_data_company_id(company_id)
        with closing(self.connect()) as conn:
            if days is not None and days > 0:
                # 在 Python 侧计算截止时间（ISO UTC，与 self.now() 格式一致），
                # 跨 SQLite/PostgreSQL 一致。旧实现用 SQLite 专有 datetime('now', ?)，
                # PG 无此函数会抛错导致 500。
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                rows = conn.execute(
                    """
                    select id, company_id, actor_id, action, target_type, target_id, payload_json, created_at
                    from audit_events
                    where company_id = ? and created_at >= ?
                    order by id desc
                    limit ?
                    """,
                    (company_id, cutoff, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    select id, company_id, actor_id, action, target_type, target_id, payload_json, created_at
                    from audit_events
                    where company_id = ?
                    order by id desc
                    limit ?
                    """,
                    (company_id, limit),
                ).fetchall()
        return [dict(row) for row in rows]
