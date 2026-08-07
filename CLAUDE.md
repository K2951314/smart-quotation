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
- **后端启动必须设置 `ADMIN_API_KEY` 环境变量**（至少 16 字符）和 `JWT_SECRET`（至少 32 字符）；本地开发可设 `SQ_DEV=1` 跳过校验（JWT_SECRET 自动生成随机密钥）。
- **上传 config.json 到 Supabase 必须使用 `desensitizeConfigForPublic()` 统一脱敏函数**（`admin/lib/supabase-deploy.js`），不得手写脱敏逻辑，避免遗漏 rules/discount_rules 导致折扣规则泄露到公开桶。
- **恢复配置走后端 API（`GET /api/config`）**，不从 Supabase 恢复（Supabase 上是脱敏版，无 rules，恢复后再保存会丢 rules）。
- **一键同步全部**会上传全部 4 个文件（config.json + price.bundle.json + stock.bundle.json + version.json）。
- **双数据库模式**：`DATABASE_URL` 以 `postgres://` 或 `postgresql://` 开头时走 PostgreSQL（SaaS 模式），否则走 SQLite（本地开发/测试）。psycopg2 懒加载，SQLite 模式零依赖。**生产环境架构断言**：未设 `SQ_DEV` 时，必须设置 `DATABASE_URL`（PostgreSQL）或 `DB_PATH`（指向持久化 Volume），否则后端拒绝启动——SQLite 文件在 Railway/Render 免费版重启后丢失。
- **认证双模式**：`ADMIN_API_KEY`（超管，全平台权限）+ JWT（租户管理员，绑定 `company_id`）。`require_admin_api` 先检查 API Key，再尝试 JWT，最后开发模式兜底。返回 `{"role": "superadmin"|"tenant"|"dev", "company_id": ...}` 供下游依赖使用。
- **租户隔离三依赖**：`require_admin_api`（认证）→ `resolve_company_id`（租户强制使用 JWT 中的 `company_id`）→ `require_superadmin`（公司创建/删除/assign-tier 等平台级操作限超管）。所有接受 `company_id` 查询参数的 admin 路由必须用 `Depends(resolve_company_id)` 而非 `Query(DEFAULT_COMPANY_ID)`，否则 JWT 用户可越权。
- **注册/登录流程**：`admin/register.html` 填邮箱+密码+公司名 → `POST /api/auth/register` 自动创建公司+用户 → 返回 JWT → 跳转配置中心。`admin/login.html` 邮箱+密码登录。
- **订阅档位系统**：三档预设 `free`/`pro`/`team`，每档定义 `features`（功能开关）+ `quota`（用量上限）。License payload 包含 `tier` 字段 + 所有 quota 字段。功能门控通过 `has_feature()` / `get_quota()` 在路由层检查，未授权返回 403。生成 license 用 `py scripts/generate_license.py --tier pro --customer "客户A"`。
- **会话信息端点**：`GET /api/auth/session`（所有认证用户可访问）返回 `{role, is_dev, tier, features, email, company_id, dev_tier_override}`，供前端显示角色徽标 + 档位徽标 + 开发模式标记。与 `GET /api/license/info`（超管专属，返回完整 license 详情含 customer/过期时间）互补。
- **开发模式档位切换**：`POST /api/dev/set-tier`（仅 `SQ_DEV=1` 时可用）可一键切换 free/pro/team 档位，无需重启后端。用于本地测试不同订阅的功能门控和配额限制。生产环境调用返回 403。前端在 admin topbar 显示切换器（`admin/lib/session-panel.js`）。

## 客户门户 (apps/index.html)

- 入口：`apps/index.html`（统一入口，authGate 覆盖层）
- 依赖 FastAPI 后端（配置/数据/库存查询）+ Supabase Storage（config.json + price/stock bundles）
- **认证模式**（当前）：前端本地模式，凭证默认存 localStorage（「保持登录」默认勾选，可取消退回 sessionStorage；admin 令牌永不持久），页头「退出」按钮调 clearAllAuth()，401 自动清凭证；后端不提供 customer 登录端点
- **产品边界说明**：如需真正的多租户客户登录（服务端校验、密码哈希、会话令牌），需在 backend 中补全 `customers` / `customer_sessions` 表与相关 API 端点（见路线图）
- 角色：admin 看完整数据（面价/折扣/报价），company 看脱敏数据（无面价/无折扣规则，防止反推成本）
- 定价：品牌折扣规则定价（config rules），base = 面价 × 品牌折扣%，再叠加利润/税务
- 税务：全局配置 `config.pricing.tax_rate`（默认 13%），在「定价设置」中统一配置；面价含税属性由 `config.pricing.face_price_tax_inclusive` 标注
- 利润率：公司账号通过「利润设置」弹窗（`profit-config.js`）自设全局利润（百分比），系统自动算最终报价；客户版步进预设为 0.5/1/5（默认 1），管理员版折扣步进为 0.1/0.5/1（默认 0.1）
- 面价隐藏：公司账号下 discount-panel 改造为利润步进器（不显示面价/折扣规则，防止反推成本）
- 折扣弹窗：动态渲染，根据 `discount_rules` 配置自动生成任意数量品牌输入框
- 三菱库存：`POST /api/stock-query`（需 `X-Stock-Key` 认证 + 频率限制），QueryEngine 通过 GWT-RPC 直连三菱官网；终端客户检测逻辑根据响应数组长度动态选择索引位置（标准格式用固定索引 46/47，扩展格式用倒数第3/4位）
- `apps/login.html` → `apps/customer.html` 已废弃，统一使用 `apps/index.html` + authGate

## 部署架构

- **本地开发**：`py -m backend.smart_quotation` → FastAPI 同源代理 `apps/` 和 `admin/`
- **生产部署**（两套可选）：
  - **后端同源**（推荐）：Railway/Render 部署后端，通过 `https://<后端域名>/admin/` 和 `/apps/` 直接访问，无需 CORS
  - **Netlify 独立**：`apps/` 和 `admin/` 分别部署 Netlify，通过 Netlify Snippet injection 注入 `window.SQ_PROD_API_BASE` 指向后端（`?api=URL` 仅本地开发生效，生产环境已禁用防 API 劫持）
- **后端地址探测**（前端 `getApiBase()` 优先级）：
  1. 构建期/运行期注入 `window.SQ_PROD_API_BASE`（生产环境首选，Netlify Snippet injection）
  2. URL 参数 `?api=URL`（**仅本地开发**：localhost/127.0.0.1/file: 协议生效）
  3. `localStorage.sq_api_base` / `localStorage.sq_admin_api_base`
  4. 同源（默认）
- **Supabase 项目地址**通过 admin 配置中心写入 `config.json` 的 `data_source.base_url`，或通过 `window.SQ_SUPABASE_BASE_URL` 覆盖
- **CSP**：`script-src 'self' https://browser.sentry-cdn.com`（SheetJS 已自托管至 `admin/lib/`，仅保留 Sentry SDK CDN 白名单）；`connect-src` 白名单：`*.supabase.co`/`.in`/`.net` + `*.sentry.io` + `*.railway.app` + `*.render.com`（`netlify.toml`，已移除 `https:` 通配防 XSS 外泄）
- **静态文件缓存策略**（`StaticCacheControlMiddleware` in `factory.py`）：HTML → `no-cache, must-revalidate`（每次通过 ETag 校验，部署后立即生效）；CSS/JS → `public, max-age=31536000, immutable`（永久缓存，靠 `?v=` 查询参数失效）；图片/字体 → `public, max-age=86400`。**改静态文件服务时不能删此中间件**——否则手机浏览器启用启发式缓存，部署后看不到更新。Netlify 部署时 `netlify.toml` 的 `[[headers]]` 提供等价策略。
- **生产环境必填**：`ADMIN_API_KEY`、`JWT_SECRET`、`SQ_LICENSE_SECRET`、`SQ_LICENSE`、`STOCK_QUERY_KEY`、`ALLOW_ORIGINS`（未设 `SQ_DEV` 时强制）；持久化备份另需 `SQ_SUPABASE_PROJECT_URL`（项目根地址）+ `SQ_SUPABASE_SERVICE_KEY` + `DB_BACKUP_BUCKET`，缺失时备份安全降级并打 warning（静默丢数据风险，需看日志确认）

## 运行与验证

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

- GUI 配置中心：`http://127.0.0.1:8001/admin/`
- API 健康检查：`http://127.0.0.1:8001/api/health`

测试命令：

```powershell
# Python 测试（主力，当前 87/87 全绿）
py -m pytest tests/ -v

# 兼容旧命令
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v

# JS 单元测试
node --test tests/*.test.js
```

## 文档指针

- `README.md`：项目概览、快速启动、功能列表、架构目录。
- `docs/gui-admin-guide.md`：用户操作手册，面向非技术人员。
- `docs/SECURITY-VERIFICATION.md`：安全验证与技术说明（对抗式审查）。
- `docs/PRODUCT-GUIDE.md`：产品说明文档，面向 PM/客户。
- `_DEPLOYMENT-STEPS.md`（本地）：部署步骤详记。
- `_LOCAL-GUIDE.md`（本地）：本地开发指南。

## 功能门控（订阅档位）

### 档位预设

| 档位 | 公司数 | SKU | 库存查询/天 | 关键功能 |
|------|--------|-----|------------|----------|
| free | 1 | 500 | 0 | core + customer_portal（带水印） |
| pro | 1 | 5000 | 50 | + stock_query + bundle_encryption + supabase_deploy + api_access |
| team | 5 | 不限 | 500 | + admin_member_inheritance + tier_profit_grouping + db_backup + custom_branding |

### 门控点

| 端点 | 检查 | quota/feature 字段 |
|------|------|-----------|
| `POST /api/config` | 规则数量 + 版本历史上限（超限自动删最旧） | `max_brands` + `max_config_revisions` |
| `POST /api/config/import` | 规则数量 + 版本历史上限（与 save 一致） | `max_brands` + `max_config_revisions` |
| `POST /api/config/{revision}/publish` | 回滚时检查规则数量 + 版本历史上限 | `max_brands` + `max_config_revisions` |
| `POST /api/items` / upload | SKU 数量 | `max_skus` |
| `POST /api/stock-query` | 功能开关 + 日配额 | `stock_query` feature + `stock_query_daily_limit` |
| `POST /api/merger/bundle/generate` (deploy) | supabase_deploy 功能 | `features` |
| `POST /api/merger/bundle/generate` (有密码) | bundle_encryption 功能 | `features` |
| `PUT /api/tiers` | tier_profit_grouping 功能 | `features` |
| `POST /api/companies/{id}/members` | admin_member_inheritance 功能 | `features` |
| `POST /api/auth/register` / `POST /api/companies` | 公司数量上限 + 用户数上限 | `max_companies` + `max_users` |
| `GET /api/audit` | audit_log 功能门控 + 按天数过滤 | `audit_log` feature + `audit_log_days` |

### 前端功能门控

- **`data-feature` 属性**：HTML 元素加 `data-feature="xxx"`，`session-panel.js` 的 `applyFeatureGating()` 根据当前档位自动显示/隐藏。
- **`hasFeature(feat)` 全局函数**：动态渲染的 UI（如成员创建按钮、Tier 管理面板）在 JS 中调用此函数判断是否渲染。
- **配额前置阻断**：`window.SQ_QUOTA`（由 `/api/auth/session` 注入）供前端在用户操作前检查（如添加规则时检查 `max_brands`），避免保存时才报错。
- **水印**：免费版 `watermark=True`，`/api/public/company/{id}` 返回 `watermark` + `watermark_config` 字段。`watermark_config` 从环境变量读取（`WATERMARK_TEXT` / `WATERMARK_PHONE` / `WATERMARK_WECHAT_QR`），支持自定义文字 + 电话（点击拨号）+ 微信二维码（点击放大长按识别）。`apps/index.html` 条件渲染水印层。

### License 生成

```powershell
py scripts/generate_license.py --tier pro --customer "客户A" --expires 2027-12-31
```

输出 base64 字符串，设为环境变量 `SQ_LICENSE`。

- 不要把历史变更记录写入本文件。
- 本文件只保留项目架构、核心运行规则、重要边界和查阅指针。
- 具体实现细节、测试结果、每日日志保留在本地工作区（不入库）。

## 产品化路线图

### P0（已完成）

- [x] Admin API Key 强校验：未设置或弱值拒绝启动，用 `secrets.compare_digest` 防时序攻击
- [x] `/api/stock-query` 加认证（`X-Stock-Key`）+ 频率限制（60s/30 次）+ 单次条数上限（50 条）
- [x] 清理文档中不存在的 customer 端点引用，明确产品边界
- [x] 多租户 `company_id` 真隔离：schema 加 `company_id` 列 + 所有 CRUD 过滤 + 隔离性测试通过

### P1（已完成）

- [x] 重写 README 与当前架构对齐
- [x] 品牌折扣规则完全配置驱动（移除前端硬编码品牌名）
- [x] 集成 Sentry 错误监控骨架（后端 observability.py + 前端按需加载）
- [x] 设计 license 校验机制（HMAC-SHA256 + 过期检查 + 功能授权）

### P2（后续）

- [x] 前端模块化重构（app.js 拆分）— apps/ 拆为 14 模块（含 profit-config.js），admin/ 拆为 14 模块（含 session-panel.js、tiers.js）；CSS 已拆分为 `styles/` 下 6 个功能模块（base/layout/forms/results/modals/responsive），拆分工具 `scripts/split_css.py`
- [x] 部署文档（本地 `_DEPLOYMENT-STEPS.md` + `_LOCAL-GUIDE.md`，README 部署章节同步）
- [ ] 产品官网 + 文档站
- [ ] 多租户客户登录（customers / customer_sessions 表 + API）
- [ ] PostgreSQL 迁移（多租户并发写入场景）
- [x] 合并双份 config-core.js（apps/ 与 admin/ 内容已统一，以 apps 版为基准 + scripts/sync-config-core.py 同步）
- [x] 消除 admin 源码真实折扣泄露（admin/lib/config-core.js 硬编码 32/36 → 改为中性 55）
- [x] 日志规范化（6 处 print() 改 logging）
- [x] 管理员公司 UI 标记（admin/lib/companies.js toggleAdminFlag + 前端 role 脱敏）
- [x] **管理员-成员配置继承 + Tier 利润率分组**（parent_company_id 配置/数据/bundle 继承 + tier 拖拽分配 + 配额门控测试全绿）
- [ ] 三菱 GWT-RPC 常量外置 + 并发查询

## 管理员-成员配置继承 + Tier 利润率分组

### 核心概念

将报价链路中的两个变量彻底解耦：
- **基础价**（面价 × 折扣%）= 管理员公司独有，成员公司共享 → 一份 config + 一份数据 + 一个 bundle
- **利润率** = 各公司独有，通过命名分组（Tier）批量管理

### 数据模型（全部存在 company meta_json 中，无需新表）

| 角色 | meta 字段 | 说明 |
|------|-----------|------|
| 管理员公司 | `is_admin: true`, `tiers: [{name, profit_margin, color}]` | 拥有 config+data，定义 Tier |
| 成员公司 | `parent_company_id: "admin-id"`, `tier: "A级"` | 继承 parent 的 config+data+bundle |
| 独立公司 | （无上述字段） | 向后兼容，行为不变 |

### 解析链路

- 查配置/数据/bundle → `resolve_data_company_id(company_id)` → 若有 parent 则用 parent 的 config+items
- 利润率 → `resolve_profit_margin(company_id)` → `tier` 查 parent.tiers → fallback `meta.profit_margin` → fallback `10`

### 新增 API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/tiers?company_id=X` | Bearer (Admin) | 获取 Tier 列表（成员公司自动从 parent 读取） |
| PUT | `/api/tiers?company_id=X` | Bearer (Admin) | 替换 Tier 列表（写入 admin meta.tiers） |
| POST | `/api/companies/{id}/assign-tier` | Bearer (Admin) | 分配公司到 Tier（设置 meta.tier + parent_company_id） |
| GET | `/api/auth/session` | Bearer (Any) | 获取会话信息（role/tier/features/is_dev/email），所有认证用户可访问 |
| POST | `/api/dev/set-tier` | Bearer (Admin) | 开发模式 tier 覆盖（仅 SQ_DEV=1），一键切换 free/pro/team 测试 |
| GET | `/api/license/info` | Bearer (Superadmin) | 获取完整 license 详情（customer/过期时间/配额），超管专属 |

### Admin UI

- 公司管理区新增「利润率分组」子面板（`#tierManager`）
- Tier 定义卡片支持增删改 + 颜色标识
- 公司卡片可拖拽（HTML5 Drag API），拖到 Tier 卡片上即完成分配
- 公司卡片显示 Tier 徽标（颜色 + 名称 + 利润率）
