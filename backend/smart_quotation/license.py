"""License 校验 + 订阅档位模块。

设计思路（第一性原理）：
- License = payload（JSON）+ HMAC-SHA256 签名
- 三档预设：free / pro / team，每档有固定的 features + quota
- quota 字段：max_companies, max_users, max_skus, max_brands,
  max_config_revisions, stock_query_daily_limit, audit_log_days, watermark
- 所有 quota 字段都有默认值，旧 license（无 quota 字段）向后兼容
- 本地开发 SQ_DEV=1 跳过校验

使用方式：
1. py scripts/generate_license.py --tier pro --customer "客户A"
2. 客户把生成的 license 写入环境变量 SQ_LICENSE
3. 后端启动时校验 license，过期或无效则拒绝启动

注意：HMAC 是对称签名，SECRET_KEY 一旦泄露客户可伪造 license。
生产环境建议升级为 RSA 非对称签名（私钥签，公钥验）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from typing import Any

from fastapi import Depends, HTTPException

logger = logging.getLogger(__name__)

# 开发模式临时密钥（每次启动随机生成，避免源码中残留固定弱值）
# 生产环境必须设置 SQ_LICENSE_SECRET 环境变量，否则拒绝启动
_DEV_SECRET: bytes | None = None

# License 有效性缓存
_license_cache: dict[str, Any] | None = None
_license_verified_at: float = 0

# 每 5 分钟重新校验一次（避免每次请求都解码）
_LICENSE_REVERIFY_INTERVAL = 300


# ─── 三档订阅预设 ─────────────────────────────────────────────
# 每档定义：features（功能开关）+ quota（用量上限）
# quota 中 -1 表示不限，0 表示禁用
TIER_FREE = "free"
TIER_PRO = "pro"
TIER_TEAM = "team"

TIER_PRESETS: dict[str, dict[str, Any]] = {
    TIER_FREE: {
        "features": ["core", "customer_portal"],
        "max_companies": 1,
        "max_users": 1,
        "max_skus": 500,
        "max_brands": 2,
        "max_config_revisions": 3,
        "stock_query_daily_limit": 0,
        "audit_log_days": 7,
        "watermark": True,
    },
    TIER_PRO: {
        "features": ["core", "customer_portal", "stock_query", "bundle_encryption",
                      "supabase_deploy", "api_access", "audit_log"],
        "max_companies": 1,
        "max_users": 3,
        "max_skus": 5000,
        "max_brands": -1,
        "max_config_revisions": 20,
        "stock_query_daily_limit": 50,
        "audit_log_days": 30,
        "watermark": False,
    },
    TIER_TEAM: {
        "features": ["core", "customer_portal", "stock_query", "bundle_encryption",
                      "supabase_deploy", "api_access", "audit_log",
                      "admin_member_inheritance", "tier_profit_grouping",
                      "db_backup", "custom_branding"],
        "max_companies": 5,
        "max_users": -1,
        "max_skus": -1,
        "max_brands": -1,
        "max_config_revisions": -1,
        "stock_query_daily_limit": 500,
        "audit_log_days": 90,
        "watermark": False,
    },
}


def _get_secret() -> bytes:
    """获取 license 签名密钥。

    生产环境：必须设置 SQ_LICENSE_SECRET，否则 raise RuntimeError 拒绝启动。
    开发环境（SQ_DEV=1）：未设置时生成随机临时密钥（每次启动不同），
    避免源码中残留固定弱值；开发模式下通常不验签，此密钥仅用于 generate_license()。
    """
    global _DEV_SECRET
    secret = os.environ.get("SQ_LICENSE_SECRET", "").strip()
    if secret:
        return secret.encode("utf-8")

    if os.environ.get("SQ_DEV", "0") == "1":
        if _DEV_SECRET is None:
            _DEV_SECRET = secrets.token_bytes(32)
            logger.warning("SQ_LICENSE_SECRET 未设置，开发模式使用随机临时密钥")
        return _DEV_SECRET

    raise RuntimeError(
        "SQ_LICENSE_SECRET 未设置。生产环境必须设置一个强随机字符串作为签名密钥。\n"
        "本地开发可设 SQ_DEV=1 跳过此校验。"
    )


def generate_license(
    customer: str,
    expires_at: str,
    *,
    product: str = "smart-quotation",
    features: list[str] | None = None,
    max_companies: int = 1,
    secret: str | None = None,
) -> str:
    """生成 license 字符串（兼容旧接口，推荐用 generate_tiered_license）。

    参数：
        customer: 客户名称
        expires_at: 过期时间，ISO 8601 格式（如 "2027-12-31T23:59:59Z"）
        product: 产品标识
        features: 授权功能列表（如 ["multi_tenant", "stock_query"]）
        max_companies: 最大公司数
        secret: 签名密钥（默认从环境变量读取）

    返回：base64 编码的 license 字符串，客户把它设为环境变量 SQ_LICENSE。

    示例：
        py -c "from backend.smart_quotation.license import generate_license; print(generate_license('客户A', '2027-12-31T23:59:59Z', max_companies=5, secret='your-secret'))"
    """
    if secret is None:
        secret = _get_secret().decode("utf-8")

    payload = {
        "product": product,
        "customer": customer,
        "expires_at": expires_at,
        "features": features or ["core"],
        "max_companies": max_companies,
        "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_json.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    license_obj = {"payload": payload, "signature": signature}
    license_json = json.dumps(license_obj, separators=(",", ":"))
    return base64.b64encode(license_json.encode("utf-8")).decode("ascii")


def generate_tiered_license(
    customer: str,
    tier: str,
    expires_at: str,
    *,
    secret: str | None = None,
    **overrides: Any,
) -> str:
    """按订阅档位生成 license（推荐用法）。

    参数：
        customer: 客户名称
        tier: 档位名 "free" / "pro" / "team"
        expires_at: 过期时间 ISO 8601
        secret: 签名密钥（默认从环境变量）
        **overrides: 覆盖预设的 quota 字段（如 max_companies=10）

    返回：base64 编码的 license 字符串。

    示例：
        py scripts/generate_license.py --tier pro --customer "客户A"
    """
    if tier not in TIER_PRESETS:
        raise ValueError(f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}")

    preset = dict(TIER_PRESETS[tier])
    preset.update(overrides)

    if secret is None:
        secret = _get_secret().decode("utf-8")

    payload = {
        "product": "smart-quotation",
        "customer": customer,
        "tier": tier,
        "expires_at": expires_at,
        "features": preset["features"],
        "max_companies": preset["max_companies"],
        "max_users": preset["max_users"],
        "max_skus": preset["max_skus"],
        "max_brands": preset["max_brands"],
        "max_config_revisions": preset["max_config_revisions"],
        "stock_query_daily_limit": preset["stock_query_daily_limit"],
        "audit_log_days": preset["audit_log_days"],
        "watermark": preset["watermark"],
        "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    signature = hmac.new(
        secret.encode("utf-8"),
        payload_json.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    license_obj = {"payload": payload, "signature": signature}
    license_json = json.dumps(license_obj, separators=(",", ":"))
    return base64.b64encode(license_json.encode("utf-8")).decode("ascii")


def _decode_license(license_str: str) -> dict[str, Any] | None:
    """解码并验签 license。无效则返回 None。"""
    if not license_str:
        return None
    try:
        license_json = base64.b64decode(license_str.strip()).decode("utf-8")
        license_obj = json.loads(license_json)
    except Exception:
        return None

    payload = license_obj.get("payload")
    signature = license_obj.get("signature")
    if not payload or not signature:
        return None

    # 重新计算签名
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    expected_sig = hmac.new(
        _get_secret(),
        payload_json.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(signature, expected_sig):
        return None

    return payload


# 开发模式 payload（所有功能开放，方便本地开发）
_DEV_PAYLOAD: dict[str, Any] = {
    "product": "smart-quotation",
    "customer": "DEVELOPMENT",
    "tier": "team",
    "expires_at": "2099-12-31T23:59:59Z",
    "features": TIER_PRESETS[TIER_TEAM]["features"],
    "max_companies": 999,
    "max_users": -1,
    "max_skus": -1,
    "max_brands": -1,
    "max_config_revisions": -1,
    "stock_query_daily_limit": 999,
    "audit_log_days": 90,
    "watermark": False,
    "issued_at": "dev",
}


def verify_license(force: bool = False) -> dict[str, Any] | None:
    """校验当前环境中的 license。

    返回 license payload（包含 customer、tier、features、quota 等），无效则返回 None。
    本地开发（SQ_DEV=1）时如果没设 license，返回开发用 payload（全功能）。
    """
    global _license_cache, _license_verified_at

    is_dev = os.environ.get("SQ_DEV", "0") == "1"

    # 本地开发：无 license 时返回开发 payload
    if is_dev and not os.environ.get("SQ_LICENSE", "").strip():
        return dict(_DEV_PAYLOAD)

    # 缓存检查（5 分钟内不重复解码）
    now = time.time()
    if not force and _license_cache is not None and (now - _license_verified_at) < _LICENSE_REVERIFY_INTERVAL:
        return _license_cache

    license_str = os.environ.get("SQ_LICENSE", "").strip()
    payload = _decode_license(license_str)

    if payload is None:
        if is_dev:
            # 本地开发 + license 无效：记录警告但放行
            logger.warning("SQ_LICENSE 无效或未设置，开发模式放行")
            _license_cache = dict(_DEV_PAYLOAD)
        else:
            _license_cache = None
        _license_verified_at = now
        return _license_cache

    # 检查过期
    expires_at = payload.get("expires_at", "")
    if expires_at:
        try:
            expiry = time.mktime(time.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ"))
            if now > expiry:
                logger.warning("License 已过期（%s）", expires_at)
                _license_cache = None
                _license_verified_at = now
                return None
        except (ValueError, OverflowError):
            # 日期格式错误，视为无效
            _license_cache = None
            _license_verified_at = now
            return None

    _license_cache = payload
    _license_verified_at = now
    return payload


def get_license_info() -> dict[str, Any]:
    """获取当前 license 信息（用于 /api/license/info 端点）。"""
    payload = verify_license()
    if payload is None:
        return {"valid": False, "reason": "SQ_LICENSE 未设置或无效"}
    return {
        "valid": True,
        "customer": payload.get("customer", "UNKNOWN"),
        "product": payload.get("product", "smart-quotation"),
        "tier": payload.get("tier", "free"),
        "expires_at": payload.get("expires_at", ""),
        "features": payload.get("features", []),
        "max_companies": payload.get("max_companies", 1),
        "max_users": payload.get("max_users", 1),
        "max_skus": payload.get("max_skus", 500),
        "max_brands": payload.get("max_brands", 2),
        "max_config_revisions": payload.get("max_config_revisions", 3),
        "stock_query_daily_limit": payload.get("stock_query_daily_limit", 0),
        "audit_log_days": payload.get("audit_log_days", 7),
        "watermark": payload.get("watermark", True),
    }


def has_feature(feature: str) -> bool:
    """检查 license 是否包含某功能。"""
    payload = verify_license()
    if payload is None:
        return False
    features = payload.get("features", [])
    return feature in features or "all" in features


def get_quota(field: str, default: Any = None) -> Any:
    """获取 quota 字段值。未设置时返回 default。

    常用 field：max_companies, max_users, max_skus, max_brands,
    max_config_revisions, stock_query_daily_limit, audit_log_days, watermark
    """
    payload = verify_license()
    if payload is None:
        return default
    return payload.get(field, default)


def require_feature(feature: str):
    """FastAPI 依赖：要求 license 包含某功能，否则返回 403。

    用法：
        @app.post("/api/xxx", dependencies=[Depends(require_feature("stock_query"))])
        def xxx(): ...
    """
    def _check() -> None:
        if not has_feature(feature):
            raise HTTPException(
                status_code=403,
                detail=f"当前订阅档位不包含此功能（{feature}），请升级订阅。",
            )
    return _check
