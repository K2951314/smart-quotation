"""公开端点：健康检查、数据源设置、config/version/bundle 代理、公司 profile。"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, require_company_access


def register(app) -> None:
    """注册公开端点到 FastAPI app。"""
    store = app.state.store

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/settings/datasource", dependencies=[Depends(require_admin_api)])
    def get_datasource_settings() -> dict[str, Any]:
        """返回全局数据源配置（供 admin 自动填充 Supabase Base URL）。

        安全策略：仅返回 Supabase public storage URL（非敏感），不返回 anon_key。
        不返回 is_dev 标志（避免泄露运行模式，攻击者可据此调整攻击策略）。
        """
        return {
            "supabase_base_url": os.environ.get("SQ_SUPABASE_BASE_URL", "").strip(),
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

        Supabase 地址注入优先级：
        1. 公司级 meta.supabase_base_url
        2. 环境变量 SQ_SUPABASE_BASE_URL
        3. 配置中已有的 data_source.base_url
        """
        role = require_company_access(request, company_id=company_id)
        company_supabase_url = ""
        try:
            company = store.get_company(company_id)
            company_supabase_url = ((company.get("meta") or {}).get("supabase_base_url") or "").strip()
        except Exception:
            pass
        env_supabase_url = os.environ.get("SQ_SUPABASE_BASE_URL", "").strip()
        effective_supabase_url = company_supabase_url or env_supabase_url
        try:
            config = store.get_active_config(company_id=company_id)
            if role == "company":
                config = store.desensitize_config(config)
            if effective_supabase_url:
                ds = config.setdefault("data_source", {})
                if not ds.get("base_url"):
                    ds["base_url"] = effective_supabase_url
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
        require_company_access(request, company_id=company_id)
        try:
            stats = store.get_items_stats(company_id=company_id)
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
        role = require_company_access(request, company_id=company_id)
        try:
            return store.build_price_bundle(company_id=company_id, role=role)
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
        require_company_access(request, company_id=company_id)
        try:
            return store.build_stock_bundle(company_id=company_id)
        except LookupError:
            return JSONResponse(
                status_code=404,
                content={"error": "no published config", "hint": "请先在 /admin/ 中发布配置"},
            )

    @app.get("/api/license/info", dependencies=[Depends(require_admin_api)])
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
        """获取指定公司的已发布配置。company 角色返回脱敏配置。"""
        role = require_company_access(request, company_id=company_id)
        try:
            config = store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if role == "company":
            config = store.desensitize_config(config)
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

        管理员公司通过 meta.is_admin 标记，避免在前端硬编码 company_id 判断。
        """
        require_company_access(request, company_id=company_id)
        try:
            company = store.get_company(company_id)
            meta = company.get("meta") or {}
            role = "admin" if meta.get("is_admin") else "company"
            return {
                "id": company["id"],
                "name": company["name"],
                "role": role,
                "profit_margin": meta.get("profit_margin", 10),
            }
        except LookupError:
            if company_id == "default":
                return {"id": "default", "name": "默认", "role": "company", "profit_margin": 10}
            raise HTTPException(status_code=404, detail="company not found") from None
