"""Admin 公司管理路由：CRUD + 令牌轮换。

租户隔离策略：
- list/get/update/regenerate-token：租户只能操作自己的公司，超管可操作任意公司
- create/delete/create-member：超管专属（平台级操作，租户不应能创建或删除公司）
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, require_superadmin
from .models import CompanyCreate, CompanyUpdate


def _ensure_company_access(auth: dict[str, Any], company_id: str) -> None:
    """租户只能访问自己的公司，超管可访问任意公司。"""
    if auth["role"] == "tenant" and auth["company_id"] != company_id:
        raise HTTPException(status_code=403, detail="无权访问此公司")


def register(app) -> None:
    """注册公司管理端点。"""
    store = app.state.store

    @app.get("/api/companies")
    def list_companies_admin(auth: dict[str, Any] = Depends(require_admin_api)) -> list[dict[str, Any]]:
        """列出公司。超管看到全部，租户只看到自己的。"""
        if auth["role"] == "tenant":
            try:
                return [store.get_company(auth["company_id"])]
            except LookupError:
                return []
        return store.list_companies()

    @app.get("/api/companies/{company_id}")
    def get_company_admin(
        company_id: str,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        _ensure_company_access(auth, company_id)
        try:
            return store.get_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies", dependencies=[Depends(require_superadmin)])
    def create_company_admin(payload: CompanyCreate) -> dict[str, Any]:
        """创建公司（超管专属）。

        设计原则（树形公司结构）：
        - 不传 parent_company_id → 创建为「数据源管理员」（自动 is_admin=true），
          拥有独立 config/data/折扣/tiers
        - 传 parent_company_id → 创建为「成员公司」，继承 parent 的配置/数据
        """
        meta = dict(payload.meta or {})
        has_parent = bool(meta.get("parent_company_id"))
        # 无 parent 的公司自动标记为管理员（数据源管理员）
        if not has_parent and not meta.get("is_admin"):
            meta["is_admin"] = True
        # 有 parent 的成员公司不标记 is_admin（防冲突）
        if has_parent:
            meta.pop("is_admin", None)

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
            return store.create_company(payload.id, payload.name, meta)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/companies/{admin_id}/members", dependencies=[Depends(require_superadmin)])
    def create_member_company(admin_id: str, payload: CompanyCreate) -> dict[str, Any]:
        """在管理员公司下创建成员公司（超管专属）。

        自动设置 parent_company_id = admin_id，成员公司继承管理员的配置/数据/折扣/bundle。
        可通过 meta.tier 指定初始 Tier 分组。
        """
        from ..license import has_feature
        if not has_feature("admin_member_inheritance"):
            raise HTTPException(
                status_code=403,
                detail="管理员-成员配置继承是专业版功能，请升级订阅。",
            )
        if admin_id == DEFAULT_COMPANY_ID:
            raise HTTPException(status_code=422, detail="default 公司不能作为管理员添加成员")
        # 验证管理员公司存在
        try:
            admin = store.get_company(admin_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=f"管理员公司 {admin_id} 不存在") from exc
        # 确保管理员标记正确（自动修复老数据）
        admin_meta = dict(admin.get("meta") or {})
        if not admin_meta.get("is_admin"):
            admin_meta["is_admin"] = True
            store.update_company(admin_id, meta=admin_meta)

        meta = dict(payload.meta or {})
        meta["parent_company_id"] = admin_id
        # 成员公司绝不标记 is_admin
        meta.pop("is_admin", None)

        # License 检查
        from ..license import verify_license
        license_payload = verify_license()
        if license_payload is not None:
            max_companies = int(license_payload.get("max_companies", 1))
            current_companies = [c for c in store.list_companies() if c["id"] != DEFAULT_COMPANY_ID]
            if len(current_companies) >= max_companies:
                raise HTTPException(
                    status_code=402,
                    detail=f"已达到 license 授权上限（{max_companies} 家公司）。请联系供应商升级 license。",
                )
        try:
            return store.create_company(payload.id, payload.name, meta)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.patch("/api/companies/{company_id}")
    def update_company_admin(
        company_id: str,
        payload: CompanyUpdate,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        _ensure_company_access(auth, company_id)
        # 租户不能自行修改敏感 meta 字段（防提权）：
        # - is_admin：设为 True 会在 require_company_access 中获得 admin 角色，看到面价/折扣
        # - parent_company_id：设为其他公司会继承该公司的配置/数据/tier 利润率
        # - access_token / token_created_at：篡改令牌破坏认证
        if payload.meta is not None and auth["role"] == "tenant":
            meta = dict(payload.meta)
            for key in ("is_admin", "parent_company_id", "access_token", "token_created_at", "token_expires_days"):
                meta.pop(key, None)
            payload = CompanyUpdate(name=payload.name, meta=meta)
        try:
            return store.update_company(company_id, payload.name, payload.meta)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/companies/{company_id}", dependencies=[Depends(require_superadmin)])
    def delete_company_admin(company_id: str) -> dict[str, Any]:
        try:
            return store.delete_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/regenerate-token")
    def regenerate_company_token(
        company_id: str,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        """重新生成公司访问令牌（旧令牌立即失效）。租户只能轮换自己的令牌。"""
        _ensure_company_access(auth, company_id)
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
