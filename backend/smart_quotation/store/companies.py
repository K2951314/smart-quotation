"""公司 CRUD + 访问令牌管理 + 配置继承/Tier 解析。"""

from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID


# 默认利润率（未配置 tier 且无 meta.profit_margin 时使用）
DEFAULT_PROFIT_MARGIN = 10.0


class CompaniesMixin:
    """公司管理：CRUD、令牌生成/验证/轮换、配置继承、Tier 利润率解析。"""

    # 令牌默认有效期：90 天。可通过 company meta.token_expires_days 覆盖。
    DEFAULT_TOKEN_EXPIRES_DAYS = 90

    # ─── 配置继承 + Tier 解析 ──────────────────────────────

    def resolve_data_company_id(self, company_id: str) -> str:
        """解析数据归属公司 ID。

        成员公司（meta.parent_company_id 已设置）的配置/商品数据/bundle
        全部从 parent 读取；独立公司（无 parent_company_id）行为不变。

        防环：若 parent 等于自身或 parent 链超过 3 层，停止回退。
        """
        current = company_id
        for _ in range(3):  # 最多 3 层，防环
            try:
                company = self.get_company(current)
            except LookupError:
                return current
            parent_id = (company.get("meta") or {}).get("parent_company_id")
            if not parent_id or parent_id == current:
                return current
            current = parent_id
        return current

    def resolve_profit_margin(self, company_id: str) -> float:
        """解析公司利润率（优先级：tier → meta.profit_margin → 默认 10）。

        1. 若公司 meta.tier 已设置，到 parent（或自身）的 meta.tiers 查找
        2. tier 未匹配或未设置 → fallback 到 meta.profit_margin
        3. 都未设置 → 默认 10
        """
        try:
            company = self.get_company(company_id)
        except LookupError:
            if company_id == DEFAULT_COMPANY_ID:
                return DEFAULT_PROFIT_MARGIN
            return DEFAULT_PROFIT_MARGIN
        meta = company.get("meta") or {}

        # 1. tier 解析
        tier_name = meta.get("tier")
        if tier_name:
            tiers = self.get_tiers(company_id)
            for tier in tiers:
                if tier.get("name") == tier_name:
                    try:
                        return float(tier.get("profit_margin", DEFAULT_PROFIT_MARGIN))
                    except (TypeError, ValueError):
                        return DEFAULT_PROFIT_MARGIN

        # 2. fallback meta.profit_margin
        pm = meta.get("profit_margin")
        if pm is not None:
            try:
                return float(pm)
            except (TypeError, ValueError):
                pass

        # 3. 默认值
        return DEFAULT_PROFIT_MARGIN

    def get_tiers(self, company_id: str) -> list[dict[str, Any]]:
        """获取作用于该公司的 Tier 列表。

        - 成员公司：从 parent 的 meta.tiers 读取
        - 管理员/独立公司：从自身 meta.tiers 读取
        """
        data_company_id = self.resolve_data_company_id(company_id)
        try:
            company = self.get_company(data_company_id)
        except LookupError:
            return []
        return (company.get("meta") or {}).get("tiers") or []

    def resolve_company_profile(self, company_id: str) -> dict[str, Any]:
        """解析公司完整 profile（含 tier 解析后的 profit_margin + parent 信息）。

        供 /api/public/company/{id} 使用。
        """
        try:
            company = self.get_company(company_id)
        except LookupError:
            if company_id == DEFAULT_COMPANY_ID:
                return {
                    "id": "default",
                    "name": "默认",
                    "role": "company",
                    "profit_margin": DEFAULT_PROFIT_MARGIN,
                    "tier": None,
                    "parent_company_id": None,
                }
            raise
        meta = company.get("meta") or {}
        role = "admin" if meta.get("is_admin") else "company"
        profit_margin = self.resolve_profit_margin(company_id)
        return {
            "id": company["id"],
            "name": company["name"],
            "role": role,
            "profit_margin": profit_margin,
            "tier": meta.get("tier"),
            "parent_company_id": meta.get("parent_company_id"),
        }

    def list_companies(self) -> list[dict[str, Any]]:
        """列出所有公司（按创建时间降序），确保 default 始终在列表中。"""
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "select id, name, created_at, meta_json from companies order by created_at desc"
            ).fetchall()
        out = []
        has_default = False
        for row in rows:
            item = {"id": row["id"], "name": row["name"], "created_at": row["created_at"]}
            try:
                item["meta"] = json.loads(row["meta_json"] or "{}")
            except json.JSONDecodeError:
                item["meta"] = {}
            out.append(item)
            if row["id"] == "default":
                has_default = True
        if not has_default:
            out.append({"id": "default", "name": "默认", "created_at": "", "meta": {}})
        return out

    def get_company(self, company_id: str) -> dict[str, Any]:
        """获取单个公司（含 meta）。不存在时 raise LookupError。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select id, name, created_at, meta_json from companies where id = ?",
                (company_id,),
            ).fetchone()
        if not row:
            raise LookupError(f"company {company_id} not found")
        try:
            meta = json.loads(row["meta_json"] or "{}")
        except json.JSONDecodeError:
            meta = {}
        return {"id": row["id"], "name": row["name"], "created_at": row["created_at"], "meta": meta}

    def create_company(self, company_id: str, name: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """创建公司，自动生成访问令牌。"""
        company_id = str(company_id).strip()
        if not company_id:
            raise ValueError("company_id 不能为空")
        meta = dict(meta or {})
        if not meta.get("access_token"):
            meta["access_token"] = self._generate_access_token()
        if not meta.get("token_created_at"):
            meta["token_created_at"] = datetime.now(timezone.utc).isoformat()
        with closing(self.connect()) as conn:
            try:
                conn.execute(
                    "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                    (company_id, str(name).strip(), self.now(), json.dumps(meta, ensure_ascii=False)),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"company {company_id} 已存在") from exc
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return {"id": company_id, "name": name, "meta": meta}

    @staticmethod
    def _generate_access_token() -> str:
        """生成 URL 安全的随机访问令牌（43 字符，256 位熵）。"""
        return secrets.token_urlsafe(32)

    def verify_company_token(self, company_id: str, token: str) -> bool:
        """验证公司访问令牌（compare_digest 防时序攻击 + 过期检查）。"""
        if not token:
            return False
        try:
            company = self.get_company(company_id)
        except LookupError:
            return False
        meta = company.get("meta") or {}
        stored_token = meta.get("access_token", "")
        if not stored_token:
            return False
        if not secrets.compare_digest(token, stored_token):
            return False
        token_created_at = meta.get("token_created_at", "")
        if token_created_at:
            try:
                created = datetime.fromisoformat(token_created_at.replace("Z", "+00:00"))
                expires_days = int(meta.get("token_expires_days", self.DEFAULT_TOKEN_EXPIRES_DAYS))
                age = datetime.now(timezone.utc) - created
                if age.days > expires_days:
                    return False
            except (ValueError, TypeError):
                pass
        return True

    def find_company_by_token(self, token: str) -> str | None:
        """用 token 反查公司 ID（遍历所有公司，compare_digest 匹配）。

        用于前端请求 bundle/version.json 时漏传 company_id 的兜底场景：
        后端收到 X-Company-Token 但 company_id=default，用 token 找出真实公司。
        公司数量受 license 限制（通常 ≤5），遍历开销可接受。
        """
        if not token:
            return None
        for company in self.list_companies():
            meta = company.get("meta") or {}
            stored_token = meta.get("access_token", "")
            if stored_token and secrets.compare_digest(token, stored_token):
                # 复用过期检查逻辑
                token_created_at = meta.get("token_created_at", "")
                if token_created_at:
                    try:
                        created = datetime.fromisoformat(token_created_at.replace("Z", "+00:00"))
                        expires_days = int(meta.get("token_expires_days", self.DEFAULT_TOKEN_EXPIRES_DAYS))
                        age = datetime.now(timezone.utc) - created
                        if age.days > expires_days:
                            return None
                    except (ValueError, TypeError):
                        pass
                return company["id"]
        return None

    def regenerate_company_token(self, company_id: str) -> dict[str, Any]:
        """重新生成公司访问令牌（旧令牌立即失效）。"""
        company = self.get_company(company_id)
        meta = dict(company.get("meta") or {})
        meta["access_token"] = self._generate_access_token()
        meta["token_created_at"] = datetime.now(timezone.utc).isoformat()
        return self.update_company(company_id, meta=meta)

    def update_company(self, company_id: str, name: str | None = None, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """更新公司名称和/或 meta。"""
        with closing(self.connect()) as conn:
            if name is not None:
                conn.execute("update companies set name = ? where id = ?", (str(name).strip(), company_id))
            if meta is not None:
                conn.execute(
                    "update companies set meta_json = ? where id = ?",
                    (json.dumps(meta, ensure_ascii=False), company_id),
                )
            if conn.total_changes == 0:
                raise LookupError(f"company {company_id} not found")
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return self.get_company(company_id)

    def delete_company(self, company_id: str) -> dict[str, str]:
        """删除公司 + 级联删除其所有配置/数据/审计。

        安全策略：default 租户不可删除（防止误删导致系统不可用）。
        """
        if company_id == DEFAULT_COMPANY_ID:
            raise ValueError("默认公司不能删除")
        with closing(self.connect()) as conn:
            row = conn.execute("select id from companies where id = ?", (company_id,)).fetchone()
            if not row:
                raise LookupError(f"company {company_id} not found")
            conn.execute("delete from quotation_configs where company_id = ?", (company_id,))
            conn.execute("delete from quotation_items where company_id = ?", (company_id,))
            conn.execute("delete from audit_events where company_id = ?", (company_id,))
            conn.execute("delete from companies where id = ?", (company_id,))
            conn.commit()
        self.cache.invalidate()
        self._mark_db_dirty(immediate=True)
        return {"company_id": company_id, "status": "deleted"}
