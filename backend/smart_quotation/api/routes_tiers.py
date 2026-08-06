"""Tier（利润率分组）管理路由：查询/更新 Tier + 公司分配。

租户隔离：
- get_tiers / update_tiers 使用 Depends(resolve_company_id)
- assign_tier 需要超管权限（修改公司结构是平台级操作）
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, require_superadmin, resolve_company_id


class TierItem(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    profit_margin: float = Field(ge=0, le=100)
    color: str = ""


class TiersUpdate(BaseModel):
    tiers: list[TierItem]


class TierAssign(BaseModel):
    tier: str | None = None
    parent_company_id: str | None = None


def register(app) -> None:
    """注册 Tier 管理端点。"""
    store = app.state.store

    @app.get("/api/tiers")
    def get_tiers(company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        """获取作用于该公司的 Tier 列表。

        成员公司自动从 parent 的 meta.tiers 读取。
        返回的 parent_company_id 是数据归属公司（即 tiers 的来源）。
        """
        tiers = store.get_tiers(company_id)
        data_company_id = store.resolve_data_company_id(company_id)
        return {
            "company_id": company_id,
            "parent_company_id": data_company_id if data_company_id != company_id else None,
            "tiers": tiers,
        }

    @app.put("/api/tiers")
    def update_tiers(
        payload: TiersUpdate,
        company_id: str = Depends(resolve_company_id),
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        """替换数据归属公司的 Tier 列表（写入 meta.tiers）。

        成员公司不能修改 parent 的 Tier（利润率是管理员公司独有）。
        只有 admin 公司自己（company_id == data_company_id）或超管可以修改。
        """
        data_company_id = store.resolve_data_company_id(company_id)
        if auth["role"] == "tenant" and company_id != data_company_id:
            raise HTTPException(status_code=403, detail="成员公司不能修改管理员的 Tier 配置")
        try:
            company = store.get_company(data_company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        meta = dict(company.get("meta") or {})
        meta["tiers"] = [t.model_dump() for t in payload.tiers]
        updated = store.update_company(data_company_id, meta=meta)
        return {
            "company_id": data_company_id,
            "tiers": (updated.get("meta") or {}).get("tiers", []),
        }

    @app.post("/api/companies/{company_id}/assign-tier", dependencies=[Depends(require_superadmin)])
    def assign_tier(company_id: str, payload: TierAssign) -> dict[str, Any]:
        """将公司分配到指定 Tier（超管操作）。

        - payload.tier 为 null → 移除 tier 分配（公司回退到 meta.profit_margin）
        - payload.parent_company_id 可同时设置/变更 parent（设为空串或 null 清除）
        - parent_company_id 不能等于自身（防环）
        """
        if company_id == DEFAULT_COMPANY_ID:
            raise HTTPException(status_code=422, detail="default 公司不支持 tier 分配")
        try:
            company = store.get_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        meta = dict(company.get("meta") or {})

        if payload.tier is None:
            meta.pop("tier", None)
        else:
            meta["tier"] = payload.tier

        if payload.parent_company_id is not None:
            parent_id = payload.parent_company_id.strip()
            if parent_id and parent_id == company_id:
                raise HTTPException(status_code=422, detail="parent_company_id 不能等于自身")
            if parent_id:
                try:
                    store.get_company(parent_id)
                except LookupError as exc:
                    raise HTTPException(status_code=422, detail=f"parent 公司 {parent_id} 不存在") from exc
                meta["parent_company_id"] = parent_id
            else:
                meta.pop("parent_company_id", None)

        updated = store.update_company(company_id, meta=meta)
        return {
            "company_id": company_id,
            "tier": (updated.get("meta") or {}).get("tier"),
            "parent_company_id": (updated.get("meta") or {}).get("parent_company_id"),
            "profit_margin": store.resolve_profit_margin(company_id),
        }
