import base64
import io
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

import yaml

from .config import normalize_config


class ConfigCache:
    def __init__(self) -> None:
        self._cache: dict[tuple[str, str], dict[str, Any]] = {}

    def get(self, company_id: str, revision: str, loader):
        key = (company_id, revision)
        if key not in self._cache:
            self._cache[key] = loader(company_id, revision)
        return self._cache[key]

    def invalidate_company(self, company_id: str) -> None:
        self._cache = {key: value for key, value in self._cache.items() if key[0] != company_id}


class QuotationStore:
    def __init__(self, db_path: str = "quotation.db") -> None:
        self.db_path = db_path
        self.cache = ConfigCache()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_schema(self) -> None:
        with closing(self.connect()) as conn:
            conn.executescript(
                """
                create table if not exists companies (
                    id text primary key,
                    name text not null,
                    code text not null unique,
                    status text not null default 'active',
                    created_at text not null
                );
                create table if not exists quotation_configs (
                    id integer primary key autoincrement,
                    company_id text not null,
                    revision text not null,
                    status text not null,
                    config_json text not null,
                    created_by text,
                    published_at text,
                    created_at text not null,
                    unique(company_id, revision)
                );
                create table if not exists quotation_items (
                    id integer primary key autoincrement,
                    company_id text not null,
                    data_revision text not null,
                    item_key text not null,
                    fields_json text not null
                );
                create table if not exists audit_events (
                    id integer primary key autoincrement,
                    company_id text not null,
                    actor_id text,
                    action text not null,
                    target_type text not null,
                    target_id text,
                    payload_json text not null,
                    created_at text not null
                );
                """
            )
            conn.commit()

    def create_company(self, name: str, code: str) -> str:
        company_id = code
        with closing(self.connect()) as conn:
            conn.execute(
                "insert into companies(id, name, code, status, created_at) values(?, ?, ?, 'active', ?)",
                (company_id, name, code, self.now()),
            )
            conn.commit()
        return company_id

    def normalize_config(self, company_id: str, raw_config: dict[str, Any] | None) -> dict[str, Any]:
        return normalize_config(company_id, raw_config)

    def save_config(self, company_id: str, config: dict[str, Any], status: str = "draft", actor_id: str | None = None) -> dict[str, Any]:
        normalized = normalize_config(company_id, config)
        published_at = self.now() if status == "published" else None
        with closing(self.connect()) as conn:
            if status == "published":
                conn.execute(
                    "update quotation_configs set status = 'archived' where company_id = ? and status = 'published'",
                    (company_id,),
                )
            conn.execute(
                """
                insert into quotation_configs(company_id, revision, status, config_json, created_by, published_at, created_at)
                values(?, ?, ?, ?, ?, ?, ?)
                on conflict(company_id, revision) do update set
                    status = excluded.status,
                    config_json = excluded.config_json,
                    created_by = excluded.created_by,
                    published_at = excluded.published_at
                """,
                (
                    company_id,
                    normalized["revision"],
                    status,
                    json.dumps(normalized, ensure_ascii=False),
                    actor_id,
                    published_at,
                    self.now(),
                ),
            )
            self.audit(conn, company_id, actor_id, f"config.{status}", "quotation_config", normalized["revision"], normalized)
            conn.commit()
        if status == "published":
            self.cache.invalidate_company(company_id)
        return normalized

    def get_active_config(self, company_id: str) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select revision from quotation_configs where company_id = ? and status = 'published' order by published_at desc, id desc limit 1",
                (company_id,),
            ).fetchone()
            if not row:
                raise LookupError(f"no published config for company {company_id}")
            revision = row["revision"]
        return self.cache.get(company_id, revision, self.get_config)

    def get_config(self, company_id: str, revision: str) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select config_json from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            ).fetchone()
        if not row:
            raise LookupError(f"config {revision} not found for company {company_id}")
        return json.loads(row["config_json"])

    def export_config(self, company_id: str, revision: str, fmt: str = "json") -> str:
        config = self.get_config(company_id, revision)
        if fmt == "yaml":
            return yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
        if fmt == "json":
            return json.dumps(config, ensure_ascii=False, indent=2)
        raise ValueError("fmt must be json or yaml")

    def import_config(
        self,
        company_id: str,
        content: str,
        fmt: str = "json",
        status: str = "draft",
        actor_id: str | None = None,
    ) -> dict[str, Any]:
        if fmt == "yaml":
            raw = yaml.safe_load(content) or {}
        elif fmt == "json":
            raw = json.loads(content)
        else:
            raise ValueError("fmt must be json or yaml")
        return self.save_config(company_id, raw, status=status, actor_id=actor_id)

    def replace_items(self, company_id: str, data_revision: str, rows: list[dict[str, Any]]) -> None:
        with closing(self.connect()) as conn:
            conn.execute("delete from quotation_items where company_id = ? and data_revision = ?", (company_id, data_revision))
            conn.executemany(
                "insert into quotation_items(company_id, data_revision, item_key, fields_json) values(?, ?, ?, ?)",
                [
                    (
                        company_id,
                        data_revision,
                        row["item_key"],
                        json.dumps(row.get("fields") or {}, ensure_ascii=False),
                    )
                    for row in rows
                ],
            )
            self.audit(conn, company_id, None, "items.replace", "quotation_items", data_revision, {"count": len(rows)})
            conn.commit()

    def delete_items_revision(self, company_id: str, data_revision: str) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            result = conn.execute(
                "delete from quotation_items where company_id = ? and data_revision = ?",
                (company_id, data_revision),
            )
            count = result.rowcount
            self.audit(conn, company_id, None, "items.rollback", "quotation_items", data_revision, {"deleted": count})
            conn.commit()
        return {"data_revision": data_revision, "deleted": count}

    def search_items(self, company_id: str, query: str, searchable_fields: list[str]) -> list[dict[str, Any]]:
        tokens = [token.upper() for token in str(query or "").split() if token.strip()]
        if not tokens:
            return []
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "select item_key, fields_json from quotation_items where company_id = ? order by id",
                (company_id,),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            fields = json.loads(row["fields_json"])
            combined = " ".join(str(fields.get(field, "")) for field in searchable_fields).upper()
            if all(token in combined for token in tokens):
                out.append({"item_key": row["item_key"], "fields": fields})
        return out

    def audit(
        self,
        conn: sqlite3.Connection,
        company_id: str,
        actor_id: str | None,
        action: str,
        target_type: str,
        target_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        conn.execute(
            """
            insert into audit_events(company_id, actor_id, action, target_type, target_id, payload_json, created_at)
            values(?, ?, ?, ?, ?, ?, ?)
            """,
            (company_id, actor_id, action, target_type, target_id, json.dumps(payload, ensure_ascii=False), self.now()),
        )

    def parse_excel_to_rows(
        self,
        file_bytes: bytes,
        filename: str,
        company_id: str,
        *,
        sheet_index: int = 0,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """
        解析 Excel(.xlsx) 或 CSV 文件，使用当前发布配置的 excel_aliases 自动映射字段。
        返回 (rows, mapping_report)
          rows: 可直接传给 replace_items 的列表
          mapping_report: {matched: [...], unmatched: [...], total_rows: int}
        """
        import io

        # 获取字段别名映射表
        try:
            config = self.get_active_config(company_id)
        except LookupError:
            config = {}
        alias_map: dict[str, str] = {}  # alias → field_key
        for field in config.get("fields", []):
            for alias in field.get("excel_aliases", []):
                alias_map[alias] = field["key"]
            alias_map[field["key"]] = field["key"]  # key 本身也作为别名

        # 解析文件
        if filename.lower().endswith(".csv"):
            import csv

            reader = csv.DictReader(io.StringIO(file_bytes.decode("utf-8-sig")))
            raw_rows = list(reader)
            headers = list(raw_rows[0].keys()) if raw_rows else []
        else:
            try:
                import openpyxl
            except ImportError as exc:
                raise ImportError("请先安装 openpyxl：pip install openpyxl") from exc
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
            ws = wb.worksheets[sheet_index]
            all_rows = list(ws.iter_rows(values_only=True))
            if not all_rows:
                return [], {"matched": [], "unmatched": [], "total_rows": 0}
            headers = [str(h or "").strip() for h in all_rows[0]]
            raw_rows = [
                {headers[i]: (str(cell) if cell is not None else "") for i, cell in enumerate(row)}
                for row in all_rows[1:]
                if any(cell is not None for cell in row)
            ]

        # 字段映射
        col_mapping: dict[str, str] = {}  # excel_col → field_key
        for col in headers:
            if col in alias_map:
                col_mapping[col] = alias_map[col]

        matched = sorted({v for v in col_mapping.values()})
        unmatched = [col for col in headers if col not in col_mapping]

        # 构建 rows — 使用 spec 或第一个 searchable 字段作为 item_key
        searchable = [f["key"] for f in config.get("fields", []) if f.get("searchable")]
        key_field = searchable[0] if searchable else "spec"

        rows: list[dict[str, Any]] = []
        for raw in raw_rows:
            fields: dict[str, Any] = {}
            for col, key in col_mapping.items():
                val = raw.get(col, "")
                # 尝试转数字
                try:
                    fields[key] = float(val) if "." in str(val) else int(val)
                except (ValueError, TypeError):
                    fields[key] = val
            item_key = str(fields.get(key_field, "")).strip()
            if not item_key:
                continue
            rows.append({"item_key": item_key, "fields": fields})

        return rows, {
            "matched": matched,
            "unmatched": unmatched,
            "total_rows": len(rows),
        }

    def delete_company(self, company_id: str) -> None:
        """软删除：将公司状态置为 inactive"""
        with closing(self.connect()) as conn:
            result = conn.execute(
                "update companies set status = 'inactive' where id = ?",
                (company_id,),
            )
            if result.rowcount == 0:
                raise LookupError(f"company {company_id} not found")
            self.audit(conn, company_id, None, "company.delete", "company", company_id, {})
            conn.commit()

    def hard_delete_company(self, company_id: str) -> dict[str, Any]:
        """彻底删除公司及其所有关联数据（配置、料号、审计）"""
        with closing(self.connect()) as conn:
            # 先删除关联数据（外键约束）
            conn.execute("delete from quotation_items where company_id = ?", (company_id,))
            conn.execute("delete from quotation_configs where company_id = ?", (company_id,))
            conn.execute("delete from audit_events where company_id = ?", (company_id,))
            # 再删除公司本身
            result = conn.execute("delete from companies where id = ?", (company_id,))
            if result.rowcount == 0:
                raise LookupError(f"company {company_id} not found")
            conn.commit()
        return {"company_id": company_id, "status": "deleted"}

    def delete_config(self, company_id: str, revision: str) -> dict[str, Any]:
        """删除指定版本号的配置记录"""
        with closing(self.connect()) as conn:
            result = conn.execute(
                "delete from quotation_configs where company_id = ? and revision = ?",
                (company_id, revision),
            )
            if result.rowcount == 0:
                raise LookupError(f"config {company_id}/{revision} not found")
            self.audit(conn, company_id, None, "config.delete", "quotation_configs", revision, {})
            conn.commit()
        return {"company_id": company_id, "revision": revision, "status": "deleted"}

    def update_company(self, company_id: str, name: str | None = None, status: str | None = None) -> dict[str, Any]:
        """更新公司名称 / 状态"""
        updates: list[str] = []
        params: list[Any] = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if status is not None:
            updates.append("status = ?")
            params.append(status)
        if not updates:
            raise ValueError("nothing to update")
        params.append(company_id)
        with closing(self.connect()) as conn:
            result = conn.execute(
                f"update companies set {', '.join(updates)} where id = ?",  # noqa: S608
                params,
            )
            if result.rowcount == 0:
                raise LookupError(f"company {company_id} not found")
            row = conn.execute(
                "select id, name, code, status, created_at from companies where id = ?",
                (company_id,),
            ).fetchone()
            self.audit(conn, company_id, None, "company.update", "company", company_id, {"name": name, "status": status})
            conn.commit()
        return dict(row)

    def rename_company(self, old_id: str, new_name: str | None = None, new_id: str | None = None) -> dict[str, Any]:
        """重命名/迁移公司 ID（级联更新所有关联表）"""
        if not new_name and not new_id:
            raise ValueError("new_name or new_id required")
        if new_id and new_id == old_id:
            raise ValueError(f"new_id must differ from current id: {old_id}")
        with closing(self.connect()) as conn:
            # Check new_id doesn't collide if changing id
            if new_id:
                existing = conn.execute("select id from companies where id = ?", (new_id,)).fetchone()
                if existing:
                    raise ValueError(f"company_id {new_id} already exists")
            # Build updates for companies table
            updates: list[str] = []
            params: list[Any] = []
            if new_name:
                updates.append("name = ?")
                params.append(new_name)
            if new_id:
                updates.append("id = ?")
                params.append(new_id)
                # Also update code if new_id is provided
                if "code" not in "".join(updates):
                    updates.append("code = ?")
                    params.append(new_id)
            if not updates:
                raise ValueError("nothing to update")
            # Cascade: update all related tables if id changes
            if new_id:
                conn.execute("update quotation_configs set company_id = ? where company_id = ?", (new_id, old_id))
                conn.execute("update quotation_items set company_id = ? where company_id = ?", (new_id, old_id))
                conn.execute("update audit_events set company_id = ? where company_id = ?", (new_id, old_id))
            params.append(old_id)
            result = conn.execute(
                f"update companies set {', '.join(updates)} where id = ?",  # noqa: S608
                params,
            )
            if result.rowcount == 0:
                raise LookupError(f"company {old_id} not found")
            target_id = new_id or old_id
            row = conn.execute(
                "select id, name, code, status, created_at from companies where id = ?",
                (target_id,),
            ).fetchone()
            self.audit(conn, target_id, None, "company.rename", "company", target_id,
                       {"old_id": old_id, "new_name": new_name, "new_id": new_id})
            conn.commit()
        return dict(row)

    def list_companies(self) -> list[dict[str, Any]]:
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "select id, name, code, status, created_at from companies order by created_at desc"
            ).fetchall()
        return [dict(row) for row in rows]

    def list_configs(self, company_id: str) -> list[dict[str, Any]]:
        with closing(self.connect()) as conn:
            rows = conn.execute(
                """
                select id, revision, status, created_by, published_at, created_at
                from quotation_configs
                where company_id = ?
                order by id desc
                """,
                (company_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def rollback_config(self, company_id: str, revision: str, actor_id: str | None = None) -> dict[str, Any]:
        config = self.get_config(company_id, revision)
        # save as new published, re-using the same revision label (normalize will keep revision)
        return self.save_config(company_id, config, status="published", actor_id=actor_id)

    def list_audit(self, company_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with closing(self.connect()) as conn:
            rows = conn.execute(
                """
                select id, actor_id, action, target_type, target_id, created_at
                from audit_events
                where company_id = ?
                order by id desc
                limit ?
                """,
                (company_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_items_stats(self, company_id: str) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                select data_revision,
                       count(*) as count,
                       max(id) as last_id
                from quotation_items
                where company_id = ?
                group by data_revision
                order by last_id desc
                limit 1
                """,
                (company_id,),
            ).fetchone()
        if not row:
            return {"data_revision": None, "count": 0}
        return {"data_revision": row["data_revision"], "count": row["count"]}

    def now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    # ─── Merger / Bundle ───────────────────────────────────────────────

    def detect_brands(
        self,
        files: list[tuple[str, bytes]],
        company_id: str,
    ) -> list[dict[str, Any]]:
        """
        上传多文件，按文件名识别品牌。
        files: [(filename, file_bytes), ...]
        返回: [{ filename, detected_brand, row_count, preview }]
        """
        try:
            config = self.get_active_config(company_id)
        except LookupError:
            config = {}

        brand_rules = (config.get("merger") or {}).get("brand_rules") or {}
        brands = brand_rules.get("brands") or []
        default_brand = str(brand_rules.get("defaultBrand") or "UNMAPPED").strip() or "UNMAPPED"

        results: list[dict[str, Any]] = []
        for filename, file_bytes in files:
            # 品牌检测：按文件名前缀匹配
            detected = default_brand
            basename = os.path.splitext(os.path.basename(filename))[0].upper()
            for brand in brands:
                brand_id = str(brand.get("id") or "").strip()
                for prefix in brand.get("prefixes") or []:
                    prefix_upper = str(prefix).strip().upper()
                    if prefix_upper and basename.startswith(prefix_upper):
                        detected = brand_id
                        break
                if detected != default_brand:
                    break

            # 解析文件行数
            try:
                rows, _ = self.parse_excel_to_rows(file_bytes, filename, company_id)
                row_count = len(rows)
                preview = rows[:3]
            except Exception:
                row_count = 0
                preview = []

            results.append({
                "filename": filename,
                "detected_brand": detected,
                "row_count": row_count,
                "preview": preview,
            })

        return results

    def build_price_bundle(
        self,
        company_id: str,
        password: str = "",
    ) -> dict[str, Any]:
        """
        从数据库数据生成价格 Bundle（与前端 bundle-utils.js 兼容格式）。
        password 为空时不加密，否则使用 AES-GCM + PBKDF2 加密。
        """
        try:
            config = self.get_active_config(company_id)
        except LookupError:
            config = {}

        primary_field = str((config.get("merger") or {}).get("primary_field") or "spec")
        searchable = [f["key"] for f in config.get("fields", []) if f.get("searchable")]
        key_field = searchable[0] if searchable else primary_field

        # 从数据库读取所有 items
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "SELECT item_key, fields_json FROM quotation_items WHERE company_id = ? ORDER BY id",
                (company_id,),
            ).fetchall()

        dataset_rows = []
        for row in rows:
            fields = json.loads(row["fields_json"])
            key = str(fields.get(key_field, "") or row["item_key"]).strip()
            if not key:
                continue
            if primary_field and key and primary_field not in fields:
                fields[primary_field] = key
            dataset_rows.append({"key": key, "fields": fields})

        dataset = {
            "schema_version": 2,
            "primary_field": primary_field,
            "rows": dataset_rows,
        }

        dataset_json = json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))

        secured = bool(password and password.strip())
        if secured:
            payload = self._encrypt_aes_gcm(dataset_json, password.strip())
        else:
            payload = base64.b64encode(dataset_json.encode("utf-8")).decode("ascii")

        return {
            "secured": secured,
            "payload": payload,
            "meta": {
                "version": datetime.now(timezone.utc).isoformat(),
                "rowCount": len(dataset_rows),
            },
        }

    def build_stock_bundle(self, company_id: str) -> dict[str, Any]:
        """
        从数据库数据生成库存 Bundle（不加密，与前端 bundle-utils.js 兼容格式）。
        """
        try:
            config = self.get_active_config(company_id)
        except LookupError:
            config = {}

        stock_key_field = str((config.get("merger") or {}).get("stock_key_field") or "code")

        with closing(self.connect()) as conn:
            rows = conn.execute(
                "SELECT item_key, fields_json FROM quotation_items WHERE company_id = ? ORDER BY id",
                (company_id,),
            ).fetchall()

        # 构建库存 dataset - 只包含有 stock 字段的行
        dataset_rows = []
        for row in rows:
            fields = json.loads(row["fields_json"])
            stock_val = fields.get("stock")
            if not stock_val:
                continue
            key = str(fields.get(stock_key_field, "") or row["item_key"]).strip()
            if not key:
                continue
            row_fields = {stock_key_field: key, "stock": str(stock_val)}
            dataset_rows.append({"key": key, "fields": row_fields})

        dataset = {
            "schema_version": 2,
            "key_field": stock_key_field,
            "rows": dataset_rows,
        }

        dataset_json = json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))
        payload = base64.b64encode(dataset_json.encode("utf-8")).decode("ascii")

        return {
            "secured": False,
            "payload": payload,
            "meta": {
                "version": datetime.now(timezone.utc).isoformat(),
                "rowCount": len(dataset_rows),
            },
        }

    def _encrypt_aes_gcm(self, plaintext: str, password: str) -> str:
        """AES-GCM 加密（PBKDF2 100k iterations SHA-256），与前端 bundle-utils.js 兼容。"""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes

        salt = os.urandom(16)
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
        )
        key = kdf.derive(password.encode("utf-8"))
        aesgcm = AESGCM(key)
        iv = os.urandom(12)
        cipher = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)

        # 布局: salt(16) + iv(12) + cipher
        bundle = salt + iv + cipher
        return base64.b64encode(bundle).decode("ascii")

    @staticmethod
    def build_supabase_write_url(public_url: str) -> str:
        """将 Supabase Storage 的 public URL 转换为写入 URL。"""
        write_url = public_url.replace("/storage/v1/object/public/", "/storage/v1/object/")
        if write_url == public_url:
            raise ValueError("data_source.base_url 必须是 Supabase Storage public object URL")
        return write_url
