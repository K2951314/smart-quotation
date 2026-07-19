# CLAUDE.md — 智能询价

## 项目概览

这是一个多租户配置驱动的智能询价系统，包含：

- `apps/`：静态前端报价台 + 客户门户，基于远端配置和数据包运行。
- `admin/`：浏览器端 GUI 配置中心，面向非技术人员（含品牌识别、Bundle 生成与导出功能）。
- `backend/`：FastAPI + SQLite 后端，提供多租户公司、配置、数据、审计、客户管理和导入/回滚接口。

## 主要规则

- 该系统的关键隔离单位是 `company_id`。多租户真隔离正在分阶段落地（见路线图 P0-4）。
- `admin/` 前端和 `backend/` 后端共同构成多租户配置平台；`apps/` 是独立的静态报价台，不直接依赖 `admin/`。
- 配置发布与回滚：使用 `POST /api/config/{revision}/publish`。
- 商品数据回滚/撤销：使用 `DELETE /api/items/rollback?data_revision=...`。
- 配置文件 `config.example.json` 仅用于示例，**不应包含密钥、密码、Token 或任何机密值**。
- 如果需要写入密码或密钥，应在后端安全存储，不要硬编码到前端源码。
- **源码中不得硬编码任何客户/部署相关的真实 URL**（Supabase 项目地址、后端域名等），一律改为环境变量或 admin 配置中心注入。
- **后端启动必须设置 `ADMIN_API_KEY` 环境变量**（至少 16 字符）；本地开发可设 `SQ_DEV=1` 跳过校验。

## 客户门户 (apps/index.html)

- 入口：`apps/index.html`（统一入口，authGate 覆盖层）
- 依赖 FastAPI 后端（配置/数据/库存查询）+ Supabase Storage（config.json + price/stock bundles）
- **认证模式**（当前）：前端本地模式，profile 存于 sessionStorage 或由 `window.__COMPANY_PROFILE__` 构建期注入；后端不提供 customer 登录端点
- **产品边界说明**：如需真正的多租户客户登录（服务端校验、密码哈希、会话令牌），需在 backend 中补全 `customers` / `customer_sessions` 表与相关 API 端点（见路线图）
- 角色：admin 看完整数据（面价/折扣/报价），company 看脱敏数据（无面价/折扣）
- 定价：品牌折扣规则定价（config rules），base = 面价 × 品牌折扣%，再叠加利润/税务
- 税务：全局配置 `config.pricing.tax_rate`（默认 13%），在「定价设置」中统一配置；面价含税属性由 `config.pricing.face_price_tax_inclusive` 标注
- 利润率：公司账号自设全局利润（百分比），系统自动算最终报价
- 面价隐藏：公司账号下前端不渲染 discount-panel
- 折扣弹窗：动态渲染，根据 `discount_rules` 配置自动生成任意数量品牌输入框
- 三菱库存：`POST /api/stock-query`（需 `X-Stock-Key` 认证 + 频率限制），QueryEngine 通过 GWT-RPC 直连三菱官网
- `apps/login.html` → `apps/customer.html` 已废弃，统一使用 `apps/index.html` + authGate

## 部署架构

- **本地开发**：`py -m backend.smart_quotation` → FastAPI 同源代理 `apps/`
- **Netlify 生产**：`apps/` 部署 Netlify，FastAPI 后端独立部署到 Railway / Render 等平台
  - 前端 `getApiBase()` 自动探测：URL 参数 `?api=URL` → `localStorage.sq_api_base` → 同源
  - 后端地址不再硬编码到源码，部署方通过环境变量 `SQ_PROD_API_BASE` 或前端 URL 参数注入
  - Supabase 项目地址通过 admin 配置中心写入 `config.json` 的 `data_source.base_url`，或通过 `window.SQ_SUPABASE_BASE_URL` 覆盖
  - CSP `connect-src` 已设为 `https:` 通配以支持动态后端地址（`netlify.toml`）

## 运行与验证

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

- GUI 配置中心：`http://127.0.0.1:8001/admin/`
- API 健康检查：`http://127.0.0.1:8001/api/health`

测试命令：

```powershell
# Python 测试（主力，当前 28/28 全绿）
py -m pytest tests/ -v

# 兼容旧命令
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v

# JS 单元测试
node --test tests/*.test.js
```

## 文档指针

- `README.md`：项目概览、快速启动、功能列表、架构目录。
- `docs/gui-admin-guide.md`：用户操作手册，面向非技术人员。

## 记忆原则

- 不要把历史变更记录写入本文件。
- 本文件只保留项目架构、核心运行规则、重要边界和查阅指针。
- 具体实现细节、测试结果、每日日志保留在本地工作区（不入库）。

## 产品化路线图

### P0（已完成）

- [x] Admin API Key 强校验：未设置或弱值拒绝启动，用 `secrets.compare_digest` 防时序攻击
- [x] `/api/stock-query` 加认证（`X-Stock-Key`）+ 频率限制（60s/30 次）+ 单次条数上限（50 条）
- [x] 清理文档中不存在的 customer 端点引用，明确产品边界
- [x] 多租户 `company_id` 真隔离：schema 加 `company_id` 列 + 所有 CRUD 过滤 + 隔离性测试 21/21 通过

### P1（已完成）

- [x] 重写 README 与当前架构对齐
- [x] 品牌折扣规则完全配置驱动（移除前端硬编码品牌名）
- [x] 集成 Sentry 错误监控骨架（后端 observability.py + 前端按需加载）
- [x] 设计 license 校验机制（HMAC-SHA256 + 过期检查 + 功能授权）

### P2（后续）

- [x] 前端模块化重构（app.js 拆分）— apps/ 拆为 13 模块，admin/ 拆为 12 模块
- [ ] 部署文档（DEPLOYMENT.md）
- [ ] 产品官网 + 文档站
- [ ] 多租户客户登录（customers / customer_sessions 表 + API）
- [ ] PostgreSQL 迁移（多租户并发写入场景）
- [x] 合并双份 config-core.js（apps/ 与 admin/ 内容已统一，以 apps 版为基准 + scripts/sync-config-core.py 同步）
- [x] 消除 admin 源码真实折扣泄露（admin/lib/config-core.js 硬编码 32/36 → 改为中性 55）
- [x] 日志规范化（6 处 print() 改 logging）
- [ ] 三菱 GWT-RPC 常量外置 + 并发查询
