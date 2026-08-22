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

logger = logging.getLogger(__name__)

# 开发模式临时密钥（每次启动随机生成，避免源码中残留固定弱值）
# 生产环境必须设置 SQ_LICENSE_SECRET 环境变量，否则拒绝启动
_DEV_SECRET: bytes | None = None

# License 有效性缓存
_license_cache: dict[str, Any] | None = None
_license_verified_at: float = 0

# 每 5 分钟重新校验一次（避免每次请求都解码）
_LICENSE_REVERIFY_INTERVAL = 300

# 过期宽限期（天）：license 过期后宽限期内仍放行并打 error 告警，
# 超期才 fail-closed 到免费档——避免合法客户因续费不及时业务突然中断。
_LICENSE_GRACE_PERIOD_DAYS = 7


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
                      "admin_member_inheritance", "tier_profit_grouping"],
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


def _get_public_key() -> str:
    """获取 RSA 公钥（PEM，用于 RS256 验签）。未设置时返回空字符串。"""
    return os.environ.get("SQ_LICENSE_PUBLIC_KEY", "").strip()


def _sign_rsa(payload_json: str, private_key_pem: str) -> str:
    """用 RSA 私钥签名（RS256），返回 base64 签名。"""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    sig = key.sign(payload_json.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(sig).decode("ascii")


def _verify_rsa(payload_json: str, signature_b64: str, public_key_pem: str) -> bool:
    """用 RSA 公钥验签（RS256）。失败（含公钥未配置/格式错误）返回 False。"""
    if not public_key_pem:
        return False
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    try:
        key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        sig = base64.b64decode(signature_b64)
        key.verify(sig, payload_json.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
        return True
    except Exception:
        return False


def _expiry_status(payload: dict[str, Any], now: float) -> str:
    """判断 license 过期状态：'valid'（有效）/ 'grace'（宽限期）/ 'expired'（失效）。

    宽限期：过期后 _LICENSE_GRACE_PERIOD_DAYS 天内仍放行（打 error 告警），
    超期才返回 'expired' 触发 fail-closed 到免费档。
    """
    expires_at = payload.get("expires_at", "")
    if not expires_at:
        return "valid"
    try:
        expiry = time.mktime(time.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, OverflowError):
        return "expired"  # 日期格式错误，视为失效
    if now <= expiry:
        return "valid"
    if now <= expiry + _LICENSE_GRACE_PERIOD_DAYS * 86400:
        return "grace"
    return "expired"


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
    private_key: str | None = None,
    **overrides: Any,
) -> str:
    """按订阅档位生成 license（推荐用法）。

    参数：
        customer: 客户名称
        tier: 档位名 "free" / "pro" / "team"
        expires_at: 过期时间 ISO 8601
        secret: HMAC 对称签名密钥（默认从环境变量；向后兼容旧部署）
        private_key: RSA 私钥 PEM（推荐，非对称签名；私钥只在供应商侧）
        **overrides: 覆盖预设的 quota 字段（如 max_companies=10）

    返回：base64 编码的 license 字符串。
    优先用 private_key（RSA RS256）；否则回退 secret（HMAC HS256）。

    示例：
        py scripts/generate_license.py --tier pro --customer "客户A"
        py scripts/generate_license.py --tier pro --customer "客户A" --private-key keys/private.pem
    """
    if tier not in TIER_PRESETS:
        raise ValueError(f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}")

    preset = dict(TIER_PRESETS[tier])
    preset.update(overrides)

    if private_key is None:
        private_key = os.environ.get("SQ_LICENSE_PRIVATE_KEY", "").strip() or None
    if secret is None and not private_key:
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
    if private_key:
        signature = _sign_rsa(payload_json, private_key)
        license_obj = {"alg": "RS256", "payload": payload, "signature": signature}
    else:
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

    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    alg = str(license_obj.get("alg") or "HS256")

    if alg == "RS256":
        # 非对称验签：公钥在部署侧（SQ_LICENSE_PUBLIC_KEY），私钥只在供应商侧。
        # 即使部署侧公钥泄露，攻击者也无法伪造 license（只有私钥能签）。
        if not _verify_rsa(payload_json, signature, _get_public_key()):
            return None
    else:
        # HS256（向后兼容旧 license）：HMAC-SHA256 对称验签
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

# 开发模式 tier 覆盖（仅 SQ_DEV=1 时生效，用于本地测试不同订阅档位）
# 设为 None 时走默认逻辑；设为 "free"/"pro"/"team" 时返回对应档位的 payload
_dev_tier_override: str | None = None

# 超管档位预览覆盖（不要求 SQ_DEV=1，用于生产环境超管预览不同档位功能）
# 与 _dev_tier_override 的区别：
#   - _dev_tier_override 仅在 SQ_DEV=1 时生效（本地开发专用）
#   - _admin_preview_override 不要求 SQ_DEV=1，但只影响 session/quota 显示，
#     不影响真实 license 校验（公开端点认证/限流照常工作）
# 安全约束：由路由层 require_superadmin 守卫，只有 ADMIN_API_KEY 持有者能设置。
_admin_preview_override: str | None = None


def set_dev_tier_override(tier: str | None) -> bool:
    """设置开发模式 tier 覆盖（仅 SQ_DEV=1 时生效）。

    用于本地测试不同订阅档位——无需重启后端，调用此函数即可切换。
    生产环境调用此函数是 no-op（返回 False）。

    Args:
        tier: "free" / "pro" / "team" / None（None = 清除覆盖，恢复默认）

    Returns:
        True = 覆盖成功，False = 非开发模式，拒绝覆盖
    """
    global _dev_tier_override, _license_cache, _license_verified_at
    is_dev = os.environ.get("SQ_DEV", "0") == "1"
    if not is_dev:
        return False
    if tier is not None and tier not in TIER_PRESETS:
        raise ValueError(f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}")
    _dev_tier_override = tier
    # 清除缓存，让下次 verify_license 重新生成
    _license_cache = None
    _license_verified_at = 0
    logger.info("开发模式 tier 覆盖已设置为: %s", tier)
    return True


def get_dev_tier_override() -> str | None:
    """获取当前开发模式 tier 覆盖值（None = 未覆盖）。"""
    return _dev_tier_override


def set_admin_preview_override(tier: str | None) -> None:
    """设置超管档位预览覆盖（不要求 SQ_DEV=1）。

    用于生产环境超管预览不同档位的功能门控和配额限制——
    不影响真实 license 校验，只影响 /api/auth/session 返回的 plan/quota/features。
    由路由层 /api/admin/preview-tier 守卫（require_superadmin）。

    Args:
        tier: "free" / "pro" / "team" / None（None = 清除预览，恢复真实 license 档位）
    """
    global _admin_preview_override
    if tier is not None and tier not in TIER_PRESETS:
        raise ValueError(f"未知档位: {tier}，可选: {list(TIER_PRESETS.keys())}")
    _admin_preview_override = tier
    # 清除 license 缓存，让下次 verify_license/session 重新计算
    global _license_cache, _license_verified_at
    _license_cache = None
    _license_verified_at = 0
    logger.info("超管档位预览已设置为: %s", tier)


def get_admin_preview_override() -> str | None:
    """获取当前超管档位预览覆盖值（None = 未预览）。"""
    return _admin_preview_override


def _build_dev_payload_for_tier(tier: str) -> dict[str, Any]:
    """根据 tier 构建开发模式 payload（基于 TIER_PRESETS，但放宽过期时间）。"""
    preset = dict(TIER_PRESETS[tier])
    return {
        "product": "smart-quotation",
        "customer": f"DEV-{tier.upper()}",
        "tier": tier,
        "expires_at": "2099-12-31T23:59:59Z",
        "features": preset["features"],
        "max_companies": preset["max_companies"],
        "max_users": preset["max_users"],
        "max_skus": preset["max_skus"],
        "max_brands": preset["max_brands"],
        "max_config_revisions": preset["max_config_revisions"],
        "stock_query_daily_limit": preset["stock_query_daily_limit"],
        "audit_log_days": preset["audit_log_days"],
        "watermark": preset["watermark"],
        "issued_at": "dev",
    }


def verify_license(force: bool = False) -> dict[str, Any] | None:
    """校验当前环境中的 license。

    返回 license payload（包含 customer、tier、features、quota 等），无效则返回 None。
    本地开发（SQ_DEV=1）时如果没设 license，返回开发用 payload（全功能）。

    开发模式 tier 覆盖：如果 set_dev_tier_override() 设置了覆盖值，
    返回对应档位的 payload（用于本地测试不同订阅）。
    """
    global _license_cache, _license_verified_at

    is_dev = os.environ.get("SQ_DEV", "0") == "1"

    # 开发模式 tier 覆盖优先级最高（用于本地测试不同档位）
    if is_dev and _dev_tier_override is not None:
        return _build_dev_payload_for_tier(_dev_tier_override)

    # 本地开发：无 license 且无覆盖时返回开发 payload
    if is_dev and not os.environ.get("SQ_LICENSE", "").strip():
        return dict(_DEV_PAYLOAD)

    # 缓存检查（5 分钟内不重复解码；但过期状态每次检查，消除缓存导致的过期检测延迟）
    now = time.time()
    if not force and _license_cache is not None and (now - _license_verified_at) < _LICENSE_REVERIFY_INTERVAL:
        status = _expiry_status(_license_cache, now)
        if status == "valid":
            return _license_cache
        if status == "grace":
            logger.error(
                "License 已过期（%s），宽限期 %d 天内仍放行，请尽快续费",
                _license_cache.get("expires_at"), _LICENSE_GRACE_PERIOD_DAYS,
            )
            return _license_cache
        # expired：缓存失效，走完整校验（返回 None 触发 fail-closed）
        _license_cache = None
        _license_verified_at = 0

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

    # 检查过期（含宽限期）
    status = _expiry_status(payload, now)
    if status == "expired":
        logger.error(
            "License 已过期且超过宽限期（%s），功能回退到免费档",
            payload.get("expires_at"),
        )
        _license_cache = None
        _license_verified_at = now
        return None
    if status == "grace":
        logger.error(
            "License 已过期（%s），宽限期 %d 天内仍放行，请尽快续费",
            payload.get("expires_at"), _LICENSE_GRACE_PERIOD_DAYS,
        )

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


def get_quota(field: str, default: Any = None) -> Any:
    """获取 quota 字段值。未设置时返回 default。

    常用 field：max_companies, max_users, max_skus, max_brands,
    max_config_revisions, stock_query_daily_limit, audit_log_days, watermark

    安全策略（fail-closed）：生产环境无有效 license 时回退到免费档默认值
    （免费档是最低合法授权），而非返回 default 中的 -1=不限，
    防止未授权实例绕过配额/功能门控。
    """
    payload = verify_license()
    if payload is None:
        # 无 license：fail-closed 到免费档配额
        return TIER_PRESETS[TIER_FREE].get(field, default)
    return payload.get(field, default)


# ─── 每租户订阅档位（per-tenant plan）────────────────────────
# 订阅档位从「全局 license」下沉到「每个客户公司」（company.meta.plan）。
# 全局 license 退化为「部署总授权」：只管 max_companies（总租户数上限）。
# 每租户 plan 决定该公司的功能开关 + 配额 + 水印。

# 档位等级（用于比较：license 允许的最高档位 >= 分配的 plan）
TIER_RANK: dict[str, int] = {TIER_FREE: 0, TIER_PRO: 1, TIER_TEAM: 2}


def plan_has_feature(plan: str, feature: str) -> bool:
    """检查某订阅档位（free/pro/team）是否包含某功能。非法档位回退 free。"""
    preset = TIER_PRESETS.get(plan) or TIER_PRESETS[TIER_FREE]
    features = preset.get("features", [])
    return feature in features or "all" in features


def get_plan_quota(plan: str, field: str, default: Any = None) -> Any:
    """获取某订阅档位的 quota 字段值。未设置返回 default。非法档位回退 free。"""
    preset = TIER_PRESETS.get(plan) or TIER_PRESETS[TIER_FREE]
    return preset.get(field, default)


def get_license_tier() -> str:
    """返回全局 license 的订阅档位（部署总授权的最高档位）。

    无有效 license 或 tier 非法时返回 free（fail-closed）。
    用于校验「每租户分配的 plan 不得超过部署 license 档位」。
    """
    payload = verify_license()
    if payload is None:
        return TIER_FREE
    tier = payload.get("tier", TIER_FREE)
    return tier if tier in TIER_PRESETS else TIER_FREE
