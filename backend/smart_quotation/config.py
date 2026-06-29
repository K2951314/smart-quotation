from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any


DEFAULT_FORMULA = "face_price * discount_percent / 100"

DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": 3,
    "revision": "",
    "data_source": {
        "base_url": "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/s-q",
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

    formula = (config.get("pricing") or {}).get("default_formula") or DEFAULT_FORMULA
    if "__" in formula or "import" in formula.lower():
        raise ValueError("pricing.default_formula contains forbidden tokens")
