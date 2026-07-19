"""Admin 配置管理路由：保存/发布/回滚/导入导出/校验。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse

from ..observability import capture_event
from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api
from .models import ConfigImport, ConfigSave


def register(app) -> None:
    """注册配置管理端点（需 admin 认证）。"""
    store = app.state.store
    engine = app.state.engine

    @app.get("/api/configs", dependencies=[Depends(require_admin_api)])
    def list_configs(company_id: str = Query(DEFAULT_COMPANY_ID)) -> list[dict[str, Any]]:
        return store.list_configs(company_id=company_id)

    @app.get("/api/config", dependencies=[Depends(require_admin_api)])
    def get_active_config(company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            return store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config", dependencies=[Depends(require_admin_api)])
    def save_config(payload: ConfigSave, company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            return store.save_config(payload.config, status=payload.status, company_id=company_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/config/{revision}/publish", dependencies=[Depends(require_admin_api)])
    def rollback_config(revision: str, company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            result = store.rollback_config(revision, company_id=company_id)
            capture_event("config.published", company_id=company_id, revision=revision)
            return result
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/config/{revision}", dependencies=[Depends(require_admin_api)])
    def delete_config(revision: str, company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, str]:
        try:
            store.delete_config(revision, company_id=company_id)
            return {"revision": revision, "status": "deleted"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/config/validate", dependencies=[Depends(require_admin_api)])
    def validate_config(company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        errors = engine.validate_config(config)
        return {"valid": len(errors) == 0, "errors": errors}

    @app.get("/api/config/{revision}/export", response_class=PlainTextResponse, dependencies=[Depends(require_admin_api)])
    def export_config(revision: str, fmt: Literal["json", "yaml"] = "json", company_id: str = Query(DEFAULT_COMPANY_ID)) -> str:
        try:
            return store.export_config(revision, fmt, company_id=company_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config/import", dependencies=[Depends(require_admin_api)])
    def import_config(payload: ConfigImport, company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            return store.import_config(payload.content, fmt=payload.fmt, status=payload.status, company_id=company_id)
        except (ValueError, SyntaxError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/config/example", dependencies=[Depends(require_admin_api)])
    def read_example_config() -> dict[str, Any]:
        repo_root = Path(__file__).resolve().parents[3]
        config_path = repo_root / "config.example.json"
        if not config_path.exists():
            raise HTTPException(status_code=404, detail="config.example.json not found")
        try:
            with config_path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"config.example.json is invalid JSON: {exc}") from exc

    @app.get("/api/audit", dependencies=[Depends(require_admin_api)])
    def list_audit(limit: int = Query(50, ge=1, le=200), company_id: str = Query(DEFAULT_COMPANY_ID)) -> list[dict[str, Any]]:
        return store.list_audit(limit, company_id=company_id)
