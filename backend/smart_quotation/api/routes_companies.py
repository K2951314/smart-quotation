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


def _validate_plan_within_license(meta: dict[str, Any] | None, auth: dict[str, Any] | None = None) -> None:
    """校验 meta.plan 不超过全局 license 档位（防止绕过部署总授权）。

    - plan 非法 → 422
    - plan 档位 > license 档位 → 402（需先升级部署 license）
    - 未设置 plan → 跳过（继承全局 license tier）

    超管 / 开发模式豁免：部署管理员应能分配任意档位（如给客户演示
    高档位功能），plan 上限检查仅约束租户管理员（防 JWT 用户自我
    提权到超过部署授权的档位）。
    """
    if not meta:
        return
    plan = meta.get("plan")
    if not plan:
        return
    from ..license import TIER_PRESETS, TIER_RANK, get_license_tier
    if plan not in TIER_PRESETS:
        raise HTTPException(status_code=422, detail=f"无效订阅档位: {plan}")
    # 超管和开发模式豁免：部署管理员不受 plan ≤ license tier 约束
    if auth and auth.get("role") in ("superadmin", "dev"):
        return
    license_tier = get_license_tier()
    if TIER_RANK.get(plan, 0) > TIER_RANK.get(license_tier, 0):
        raise HTTPException(
            status_code=402,
            detail=(
                f"无法分配「{plan}」档位：当前部署 license 最高档位为「{license_tier}」。"
                "请先升级部署 license。"
            ),
        )


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

        # 订阅档位上限校验：分配的 plan 不得超过部署 license 档位
        # （超管/开发模式豁免——create_company_admin 已用 require_superadmin 守卫）
        _validate_plan_within_license(meta, auth=None)

        # License 强制检查：公司数量不能超过授权上限
        # default 公司不计入配额（它是系统默认租户）
        # fail-closed：无有效 license 时 get_quota 回退免费档（max_companies=1）
        from ..license import get_quota
        max_companies = int(get_quota("max_companies", 1))
        if max_companies >= 0:
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
        from ..license import plan_has_feature
        if not plan_has_feature(store.resolve_subscription_plan(admin_id), "admin_member_inheritance"):
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

        # 订阅档位上限校验：分配的 plan 不得超过部署 license 档位
        # （超管/开发模式豁免——create_member_company 已用 require_superadmin 守卫）
        _validate_plan_within_license(meta, auth=None)

        # License 检查（fail-closed：无有效 license 回退免费档 max_companies=1）
        from ..license import get_quota
        max_companies = int(get_quota("max_companies", 1))
        if max_companies >= 0:
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
        # - plan：订阅档位只能由管理员/超管分配，租户不能自我升级
        # - tier / profit_margin：利润率分组/加价率是超管专属（assign_tier），租户不能自改
        # - access_token / token_created_at：篡改令牌破坏认证
        if payload.meta is not None and auth["role"] == "tenant":
            meta = dict(payload.meta)
            for key in ("is_admin", "parent_company_id", "plan", "tier", "profit_margin",
                        "access_token", "token_created_at", "token_expires_days"):
                meta.pop(key, None)
            payload = CompanyUpdate(name=payload.name, meta=meta)
        # 订阅档位上限校验：租户自我提权防护（超管/开发模式豁免）
        _validate_plan_within_license(payload.meta, auth=auth)
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
