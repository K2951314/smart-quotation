"""配置 CRUD：保存/获取/发布/回滚/导入/导出/脱敏。"""

from __future__ import annotations

import copy
import json
from contextlib import closing
from typing import Any

import yaml

from ..config import normalize_config
from .base import DEFAULT_COMPANY_ID


class ConfigsMixin:
    """报价配置管理：版本化保存、发布、回滚、导入导出、脱敏。"""

    def normalize_config(self, raw_config: dict[str, Any] | None) -> dict[str, Any]:
        return normalize_config(raw_config)

    def save_config(
        self,
        config: dict[str, Any],
        status: str = "draft",
        actor_id: str | None = None,
        company_id: str = DEFAULT_COMPANY_ID,
    ) -> dict[str, Any]:
        """保存配置（草稿或发布）。发布时自动归档同公司旧发布版本。"""
        normalized = normalize_config(config)
        published_at = self.now() if status == "published" else None
        with closing(self.connect()) as conn:
            if status == "published":
                conn.execute(
                    "update quotation_configs set status = 'archived' where status = 'published' and company_id = ?",
                    (company_id,),
                )
            conn.execute(
                """
                insert into quotation_configs(company_id, revision, status, config_json, created_by, published_at, created_at)
                values(?, ?, ?, ?, ?, ?, ?)
                on conflict(company_id, revision) do update set
                    status = excluded.status,
                    config_json = excluded.config_json,
                    created_by = excluded.created_by,
                    published_at = excluded.published_at
                """,
                (
                    company_id,
                    normalized["revision"],
                    status,
                    json.dumps(normalized, ensure_ascii=False),
                    actor_id,
                    published_at,
                    self.now(),
                ),
            )
            self.audit(conn, actor_id, f"config.{status}", "quotation_config", normalized["revision"], normalized, company_id=company_id)
            conn.commit()
        if status == "published":
            self.cache.invalidate()
        self._mark_db_dirty(immediate=True)
        return normalized

    def get_active_config(self, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """获取当前已发布配置（带缓存）。"""
        cache_key = f"active:{company_id}"
        def _loader():
            with closing(self.connect()) as conn:
                row = conn.execute(
                    "select revision from quotation_configs where company_id = ? and status = 'published' order by published_at desc, id desc limit 1",
                    (company_id,),
                ).fetchone()
                if not row:
                    raise LookupError(f"no published config for company {company_id}")
                return self.get_config(row["revision"], company_id=company_id)
        return self.cache.get(cache_key, _loader)

    @staticmethod
    def desensitize_config(config: dict[str, Any]) -> dict[str, Any]:
        """脱敏配置：移除折扣规则和定价公式（company 角色不应看到）。"""
        safe = copy.deepcopy(config)
        safe.pop("rules", None)
        safe.pop("discount_rules", None)
        if "pricing" in safe:
            safe["pricing"] = copy.deepcopy(safe["pricing"])
            safe["pricing"].pop("default_formula", None)
        safe["_desensitized"] = True
        return safe

    def get_config(self, revision: str, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """按版本号获取配置。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select config_json from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            ).fetchone()
        if not row:
            raise LookupError(f"config {revision} not found in company {company_id}")
        return json.loads(row["config_json"])

    def export_config(self, revision: str, fmt: str = "json", company_id: str = DEFAULT_COMPANY_ID) -> str:
        """导出配置为 JSON 或 YAML 字符串。"""
        config = self.get_config(revision, company_id=company_id)
        if fmt == "yaml":
            return yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
        if fmt == "json":
            return json.dumps(config, ensure_ascii=False, indent=2)
        raise ValueError("fmt must be json or yaml")

    def import_config(
        self,
        content: str,
        fmt: str = "json",
        status: str = "draft",
        actor_id: str | None = None,
        company_id: str = DEFAULT_COMPANY_ID,
    ) -> dict[str, Any]:
        """从 JSON/YAML 字符串导入配置。"""
        if fmt == "yaml":
            raw = yaml.safe_load(content) or {}
        elif fmt == "json":
            raw = json.loads(content)
        else:
            raise ValueError("fmt must be json or yaml")
        return self.save_config(raw, status=status, actor_id=actor_id, company_id=company_id)

    def list_configs(self, company_id: str = DEFAULT_COMPANY_ID) -> list[dict[str, Any]]:
        """列出公司的所有配置版本（按 ID 降序）。"""
        with closing(self.connect()) as conn:
            rows = conn.execute(
                """
                select id, company_id, revision, status, created_by, published_at, created_at
                from quotation_configs
                where company_id = ?
                order by id desc
                """,
                (company_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def rollback_config(self, revision: str, actor_id: str | None = None, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """将指定版本重新发布为当前配置。"""
        config = self.get_config(revision, company_id=company_id)
        return self.save_config(config, status="published", actor_id=actor_id, company_id=company_id)

    def delete_config(self, revision: str, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """删除指定版本号的配置记录。"""
        with closing(self.connect()) as conn:
            result = conn.execute(
                "delete from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            )
            if result.rowcount == 0:
                raise LookupError(f"config {revision} not found in company {company_id}")
            self.audit(conn, None, "config.delete", "quotation_configs", revision, {}, company_id=company_id)
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return {"revision": revision, "status": "deleted"}
