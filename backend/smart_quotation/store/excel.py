"""Excel/CSV 解析：按配置别名自动映射字段 + 未税面价转含税。"""

from __future__ import annotations

import io
from typing import Any

from .base import DEFAULT_COMPANY_ID

# 单次导入行数上限：防止超大文件全量读入内存导致 OOM
_MAX_IMPORT_ROWS = 50000

# 常见别名自动映射表：用户配置中未列出的列名（如库存表"物料长代码"）自动映射到对应字段，
# 避免配置遗漏导致字段缺失 → 库存 bundle key 不匹配 → 库存看不到。
# 优先级低于 config 的 excel_aliases（alias_map 优先）。
COMMON_ALIASES: dict[str, str] = {
    "物料长代码": "code",
    "物料编码": "code",
    "物料代码": "code",
    "代码": "code",
    "产品编码": "code",
    "商品编码": "code",
    "产品编号": "code",
    "物料编号": "code",
    "规格型号": "spec",
    "规格": "spec",
    "型号": "spec",
    "产品型号": "spec",
    "面价": "face_price",
    "销售单价": "face_price",
    "单价": "face_price",
    "含税单价": "face_price",
    "库存数量": "stock",
    "库存": "stock",
    "数量": "stock",
    "品牌": "brand",
    "产品名称": "name",
    "名称": "name",
}


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

        def _norm_alias(s: Any) -> str:
            # 归一化：去所有空格 + 小写，避免列名带空格/大小写差异导致匹配失败
            # （用户反馈：库存表列名带空格无法识别 → 映射失败 → 库存看不到了）
            return "".join(str(s or "").split()).lower()

        alias_map: dict[str, str] = {}
        for field in config.get("fields", []):
            for alias in field.get("excel_aliases", []):
                alias_map[_norm_alias(alias)] = field["key"]
            alias_map[_norm_alias(field["key"])] = field["key"]

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
            raw_rows = []
            for row in reader:
                # 边迭代边计数，超限立即抛错，避免 list(reader) 全量入内存 OOM
                if len(raw_rows) >= _MAX_IMPORT_ROWS:
                    raise ValueError(f"CSV 行数超限（>{_MAX_IMPORT_ROWS} 行），单次上限 {_MAX_IMPORT_ROWS} 行，请拆分文件后分批导入")
                # 与 xlsx 分支对齐：列名 strip（Excel 导出的 CSV 列头常带首尾空格，
                # 不 strip 会导致别名匹配静默失败 → face_price 缺失 → 报价变 0）
                raw_rows.append({str(k or "").strip(): v for k, v in row.items()})
            headers = list(raw_rows[0].keys()) if raw_rows else []
        elif filename.lower().endswith(".xls"):
            # .xls 旧格式：openpyxl 不支持，用 xlrd（否则库存表导入静默失败 → 库存看不到了）
            try:
                import xlrd
            except ImportError as exc:
                raise ImportError("请先安装 xlrd：pip install xlrd") from exc
            wb = xlrd.open_workbook(file_contents=file_bytes)
            ws = wb.sheet_by_index(sheet_index)
            if ws.nrows == 0:
                return [], {"matched": [], "unmatched": [], "total_rows": 0}
            headers = [str(ws.cell_value(0, c) or "").strip() for c in range(ws.ncols)]
            raw_rows = []
            for r in range(1, ws.nrows):
                if len(raw_rows) >= _MAX_IMPORT_ROWS:
                    raise ValueError(f"Excel 行数超限（>{_MAX_IMPORT_ROWS} 行），单次上限 {_MAX_IMPORT_ROWS} 行，请拆分文件后分批导入")
                row = [ws.cell_value(r, c) for c in range(ws.ncols)]
                if any(cell not in (None, "") for cell in row):
                    raw_rows.append({headers[i]: (str(cell) if cell is not None else "") for i, cell in enumerate(row)})
        else:
            try:
                import openpyxl
            except ImportError as exc:
                raise ImportError("请先安装 openpyxl：pip install openpyxl") from exc
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
            try:
                ws = wb.worksheets[sheet_index]
                all_rows = []
                for row in ws.iter_rows(values_only=True):
                    all_rows.append(row)
                    if len(all_rows) > _MAX_IMPORT_ROWS:
                        raise ValueError(f"Excel 行数超限（>{_MAX_IMPORT_ROWS} 行），单次上限 {_MAX_IMPORT_ROWS} 行，请拆分文件后分批导入")
            finally:
                # read_only 模式的解析器资源需显式释放，不能依赖 GC
                wb.close()
            if not all_rows:
                return [], {"matched": [], "unmatched": [], "total_rows": 0}
            headers = [str(h or "").strip() for h in all_rows[0]]
            raw_rows = [
                {headers[i]: (str(cell) if cell is not None else "") for i, cell in enumerate(row)}
                for row in all_rows[1:]
                if any(cell is not None for cell in row)
            ]

        # 字段映射（归一化匹配，忽略空格/大小写）
        col_mapping: dict[str, str] = {}
        for col in headers:
            norm = _norm_alias(col)
            if norm in alias_map:
                col_mapping[col] = alias_map[norm]
        # 对未匹配的列，用常见别名自动映射（用户配置的 excel_aliases 可能未覆盖所有列名，
        # 如库存表"物料长代码"→code，若不映射则 fields 缺 code → stock bundle key 错 → 库存不关联）
        for col in headers:
            if col in col_mapping:
                continue
            norm = _norm_alias(col)
            if norm in COMMON_ALIASES:
                col_mapping[col] = COMMON_ALIASES[norm]

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
                # key_field 列缺失时（库存表常只有 code+stock 无 spec），
                # fallback 用库存关联字段 + 主字段，避免整表被跳过 → 库存 bundle 空 → 库存看不到了
                stock_key_field = str((config.get("merger") or {}).get("stock_key_field") or "code")
                primary_field = str((config.get("merger") or {}).get("primary_field") or "spec")
                item_key = str(fields.get(stock_key_field, "") or fields.get(primary_field, "")).strip()
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
