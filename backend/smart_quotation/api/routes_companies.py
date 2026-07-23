"""Admin 公司管理路由：CRUD + 令牌轮换。"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api
from .models import CompanyCreate, CompanyUpdate


def register(app) -> None:
    """注册公司管理端点（需 admin 认证）。

    安全说明：
    - 所有端点需要 Admin API Key（Bearer token），这是最高权限。
    - list/get 返回完整 access_token，因为 admin 前端需要它构建客户访问链接。
    - 前端（admin/lib/companies.js）已自行做显示脱敏（只显示前 8 字符 + "..."）。
    - 真正的防护是 Admin API Key 的强校验 + CSP（script-src 'self'）防 XSS。
    """
    store = app.state.store

    @app.get("/api/companies", dependencies=[Depends(require_admin_api)])
    def list_companies_admin() -> list[dict[str, Any]]:
        return store.list_companies()

    @app.get("/api/companies/{company_id}", dependencies=[Depends(require_admin_api)])
    def get_company_admin(company_id: str) -> dict[str, Any]:
        try:
            return store.get_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies", dependencies=[Depends(require_admin_api)])
    def create_company_admin(payload: CompanyCreate) -> dict[str, Any]:
        # License 强制检查：公司数量不能超过授权上限
        # default 公司不计入配额（它是系统默认租户）
        from ..license import verify_license
        license_payload = verify_license()
        if license_payload is not None:
            max_companies = int(license_payload.get("max_companies", 1))
            current_companies = [c for c in store.list_companies() if c["id"] != DEFAULT_COMPANY_ID]
            if len(current_companies) >= max_companies:
                raise HTTPException(
                    status_code=402,
                    detail=f"已达到 license 授权上限（{max_companies} 家公司）。"
                    f"当前已有 {len(current_companies)} 家，请联系供应商升级 license。",
                )
        try:
            return store.create_company(payload.id, payload.name, payload.meta)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.patch("/api/companies/{company_id}", dependencies=[Depends(require_admin_api)])
    def update_company_admin(company_id: str, payload: CompanyUpdate) -> dict[str, Any]:
        try:
            return store.update_company(company_id, payload.name, payload.meta)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/companies/{company_id}", dependencies=[Depends(require_admin_api)])
    def delete_company_admin(company_id: str) -> dict[str, Any]:
        try:
            return store.delete_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/regenerate-token", dependencies=[Depends(require_admin_api)])
    def regenerate_company_token(company_id: str) -> dict[str, Any]:
        """重新生成公司访问令牌（旧令牌立即失效）。"""
        try:
            company = store.regenerate_company_token(company_id)
            return {
                "id": company["id"],
                "name": company["name"],
                "access_token": (company.get("meta") or {}).get("access_token", ""),
                "message": "令牌已重新生成，旧令牌已失效。请将新令牌安全地分享给客户。",
            }
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
