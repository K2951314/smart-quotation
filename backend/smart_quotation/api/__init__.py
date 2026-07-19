"""Smart Quotation API — FastAPI 应用工厂。

模块结构：
  - factory.py:        create_app() 工厂（CORS、状态、静态文件挂载）
  - auth.py:           认证依赖与频率限制
  - models.py:         Pydantic 请求模型
  - supabase.py:       SSRF 防护 + Bundle 部署辅助
  - routes_public.py:  公开端点（健康检查、config/bundle 代理）
  - routes_companies.py: 公司 CRUD
  - routes_config.py:  配置管理（保存/发布/回滚/导入导出/校验）
  - routes_items.py:   商品数据（替换/上传/回滚/报价查询）
  - routes_merger.py:  品牌检测 + Bundle 生成与部署
  - routes_stock.py:   三菱库存查询
"""

from __future__ import annotations

from .factory import create_app

__all__ = ["create_app"]
