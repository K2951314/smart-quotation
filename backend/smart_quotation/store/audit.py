"""审计日志：记录和查询操作事件。"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from typing import Any

from .base import DEFAULT_COMPANY_ID


class AuditMixin:
    """审计事件记录（所有数据变更操作自动留痕）。"""

    def audit(
        self,
        conn: sqlite3.Connection,
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

    def list_audit(self, limit: int = 50, company_id: str = DEFAULT_COMPANY_ID) -> list[dict[str, Any]]:
        """查询审计日志（按 ID 降序，最多 limit 条）。"""
        with closing(self.connect()) as conn:
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
