"""Excel/CSV 解析：按配置别名自动映射字段 + 未税面价转含税。"""

from __future__ import annotations

import io
from typing import Any

from .base import DEFAULT_COMPANY_ID


class ExcelMixin:
    """Excel 文件解析与字段映射。"""

    def parse_excel_to_rows(
        self,
        file_bytes: bytes,
        filename: str,
        *,
        sheet_index: int = 0,
        company_id: str = DEFAULT_COMPANY_ID,
        face_price_tax_inclusive: bool | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """解析 Excel(.xlsx) 或 CSV，使用当前发布配置的 excel_aliases 自动映射字段。

        返回 (rows, mapping_report)
          rows: 可直接传给 replace_items 的列表
          mapping_report: {matched: [...], unmatched: [...], total_rows: int}

        face_price_tax_inclusive:
          None  → 使用 config.pricing.face_price_tax_inclusive（默认 True）
          True  → 面价已是含税价，不做转换
          False → 面价为未税价，自动 ×(1+tax_rate/100) 转为含税价存储
        """
        # 获取字段别名映射表
        try:
            config = self.get_active_config(company_id=company_id)
        except LookupError:
            config = {}
        alias_map: dict[str, str] = {}
        for field in config.get("fields", []):
            for alias in field.get("excel_aliases", []):
                alias_map[alias] = field["key"]
            alias_map[field["key"]] = field["key"]

        # 税务转换参数
        pricing_cfg = config.get("pricing") or {}
        tax_rate = float(pricing_cfg.get("tax_rate", 13) or 13)
        if face_price_tax_inclusive is None:
            face_price_tax_inclusive = bool(pricing_cfg.get("face_price_tax_inclusive", True))
        need_tax_conversion = not face_price_tax_inclusive and tax_rate > 0

        # 解析文件
        if filename.lower().endswith(".csv"):
            import csv
            # CSV 编码自动探测：优先 UTF-8-sig，回退 GBK（中文 Windows 常见）
            try:
                text = file_bytes.decode("utf-8-sig")
            except UnicodeDecodeError:
                try:
                    text = file_bytes.decode("gbk")
                except UnicodeDecodeError:
                    text = file_bytes.decode("utf-8-sig", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
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
        col_mapping: dict[str, str] = {}
        for col in headers:
            if col in alias_map:
                col_mapping[col] = alias_map[col]

        matched = sorted({v for v in col_mapping.values()})
        unmatched = [col for col in headers if col not in col_mapping]

        searchable = [f["key"] for f in config.get("fields", []) if f.get("searchable")]
        key_field = searchable[0] if searchable else "spec"

        rows: list[dict[str, Any]] = []
        converted_count = 0
        for raw in raw_rows:
            fields: dict[str, Any] = {}
            for col, key in col_mapping.items():
                val = raw.get(col, "")
                try:
                    fields[key] = float(val) if "." in str(val) else int(val)
                except (ValueError, TypeError):
                    fields[key] = val
            if need_tax_conversion and "face_price" in fields:
                try:
                    original = float(fields["face_price"])
                    fields["face_price"] = round(original * (1 + tax_rate / 100), 2)
                    converted_count += 1
                except (ValueError, TypeError):
                    pass
            item_key = str(fields.get(key_field, "")).strip()
            if not item_key:
                continue
            rows.append({"item_key": item_key, "fields": fields})

        report = {
            "matched": matched,
            "unmatched": unmatched,
            "total_rows": len(rows),
        }
        if need_tax_conversion:
            report["tax_conversion"] = {
                "applied": True,
                "tax_rate": tax_rate,
                "converted_rows": converted_count,
                "note": f"面价已从未税转为含税（×{1 + tax_rate / 100:.4f}）",
            }
        return rows, report
