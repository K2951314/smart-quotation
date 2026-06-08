# Memory - 智能询价项目

## 项目架构
- 纯前端询价工具，部署 Netlify，数据源 Supabase 公开存储桶
- 字段映射：单字母键 c/p/s/r/b/n/m/a/i 硬编码在 app.js
- AES-GCM 解密（PBKDF2 100k iterations SHA-256）加密价格包
- 动态脚本注入加载 bundle（已标记为安全风险，已修复为 JSON.parse）
- Cache Storage API（quotation-cache-v2）+ config.version 版本失效
- 品牌折扣引擎（EX活动/OSG/三菱/其他）+ localStorage 持久化
- config-core.js 双向兼容 v2 `discount_rules` 和 v3 `rules` 格式（2026-06-08 新增 v3→v2 规范化）

## 上线前全检结论 (2026-05-16)
- **No-Go**：2 个阻断项需修复
- P0-1: 远程脚本注入无校验（app.js:382-386），应改为 JSON.parse
- P0-2: 缺少安全响应头（CSP/X-Frame-Options/X-Content-Type-Options）
- P0-3: 新增 item rollback 接口 `DELETE /api/companies/{company_id}/items/rollback?data_revision=...`，用于撤销最近导入的数据版本
- 完整报告：deliverables/gstack/pre-launch-check-quotation-2026-05-16.md

## 字段配置化方案
- config.json 扩展：fields（字段映射+标签）、copy_columns（复制列）、copy_prefix、stock_prefix
- 5 Phase 渐进改造，Phase 1-2 零风险（1h），Phase 3-4 中风险（3.5h）
- 仅改显示层和复制层，不改数据合并层

## 多租户 GUI 配置系统（schema_version 3，已完成 v1 + 补全 + merger 迁移）
- 后端：FastAPI + SQLite，company_id 隔离，store.py 提供全套 CRUD
- API 端点总计 16+：公司管理(CRUD+软删除+重命名)、配置管理(CRUD+回滚+校验+导入导出)、数据管理(写入+上传+统计)、数据拼接(品牌识别+Bundle生成+Supabase部署)、报价、审计
- GUI admin/：10 个导航区（2026-06-08 删除数据导入区）
- 数据拼接区：品牌识别→数据合并→Bundle生成（AES-GCM加密可选）→Supabase部署
- 公司管理升级：页面加载自动显示公司列表、重命名/停用按钮
- 测试：34 条全绿（2026-06-04）
- 运行：`py -m backend.smart_quotation` → http://127.0.0.1:8001/admin/（2026-06-08 端口 8000 被 VMware NAT 占用，迁移至 8001）
- 依赖：fastapi, uvicorn, pydantic, PyYAML, openpyxl, python-multipart, cryptography
- **文档**：
  - `docs/gui-admin-guide.md`：中文 GUI 操作手册，覆盖 10 个功能区操作流程
  - `docs/multitenant-config-v1-zh.md`：中文技术说明，含架构/API 参考/数据库模型/schema v3 完整样例
  - `README.md` 已更新，补充多租户系统架构和启动说明
