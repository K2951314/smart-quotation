# Memory - 智能询价项目

## 项目架构

- **apps/index.html + apps/app.js**：唯一客户门户入口
  - authGate 覆盖层（登录表单）→ 登录后注入 g_CustomerProfile
  - admin 看面价/折扣/可调价；company 隐藏面价/折扣，显示「成本价/未税/含税」+ 利润率 + 含税切换
  - 公司账号无 discount-panel 调价按钮渲染
- admin/ + backend/：多租户 GUI 配置平台（schema_version 3）
  - admin/merger-app.js + admin/lib/：品牌识别 + Bundle 生成 + 加密（AES-GCM）（2026-06-29 merger/ 文件夹已删除，功能完整迁移至 admin/）
- 字段映射：单字母键 c/p/s/r/b/n/m/a/i 硬编码在 app.js
- Cache Storage API（quotation-cache-v3/v4）+ config.version 版本失效
- 品牌折扣引擎（动态品牌，根据 discount_rules 配置自动渲染）+ localStorage 持久化
- config-core.js 双向兼容 v2 `discount_rules` 和 v3 `rules` 格式
- **三菱库存查询**：嵌入 8001 FastAPI，`POST /api/stock-query` — 无认证、无 Pydantic
  - 格式：`{"queries": "型号1 材质1\n型号2\n..."}` → `{"results": ["行 库存信息", ...], "count": N}`
  - 凭据从 config.ini 三级降级加载（环境变量 → config.ini → cookie fallback）
  - 和原版 `D:\zhangkun\三菱库存\mobile_server.py` 同格式，只需一个 8001 服务

## 部署架构

- **本地开发**：`py -m backend.smart_quotation` → FastAPI 同源代理
- **生产**：Netlify 前端 + Railway/Render 后端
- apps/index.html 通过 HARDCODED_PROD_API 或 ?api= URL 参数切换后端

## 客户账号 · 专属定价 · 税务 · 利润率

- 登录：账号+密码（pbkdf2_hmac sha256 200k），7天会话令牌（DB存sha256哈希）
- 角色：account_type=admin（完整数据）/ company（脱敏+利润率+含税切换）
- 品牌折扣定价：base = 面价 × 品牌折扣%(config rules)
- 专属定价：品牌折扣价 + 价格表混合（可逐品覆盖 override_price）
- 税务：按客户设税率，前端含税/未税切换
- 利润率：客户自设全局利润（百分比/固定金额/无）
- 面价完全隐藏：服务端物理剔除 face_price/discount_rate
- 新增3表：customers / customer_prices / customer_sessions
- 新增17+ API端点：认证(3) + 管理端客户管理(9) + 客户端脱敏接口(5)
- 路由：`/api/customer/profile`（PATCH）、`/api/customer/me`（GET）、`/api/customer/config`（GET）
- 测试账号：TJLH/cs/cs（公司）、TJLH/admin_test/admin123（管理员）

## 多租户 GUI 配置系统（schema_version 3）

- 后端：FastAPI + SQLite，company_id 隔离，store.py 全套 CRUD
- API 端点 16+：公司管理、配置管理、数据管理、数据拼接、报价、审计、客户管理
- GUI admin/：10 个导航区（2026-06-08 删除数据导入区）
- 数据拼接区：品牌识别→数据合并→Bundle生成（AES-GCM加密可选）→Supabase部署
- **端口**：8001（8000 被 VMware NAT 占用）
- 依赖：fastapi, uvicorn, pydantic, PyYAML, openpyxl, python-multipart, cryptography
- **文档**：
  - `docs/gui-admin-guide.md`：中文 GUI 操作手册
  - `docs/multitenant-config-v1-zh.md`：中文技术说明，含架构/API/数据库模型/schema v3

## 配置数据流转链路 (2026-06-28 修复)

完整的 admin→backend→frontend 配置流转：
1. **admin 保存/发布** → POST /api/companies/{id}/config → SQLite quotation_configs
2. **发布时自动同步 Supabase** → config.json + version.json → Supabase Storage (s-q bucket)
3. **前端加载 (双路径)**：
   - 路径A: loadConfigFromApi() → /api/customer/config (SQ_API_BASE 已配置时优先)
   - 路径B: loadRemoteConfig() → Supabase config.json (回退)
4. **公司账号脱敏**：/api/customer/config 剔除 rules/pricing/face_price，保留 result_layout/labels/ui/fields/copy

## Bug 修复

- P0: 客户登录 config 404 — TJLH 配置 draft→published
- P0 (2026-06-28): **admin 配置不生效** — 4项根因修复：
  1. /api/customer/config 公司账号缺 result_layout 和 labels（api.py L589）
  2. loadConfigFromApi() localhost 限制（apps/app.js L850）
  3. admin 发布后未自动部署到 Supabase（admin/app.js saveConfig/rollbackToRevision）
  4. Netlify CSP connect-src 仅限 *.supabase.co（netlify.toml）
- P0: Supabase 400 — bucket ex(private)→s-q(public) + 4文件部署 + BundleGenerate/BundleDeploy 移到模块级
- P0: admin GUI 联动 — result_layout 路径不匹配(ui.result_layout→result_layout)、input 事件遗漏 data-ui-field-row、localStorage 折扣覆盖拦截远程配置
- P0: admin API 认证 — require_admin(customer token) → require_admin_api(API key Bearer)
- P1: admin/lib/config-core.js 同步 — v3 rules 解析 + gt/gte/lt/lte 数值比较操作符
- 完整报告：deliverables/gstack/pre-launch-check-quotation-2026-05-16.md

## 上线前全检 (2026-05-16)

- No-Go：远程脚本注入无校验、缺少安全响应头

## 刀具列折扣匹配问题结论 (2026-06-28)

- **根因**：多品牌 Excel 拼接（merger）过程中，长合品牌数据的 name 列映射与三菱规则字段不一致。折扣引擎的 `conditionMatches` + `getDiscountPreset` 逻辑本身**无 Bug**（Node.js 测试验证通过）。
- **现象**：result card 上显示 "刀具" chip（来自 `special` 字段），但三菱规则配置为 `field: "name" contains "刀具"`，导致匹配失败走 other 规则。
- **结论**：非代码缺陷，是数据拼接阶段的列名映射偏差。解决方案——在 admin 规则中将匹配字段从 `name` 改为 `special`，或在 merger 品牌拼接时统一列名映射。

## 下一步计划

- **多租户调整**：优化 company_id 隔离机制，完善客户专属定价的跨公司支持
- 折扣弹窗 + 配置流转链路均已修复，离线调试状态正常
