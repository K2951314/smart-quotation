"""License 校验模块。

设计思路：
- License = payload（JSON）+ HMAC-SHA256 签名
- 你保留私钥（SECRET_KEY），用签名工具给客户生成 license
- 客户端用同一个 SECRET_KEY 验签（HMAC 是对称的，生产中应换 RSA 非对称方案）
- License payload 包含：product、customer、expires_at、features、max_companies
- 本地开发 SQ_DEV=1 跳过校验

使用方式：
1. 你用 generate_license() 给客户生成 license 字符串
2. 客户把 license 写入环境变量 SQ_LICENSE 或通过 /api/license/verify 端点上传
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
    """生成 license 字符串（你用这个给客户签 license）。

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


def verify_license(force: bool = False) -> dict[str, Any] | None:
    """校验当前环境中的 license。

    返回 license payload（包含 customer、expires_at 等），无效则返回 None。
    本地开发（SQ_DEV=1）时如果没设 license，返回一个开发用 payload。
    """
    global _license_cache, _license_verified_at

    is_dev = os.environ.get("SQ_DEV", "0") == "1"

    # 本地开发：无 license 时返回开发 payload
    if is_dev and not os.environ.get("SQ_LICENSE", "").strip():
        return {
            "product": "smart-quotation",
            "customer": "DEVELOPMENT",
            "expires_at": "2099-12-31T23:59:59Z",
            "features": ["core", "multi_tenant", "stock_query"],
            "max_companies": 999,
            "issued_at": "dev",
        }

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
            _license_cache = {
                "product": "smart-quotation",
                "customer": "DEVELOPMENT",
                "expires_at": "2099-12-31T23:59:59Z",
                "features": ["core", "multi_tenant", "stock_query"],
                "max_companies": 999,
                "issued_at": "dev",
            }
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
        "expires_at": payload.get("expires_at", ""),
        "features": payload.get("features", []),
        "max_companies": payload.get("max_companies", 1),
    }


def has_feature(feature: str) -> bool:
    """检查 license 是否包含某功能。"""
    payload = verify_license()
    if payload is None:
        return False
    features = payload.get("features", [])
    return feature in features or "all" in features
