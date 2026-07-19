"""Bundle 生成与部署：价格包/库存包 + 品牌检测 + AES-GCM 加密。"""

from __future__ import annotations

import base64
import json
import os
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID, SENSITIVE_FIELDS


class BundlesMixin:
    """数据包生成：价格 Bundle（含加密/脱敏）、库存 Bundle、品牌检测。"""

    def detect_brands(
        self,
        files: list[tuple[str, bytes]],
        company_id: str = DEFAULT_COMPANY_ID,
    ) -> list[dict[str, Any]]:
        """上传多文件，按文件名前缀识别品牌。"""
        try:
            config = self.get_active_config(company_id=company_id)
        except LookupError:
            config = {}

        brand_rules = (config.get("merger") or {}).get("brand_rules") or {}
        brands = brand_rules.get("brands") or []
        default_brand = str(brand_rules.get("defaultBrand") or "UNMAPPED").strip() or "UNMAPPED"

        results: list[dict[str, Any]] = []
        for filename, file_bytes in files:
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
            try:
                rows, _ = self.parse_excel_to_rows(file_bytes, filename, company_id=company_id)
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
        password: str = "",
        company_id: str = DEFAULT_COMPANY_ID,
        role: str = "admin",
    ) -> dict[str, Any]:
        """从数据库数据生成价格 Bundle（与前端 bundle-utils.js 兼容格式）。

        password 为空时不加密，否则使用 AES-GCM + PBKDF2 加密。
        role='company' 时脱敏面价并预计算报价。
        """
        try:
            config = self.get_active_config(company_id=company_id)
        except LookupError:
            config = {}

        primary_field = str((config.get("merger") or {}).get("primary_field") or "spec")
        searchable = [f["key"] for f in config.get("fields", []) if f.get("searchable")]
        key_field = searchable[0] if searchable else primary_field

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
            if role == "company":
                fields = self._desensitize_item_fields(fields, config)
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
                "company_id": company_id,
                "role": role,
            },
        }

    def _desensitize_item_fields(self, fields: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        """脱敏单个商品字段：通过正式报价引擎计算 quote_price，然后移除敏感字段。

        复用 QuotationEngine.quote_row 确保客户价格包与服务端报价完全一致，
        包括自定义公式、规则动作（set_field/set_formula）、取整策略。
        """
        from ..engine import QuotationEngine

        # 用正式引擎计算（复用公式、规则、取整逻辑）
        quoted = QuotationEngine(self).quote_row({"item_key": "", "fields": dict(fields)}, config)
        safe = quoted["fields"]

        # 移除敏感字段（面价、折扣、成本等）
        security = config.get("security") or {}
        sensitive_fields = set(security.get("sensitive_fields") or list(SENSITIVE_FIELDS))
        for sensitive in sensitive_fields:
            safe.pop(sensitive, None)
        return safe

    def build_stock_bundle(self, company_id: str = DEFAULT_COMPANY_ID) -> dict[str, Any]:
        """从数据库数据生成库存 Bundle（不加密，与前端 bundle-utils.js 兼容格式）。"""
        try:
            config = self.get_active_config(company_id=company_id)
        except LookupError:
            config = {}

        stock_key_field = str((config.get("merger") or {}).get("stock_key_field") or "code")

        with closing(self.connect()) as conn:
            rows = conn.execute(
                "SELECT item_key, fields_json FROM quotation_items WHERE company_id = ? ORDER BY id",
                (company_id,),
            ).fetchall()

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
                "company_id": company_id,
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
