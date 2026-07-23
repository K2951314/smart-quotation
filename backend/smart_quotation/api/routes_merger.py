"""Merger / Bundle 端点：品牌检测、Bundle 生成与部署。"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, File, HTTPException, Query, UploadFile

from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api
from .models import BundleDeploy, BundleGenerate
from .supabase import deploy_bundles_to_supabase

# 单文件上传上限：10MB
_MAX_FILE_SIZE = 10 * 1024 * 1024


def register(app) -> None:
    """注册 Merger/Bundle 端点（需 admin 认证）。"""
    store = app.state.store
    is_dev = app.state.is_dev

    @app.post("/api/merger/detect-brands", dependencies=[Depends(require_admin_api)])
    async def detect_brands(
        files: list[UploadFile] = File(...),
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        """上传多个 Excel 文件，按文件名识别品牌，返回检测结果。"""
        file_tuples = []
        for f in files:
            content = await f.read()
            if len(content) > _MAX_FILE_SIZE:
                raise HTTPException(status_code=413, detail=f"文件 {f.filename or ''} 过大（{len(content) // 1024 // 1024}MB），上限 {_MAX_FILE_SIZE // 1024 // 1024}MB")
            file_tuples.append((f.filename or "unknown.xlsx", content))
        results = store.detect_brands(file_tuples, company_id=company_id)
        return {"files": results}

    @app.post("/api/merger/bundle/generate", dependencies=[Depends(require_admin_api)])
    def generate_bundles(
        payload: BundleGenerate,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        """生成价格包 + 库存包，可选部署到 Supabase。

        安全策略：
        - 部署到 Supabase 时，强制使用 role='company' 生成脱敏 Bundle。
        - config.json 上传前也强制脱敏。
        - 预览模式允许 admin 角色。
        """
        effective_role = "company" if payload.deploy else payload.role
        price_bundle = store.build_price_bundle(
            password=payload.password, company_id=company_id, role=effective_role
        )
        stock_bundle = store.build_stock_bundle(company_id=company_id)

        result = {
            "price_bundle": price_bundle,
            "stock_bundle": stock_bundle,
        }

        if payload.deploy:
            if not payload.anon_key:
                raise HTTPException(status_code=422, detail="部署到 Supabase 需要提供 anon_key")
            try:
                config = store.get_active_config(company_id=company_id)
                safe_config = store.desensitize_config(config)
                deploy_results = deploy_bundles_to_supabase(
                    safe_config, price_bundle, stock_bundle, payload.anon_key, is_dev
                )
                result["deploy"] = deploy_results
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc

        return result

    @app.post("/api/merger/bundle/deploy", dependencies=[Depends(require_admin_api)])
    def deploy_bundles(
        payload: BundleDeploy,
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        """将 Bundle 部署到 Supabase Storage。

        安全策略：从数据库重建脱敏 bundle，忽略客户端传入的 price_bundle。
        """
        if not payload.anon_key:
            raise HTTPException(status_code=422, detail="anon_key is required")
        try:
            config = store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        safe_config = store.desensitize_config(config)
        safe_price_bundle = store.build_price_bundle(
            password="", company_id=company_id, role="company"
        )
        safe_stock_bundle = store.build_stock_bundle(company_id=company_id)
        try:
            results = deploy_bundles_to_supabase(
                safe_config, safe_price_bundle, safe_stock_bundle, payload.anon_key, is_dev
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc
        return {"deploy": results}
