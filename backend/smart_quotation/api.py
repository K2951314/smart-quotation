from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import QuotationEngine
from .mitsubishi_stock import get_engine as get_stock_engine
from .store import QuotationStore


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



class BundleGenerate(BaseModel):
    password: str = ""
    deploy: bool = False
    anon_key: str = ""


class BundleDeploy(BaseModel):
    price_bundle: dict[str, Any]
    stock_bundle: dict[str, Any]
    anon_key: str


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
    app.state.store = store
    engine = QuotationEngine(store)

    # Admin API key dependency — protects all admin backend routes
    admin_security = HTTPBearer(auto_error=False)

    def require_admin_api(credentials: HTTPAuthorizationCredentials | None = Depends(admin_security)) -> None:
        """验证 admin 后台 API key。本地开发时 key 硬编码在生产环境中应通过环境变量设置。"""
        import os
        expected_key = os.environ.get("ADMIN_API_KEY", "admin-secret-key")
        if not credentials or credentials.credentials != expected_key:
            raise HTTPException(status_code=401, detail="missing admin API key")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # ─── 公开端点（无需认证）─────────────────────────────────────

    @app.get("/api/config/active")
    def get_active_config_public() -> dict[str, Any]:
        """公开获取已发布配置，无需认证。用于 apps 前端加载。"""
        try:
            config = store.get_active_config()
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return config

    # ─── Admin 受保护端点（需 ADMIN_API_KEY）───────────────────

    @app.get("/api/configs", dependencies=[Depends(require_admin_api)])
    def list_configs() -> list[dict[str, Any]]:
        return store.list_configs()

    @app.get("/api/config", dependencies=[Depends(require_admin_api)])
    def get_active_config() -> dict[str, Any]:
        try:
            return store.get_active_config()
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config", dependencies=[Depends(require_admin_api)])
    def save_config(payload: ConfigSave) -> dict[str, Any]:
        try:
            return store.save_config(payload.config, status=payload.status)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/api/config/{revision}/publish", dependencies=[Depends(require_admin_api)])
    def rollback_config(revision: str) -> dict[str, Any]:
        try:
            return store.rollback_config(revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/config/{revision}", dependencies=[Depends(require_admin_api)])
    def delete_config(revision: str) -> dict[str, str]:
        try:
            store.delete_config(revision)
            return {"revision": revision, "status": "deleted"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/config/validate", dependencies=[Depends(require_admin_api)])
    def validate_config() -> dict[str, Any]:
        try:
            config = store.get_active_config()
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        errors = engine.validate_config(config)
        return {"valid": len(errors) == 0, "errors": errors}

    @app.get("/api/config/{revision}/export", response_class=PlainTextResponse, dependencies=[Depends(require_admin_api)])
    def export_config(revision: str, fmt: Literal["json", "yaml"] = "json") -> str:
        try:
            return store.export_config(revision, fmt)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/config/import", dependencies=[Depends(require_admin_api)])
    def import_config(payload: ConfigImport) -> dict[str, Any]:
        try:
            return store.import_config(payload.content, fmt=payload.fmt, status=payload.status)
        except (ValueError, SyntaxError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/config/example", dependencies=[Depends(require_admin_api)])
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

    @app.get("/api/audit", dependencies=[Depends(require_admin_api)])
    def list_audit(limit: int = Query(50, ge=1, le=200)) -> list[dict[str, Any]]:
        return store.list_audit(limit)

    @app.get("/api/items/stats", dependencies=[Depends(require_admin_api)])
    def get_items_stats() -> dict[str, Any]:
        return store.get_items_stats()

    @app.post("/api/items", dependencies=[Depends(require_admin_api)])
    def replace_items(payload: ItemsReplace) -> dict[str, int | str]:
        store.replace_items(payload.data_revision, payload.rows)
        return {"count": len(payload.rows)}

    @app.post("/api/items/upload", dependencies=[Depends(require_admin_api)])
    async def upload_items(
        file: UploadFile = File(...),
        data_revision: str = Query("", description="留空则自动从文件名生成"),
        write: bool = Query(False, description="True 时直接写入，False 仅预览"),
    ) -> dict[str, Any]:
        content = await file.read()
        filename = file.filename or "upload.xlsx"
        try:
            rows, report = store.parse_excel_to_rows(content, filename)
        except (ImportError, ValueError, Exception) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if write:
            rev = data_revision or (filename.rsplit(".", 1)[0] + "_" + store.now()[:10])
            store.replace_items(rev, rows)
            return {"action": "written", "data_revision": rev, "count": len(rows), "report": report}
        return {"action": "preview", "count": len(rows), "report": report, "preview": rows[:5]}

    @app.delete("/api/items/rollback", dependencies=[Depends(require_admin_api)])
    def rollback_items(
        data_revision: str = Query(..., description="要回滚的库存版本，删除该版本的所有行"),
    ) -> dict[str, Any]:
        try:
            return store.delete_items_revision(data_revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/quote", dependencies=[Depends(require_admin_api)])
    def quote(q: str = Query(..., min_length=1)) -> dict[str, Any]:
        try:
            config = store.get_active_config()
            return {
                "config_revision": config["revision"],
                "results": engine.quote(q),
            }
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # ─── Merger / Bundle Endpoints ───────────────────────────────────────

    @app.post("/api/merger/detect-brands", dependencies=[Depends(require_admin_api)])
    async def detect_brands(
        files: list[UploadFile] = File(...),
    ) -> dict[str, Any]:
        """上传多个 Excel 文件，按文件名识别品牌，返回检测结果。"""
        file_tuples = []
        for f in files:
            content = await f.read()
            file_tuples.append((f.filename or "unknown.xlsx", content))
        results = store.detect_brands(file_tuples)
        return {"files": results}

    @app.post("/api/merger/bundle/generate", dependencies=[Depends(require_admin_api)])
    def generate_bundles(
        payload: BundleGenerate,
    ) -> dict[str, Any]:
        """生成价格包 + 库存包，可选部署到 Supabase。"""
        price_bundle = store.build_price_bundle(password=payload.password)
        stock_bundle = store.build_stock_bundle()

        result = {
            "price_bundle": price_bundle,
            "stock_bundle": stock_bundle,
        }

        if payload.deploy:
            if not payload.anon_key:
                raise HTTPException(status_code=422, detail="部署到 Supabase 需要提供 anon_key")
            try:
                config = store.get_active_config()
                deploy_results = _deploy_bundles_to_supabase(config, price_bundle, stock_bundle, payload.anon_key)
                result["deploy"] = deploy_results
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc

        return result

    @app.post("/api/merger/bundle/deploy", dependencies=[Depends(require_admin_api)])
    def deploy_bundles(
        payload: BundleDeploy,
    ) -> dict[str, Any]:
        """将已有的 Bundle 部署到 Supabase Storage。"""
        if not payload.anon_key:
            raise HTTPException(status_code=422, detail="anon_key is required")
        try:
            config = store.get_active_config()
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            results = _deploy_bundles_to_supabase(config, payload.price_bundle, payload.stock_bundle, payload.anon_key)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"部署失败: {exc}") from exc
        return {"deploy": results}

    def _deploy_bundles_to_supabase(
        config: dict[str, Any],
        price_bundle: dict[str, Any],
        stock_bundle: dict[str, Any],
        anon_key: str,
    ) -> dict[str, str]:
        """内部函数：将 Bundle + config.json + version.json 上传到 Supabase Storage。"""
        import urllib.request
        import urllib.error

        data_source = config.get("data_source") or {}
        base_url = str(data_source.get("base_url") or "").rstrip("/")
        if not base_url:
            raise ValueError("配置缺少 data_source.base_url")

        price_file = str(data_source.get("price_bundle_file") or "price.bundle.json")
        stock_file = str(data_source.get("stock_bundle_file") or "stock.bundle.json")
        config_file = str(data_source.get("config_file") or "config.json")
        version_file = str(data_source.get("version_file") or "version.json")

        results: dict[str, str] = {}

        def _upload(label: str, filename: str, body: bytes) -> None:
            if filename.startswith("http"):
                public_url = filename
            else:
                public_url = f"{base_url}/{filename.lstrip('/')}"
            write_url = QuotationStore.build_supabase_write_url(public_url)
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
            except urllib.error.HTTPError as exc:
                raise ValueError(f"Supabase {label} 上传失败: HTTP {exc.code}") from exc

        # 1. price.bundle.json
        _upload("price", price_file, json.dumps(price_bundle, ensure_ascii=False).encode("utf-8"))
        results["price"] = f"deployed ({price_bundle.get('meta', {}).get('rowCount', '?')} rows)"

        # 2. stock.bundle.json
        _upload("stock", stock_file, json.dumps(stock_bundle, ensure_ascii=False).encode("utf-8"))
        results["stock"] = f"deployed ({stock_bundle.get('meta', {}).get('rowCount', '?')} rows)"

        # 3. config.json — 上传完整配置（前端 config-core.js 兼容 v3 rules 格式）
        _upload("config", config_file, json.dumps(config, ensure_ascii=False).encode("utf-8"))
        results["config"] = "deployed"

        # 4. version.json — 版本标记，前端用它做缓存失效
        revision = str(config.get("revision") or config.get("version") or "")
        version_payload = json.dumps({"version": revision, "updated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False).encode("utf-8")
        _upload("version", version_file, version_payload)
        results["version"] = f"deployed ({revision})"

        return results

    # ─── Mitsubishi Stock Query ─────────────────────────────────────
    # 无认证、无 Pydantic 模型，和原版 mobile_server.py 一样简单

    @app.post("/api/stock-query")
    async def stock_query(request: Request):
        """查询三菱官网实时库存（无需认证，和原版一致）。

        请求格式：{"queries": "型号1 材质1\n型号2 材质2\n..."}
        响应格式：{"results": ["型号 材质 上海库存N 日本库存M", ...], "count": N}
        """
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")

        query_text = body.get("queries", "") if isinstance(body, dict) else ""
        lines = [ln.strip() for ln in str(query_text).split("\n") if ln.strip()]
        if not lines:
            return {"results": [], "count": 0}

        engine = get_stock_engine()
        if not engine.ensure_ready():
            raise HTTPException(status_code=503, detail="三菱官网登录失败，请检查 config.ini 中的账号密码")

        results = []
        for line in lines:
            # 空格前=型号，空格后=材质
            parts = line.split(None, 1)
            model = parts[0]
            material = parts[1] if len(parts) > 1 else ""
            if not model:
                continue

            shanghai, japan, error = engine.search(model, material)

            stock_parts = []
            if shanghai > 0:
                stock_parts.append(f"上海库存{shanghai}")
            if japan > 0:
                stock_parts.append(f"日本库存{japan}")

            inv = " ".join(stock_parts) if stock_parts else ("无货" if not error else "")
            tag = f" {material}" if material else ""

            if error:
                results.append(f"{model}{tag} {error}")
            else:
                results.append(f"{model}{tag} {inv}")

        return {"results": results, "count": len(results)}

    root_dir = Path(__file__).resolve().parents[2]
    admin_dir = root_dir / "admin"
    apps_dir  = root_dir / "apps"

    if admin_dir.exists():
        app.mount("/admin", StaticFiles(directory=str(admin_dir), html=True), name="admin")
    if apps_dir.exists():
        app.mount("/apps", StaticFiles(directory=str(apps_dir)), name="apps")

    return app
