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
    price_bundle: dict[str, Any] = Field(default_factory=dict)
    stock_bundle: dict[str, Any] = Field(default_factory=dict)
    anon_key: str


class RegisterRequest(BaseModel):
    """注册请求：创建租户管理员账号 + 公司。"""
    email: str
    password: str
    company_name: str


class LoginRequest(BaseModel):
    """登录请求：邮箱 + 密码 → JWT。"""
    email: str
    password: str


class ForgotPasswordRequest(BaseModel):
    """密码找回：提交邮箱，发送重置链接。"""
    email: str


class ResetPasswordRequest(BaseModel):
    """密码重置：用 reset_token 设置新密码。"""
    token: str
    password: str  # 新密码，至少 8 位


class ChangePasswordRequest(BaseModel):
    """登录用户自助修改密码（JWT 认证）。"""
    old_password: str
    new_password: str  # 新密码，至少 8 位


class SubAccountCreate(BaseModel):
    """子账号创建（租户给自己公司加登录席位）。"""
    email: str
    password: str  # 至少 8 位


class UserUpdate(BaseModel):
    """用户属性更新（超管）。

    字段语义（plan+到期 = 用户的「当前订阅」）：
    - plan: ""=不改, "free"/"pro"/"team"=分配, "inherit"=退订回公司级
    - plan_duration: "7d"/"1m"/"3m"/"6m"/"1y" 快捷时长。同档位=续期
      （从剩余时间顺延），换档位=替换（从现在起算）；优先于 plan_expires
    - plan_expires: None=不改, ""=清除（永久）, "2026-12-31"=到期时间。
      设置 plan 时 duration 和 expires 都不传则永久
    - is_active/company_id: None=不改, 否则设置新值
    """
    plan: str = ""  # 空=不改；"inherit"=退订回公司级；free/pro/team=分配
    plan_duration: str | None = None
    plan_expires: str | None = None
    is_active: bool | None = None
    company_id: str | None = None
