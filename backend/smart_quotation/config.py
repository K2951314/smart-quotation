from __future__ import annotations

import copy
import os
import re
from datetime import datetime, timezone
from typing import Any


DEFAULT_FORMULA = "face_price * discount_percent / 100"

DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": 3,
    "revision": "",
    "data_source": {
        # 部署期注入：通过 admin 配置中心或环境变量 SQ_SUPABASE_BASE_URL 设置
        "base_url": os.environ.get("SQ_SUPABASE_BASE_URL", ""),
        "version_file": "version.json",
        "config_file": "config.json",
        "price_bundle_file": "price.bundle.json",
        "stock_bundle_file": "stock.bundle.json",
        "cache_name": "quotation-cache-v3",
    },
    "pricing": {
        "currency": "CNY",
        "decimal_places": 1,
        "rounding": {"mode": "ceil", "integer_above": 100},
        "default_formula": DEFAULT_FORMULA,
        # 税率（全局，非公司级）——中国工业品增值税率几乎统一为 13%。
        # 仅在"切换未税价"时使用：未税价 = 含税价 / (1 + tax_rate/100)。
        "tax_rate": 13,
        # 面价是否含税。上传价格表时若标注为未税，入库时自动 ×(1+tax_rate) 转为含税存储。
        "face_price_tax_inclusive": True,
    },
    "fields": [
        {
            "key": "spec",
            "label": "规格型号",
            "type": "text",
            "source": "price",
            "excel_aliases": ["规格型号", "规格", "型号"],
            "searchable": True,
            "copyable": True,
            "required": True,
            "result_area": "identity",
        },
        {
            "key": "face_price",
            "label": "面价",
            "type": "number",
            "source": "price",
            "excel_aliases": ["销售单价", "面价", "目录价", "单价"],
            "searchable": False,
            "copyable": False,
            "required": False,
            "result_area": "metric",
        },
        {
            "key": "quote_price",
            "label": "报价",
            "type": "computed",
            "source": "computed",
            "excel_aliases": [],
            "searchable": False,
            "copyable": True,
            "required": False,
            "result_area": "metric",
        },
    ],
    "rules": [
        {
            "id": "default",
            "label": "默认折扣",
            "priority": 9999,
            "default": True,
            "actions": [{"type": "set_discount", "percent": 55}],
        }
    ],
    "copy": {
        "columns": [
            {"field": "spec", "label": "规格", "default": True, "line": "main"},
            {"field": "quote_price", "label": "报价", "default": True, "line": "main", "prefix": "含税"},
        ]
    },
    "ui": {
        "app_title": "智能询价系统",
        "result_layout": {
            "identity": ["spec"],
            "metrics": ["face_price", "quote_price"],
            "chips": [],
            "details": [],
        },
    },
    "integrations": {},
}


def deep_merge(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in (incoming or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        elif value is not None:
            out[key] = copy.deepcopy(value)
    return out


def now_revision() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d.%H%M%S")


def normalize_field(field: dict[str, Any]) -> dict[str, Any]:
    key = str(field.get("key") or "").strip()
    return {
        "key": key,
        "label": str(field.get("label") or key).strip() or key,
        "type": str(field.get("type") or "text").strip() or "text",
        "source": str(field.get("source") or "price").strip() or "price",
        "excel_aliases": [str(item).strip() for item in field.get("excel_aliases") or [] if str(item).strip()],
        "searchable": bool(field.get("searchable")),
        "copyable": bool(field.get("copyable")),
        "required": bool(field.get("required")),
        "result_area": str(field.get("result_area") or "detail").strip() or "detail",
    }


def v2_rule_to_v3(rule: dict[str, Any], index: int) -> dict[str, Any]:
    conditions = rule.get("conditions") or []
    v3_conditions = []
    for item in (conditions or []):
        item = item or {}
        field = str(item.get("field") or "").strip()
        if "contains" in item:
            v3_conditions.append({"field": field, "op": "contains", "value": item.get("contains")})
        elif "equals" in item:
            v3_conditions.append({"field": field, "op": "equals", "value": item.get("equals")})
        elif "regex" in item:
            v3_conditions.append({"field": field, "op": "regex", "value": item.get("regex")})
        else:
            v3_conditions.append({"field": field, "op": "equals", "value": ""})
    out = {
        "id": str(rule.get("id") or rule.get("label") or f"rule_{index}"),
        "label": str(rule.get("label") or rule.get("id") or f"规则 {index + 1}"),
        "priority": int(rule.get("priority") or ((index + 1) * 10)),
        "default": bool(rule.get("default")),
        "actions": [{"type": "set_discount", "percent": float(rule.get("percent", 55))}],
    }
    if v3_conditions:
        out["when"] = {"all": v3_conditions}
    return out


def normalize_config(raw_config: dict[str, Any] | None) -> dict[str, Any]:
    raw = copy.deepcopy(raw_config or {})
    schema_version = int(raw.get("schema_version") or 2)

    if schema_version <= 2:
        revision = str(raw.get("version") or raw.get("revision") or now_revision())
        rounding_threshold = raw.get("pricing", {}).get("rounding_threshold", raw.get("rounding_threshold", 100))
        decimal_places = raw.get("pricing", {}).get("decimal_places", raw.get("decimal_places", 1))
        migrated = {
            "schema_version": 3,
            "revision": revision,
            "pricing": {
                "currency": "CNY",
                "decimal_places": decimal_places,
                "rounding": {"mode": "ceil", "integer_above": rounding_threshold},
                "default_formula": DEFAULT_FORMULA,
                "tax_rate": 13,
                "face_price_tax_inclusive": True,
            },
            "fields": [normalize_field(item or {}) for item in raw.get("fields") or DEFAULT_CONFIG["fields"]],
            "rules": [v2_rule_to_v3(item or {}, index) for index, item in enumerate(raw.get("discount_rules") or [])],
            "copy": copy.deepcopy(raw.get("copy") or DEFAULT_CONFIG["copy"]),
            "ui": {
                "app_title": (raw.get("labels") or {}).get("app_title", DEFAULT_CONFIG["ui"]["app_title"]),
                "result_layout": copy.deepcopy(raw.get("result_layout") or DEFAULT_CONFIG["ui"]["result_layout"]),
            },
            "integrations": copy.deepcopy(DEFAULT_CONFIG["integrations"]),
            "data_source": deep_merge(DEFAULT_CONFIG["data_source"], raw.get("data_source") or {}),
        }
    else:
        migrated = deep_merge(DEFAULT_CONFIG, raw)
        migrated["schema_version"] = 3
        migrated["revision"] = str(raw.get("revision") or raw.get("version") or now_revision())
        migrated["fields"] = [normalize_field(item or {}) for item in migrated.get("fields") or []]

    if not migrated.get("rules"):
        migrated["rules"] = copy.deepcopy(DEFAULT_CONFIG["rules"])

    validate_config(migrated)
    return migrated


def validate_config(config: dict[str, Any]) -> None:
    fields = config.get("fields") or []
    field_keys = {item.get("key") for item in fields if item.get("key")}
    if not fields:
        raise ValueError("fields must contain at least one field")
    for index, field in enumerate(fields):
        if not field.get("key"):
            raise ValueError(f"fields[{index}].key is required")

    if not any(rule.get("default") for rule in config.get("rules") or []):
        raise ValueError("rules must include one default rule")

    for rule in config.get("rules") or []:
        for action in rule.get("actions") or []:
            action_type = action.get("type")
            if action_type not in {"set_discount", "set_field", "set_formula", "stop"}:
                raise ValueError(f"unsupported action type: {action_type}")
            if action_type == "set_field" and action.get("field") not in field_keys:
                raise ValueError(f"set_field references unknown field: {action.get('field')}")
        for cond in _iter_when_conditions(rule.get("when") or {}):
            if cond.get("op") == "regex":
                try:
                    validate_regex_pattern(str(cond.get("value") or ""))
                except ValueError as exc:
                    raise ValueError(f"rule '{rule.get('id')}' regex condition rejected: {exc}") from exc

    formula = (config.get("pricing") or {}).get("default_formula") or DEFAULT_FORMULA
    if "__" in formula or "import" in formula.lower():
        raise ValueError("pricing.default_formula contains forbidden tokens")


# ─── ReDoS 防护 ─────────────────────────────────────────────
# 规则正则由管理员经配置写入，但配置导入可能带入误操作/恶意 pattern。
# 嵌套量词（如 (a+)+、(x{2,})*）在特定输入下产生指数级回溯，可卡死报价
# worker（quote 对每行每条规则求值）。在保存期拦截成本最低。
MAX_REGEX_PATTERN_LENGTH = 200
_NESTED_QUANTIFIER_RE = re.compile(
    r"\([^()]*(?:[+*]|\{\d+(?:,\d*)?\})[^()]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})"
)


def validate_regex_pattern(pattern: str) -> None:
    """校验规则正则：长度上限 + 必须可编译 + 禁止嵌套量词。"""
    if len(pattern) > MAX_REGEX_PATTERN_LENGTH:
        raise ValueError(f"regex pattern too long ({len(pattern)} > {MAX_REGEX_PATTERN_LENGTH})")
    try:
        re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"regex pattern invalid: {exc}") from exc
    if _NESTED_QUANTIFIER_RE.search(pattern):
        raise ValueError(f"regex pattern has nested quantifiers (ReDoS risk): {pattern[:50]}")


def _iter_when_conditions(when: dict[str, Any]):
    """递归展开 when 条件树（all/any/not），产出叶子条件。"""
    if not isinstance(when, dict):
        return
    for key in ("all", "any"):
        if key in when:
            for item in when.get(key) or []:
                yield from _iter_when_conditions(item)
    if "not" in when:
        yield from _iter_when_conditions(when.get("not"))
    if when.get("op"):
        yield when
