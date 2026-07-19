"""Pydantic 请求模型定义。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class CompanyCreate(BaseModel):
    id: str
    name: str
    meta: dict[str, Any] = Field(default_factory=dict)


class CompanyUpdate(BaseModel):
    name: str | None = None
    meta: dict[str, Any] | None = None


class ConfigSave(BaseModel):
    config: dict[str, Any]
    status: Literal["draft", "published"] = "draft"


class ItemsReplace(BaseModel):
    data_revision: str = "manual"
    rows: list[dict[str, Any]] = Field(default_factory=list)


class ConfigImport(BaseModel):
    content: str
    fmt: Literal["json", "yaml"] = "json"
    status: Literal["draft", "published"] = "draft"


class BundleGenerate(BaseModel):
    password: str = ""
    deploy: bool = False
    anon_key: str = ""
    role: Literal["admin", "company"] = "company"


class BundleDeploy(BaseModel):
    price_bundle: dict[str, Any]
    stock_bundle: dict[str, Any]
    anon_key: str
