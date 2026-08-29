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

    def seed_default_config(self, company_id: str, actor_id: str | None = None) -> None:
        """为新建公司初始化默认配置并发布（开箱即用）。

        与 admin 前端 defaultConfig()（admin-core.js）字段/规则对齐：
        注册用户登录即有完整可编辑的配置，无需从零搭建；
        上传数据的 bundle 生成也依赖已发布配置的字段定义。
        幂等：已有任何配置的公司跳过。
        """
        with closing(self.connect()) as conn:
            existing = conn.execute(
                "select 1 from quotation_configs where company_id = ? limit 1",
                (company_id,),
            ).fetchone()
        if existing:
            return
        from datetime import datetime as _dt, timezone as _tz
        config = {
            "schema_version": 3,
            "revision": _dt.now(_tz.utc).date().isoformat(),
            "data_source": {
                "base_url": "",
                "version_file": "version.json",
                "config_file": "config.json",
                "price_bundle_file": "price.bundle.json",
                "stock_bundle_file": "stock.bundle.json",
                "cache_name": "quotation-cache-v3",
            },
            "pricing": {
                "currency": "CNY",
                "decimal_places": 1,
                "rounding": {"mode": "ceil", "integer_above": 100},
                "default_formula": "face_price * discount_percent / 100",
                "tax_rate": 13,
                "face_price_tax_inclusive": True,
                "discount_step": {"default": 1, "min": 1, "presets": [0.5, 1, 5]},
            },
            "fields": [
                {"key": "code", "label": "代码", "type": "text", "source": "both", "excel_aliases": ["代码", "货号", "物料编码", "编码", "物料长代码"], "searchable": True, "copyable": True, "required": False, "result_area": "identity"},
                {"key": "spec", "label": "型号", "type": "text", "source": "price", "excel_aliases": ["规格型号", "规格", "型号", "产品型号"], "searchable": True, "copyable": True, "required": False, "result_area": "identity"},
                {"key": "face_price", "label": "面价", "type": "number", "source": "price", "excel_aliases": ["销售单价", "面价", "目录价", "含税单价", "单价"], "searchable": False, "copyable": False, "required": False, "result_area": "metric"},
                {"key": "quote_price", "label": "报价", "type": "computed", "source": "computed", "excel_aliases": [], "searchable": False, "copyable": True, "required": False, "result_area": "metric"},
                {"key": "special", "label": "特价", "type": "text", "source": "price", "excel_aliases": ["特价", "活动", "促销"], "searchable": True, "copyable": True, "required": False, "result_area": "chip"},
                {"key": "stock", "label": "库存", "type": "text", "source": "stock", "excel_aliases": ["库存", "库存数量", "可用数量", "数量"], "searchable": False, "copyable": True, "required": False, "result_area": "chip"},
                {"key": "remark", "label": "备注", "type": "text", "source": "price", "excel_aliases": ["补充说明", "备注", "说明"], "searchable": True, "copyable": True, "required": False, "result_area": "detail"},
                {"key": "brand", "label": "品牌", "type": "text", "source": "price", "excel_aliases": ["品牌", "厂家"], "searchable": False, "copyable": False, "required": False, "result_area": "detail"},
                {"key": "name", "label": "名称", "type": "text", "source": "price", "excel_aliases": ["名称", "品名", "类别"], "searchable": False, "copyable": False, "required": False, "result_area": "detail"},
                {"key": "mnemonic", "label": "助记码", "type": "text", "source": "price", "excel_aliases": ["助记码", "简码"], "searchable": False, "copyable": False, "required": False, "result_area": "detail"},
                {"key": "alias", "label": "别名", "type": "text", "source": "price", "excel_aliases": ["别名", "旧型号"], "searchable": False, "copyable": False, "required": False, "result_area": "detail"},
            ],
            "rules": [
                {"id": "default", "label": "默认折扣", "priority": 100, "default": True, "actions": [{"type": "set_discount", "percent": 55}]},
            ],
            "copy": {
                "columns": [
                    {"field": "code", "label": "代码", "line": "main", "default": True, "prefix": ""},
                    {"field": "spec", "label": "型号", "line": "main", "default": True, "prefix": ""},
                    {"field": "quote_price", "label": "报价", "line": "main", "default": True, "prefix": "含税"},
                    {"field": "stock", "label": "库存", "line": "main", "default": False, "prefix": ""},
                ]
            },
        }
        self.save_config(config, status="published", actor_id=actor_id, company_id=company_id)

    def save_config(
        self,
        config: dict[str, Any],
        status: str = "draft",
        actor_id: str | None = None,
        company_id: str = DEFAULT_COMPANY_ID,
    ) -> dict[str, Any]:
        """保存配置（草稿或发布）。发布时自动归档同公司旧发布版本。

        成员公司（有 parent_company_id）的配置实际保存到 parent 名下，
        确保共享数据源的公司共用同一份配置。
        """
        company_id = self.resolve_data_company_id(company_id)
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
        """获取当前已发布配置（带缓存）。

        成员公司自动回退到 parent 的配置（共享数据源场景）。
        """
        company_id = self.resolve_data_company_id(company_id)
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
        """脱敏配置：company 角色不应看到面价/成本相关字段。

        安全设计（防止面价反推）：
        - 公司账户不应看到 face_price（面价/成本价）
        - 公司账户不应看到 discount_rules（知道折扣可反推面价）
        - 公司账户不应看到 rules（可能包含折扣条件）
        - 公司账户不应看到 pricing.default_formula（可能包含面价引用）
        - 报价使用服务端预计算的 quote_price（已包含折扣和利润率）
        """
        safe = copy.deepcopy(config)
        # 移除折扣规则（防止通过 quote_price 反推 face_price）
        safe.pop("discount_rules", None)
        safe.pop("rules", None)
        if "pricing" in safe:
            safe["pricing"] = copy.deepcopy(safe["pricing"])
            safe["pricing"].pop("default_formula", None)
        safe["_desensitized"] = True
        return safe

    def get_config(self, revision: str, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """按版本号获取配置。"""
        company_id = self.resolve_data_company_id(company_id)
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
        company_id = self.resolve_data_company_id(company_id)
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
        company_id = self.resolve_data_company_id(company_id)
        if fmt == "yaml":
            raw = yaml.safe_load(content) or {}
        elif fmt == "json":
            raw = json.loads(content)
        else:
            raise ValueError("fmt must be json or yaml")
        return self.save_config(raw, status=status, actor_id=actor_id, company_id=company_id)

    def list_configs(self, company_id: str = DEFAULT_COMPANY_ID) -> list[dict[str, Any]]:
        """列出公司的所有配置版本（按 ID 降序）。"""
        company_id = self.resolve_data_company_id(company_id)
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
        company_id = self.resolve_data_company_id(company_id)
        config = self.get_config(revision, company_id=company_id)
        return self.save_config(config, status="published", actor_id=actor_id, company_id=company_id)

    def delete_config(self, revision: str, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """删除指定版本号的配置记录。

        安全策略：当前已发布版本（status='published'）不可删除，
        否则客户侧 /config.json 等端点会 404 断供。调用方（如版本裁剪）
        应先跳过 published 版本。
        """
        company_id = self.resolve_data_company_id(company_id)
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select status from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            ).fetchone()
            if not row:
                raise LookupError(f"config {revision} not found in company {company_id}")
            if row["status"] == "published":
                raise ValueError(f"config {revision} 是当前已发布版本，不能删除")
            result = conn.execute(
                "delete from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            )
            self.audit(conn, None, "config.delete", "quotation_configs", revision, {}, company_id=company_id)
            conn.commit()
        self.cache.invalidate()
        self._mark_db_dirty(immediate=True)
        return {"revision": revision, "status": "deleted"}
