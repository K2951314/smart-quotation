"""Admin 公司管理路由：CRUD + 令牌轮换。

租户隔离策略：
- list/get/update/regenerate-token：租户只能操作自己的公司，超管可操作任意公司
- create-member：租户可在自己的管理员公司下创建成员（parent 强制为自己），
  超管可在任意公司下创建
- create/delete：超管专属（平台级操作，租户不应能创建或删除顶级公司）
"""

from __future__ import annotations

from contextlib import closing
from typing import Any

from fastapi import Depends, HTTPException, Query

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, require_superadmin
from .models import CompanyCreate, CompanyUpdate


def _ensure_company_access(auth: dict[str, Any], company_id: str, store: Any) -> None:
    """租户只能访问自己名下的公司（主公司 + 拥有的公司 + 其成员），超管任意。"""
    if auth["role"] != "tenant":
        return
    if auth["company_id"] == company_id:
        return
    visible = {
        c["id"] for c in store.list_companies_for_tenant(auth["user_id"], auth["company_id"])
    }
    if company_id in visible:
        return
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
        """列出公司。超管看到全部；租户看到自己名下的（拥有的管理员公司
        + 这些公司下的成员公司）——账号配额 max_companies 允许租户拥有多家。

        每家带 resolved_plan（生效档位：显式覆盖 > owner 账号档位 > free），
        前端展示「生效档位」用它，而非 meta.plan 快照。"""
        if auth["role"] == "tenant":
            companies = store.list_companies_for_tenant(auth["user_id"], auth["company_id"])
        else:
            companies = store.list_companies()
        for c in companies:
            c["resolved_plan"] = store.resolve_subscription_plan(c["id"])
        # 附归属账号邮箱（超管视图按 owner 分组折叠展示）
        with closing(store.connect()) as conn:
            email_by_uid = {
                r["id"]: r["email"]
                for r in conn.execute("select id, email from users").fetchall()
            }
        for c in companies:
            c["owner_email"] = email_by_uid.get((c.get("meta") or {}).get("owner_user_id"))
        return companies

    @app.get("/api/companies/{company_id}")
    def get_company_admin(
        company_id: str,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        _ensure_company_access(auth, company_id, store)
        try:
            return store.get_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies")
    def create_company_admin(
        payload: CompanyCreate,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        """创建数据源管理员公司。

        两条路径：
        - 超管：平台级操作（替客户建公司），受部署 license 总量约束
        - 租户（JWT）：自助开通——受账号配额 max_companies 约束（营销口径
          的「N 家公司」= N 个数据源管理员；免费/个人 1 家、专业 5 家），
          新公司继承 owner 账号档位（不冻结 plan 快照，账号升级自动跟随）
        """
        meta = dict(payload.meta or {})
        if auth["role"] == "tenant":
            from ..license import get_plan_quota
            plan = store.resolve_user_plan(auth["user_id"], auth["company_id"])
            max_c = int(get_plan_quota(plan, "max_companies", 1))
            owned = store.count_companies_owned_by(auth["user_id"], auth["company_id"])
            if max_c >= 0 and owned >= max_c:
                raise HTTPException(
                    status_code=402,
                    detail=f"已达到当前档位上限（{max_c} 家数据源管理员公司），请升级订阅。",
                )
            meta["owner_user_id"] = auth["user_id"]
            meta["created_by"] = "tenant"
            meta.pop("parent_company_id", None)  # 租户自建的必为顶级管理员公司
        elif isinstance(meta.get("plan"), str) and meta["plan"]:
            # 超管建公司时显式指定 plan：打标，防解冻迁移误清
            meta["plan_source"] = "superadmin"

        # 树形结构原则：
        # - 不传 parent_company_id → 数据源管理员（自动 is_admin=true）
        # - 传 parent_company_id → 成员公司（超管路径，继承 parent 配置/数据）
        has_parent = bool(meta.get("parent_company_id"))
        if not has_parent and not meta.get("is_admin"):
            meta["is_admin"] = True
        if has_parent:
            meta.pop("is_admin", None)

        # 订阅档位上限校验：分配的 plan 不得超过部署 license 档位
        # （超管/开发模式豁免；租户自建不写 plan，回退 owner 账号档位）
        _validate_plan_within_license(meta, auth=auth)

        # 部署 license 强制检查（供应商总量授权）：公司数量不能超过授权上限
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

    @app.post("/api/companies/{admin_id}/members")
    def create_member_company(
        admin_id: str,
        payload: CompanyCreate,
        auth: dict[str, Any] = Depends(require_admin_api),
    ) -> dict[str, Any]:
        """在管理员公司下创建成员公司。

        权限：超管/开发模式可在任意公司下创建；租户只能在自己的公司下创建
        （parent 强制为 admin_id，不能挂到其他公司——防跨租户数据继承）。

        成员公司继承管理员的配置/数据/折扣/bundle。
        可通过 meta.tier 指定初始 Tier 分组；admin_member_inheritance 是
        专业版功能（免费/个人版租户得到 403 升级提示，而非权限拒绝）。
        """
        _ensure_company_access(auth, admin_id, store)
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
        # （超管/开发模式豁免；租户受限——防 JWT 用户借成员公司绕过部署授权）
        _validate_plan_within_license(meta, auth=auth)

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
        _ensure_company_access(auth, company_id, store)
        # 租户不能自行修改敏感 meta 字段（防提权）：
        # - parent_company_id：设为其他公司会继承该公司的配置/数据/tier 利润率
        # - plan：订阅档位只能由管理员/超管分配，租户不能自我升级
        # - tier / profit_margin：利润率分组/加价率是超管专属（assign_tier），租户不能自改
        # - access_token / token_created_at：篡改令牌破坏认证
        # 例外：is_admin=True 允许租户在自己的公司上自助升级为数据源管理员
        # （只影响自己名下的数据可见性，不越权到其他租户）——升级时 plan
        # 强制 fail-closed：沿用现有 plan，没有则 free。无 plan 的管理员公司
        # 会回退继承部署 license 档位（resolve_subscription_plan），等于免费提权。
        if payload.meta is not None and auth["role"] == "tenant":
            meta = dict(payload.meta)
            self_upgrade = meta.get("is_admin") is True
            for key in ("is_admin", "parent_company_id", "plan", "plan_source", "tier",
                        "profit_margin", "access_token", "token_created_at", "token_expires_days"):
                meta.pop(key, None)
            if self_upgrade:
                existing_meta: dict[str, Any] = {}
                try:
                    existing_meta = store.get_company(company_id).get("meta") or {}
                except LookupError:
                    pass
                meta["is_admin"] = True
                meta["plan"] = existing_meta.get("plan") or "free"
            payload = CompanyUpdate(name=payload.name, meta=meta)
        elif payload.meta is not None and "plan" in (payload.meta or {}):
            # 超管显式分配公司档位：打标（解冻迁移不动 superadmin 来源的快照）
            payload.meta = dict(payload.meta)
            if payload.meta.get("plan"):
                payload.meta["plan_source"] = "superadmin"
            else:
                payload.meta.pop("plan_source", None)
        # 订阅档位上限校验：租户自我提权防护（超管/开发模式豁免）
        _validate_plan_within_license(payload.meta, auth=auth)
        try:
            return store.update_company(company_id, payload.name, payload.meta)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            # 改名机会已用完 / 新名重复 / 名称为空
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.delete("/api/companies/{company_id}")
    def delete_company_admin(
        company_id: str,
        force: bool = Query(False, description="强制删除（公司下仍有注册用户时需确认）"),
    ) -> dict[str, Any]:
        """删除公司（超管）。

        保护：公司下仍有注册用户时拒绝删除（409）——租户账号无法自行重建
        公司，删光其公司等于废号。需超管 force=true 明确确认（级联停用用户）。
        """
        user_count = store.count_users_in_company(company_id, active_only=False)
        if user_count > 0 and not force:
            raise HTTPException(
                status_code=409,
                detail=f"该公司下还有 {user_count} 个注册用户（他们无法自行重建公司）。"
                "请先在用户管理删除这些用户，或确认后强制删除（用户将被停用）。",
            )
        try:
            return store.delete_company(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/rename-id", dependencies=[Depends(require_superadmin)])
    def rename_company_id(company_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """改公司 ID（超管，每个公司仅限一次）。

        级联更新 users/configs/items/audit 的 company_id 引用，令牌不变。
        body: {"new_id": "..."}
        """
        new_id = str(payload.get("new_id", "")).strip()
        try:
            return store.rename_company_id(company_id, new_id)
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
        _ensure_company_access(auth, company_id, store)
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
