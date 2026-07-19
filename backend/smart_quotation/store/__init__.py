"""QuotationStore — 多租户报价数据存储。

由以下 mixin 组合而成：
  - StoreBase:        连接管理、Schema 初始化、迁移
  - CompaniesMixin:   公司 CRUD + 访问令牌
  - ConfigsMixin:     配置版本化保存/发布/回滚/导入导出/脱敏
  - ItemsMixin:       商品数据 CRUD
  - AuditMixin:       审计日志
  - SecurityMixin:    安全事件（频率限制/暴力破解防护）
  - ExcelMixin:       Excel/CSV 解析
  - BundlesMixin:     价格包/库存包生成 + AES-GCM 加密
"""

from __future__ import annotations

from .base import DEFAULT_COMPANY_ID, SENSITIVE_FIELDS, ConfigCache, StoreBase
from .companies import CompaniesMixin
from .configs import ConfigsMixin
from .items import ItemsMixin
from .audit import AuditMixin
from .security import SecurityMixin
from .excel import ExcelMixin
from .bundles import BundlesMixin


class QuotationStore(
    CompaniesMixin,
    ConfigsMixin,
    ItemsMixin,
    AuditMixin,
    SecurityMixin,
    ExcelMixin,
    BundlesMixin,
    StoreBase,
):
    """多租户报价数据存储（SQLite 后端）。

    所有方法都通过 company_id 参数实现租户隔离。
    """
    pass


__all__ = [
    "QuotationStore",
    "ConfigCache",
    "DEFAULT_COMPANY_ID",
    "SENSITIVE_FIELDS",
]
