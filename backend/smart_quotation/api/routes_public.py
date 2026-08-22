"""公开端点：健康检查、数据源设置、config/version/bundle 代理、公司 profile。"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, require_company_access, require_superadmin


def register(app) -> None:
    """注册公开端点到 FastAPI app。"""
    store = app.state.store

    def _resolve_supabase_url(company_id: str) -> str:
        """获取有效 Supabase Storage 地址。

        优先级（当前选中公司的数据源地址最高）：
        1. 公司级 meta.supabase_base_url（当前选中公司，多租户独立 bucket）
        2. 环境变量 SQ_SUPABASE_BASE_URL（全局兜底）
        """
        try:
            company = store.get_company(company_id)
            company_url = ((company.get("meta") or {}).get("supabase_base_url") or "").strip()
            if company_url:
                return company_url
        except Exception:
            pass
        return os.environ.get("SQ_SUPABASE_BASE_URL", "").strip()

    def _inject_supabase_url(config: dict, company_id: str) -> None:
        """向 config.data_source 注入 Supabase 地址（当前公司 meta 优先，环境变量兜底）。

        统一走 _resolve_supabase_url 解析，确保恢复配置、代理 config.json、
        admin 上传 bundle 三条链路优先级一致。
        """
        effective = _resolve_supabase_url(company_id)
        if effective:
            ds = config.setdefault("data_source", {})
            ds["base_url"] = effective

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/health/backup")
    def health_backup() -> dict[str, Any]:
        """返回数据库备份状态（configured / 上次上传时间 / 最近错误）。

        无需认证：只暴露运维状态（是否配置、是否失败），不泄露密钥/数据。
        用于消除「备份静默降级」——管理员可主动查询备份是否真的在跑。
        """
        backup_mgr = getattr(app.state, "backup_manager", None)
        if backup_mgr is None:
            return {"available": False, "configured": False}
        status = backup_mgr.get_status()
        status["available"] = True
        return status

    @app.get("/api/settings/datasource", dependencies=[Depends(require_admin_api)])
    def get_datasource_settings(
        auth: dict[str, Any] = Depends(require_admin_api),
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        """返回有效数据源配置（供 admin 上传 bundle 时获取 Supabase Base URL）。

        优先级（与 _resolve_supabase_url 一致）：
        1. 公司级 meta.supabase_base_url（当前选中公司，最高）
        2. 环境变量 SQ_SUPABASE_BASE_URL（全局兜底）

        安全策略：仅返回 Supabase public storage URL（非敏感），不返回 anon_key。
        不返回 is_dev 标志（避免泄露运行模式）。
        """
        # 超管可查任意公司，租户只能查自己的
        effective_company_id = company_id if auth.get("role") == "superadmin" else auth.get("company_id", company_id)
        return {
            "supabase_base_url": _resolve_supabase_url(effective_company_id or DEFAULT_COMPANY_ID),
        }

    @app.get("/", include_in_schema=False)
    def root_redirect():
        return RedirectResponse(url="/admin/", status_code=302)

    # ─── 静态文件代理：模拟 Supabase Storage ──────────────────────
    @app.get("/config.json", include_in_schema=False)
    def proxy_config_json(
        request: Request,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ):
        """代理到 get_active_config(company_id)。

        Supabase 地址注入优先级（与 _resolve_supabase_url 一致）：
        1. 公司级 meta.supabase_base_url（当前公司，最高）
        2. 环境变量 SQ_SUPABASE_BASE_URL（兜底）
        """
        role, effective_company_id = require_company_access(request, company_id=company_id)
        effective_supabase_url = _resolve_supabase_url(effective_company_id)
        try:
            config = store.get_active_config(company_id=effective_company_id)
            if role == "company":
                config = store.desensitize_config(config)
            _inject_supabase_url(config, effective_company_id)
            return config
        except LookupError:
            if effective_supabase_url:
                return {
                    "_bootstrap": True,
                    "data_source": {
                        "base_url": effective_supabase_url,
                        "config_file": "config.json",
                        "version_file": "version.json",
                        "price_bundle_file": "price.bundle.json",
                        "stock_bundle_file": "stock.bundle.json",
                        "cache_name": "quotation-cache-v4",
                    },
                }
            return JSONResponse(
                status_code=404,
                content={"error": "no published config", "hint": "请先在 /admin/ 中发布配置或在 .env 中设置 SQ_SUPABASE_BASE_URL"},
            )

    @app.get("/version.json", include_in_schema=False)
    def proxy_version_json(
        request: Request,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ):
        """返回数据版本号（data_revision），用于前端 bundle 缓存失效。"""
        _, effective_company_id = require_company_access(request, company_id=company_id)
        try:
            stats = store.get_items_stats(company_id=effective_company_id)
            data_revision = stats.get("data_revision") or ""
            return {"version": data_revision, "updated_at": datetime.now(timezone.utc).isoformat()}
        except Exception:
            return {"version": "", "updated_at": datetime.now(timezone.utc).isoformat()}

    @app.get("/price.bundle.json", include_in_schema=False)
    def proxy_price_bundle(
        request: Request,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ):
        """生成价格 Bundle。company 角色返回脱敏 Bundle。"""
        role, effective_company_id = require_company_access(request, company_id=company_id)
        try:
            return store.build_price_bundle(company_id=effective_company_id, role=role)
        except LookupError:
            return JSONResponse(
                status_code=404,
                content={"error": "no published config", "hint": "请先在 /admin/ 中发布配置"},
            )

    @app.get("/stock.bundle.json", include_in_schema=False)
    def proxy_stock_bundle(
        request: Request,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ):
        """生成库存 Bundle。"""
        _, effective_company_id = require_company_access(request, company_id=company_id)
        try:
            return store.build_stock_bundle(company_id=effective_company_id)
        except LookupError:
            return JSONResponse(
                status_code=404,
                content={"error": "no published config", "hint": "请先在 /admin/ 中发布配置"},
            )

    @app.get("/api/license/info", dependencies=[Depends(require_superadmin)])
    def license_info(request: Request) -> dict[str, Any]:
        """返回当前 license 状态（需 admin 认证）。

        安全策略：license 详情（customer、过期时间、功能列表、max_companies）
        属于商业机密，不对外公开。仅 admin 可查。
        """
        from ..license import get_license_info
        return get_license_info()

    @app.get("/api/config/active")
    def get_active_config_public(
        request: Request,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        """获取指定公司的已发布配置。company 角色返回脱敏配置。

        与 /config.json 代理一致：注入 Supabase 地址到 data_source.base_url，
        让前端直接从 Supabase 拉取 bundle（不走后端代理）。

        新公司无配置时返回 _bootstrap（含 Supabase 地址），让前端从 Supabase
        加载已有配置（即其他公司已发布的 config.json），而非 404 报错。
        """
        role, effective_company_id = require_company_access(request, company_id=company_id)
        try:
            config = store.get_active_config(company_id=effective_company_id)
        except LookupError:
            # 新公司无配置：返回 _bootstrap，让前端从 Supabase 加载已有配置
            effective_supabase_url = _resolve_supabase_url(effective_company_id)
            if effective_supabase_url:
                return {
                    "_bootstrap": True,
                    "data_source": {
                        "base_url": effective_supabase_url,
                        "config_file": "config.json",
                        "version_file": "version.json",
                        "price_bundle_file": "price.bundle.json",
                        "stock_bundle_file": "stock.bundle.json",
                        "cache_name": "quotation-cache-v4",
                    },
                }
            raise HTTPException(status_code=404, detail=f"no published config for company {effective_company_id}") from None
        if role == "company":
            config = store.desensitize_config(config)
        _inject_supabase_url(config, effective_company_id)
        return config

    @app.get("/api/public/company/{company_id}")
    def get_public_company(
        company_id: str,
        request: Request,
    ) -> dict[str, Any]:
        """获取公司 profile（name + role + profit_margin），用于客户前端 authGate。

        角色判定：
          - meta.is_admin=true → role="admin"（前端显示完整数据：面价、折扣、配置入口）
          - 其他 → role="company"（前端脱敏：无面价、无折扣规则）

        利润率解析链：tier → meta.profit_margin → 默认 10。
        成员公司（有 parent_company_id）的 tier 从 parent 的 tiers 列表查找。

        管理员公司通过 meta.is_admin 标记，避免在前端硬编码 company_id 判断。
        """
        _, effective_company_id = require_company_access(request, company_id=company_id)
        try:
            # resolve_company_profile 内部已兜底 default 公司（含 plan/watermark 字段），
            # 此处只需处理「公司不存在」的 404
            return store.resolve_company_profile(effective_company_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="company not found") from None
