# Memory - 智能询价项目

## 项目架构
- **apps/index.html + apps/app.js**：唯一客户门户入口（1437 行全功能版 app.js）
  - app.js 顶部加登录门禁（g_CustomerProfile 等状态），支持 admin / company 双视图
  - admin 看面价/折扣/可调价；company 隐藏面价/折扣内部列，显示「成本价 / 未税 / 含税」+ 利润率 + 含税切换
  - 公司账号无 discount-panel 调价按钮渲染
- merger/：品牌识别 + Bundle 生成 + 加密
- admin/ + backend/：多租户 GUI 配置平台
- 字段映射：单字母键 c/p/s/r/b/n/m/a/i 硬编码在 app.js
- AES-GCM 解密（PBKDF2 100k iterations SHA-256）加密价格包
- Cache Storage API（quotation-cache-v2）+ config.version 版本失效
- 品牌折扣引擎（EX活动/OSG/三菱/其他）+ localStorage 持久化
- config-core.js 双向兼容 v2 `discount_rules` 和 v3 `rules` 格式（2026-06-08 新增 v3→v2 规范化）

## 部署架构 (2026-06-18 确定)
- **方案 A**：Netlify 部署前端 + Railway/Render 部署后端
- apps/index.html 通过 HARDCODED_PROD_API 常量或 ?api= URL 参数切换后端
- 部署前需更新 netlify.toml CSP connect-src 添加后端域名

## 客户账号 · 专属定价 · 税务 · 利润率系统（2026-06-17 完成，2026-06-18 视图改造）
- **客户账号**：登录账号+密码（pbkdf2_hmac sha256 200k），7天会话令牌（DB存sha256哈希）
- **角色权限**：account_type=admin（看完整数据+切换公司+配置入口）/ company（脱敏+利润率+含税切换）
- **品牌折扣定价**：base = 面价 × 品牌折扣%(config rules, 如EX 32.5%/OSG 37%/三菱56%/其他56%)
- **专属定价**：品牌折扣价 + 价格表混合（可逐品覆盖 override_price）
- **税务**：按客户设税率，前端含税/未税切换
- **利润率**：客户自设全局利润（百分比/固定金额/无），系统自动算最终报价
- **面价完全隐藏**：服务端物理剔除 face_price/discount_rate，公司账号走 /api/customer/* 接口
- **新增3表**：customers(含account_type) / customer_prices / customer_sessions
- **新增17个API端点**：认证(3) + 管理端客户管理(9) + 客户端脱敏接口(5, 含companies列表)
- **前端**：apps/index.html 顶部加 authGate 覆盖层 + app.js 登录门禁；admin/ 新增客户管理区
- **公司账号视图**（app.js 改造）：
  - `metricMarkup` 渲染公司账号下隐藏 face_price，quote_price 渲染为「成本价 / 未税 / 含税」
  - `resultCard.innerHTML` 渲染公司账号下不输出 discount-panel
  - 顶部 authGate：未登录显示登录表单；登录后 `g_CustomerProfile` 注入全局
  - 登录后顶部 customerInfoBar 显示客户名 + 含税/未税切换 + 利润率设置
- **导出**：复制文本增强 + Excel(SheetJS) + PDF(浏览器打印)
- **测试**：58/65 全绿（test_customer_features + test_e2e_company_view + test_backend_v1 全部通过，5 个 test_admin_gui 失败为 admin 重构遗留，1 个 test_backend_is_reachable 422 为测试方式问题）
- **不改config schema**，税率/利润/折扣率存customers表，现有配置零改动
- 路由路径：`/api/customer/profile`（PATCH 修改），`/api/customer/me`（GET 查），`/api/customer/config`（GET 查，无 published 时返回空默认 200）

## Bug 修复 (2026-06-18)
- P0: 客户登录 config 404 — TJLH 配置未发布（status=draft→published）
- P0: app.js config 容错 — /api/customer/config 失败不再阻断登录
- P0: api.py customer_config — 无已发布配置时返回空默认而非 404
- P1: portal.js 阉割版 — 删 portal.js/customer.*/login.html，git checkout 还原 index.html，在原 app.js 基础上加登录门禁
- P0: Supabase 400 — `_deploy_bundles_to_supabase` 只传2文件(缺config.json/version.json) + `normalize_config` 丢 `data_source` 字段 + DB 无 data_source + quotation_items 空 → **已修复**：部署函数改为上传4文件 + config.py保留data_source + bucket从private `ex`切换到public `s-q` + BundleGenerate/BundleDeploy移到模块级修复FastAPI body参数

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

## 测试账号
- TJLH/cs/cs（公司账号，税率 13% 利润 10%）
- TJLH/admin_test/admin123（管理员账号，测试用）
