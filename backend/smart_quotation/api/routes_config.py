"""Admin 配置管理路由：保存/发布/回滚/导入导出/校验。

租户隔离：所有接受 company_id 的端点使用 Depends(resolve_company_id)，
JWT 用户强制使用 JWT 中的 company_id，超管可指定任意 company_id。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse

from ..license import get_quota
from ..observability import capture_event
from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api, resolve_company_id
from .models import ConfigImport, ConfigSave


def _check_brands_quota(rules: list) -> None:
    """检查报价规则数量是否超出 license 上限。-1 表示不限。

    门控点：POST /api/config 保存时检查 rules 数组长度。
    与 _check_sku_quota 对齐：超限返回 402 Payment Required。
    """
    max_brands = get_quota("max_brands", -1)
    if max_brands >= 0 and len(rules) > max_brands:
        raise HTTPException(
            status_code=402,
            detail=f"报价规则数量（{len(rules)}）超出当前订阅上限（{max_brands}），请升级订阅或删除多余规则。",
        )


def _enforce_revision_limit(store, company_id: str, *, after_save: bool = False) -> None:
    """版本历史上限检查：超出时自动删除最旧版本（-1 表示不限）。

    抽取为公共函数，供 save_config / import_config / rollback_config 共用，
    防止某个端点漏掉检查导致版本无限累积。

    after_save=False（默认，pre-save 用）：确保 len < max_revs，为新版本腾位。
    after_save=True（post-save 用，如 rollback）：裁剪到 max_revs。
    """
    max_revs = get_quota("max_config_revisions", -1)
    if max_revs < 0:
        return
    existing = store.list_configs(company_id=company_id)
    # list_configs 按时间倒序，最旧在末尾
    if after_save:
        # post-save：len > max_revs 时删除（裁剪到 max_revs）
        while len(existing) > max_revs:
            oldest = existing[-1]
            try:
                store.delete_config(oldest["revision"], company_id=company_id)
            except LookupError:
                break
            existing = store.list_configs(company_id=company_id)
    else:
        # pre-save：len >= max_revs 时删除（腾位给新版本）
        while len(existing) >= max_revs:
            oldest = existing[-1]
            try:
                store.delete_config(oldest["revision"], company_id=company_id)
            except LookupError:
                break
            existing = store.list_configs(company_id=company_id)


def register(app) -> None:
    """注册配置管理端点（需 admin 认证）。"""
    store = app.state.store
    engine = app.state.engine

    @app.get("/api/configs")
    def list_configs(company_id: str = Depends(resolve_company_id)) -> list[dict[str, Any]]:
        return store.list_configs(company_id=company_id)

    @app.get("/api/config")
    def get_active_config(company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        try:
            return store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config")
    def save_config(payload: ConfigSave, company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        # 报价规则数量上限检查（-1 表示不限）
        rules = (payload.config or {}).get("rules", [])
        if isinstance(rules, list):
            _check_brands_quota(rules)
        # 版本历史上限检查：超出时自动删除最旧版本
        _enforce_revision_limit(store, company_id)
        try:
            return store.save_config(payload.config, status=payload.status, company_id=company_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/config/{revision}/publish")
    def rollback_config(revision: str, company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        # 安全检查：回滚会创建新版本，必须与 save/import 一样执行配额检查。
        # 防止降级后回滚旧版本绕过 max_brands 限制。
        try:
            config = store.get_config(revision, company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        rules = (config or {}).get("rules", [])
        if isinstance(rules, list):
            _check_brands_quota(rules)
        try:
            result = store.rollback_config(revision, company_id=company_id)
            capture_event("config.published", company_id=company_id, revision=revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        # 版本历史上限检查：在回滚创建新版本之后执行，避免删掉正在回滚的源版本
        _enforce_revision_limit(store, company_id, after_save=True)
        return result

    @app.delete("/api/config/{revision}")
    def delete_config(revision: str, company_id: str = Depends(resolve_company_id)) -> dict[str, str]:
        try:
            store.delete_config(revision, company_id=company_id)
            return {"revision": revision, "status": "deleted"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/config/validate")
    def validate_config(company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        errors = engine.validate_config(config)
        return {"valid": len(errors) == 0, "errors": errors}

    @app.get("/api/config/{revision}/export", response_class=PlainTextResponse)
    def export_config(
        revision: str,
        fmt: Literal["json", "yaml"] = "json",
        company_id: str = Depends(resolve_company_id),
    ) -> str:
        try:
            return store.export_config(revision, fmt, company_id=company_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config/import")
    def import_config(payload: ConfigImport, company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        # 先解析内容检查品牌配额，再交给 store 保存
        # 防止导入绕过 max_brands 限制
        try:
            if payload.fmt == "yaml":
                import yaml
                raw = yaml.safe_load(payload.content) or {}
            else:
                raw = json.loads(payload.content)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"配置解析失败: {exc}") from exc
        rules = (raw or {}).get("rules", []) if isinstance(raw, dict) else []
        if isinstance(rules, list):
            _check_brands_quota(rules)
        # 版本历史上限检查：与 save_config 一致，防止导入累积版本
        _enforce_revision_limit(store, company_id)
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

    @app.get("/api/audit")
    def list_audit(
        limit: int = Query(50, ge=1, le=200),
        company_id: str = Depends(resolve_company_id),
    ) -> list[dict[str, Any]]:
        # 功能门控：audit_log 是付费功能（pro/team），免费版不开放审计日志
        from ..license import has_feature
        if not has_feature("audit_log"):
            raise HTTPException(
                status_code=403,
                detail="审计日志是付费功能，请升级到个人版或专业版订阅。",
            )
        # 按订阅档位过滤审计日志保留天数（-1 或 0 表示不过滤）
        days = get_quota("audit_log_days", 7)
        return store.list_audit(limit, company_id=company_id, days=days if days > 0 else None)
