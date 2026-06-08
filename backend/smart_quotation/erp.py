from __future__ import annotations

from typing import Any


class ERPAdapter:
    provider = "base"

    async def fetch_items(self, company_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def fetch_prices(self, company_id: str, price_list: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def fetch_stock(self, company_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def create_quotation(self, company_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class ERPNextAdapter(ERPAdapter):
    provider = "erpnext"

    def require_configured(self, config: dict[str, Any]) -> None:
        if not config.get("enabled") or not config.get("base_url"):
            raise NotImplementedError("ERPNext integration is optional and not configured")

    async def fetch_items(self, company_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError("ERPNext item sync adapter is reserved for provider credentials")

    async def fetch_prices(self, company_id: str, price_list: str) -> list[dict[str, Any]]:
        raise NotImplementedError("ERPNext price sync adapter is reserved for provider credentials")

    async def fetch_stock(self, company_id: str) -> list[dict[str, Any]]:
        raise NotImplementedError("ERPNext stock sync adapter is reserved for provider credentials")

    async def create_quotation(self, company_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("ERPNext quotation push adapter is reserved for provider credentials")
