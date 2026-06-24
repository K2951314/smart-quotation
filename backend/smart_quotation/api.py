from __future__ import annotations

import json
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import customer_dep, expires_in, hash_password, hash_token, new_token, verify_password
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


# ─── Customer Management Models ──────────────────────────────────────

class CustomerCreate(BaseModel):
    username: str
    password: str
    display_name: str
    discount_rate: float = 1.0
    tax_rate: float = 0.13
    notes: str = ""
    account_type: str = "company"


class CustomerUpdate(BaseModel):
    display_name: str | None = None
    status: str | None = None
    account_type: str | None = None
    discount_rate: float | None = None
    tax_rate: float | None = None
    profit_mode: str | None = None
    profit_value: float | None = None
    notes: str | None = None


class CustomerPasswordReset(BaseModel):
    new_password: str


class PriceOverrideItem(BaseModel):
    item_key: str
    override_price: float
    notes: str = ""


class PriceOverrideBatch(BaseModel):
    overrides: list[PriceOverrideItem]


class CustomerLogin(BaseModel):
    company_code: str
    username: str
    password: str


class CustomerProfileUpdate(BaseModel):
    profit_mode: str | None = None
    profit_value: float | None = None


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
    get_customer = customer_dep(store)

    def require_admin(current: dict = Depends(get_customer)) -> dict:
        customer = current["customer"]
        if (customer.get("account_type") or "company") != "admin":
            raise HTTPException(status_code=403, detail="admin account required")
        return current

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/companies", dependencies=[Depends(require_admin)])
    def list_companies() -> list[dict[str, Any]]:
        return store.list_companies()

    @app.delete("/api/companies/{company_id}", dependencies=[Depends(require_admin)])
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

    @app.patch("/api/companies/{company_id}", dependencies=[Depends(require_admin)])
    def update_company(company_id: str, payload: CompanyUpdate) -> dict[str, Any]:
        try:
            return store.update_company(company_id, name=payload.name, status=payload.status)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, LookupError) else 422, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/rename", dependencies=[Depends(require_admin)])
    def rename_company(company_id: str, payload: CompanyRename) -> dict[str, Any]:
        try:
            result = store.rename_company(company_id, new_name=payload.new_name, new_id=payload.new_id)
            return {"old_id": company_id, "new_id": result["id"], "name": result["name"]}
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, LookupError) else 422, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config/validate", dependencies=[Depends(require_admin)])
    def validate_config(company_id: str) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        errors = engine.validate_config(config)
        return {"valid": len(errors) == 0, "errors": errors}

    @app.post("/api/companies/{company_id}/items/upload", dependencies=[Depends(require_admin)])
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

    @app.delete("/api/companies/{company_id}/items/rollback", dependencies=[Depends(require_admin)])
    def rollback_items(
        company_id: str,
        data_revision: str = Query(..., description="要回滚的库存版本，删除该版本的所有行"),
    ) -> dict[str, Any]:
        try:
            return store.delete_items_revision(company_id, data_revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies", dependencies=[Depends(require_admin)])
    def create_company(payload: CompanyCreate) -> dict[str, str]:
        try:
            company_id = store.create_company(payload.name, payload.code)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"company_id": company_id}

    @app.get("/api/companies/{company_id}/configs", dependencies=[Depends(require_admin)])
    def list_configs(company_id: str) -> list[dict[str, Any]]:
        return store.list_configs(company_id)

    @app.delete("/api/companies/{company_id}/config/{revision}", dependencies=[Depends(require_admin)])
    def delete_config(company_id: str, revision: str) -> dict[str, str]:
        try:
            store.delete_config(company_id, revision)
            return {"company_id": company_id, "revision": revision, "status": "deleted"}
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config/{revision}/publish", dependencies=[Depends(require_admin)])
    def rollback_config(company_id: str, revision: str) -> dict[str, Any]:
        try:
            return store.rollback_config(company_id, revision)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config", dependencies=[Depends(require_admin)])
    def get_active_config(company_id: str) -> dict[str, Any]:
        try:
            return store.get_active_config(company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config", dependencies=[Depends(require_admin)])
    def save_config(company_id: str, payload: ConfigSave) -> dict[str, Any]:
        try:
            return store.save_config(company_id, payload.config, status=payload.status)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/companies/{company_id}/config/{revision}/export", response_class=PlainTextResponse, dependencies=[Depends(require_admin)])
    def export_config(company_id: str, revision: str, fmt: Literal["json", "yaml"] = "json") -> str:
        try:
            return store.export_config(company_id, revision, fmt)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/config/import", dependencies=[Depends(require_admin)])
    def import_config(company_id: str, payload: ConfigImport) -> dict[str, Any]:
        try:
            return store.import_config(company_id, payload.content, fmt=payload.fmt, status=payload.status)
        except (ValueError, SyntaxError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/api/config/example", dependencies=[Depends(require_admin)])
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

    @app.get("/api/companies/{company_id}/audit", dependencies=[Depends(require_admin)])
    def list_audit(company_id: str, limit: int = Query(50, ge=1, le=200)) -> list[dict[str, Any]]:
        return store.list_audit(company_id, limit)

    @app.get("/api/companies/{company_id}/items/stats", dependencies=[Depends(require_admin)])
    def get_items_stats(company_id: str) -> dict[str, Any]:
        return store.get_items_stats(company_id)

    @app.post("/api/companies/{company_id}/items", dependencies=[Depends(require_admin)])
    def replace_items(company_id: str, payload: ItemsReplace) -> dict[str, int | str]:
        store.replace_items(company_id, payload.data_revision, payload.rows)
        return {"company_id": company_id, "count": len(payload.rows)}

    @app.get("/api/companies/{company_id}/quote", dependencies=[Depends(require_admin)])
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

    @app.post("/api/companies/{company_id}/integrations/erpnext/test", dependencies=[Depends(require_admin)])
    def test_erpnext(company_id: str) -> dict[str, str]:
        try:
            config = store.get_active_config(company_id).get("integrations", {}).get("erpnext", {})
            ERPNextAdapter().require_configured(config)
            return {"status": "configured"}
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/items", dependencies=[Depends(require_admin)])
    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/prices", dependencies=[Depends(require_admin)])
    @app.post("/api/companies/{company_id}/integrations/erpnext/sync/stock", dependencies=[Depends(require_admin)])
    @app.post("/api/companies/{company_id}/quotations/{quote_id}/push-to-erpnext", dependencies=[Depends(require_admin)])
    def reserved_erpnext(company_id: str, quote_id: str | None = None) -> dict[str, str | None]:
        return {"company_id": company_id, "quote_id": quote_id, "status": "reserved"}

    # ─── Merger / Bundle Endpoints ───────────────────────────────────────

    @app.post("/api/companies/{company_id}/merger/detect-brands", dependencies=[Depends(require_admin)])
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

    @app.post("/api/companies/{company_id}/merger/bundle/generate", dependencies=[Depends(require_admin)])
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

    @app.post("/api/companies/{company_id}/merger/bundle/deploy", dependencies=[Depends(require_admin)])
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
        frontend_config = {k: v for k, v in config.items() if k not in ("company_id", "data_source")}
        _upload("config", config_file, json.dumps(frontend_config, ensure_ascii=False).encode("utf-8"))
        results["config"] = "deployed"

        # 4. version.json — 版本标记，前端用它做缓存失效
        revision = str(config.get("revision") or config.get("version") or "")
        version_payload = json.dumps({"version": revision, "updated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False).encode("utf-8")
        _upload("version", version_file, version_payload)
        results["version"] = f"deployed ({revision})"

        return results

    # ─── Customer Authentication ──────────────────────────────────────

    @app.post("/api/customer/login")
    def customer_login(payload: CustomerLogin) -> dict[str, Any]:
        # 通过 company_code 查找 company_id
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id from companies where code = ? and status = 'active'",
                (payload.company_code,),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="公司代码无效或已停用")
        company_id = row["id"]

        customer = store.get_customer_by_username(company_id, payload.username)
        if not customer:
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        if customer["status"] != "active":
            raise HTTPException(status_code=403, detail="账号已被禁用")
        if not verify_password(payload.password, customer["password_hash"], customer["password_salt"]):
            raise HTTPException(status_code=401, detail="用户名或密码错误")

        # 创建会话
        token = new_token()
        token_h = hash_token(token)
        store.create_session(customer["id"], company_id, token_h, expires_in(7))

        # 清理过期会话（顺带）
        store.cleanup_expired_sessions()

        return {
            "token": token,
            "customer": {
                "id": customer["id"],
                "display_name": customer["display_name"],
                "company_id": company_id,
                "account_type": customer.get("account_type") or "company",
            },
        }

    @app.post("/api/customer/logout")
    def customer_logout(current: dict = Depends(get_customer)):
        store.delete_session(current["token_hash"])
        return {"status": "logged_out"}

    @app.get("/api/customer/me")
    def customer_me(current: dict = Depends(get_customer)) -> dict[str, Any]:
        c = current["customer"]
        return {
            "id": c["id"],
            "display_name": c["display_name"],
            "company_id": c["company_id"],
            "account_type": c.get("account_type") or "company",
            "tax_rate": c["tax_rate"],
            "profit_mode": c["profit_mode"],
            "profit_value": c["profit_value"],
        }

    @app.get("/api/customer/companies")
    def customer_companies(current: dict = Depends(get_customer)) -> list[dict[str, Any]]:
        """管理员可查看所有活跃公司列表（用于切换）。公司账号仅返回自己的公司。"""
        c = current["customer"]
        if (c.get("account_type") or "company") == "admin":
            return store.list_companies()
        # 公司账号只返回自己的公司
        with closing(store.connect()) as conn:
            row = conn.execute(
                "select id, name, code, status from companies where id = ?", (c["company_id"],)
            ).fetchone()
        return [dict(row)] if row else []

    # ─── Customer-facing (sanitized) endpoints ────────────────────────

    @app.get("/api/customer/quote")
    def customer_quote(
        q: str = Query(..., min_length=1),
        company_id: str = Query("", description="管理员可指定查看其他公司"),
        current: dict = Depends(get_customer),
    ) -> dict[str, Any]:
        # 管理员可切换公司；公司账号只能看自己的
        target_company = current["company_id"]
        customer = current["customer"]
        is_admin = (customer.get("account_type") or "company") == "admin"
        if is_admin and company_id:
            target_company = company_id
        try:
            return engine.quote_customer(customer, target_company, q)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/customer/config")
    def customer_config(
        company_id: str = Query("", description="管理员可指定查看其他公司"),
        current: dict = Depends(get_customer),
    ) -> dict[str, Any]:
        """返回 UI 配置。管理员看完整字段（含 face_price），公司账号脱敏。
        
        无已发布配置时返回空默认配置，不阻断门户初始化。"""
        customer = current["customer"]
        is_admin = (customer.get("account_type") or "company") == "admin"
        target_company = company_id if (is_admin and company_id) else current["company_id"]
        try:
            config = store.get_active_config(target_company)
        except LookupError:
            # 无已发布配置 → 返回空默认，不阻断前台
            return {"ui": {}, "fields": [], "copy": {}}

        if is_admin:
            # 管理员看完整配置（含 rules/pricing）
            return config

        # 公司账号：脱敏，剔除 rules / pricing 内部字段
        return {
            "ui": config.get("ui") or {},
            "fields": [
                {k: v for k, v in f.items() if k != "excel_aliases"}
                for f in config.get("fields") or []
                if f.get("key") != "face_price"
            ],
            "copy": config.get("copy") or {},
        }

    @app.get("/api/customer/profile")
    def customer_profile(current: dict = Depends(get_customer)) -> dict[str, Any]:
        c = current["customer"]
        return {
            "id": c["id"],
            "display_name": c["display_name"],
            "tax_rate": c["tax_rate"],
            "profit_mode": c["profit_mode"],
            "profit_value": c["profit_value"],
        }

    @app.patch("/api/customer/profile")
    def customer_profile_update(
        payload: CustomerProfileUpdate,
        current: dict = Depends(get_customer),
    ) -> dict[str, Any]:
        updates = {}
        if payload.profit_mode is not None:
            if payload.profit_mode not in ("none", "percent", "amount"):
                raise HTTPException(status_code=422, detail="profit_mode must be none/percent/amount")
            updates["profit_mode"] = payload.profit_mode
        if payload.profit_value is not None:
            updates["profit_value"] = payload.profit_value
        if not updates:
            raise HTTPException(status_code=422, detail="no fields to update")
        customer = store.update_customer(current["customer_id"], **updates)
        return {
            "id": customer["id"],
            "profit_mode": customer["profit_mode"],
            "profit_value": customer["profit_value"],
            "tax_rate": customer["tax_rate"],
        }

    # ─── Admin: Customer Management ───────────────────────────────────

    @app.get("/api/companies/{company_id}/customers", dependencies=[Depends(require_admin)])
    def list_customers(company_id: str) -> list[dict[str, Any]]:
        return store.list_customers(company_id)

    @app.post("/api/companies/{company_id}/customers", dependencies=[Depends(require_admin)])
    def create_customer(company_id: str, payload: CustomerCreate) -> dict[str, Any]:
        pw_hash, pw_salt = hash_password(payload.password)
        try:
            customer = store.create_customer(
                company_id=company_id,
                username=payload.username,
                password_hash=pw_hash,
                password_salt=pw_salt,
                display_name=payload.display_name,
                discount_rate=payload.discount_rate,
                tax_rate=payload.tax_rate,
                notes=payload.notes,
                account_type=payload.account_type,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {k: v for k, v in customer.items() if k not in ("password_hash", "password_salt")}

    @app.get("/api/companies/{company_id}/customers/{customer_id}", dependencies=[Depends(require_admin)])
    def get_customer_detail(company_id: str, customer_id: str) -> dict[str, Any]:
        customer = store.get_customer(customer_id)
        if not customer or customer["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        # 剔除密码字段
        return {k: v for k, v in customer.items() if k not in ("password_hash", "password_salt")}

    @app.patch("/api/companies/{company_id}/customers/{customer_id}", dependencies=[Depends(require_admin)])
    def update_customer(
        company_id: str,
        customer_id: str,
        payload: CustomerUpdate,
    ) -> dict[str, Any]:
        # 校验归属
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        try:
            customer = store.update_customer(customer_id, **payload.model_dump(exclude_none=True))
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {k: v for k, v in customer.items() if k not in ("password_hash", "password_salt")}

    @app.delete("/api/companies/{company_id}/customers/{customer_id}", dependencies=[Depends(require_admin)])
    def delete_customer(company_id: str, customer_id: str) -> dict[str, Any]:
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        try:
            return store.delete_customer(customer_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/companies/{company_id}/customers/{customer_id}/reset-password", dependencies=[Depends(require_admin)])
    def reset_customer_password(
        company_id: str,
        customer_id: str,
        payload: CustomerPasswordReset,
    ) -> dict[str, Any]:
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        pw_hash, pw_salt = hash_password(payload.new_password)
        return store.reset_customer_password(customer_id, pw_hash, pw_salt)

    # ─── Admin: Price Overrides ───────────────────────────────────────

    @app.get("/api/companies/{company_id}/customers/{customer_id}/prices", dependencies=[Depends(require_admin)])
    def list_price_overrides(company_id: str, customer_id: str) -> list[dict[str, Any]]:
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        return store.list_price_overrides(customer_id)

    @app.put("/api/companies/{company_id}/customers/{customer_id}/prices", dependencies=[Depends(require_admin)])
    def upsert_price_overrides(
        company_id: str,
        customer_id: str,
        payload: PriceOverrideBatch,
    ) -> dict[str, Any]:
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        overrides = [{"item_key": o.item_key, "override_price": o.override_price, "notes": o.notes} for o in payload.overrides]
        return store.upsert_price_overrides(customer_id, company_id, overrides)

    @app.delete("/api/companies/{company_id}/customers/{customer_id}/prices/{item_key}", dependencies=[Depends(require_admin)])
    def delete_price_override(company_id: str, customer_id: str, item_key: str) -> dict[str, Any]:
        existing = store.get_customer(customer_id)
        if not existing or existing["company_id"] != company_id:
            raise HTTPException(status_code=404, detail="customer not found")
        try:
            return store.delete_price_override(customer_id, item_key)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

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
