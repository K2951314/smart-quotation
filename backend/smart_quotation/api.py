from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import QuotationEngine
from .erp import ERPNextAdapter
from .store import QuotationStore


class CompanyCreate(BaseModel):
    name: str
    code: str


class CompanyUpdate(BaseModel):
    name: str | None = None
    status: str | None = None


class CompanyRename(BaseModel):
    new_name: str | None = None
    new_id: str | None = None


class ConfigSave(BaseModel):
    config: dict[str, Any]
    status: Literal["draft", "published"] = "draft"


class ItemsReplace(BaseModel):
    data_revision: str = "manual"
    rows: list[dict[str, Any]] = Field(default_factory=list)


class ConfigImport(BaseModel):
    content: str
    fmt: Literal["json", "yaml"] = "json"
    status: Literal["draft", "published"] = "draft"


def create_app(store: QuotationStore | None = None) -> FastAPI:
    app = FastAPI(title="Smart Quotation API", version="0.1.0")
    # CORS 配置：优先使用环境变量 ALLOW_ORIGINS（逗号分隔），若未设置则回退为允许所有来源但禁用凭证
    import os
    raw = os.environ.get("ALLOW_ORIGINS", "").strip()
    if raw:
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        allow_credentials = True
    else:
        origins = ["*"]
        allow_credentials = False

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    store = store or QuotationStore()
    store.init_schema()
    engine = QuotationEngine(store)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/companies")
    def list_companies() -> list[dict[str, Any]]:
        return store.list_companies()

    @app.delete("/api/companies/{company_id}")
    def delete_company(
        company_id: str,
        hard: bool = Query(False, description="true=彻底删除，false=仅停用"),
    ) -> dict[str, str]:
        try:
            if hard:
                result = store.hard_delete_company(company_id)
                return {"company_id": company_id, "status": "deleted"}
            else:
                store.delete_company(company_id)
                return {"company_id": company_id, "status": "inactive"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.patch("/api/companies/{company_id}")
    def update_company(company_id: str, payload: CompanyUpdate) -> dict[str, Any]:
        try:
            return store.update_company(company_id, name=payload.name, status=payload.status)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, LookupError) else 422, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/rename")
    def rename_company(company_id: str, payload: CompanyRename) -> dict[str, Any]:
        try:
            result = store.rename_company(company_id, new_name=payload.new_name, new_id=payload.new_id)
            return {"old_id": company_id, "new_id": result["id"], "name": result["name"]}
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, LookupError) else 422, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config/validate")
    def validate_config(company_id: str) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        errors = engine.validate_config(config)
        return {"valid": len(errors) == 0, "errors": errors}

    @app.post("/api/companies/{company_id}/items/upload")
    async def upload_items(
        company_id: str,
        file: UploadFile = File(...),
        data_revision: str = Query("", description="留空则自动从文件名生成"),
        write: bool = Query(False, description="True 时直接写入，False 仅预览"),
    ) -> dict[str, Any]:
        content = await file.read()
        filename = file.filename or "upload.xlsx"
        try:
            rows, report = store.parse_excel_to_rows(content, filename, company_id)
        except (ImportError, ValueError, Exception) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if write:
            rev = data_revision or (filename.rsplit(".", 1)[0] + "_" + store.now()[:10])
            store.replace_items(company_id, rev, rows)
            return {"action": "written", "data_revision": rev, "count": len(rows), "report": report}
        return {"action": "preview", "count": len(rows), "report": report, "preview": rows[:5]}

    @app.delete("/api/companies/{company_id}/items/rollback")
    def rollback_items(
        company_id: str,
        data_revision: str = Query(..., description="要回滚的库存版本，删除该版本的所有行"),
    ) -> dict[str, Any]:
        try:
            return store.delete_items_revision(company_id, data_revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies")
    def create_company(payload: CompanyCreate) -> dict[str, str]:
        try:
            company_id = store.create_company(payload.name, payload.code)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"company_id": company_id}

    @app.get("/api/companies/{company_id}/configs")
    def list_configs(company_id: str) -> list[dict[str, Any]]:
        return store.list_configs(company_id)

    @app.delete("/api/companies/{company_id}/config/{revision}")
    def delete_config(company_id: str, revision: str) -> dict[str, str]:
        try:
            store.delete_config(company_id, revision)
            return {"company_id": company_id, "revision": revision, "status": "deleted"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config/{revision}/publish")
    def rollback_config(company_id: str, revision: str) -> dict[str, Any]:
        try:
            return store.rollback_config(company_id, revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config")
    def get_active_config(company_id: str) -> dict[str, Any]:
        try:
            return store.get_active_config(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config")
    def save_config(company_id: str, payload: ConfigSave) -> dict[str, Any]:
        try:
            return store.save_config(company_id, payload.config, status=payload.status)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config/{revision}/export", response_class=PlainTextResponse)
    def export_config(company_id: str, revision: str, fmt: Literal["json", "yaml"] = "json") -> str:
        try:
            return store.export_config(company_id, revision, fmt)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config/import")
    def import_config(company_id: str, payload: ConfigImport) -> dict[str, Any]:
        try:
            return store.import_config(company_id, payload.content, fmt=payload.fmt, status=payload.status)
        except (ValueError, SyntaxError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/config/example")
    def read_example_config() -> dict[str, Any]:
        repo_root = Path(__file__).resolve().parents[2]
        config_path = repo_root / "config.example.json"
        if not config_path.exists():
            raise HTTPException(status_code=404, detail="config.example.json not found")
        try:
            with config_path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"config.example.json is invalid JSON: {exc}") from exc

    @app.get("/api/companies/{company_id}/audit")
    def list_audit(company_id: str, limit: int = Query(50, ge=1, le=200)) -> list[dict[str, Any]]:
        return store.list_audit(company_id, limit)

    @app.get("/api/companies/{company_id}/items/stats")
    def get_items_stats(company_id: str) -> dict[str, Any]:
        return store.get_items_stats(company_id)

    @app.post("/api/companies/{company_id}/items")
    def replace_items(company_id: str, payload: ItemsReplace) -> dict[str, int | str]:
        store.replace_items(company_id, payload.data_revision, payload.rows)
        return {"company_id": company_id, "count": len(payload.rows)}

    @app.get("/api/companies/{company_id}/quote")
    def quote(company_id: str, q: str = Query(..., min_length=1)) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id)
            return {
                "company_id": company_id,
                "config_revision": config["revision"],
                "results": engine.quote(company_id, q),
            }
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/integrations/erpnext/test")
    def test_erpnext(company_id: str) -> dict[str, str]:
        try:
            config = store.get_active_config(company_id).get("integrations", {}).get("erpnext", {})
            ERPNextAdapter().require_configured(config)
            return {"status": "configured"}
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/items")
    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/prices")
    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/stock")
    @app.post("/api/companies/{company_id}/quotations/{quote_id}/push-to-erpnext")
    def reserved_erpnext(company_id: str, quote_id: str | None = None) -> dict[str, str | None]:
        return {"company_id": company_id, "quote_id": quote_id, "status": "reserved"}

    # ─── Merger / Bundle Endpoints ───────────────────────────────────────

    @app.post("/api/companies/{company_id}/merger/detect-brands")
    async def detect_brands(
        company_id: str,
        files: list[UploadFile] = File(...),
    ) -> dict[str, Any]:
        """上传多个 Excel 文件，按文件名识别品牌，返回检测结果。"""
        file_tuples = []
        for f in files:
            content = await f.read()
            file_tuples.append((f.filename or "unknown.xlsx", content))
        results = store.detect_brands(file_tuples, company_id)
        return {"company_id": company_id, "files": results}

    class BundleGenerate(BaseModel):
        password: str = ""
        deploy: bool = False
        anon_key: str = ""

    @app.post("/api/companies/{company_id}/merger/bundle/generate")
    def generate_bundles(
        company_id: str,
        payload: BundleGenerate,
    ) -> dict[str, Any]:
        """生成价格包 + 库存包，可选部署到 Supabase。"""
        price_bundle = store.build_price_bundle(company_id, password=payload.password)
        stock_bundle = store.build_stock_bundle(company_id)

        result = {
            "company_id": company_id,
            "price_bundle": price_bundle,
            "stock_bundle": stock_bundle,
        }

        if payload.deploy:
            if not payload.anon_key:
                raise HTTPException(status_code=422, detail="部署到 Supabase 需要提供 anon_key")
            try:
                config = store.get_active_config(company_id)
                deploy_results = _deploy_bundles_to_supabase(config, price_bundle, stock_bundle, payload.anon_key)
                result["deploy"] = deploy_results
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc

        return result

    class BundleDeploy(BaseModel):
        price_bundle: dict[str, Any]
        stock_bundle: dict[str, Any]
        anon_key: str

    @app.post("/api/companies/{company_id}/merger/bundle/deploy")
    def deploy_bundles(
        company_id: str,
        payload: BundleDeploy,
    ) -> dict[str, Any]:
        """将已有的 Bundle 部署到 Supabase Storage。"""
        if not payload.anon_key:
            raise HTTPException(status_code=422, detail="anon_key is required")
        try:
            config = store.get_active_config(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            results = _deploy_bundles_to_supabase(config, payload.price_bundle, payload.stock_bundle, payload.anon_key)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc
        return {"company_id": company_id, "deploy": results}

    def _deploy_bundles_to_supabase(
        config: dict[str, Any],
        price_bundle: dict[str, Any],
        stock_bundle: dict[str, Any],
        anon_key: str,
    ) -> dict[str, str]:
        """内部函数：将 Bundle 上传到 Supabase Storage。"""
        import urllib.request
        import urllib.error

        data_source = config.get("data_source") or {}
        base_url = str(data_source.get("base_url") or "").rstrip("/")
        if not base_url:
            raise ValueError("配置缺少 data_source.base_url")

        price_file = str(data_source.get("price_bundle_file") or "price.bundle.json")
        stock_file = str(data_source.get("stock_bundle_file") or "stock.bundle.json")

        results = {}
        for label, filename, bundle_data in [
            ("price", price_file, price_bundle),
            ("stock", stock_file, stock_bundle),
        ]:
            # 构建写入 URL
            if filename.startswith("http"):
                public_url = filename
            else:
                public_url = f"{base_url}/{filename.lstrip('/')}"
            write_url = QuotationStore.build_supabase_write_url(public_url)

            body = json.dumps(bundle_data, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                write_url,
                data=body,
                method="PUT",
                headers={
                    "apikey": anon_key,
                    "authorization": f"Bearer {anon_key}",
                    "content-type": "application/json;charset=utf-8",
                    "x-upsert": "true",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp.read()
                results[label] = f"deployed ({bundle_data.get('meta', {}).get('rowCount', '?')} rows)"
            except urllib.error.HTTPError as exc:
                raise ValueError(f"Supabase {label} 上传失败: HTTP {exc.code}") from exc

        return results

    root_dir = Path(__file__).resolve().parents[2]
    admin_dir = root_dir / "admin"
    apps_dir  = root_dir / "apps"
    merger_dir = root_dir / "merger"

    if admin_dir.exists():
        app.mount("/admin", StaticFiles(directory=str(admin_dir), html=True), name="admin")
    # admin/index.html 通过 ../apps/lib/ 和 ../merger/lib/ 引用公共库
    if apps_dir.exists():
        app.mount("/apps", StaticFiles(directory=str(apps_dir)), name="apps")
    if merger_dir.exists():
        app.mount("/merger", StaticFiles(directory=str(merger_dir)), name="merger")

    return app
