"""商品数据 CRUD：替换/删除/搜索/统计。"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from typing import Any

from .base import DEFAULT_COMPANY_ID


class ItemsMixin:
    """商品条目管理：按 data_revision 版本化存储。"""

    def replace_items(self, data_revision: str, rows: list[dict[str, Any]], company_id: str = DEFAULT_COMPANY_ID) -> None:
        """替换指定 data_revision 的所有商品行。"""
        with closing(self.connect()) as conn:
            conn.execute(
                "delete from quotation_items where company_id = ? and data_revision = ?",
                (company_id, data_revision),
            )
            conn.executemany(
                "insert into quotation_items(company_id, data_revision, item_key, fields_json) values(?, ?, ?, ?)",
                [
                    (
                        company_id,
                        data_revision,
                        row["item_key"],
                        json.dumps(row.get("fields") or {}, ensure_ascii=False),
                    )
                    for row in rows
                ],
            )
            self.audit(conn, None, "items.replace", "quotation_items", data_revision, {"count": len(rows)}, company_id=company_id)
            conn.commit()

    def delete_items_revision(self, data_revision: str, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """删除指定 data_revision 的所有商品行（回滚）。"""
        with closing(self.connect()) as conn:
            result = conn.execute(
                "delete from quotation_items where company_id = ? and data_revision = ?",
                (company_id, data_revision),
            )
            count = result.rowcount
            self.audit(conn, None, "items.rollback", "quotation_items", data_revision, {"deleted": count}, company_id=company_id)
            conn.commit()
        return {"data_revision": data_revision, "deleted": count}

    def search_items(self, query: str, searchable_fields: list[str], company_id: str = DEFAULT_COMPANY_ID, limit: int = 500) -> list[dict[str, Any]]:
        """全表扫描搜索（所有 token 必须出现在 searchable_fields 的并集中）。

        结果上限 limit 条（默认 500），防止大数据量时内存爆炸。
        """
        tokens = [token.upper() for token in str(query or "").split() if token.strip()]
        if not tokens:
            return []
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "select item_key, fields_json from quotation_items where company_id = ? order by id",
                (company_id,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            fields = json.loads(row["fields_json"])
            combined = " ".join(str(fields.get(field, "")) for field in searchable_fields).upper()
            if all(token in combined for token in tokens):
                out.append({"item_key": row["item_key"], "fields": fields})
                if len(out) >= limit:
                    break
        return out

    def get_items_stats(self, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """返回最新 data_revision 及其行数。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                select data_revision,
                       count(*) as count,
                       max(id) as last_id
                from quotation_items
                where company_id = ?
                group by data_revision
                order by last_id desc
                limit 1
                """,
                (company_id,),
            ).fetchone()
        if not row:
            return {"data_revision": None, "count": 0}
        return {"data_revision": row["data_revision"], "count": row["count"]}
