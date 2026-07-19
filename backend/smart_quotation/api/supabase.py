"""Supabase 部署辅助：SSRF 防护 + Bundle 上传。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from ..store import QuotationStore


def validate_supabase_url(url: str, is_dev: bool) -> None:
    """SSRF 防护：校验 URL 是否为合法的 HTTPS Supabase 地址。

    拒绝条件：
    - 非 HTTPS 协议
    - 解析到内网 IP（10.x / 172.16-31.x / 192.168.x / 127.x / 169.254.x）
    - 非 Supabase 域名（除非 SQ_DEV=1 允许任意 HTTPS）
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"SSRF 防护：base_url 必须使用 HTTPS（收到 {parsed.scheme}）")

    hostname = parsed.hostname or ""
    if not hostname:
        raise ValueError("SSRF 防护：URL 缺少主机名")

    if not is_dev:
        allowed_suffixes = (".supabase.co", ".supabase.in", ".supabase.net")
        if not any(hostname.endswith(s) for s in allowed_suffixes):
            raise ValueError(
                f"SSRF 防护：base_url 主机名 {hostname} 不是 Supabase 域名。"
                f"如需自定义存储地址，请设置 SQ_DEV=1。"
            )

    try:
        infos = socket.getaddrinfo(hostname, None)
        for family, _, _, _, sockaddr in infos:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise ValueError(
                    f"SSRF 防护：base_url 主机名 {hostname} 解析到内网/保留地址 {ip}"
                )
    except socket.gaierror:
        raise ValueError(f"SSRF 防护：无法解析主机名 {hostname}")


def deploy_bundles_to_supabase(
    config: dict[str, Any],
    price_bundle: dict[str, Any],
    stock_bundle: dict[str, Any],
    anon_key: str,
    is_dev: bool,
) -> dict[str, str]:
    """将 Bundle + config.json + version.json 上传到 Supabase Storage。"""
    data_source = config.get("data_source") or {}
    base_url = str(data_source.get("base_url") or "").rstrip("/")
    if not base_url:
        raise ValueError("配置缺少 data_source.base_url")

    validate_supabase_url(base_url, is_dev)

    price_file = str(data_source.get("price_bundle_file") or "price.bundle.json")
    stock_file = str(data_source.get("stock_bundle_file") or "stock.bundle.json")
    config_file = str(data_source.get("config_file") or "config.json")
    version_file = str(data_source.get("version_file") or "version.json")

    results: dict[str, str] = {}

    def _upload(label: str, filename: str, body: bytes) -> None:
        if filename.startswith("http"):
            public_url = filename
            validate_supabase_url(public_url, is_dev)
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

    _upload("price", price_file, json.dumps(price_bundle, ensure_ascii=False).encode("utf-8"))
    results["price"] = f"deployed ({price_bundle.get('meta', {}).get('rowCount', '?')} rows)"

    _upload("stock", stock_file, json.dumps(stock_bundle, ensure_ascii=False).encode("utf-8"))
    results["stock"] = f"deployed ({stock_bundle.get('meta', {}).get('rowCount', '?')} rows)"

    _upload("config", config_file, json.dumps(config, ensure_ascii=False).encode("utf-8"))
    results["config"] = "deployed"

    revision = str(config.get("revision") or config.get("version") or "")
    version_payload = json.dumps(
        {"version": revision, "updated_at": datetime.now(timezone.utc).isoformat()},
        ensure_ascii=False,
    ).encode("utf-8")
    _upload("version", version_file, version_payload)
    results["version"] = f"deployed ({revision})"

    return results
