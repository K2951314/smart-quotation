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
- **上传 price.bundle.json 必须脱敏**：导出/上传价格包必须传 `{ desensitize: true }`（`admin/merger-app.js` / `event-bindings.js`），移除 `face_price` 并预计算 `quote_price`。未脱敏原始包会泄露面价，且成员公司会落回「面价 × 默认折扣」导致报价错乱。
- **管理员价格通道（双 bundle）**：公开桶 `price.bundle.json` 是脱敏版（无 face_price），admin 角色直连会价格显示 0（admin 渲染依赖 face_price，company 有 quote_price 兜底）。因此一键同步/单独上传价格包时必须额外生成 `price.admin.bundle.json`——完整数据（含面价）用**当前公司 access_token** AES-GCM 加密（`event-bindings.js uploadAdminPriceBundle`）。apps 端 admin 角色自动改拉该文件并用本地登录令牌解密（`apps/lib/data-load.js`），令牌即密码，轮换后需重新一键同步。令牌泄露者本来就能登录管理员账号看面价，不扩大攻击面。**任何角色**在 face_price 缺失且 quote_price 存在时都用 quote_price 兜底显示（`search-render.js appendResultRow`），防止价格显示 0。后端代理路线（无 Supabase）无需双 bundle：`/price.bundle.json` 按 `require_company_access` 角色生成（is_admin 公司 token → 完整数据）；SQ_DEV 本地开发无凭证兜底为 admin 角色。
- **Excel 别名分隔符（防报价静默变 0）**：字段 `excel_aliases` 的收集（`admin/lib/config-collect.js`）与后端归一化（`backend/smart_quotation/config.py _split_excel_alias`）必须使用同一分隔符集 `[,，、;；|｜\t\n\r]+`（逗号/顿号/分号/竖线/制表符/换行，**不含空格**——英文别名可含空格）。别名整串未拆分会导致 Excel 列名匹配失败 → `face_price` 缺失 → 脱敏预计算报价为 0（静默失败）。merger 加载价格表后有 `diagnosePriceMapping` 显式警告（`admin/lib/data-utils.js`），不得移除。存量坏数据修复用 `py scripts/fix_alias_separators.py --dry-run` 预览后执行。
- **库存 .xls + 别名自动映射 + 列名包含匹配（防库存 bundle 空）**：库存表常为 .xls 旧格式（openpyxl 不支持），用 xlrd 解析（`excel.py` .xls 分支，`requirements.txt` 含 xlrd）。`excel.py` 顶部 `COMMON_ALIASES`（物料长代码→code、库存数量→stock、规格型号→spec 等）自动映射 config 未覆盖的列名（优先级低于 config 的 excel_aliases）。前端拼接区 `data-utils.js resolveColumn` 精确 indexOf 失败时 fallback 包含匹配（「库存数量(本)」包含「库存数量」→命中），否则带后缀的库存列名会导致 `buildStockByCode` 全行跳过 → stock bundle rows=0 → 库存不显示。
- **admin 加载链路 fallback（防 admin 看不到面价）**：`price.admin.bundle.json` 404（uploadAdminPriceBundle 未上传/失败）时，apps 先走后端 `/price.bundle.json` role=admin（后端可达即拿完整包，不依赖双 bundle 上传），再回退公开脱敏包（`data-load.js` catch 回退 + `g_AdminBundleMissing` 警告保留不被「数据库就绪」覆盖）。`uploadAdminPriceBundle` 返回 `{ok, error}`，一键同步最终状态不覆盖失败（显示具体原因）。
- **fetchWithRetry 加载性能**：`data-load.js fetchWithRetry` 超时 15s + 重试 1 次（404/401/403 不重试直接回退）。超时过长（曾 60s×3=180s）会导致页面加载 2-3 分钟。
- **恢复配置走后端 API（`GET /api/config`）**，不从 Supabase 恢复（Supabase 上是脱敏版，无 rules，恢复后再保存会丢 rules）。
- **一键同步全部**会上传全部 4 个文件（config.json + price.bundle.json + stock.bundle.json + version.json）。
- **双数据库模式**：`DATABASE_URL` 以 `postgres://` 或 `postgresql://` 开头时走 PostgreSQL（SaaS 模式），否则走 SQLite（本地开发/测试）。psycopg2 懒加载，SQLite 模式零依赖。**生产环境架构断言**：未设 `SQ_DEV` 时，必须设置 `DATABASE_URL`（PostgreSQL）或 `DB_PATH`（指向持久化 Volume），否则后端拒绝启动——SQLite 文件在 Railway/Render 免费版重启后丢失。
- **认证双模式**：`ADMIN_API_KEY`（超管，全平台权限）+ JWT（租户管理员，绑定 `company_id`）。`require_admin_api` 先检查 API Key，再尝试 JWT，最后开发模式兜底。返回 `{"role": "superadmin"|"tenant"|"dev", "company_id": ...}` 供下游依赖使用。
- **租户隔离三依赖**：`require_admin_api`（认证）→ `resolve_company_id`（租户强制使用 JWT 中的 `company_id`）→ `require_superadmin`（公司创建/删除/assign-tier 等平台级操作限超管）。所有接受 `company_id` 查询参数的 admin 路由必须用 `Depends(resolve_company_id)` 而非 `Query(DEFAULT_COMPANY_ID)`，否则 JWT 用户可越权。
- **注册/登录流程**：`admin/register.html` 填邮箱+密码+公司名 → `POST /api/auth/register` 自动创建公司+用户 → 返回 JWT → 跳转配置中心。`admin/login.html` 邮箱+密码登录。
- **订阅与容量模型（2026-08 重构：账号级订阅）**：订阅挂在**账号**（`users.plan` + `plan_expires_at`）而非公司——账号升级，名下公司自动跟随。公司档位解析链（`resolve_subscription_plan`）：成员公司→继承 parent；显式 `meta.plan` 覆盖（仅超管可设，写入时打 `plan_source=superadmin` 标）；owner 账号档位（`meta.owner_user_id` 回退 `resolve_user_plan`，到期感知）；无 owner 的 is_admin/default 历史→部署 license tier；兜底 free。**机器默认值禁止写 plan 快照**——迁移/自愈/注册一律不写 meta.plan（启动迁移 `_migrate_unfreeze_machine_plans` 会解冻历史机器快照，`_migrate_backfill_company_owner` 回填 owner）。三类容量配额分离：① 部署 license `max_companies`/`max_users`＝供应商总量门禁（注册/建公司时检查全部署数）；② 账号配额 `max_companies`（免费/个人 1、专业 5，计 owner_user_id 顶级公司数，成员公司不占额）——租户可 `POST /api/companies` 自助开主公司；③ 账号席位 `max_users`（免费 1、个人 3、专业不限）——`POST /api/users/sub` 子账号、`GET /api/users/mine` 列表，租户可删自己公司子账号（不能删自己）。**租户权限域**：`resolve_company_id` 与 `_ensure_company_access` 均按 `list_companies_for_tenant`（主公司+自建+其成员）放行——租户名下多家公司可切换，不止 JWT 主公司。用户档位分配走 `PATCH /api/users/{id}`（plan_duration 支持日历月续期/换档替换语义）。生成 license 用 `py scripts/generate_license.py --tier pro --customer "客户A"`。**超管豁免**：`_validate_plan_within_license` 对 `role=superadmin`/`dev` 跳过档位上限检查。
- **会话信息端点**：`GET /api/auth/session`（所有认证用户可访问）返回 `{role, is_dev, plan, plan_expires_at, tier, features, quota, email, company_id, user_id, preview_plan, dev_tier_override}`，供前端显示角色徽标 + 档位徽标（含剩余天数/临期变橙）+ 开发模式标记 + 配额前置阻断。`plan` 是订阅档位（推荐字段名），`tier` 是向后兼容别名（两者同值；注意 `tier` 在本系统另有「利润率分组」`company.meta.tier` 含义，勿混用）。`plan_expires_at` 供租户查看自己的订阅到期。`preview_plan` 非空时表示超管正在预览某档位。与 `GET /api/license/info`（超管专属，返回完整 license 详情含 customer/过期时间）互补。
- **开发模式档位切换**：`POST /api/dev/set-tier`（仅 `SQ_DEV=1` 时可用）可一键切换 free/pro/team 档位，无需重启后端。用于本地测试不同订阅的功能门控和配额限制。生产环境调用返回 403。前端切换器仅平台侧角色可见（租户不显示）。`POST /api/admin/preview-tier`（超管专属，不要求 SQ_DEV=1）可生产环境预览高档位，不影响真实 license；两者都是内存级覆盖，重启后失效。
- **注册用户自助闭环（2026-08）**：注册生命周期 = 注册（自动建主公司 + `seed_default_config` 初始化默认配置并发布，与前端 defaultConfig 对齐——bundle 生成依赖已发布配置的字段定义，无它则门户 bundle 为空）→ 上传数据（后端托管或 Supabase）→ 复制客户链接。**改 ID/改名是租户自助功能**（注册生成的 slug+随机后缀 ID 本就设计给用户修正）：`rename-id` 已开放租户（限名下公司，越权 403）。**改 ID 后旧 JWT 自动跟随**：JWT 内 company_id 过时（users 行已级联迁移）时，`_effective_tenant_company`（auth.py，resolve_company_id/_ensure_company_access/session 共用）回退用户表当前值——租户无需重新登录，否则落到空配置「改了也没用」。**发布强制校验**：`POST /api/config` status=published 时 `engine.validate_config` 拦截坏配置（草稿自由保存）；独立校验按钮/高级 JSON 编辑器/导出 YAML/示例导入已随「发布配置」区块退役（导出配置备份按钮并入版本历史区）。
- **UI 术语对齐（2026-08）**：展示层统一为「主公司」（原"数据源管理员/管理员公司"，租户的工作台）、「客户公司」（原"成员公司"，租户下游客户，令牌链接访问、无登录）、「子账号」（同事登录席位）。后端标识符不变（`parent_company_id`、`/members` 端点）。`tier` 一词仍指利润率分组，与订阅档位无关。
- **静态资源缓存（2026-08 变更）**：`StaticCacheControlMiddleware` 对 CSS/JS 用 `no-cache, must-revalidate`（ETag 协商缓存）——曾用 1 年 immutable + `?v=` 人肉失效，多次改 JS 忘 bump 导致浏览器用旧文件（immutable 连 revalidate 都不做）。HTML 同为 no-cache。`?v=N` 版本号仍保留作保险，改 JS 时顺手 bump。
- **门户数据更新感知（2026-08）**：数据发布双路径——①后端托管（`POST /api/items/upload-json`，拼接区「上传数据到服务器」按钮，所有档位可用，免费版主路径，配额 `_check_sku_quota` 强制）：行经 `parse_excel_to_rows` 同源映射写入 items 表，门户走后端代理 `/price.bundle.json`；②Supabase 自助部署（个人版+，`data-feature="supabase_deploy"` 门控）。两路径的 version.json 版本号均为本次上传内容 SHA-256 指纹（`computeBundleContentHash`），不从 /api/items/stats 取（items 表与拼接链路无关，曾因此 version 永不变 → 门户永远不拉新）。**version.json 的 version 由本次上传内容 SHA-256 指纹生成**（`computeBundleContentHash`），不从 /api/items/stats 取（items 表与拼接链路无关，曾因此 version 永不变 → 门户永远不拉新）。门户端每 5 分钟轮询 version.json（后台标签跳过），版本变化自动重载数据；「数据库就绪」旁有 ↻ 强制刷新按钮（清 Cache API 后绕缓存重载，`window.forceDataReload`）。改 bundle 生成/版本逻辑时必须保持：内容变 → version 必变。
- **限流（2026-08 调整）**：内存限流全局 `ip:` 桶 60s/120 次（原 30 次会因配置中心单页 5-8 个请求误伤正常使用）；登录用独立 `login:` 桶，不与页面请求共享预算。文案与实际窗口一致（1 分钟）。
- **LLM 后台辅助（`backend/smart_quotation/llm.py`，可选）**：NVIDIA NIM kimi-k3 做 Excel 未匹配列名的映射建议。设计铁律：LLM 失败/限流/熔断一律返回 None，调用方降级到静态别名表，解析永远成功。客户端自带限流（默认 30 RPM < NVIDIA 40）+ 结果缓存 + 连续 3 败熔断 5 分钟。Excel 解析（含 LLM 网络调用）必须跑在线程池（`routes_items.py` 用 `run_in_threadpool`），不得在 async 事件循环里同步调用。
- **孤儿自愈（启动迁移）**：`init_schema` 依次跑：用户列迁移→访问令牌→历史独立公司升级主公司→孤儿用户重建公司（`_migrate_repair_orphan_users`，公司行丢失时按原 ID 重建 is_admin+free）→owner 回填→解冻机器 plan 快照。全部幂等，日志打印迁移清单。**不要手工修数据**，交给迁移。

## 客户门户 (apps/index.html)

- 入口：`apps/index.html`（统一入口，authGate 覆盖层）
- 依赖 FastAPI 后端（配置/数据/库存查询）+ Supabase Storage（config.json + price/stock bundles）
- **认证模式**（当前）：前端本地模式，凭证默认存 localStorage（「保持登录」默认勾选，可取消退回 sessionStorage；admin 令牌永不持久）；URL 链接携带的 token/stockkey 落地时同样遵循「保持登录」偏好（公用电脑取消后只进 sessionStorage）。页头「退出」按钮调 clearAllAuth()，401 自动清凭证；后端不提供 customer 登录端点
- **产品边界说明**：如需真正的多租户客户登录（服务端校验、密码哈希、会话令牌），需在 backend 中补全 `customers` / `customer_sessions` 表与相关 API 端点（见路线图）
- 角色：admin 看完整数据（面价/折扣/报价），company 看脱敏数据（无面价/无折扣规则，防止反推成本）
- 定价：品牌折扣规则定价（config rules），base = 面价 × 品牌折扣%，再叠加利润/税务
- 税务：全局配置 `config.pricing.tax_rate`（默认 13%），在「定价设置」中统一配置；面价含税属性由 `config.pricing.face_price_tax_inclusive` 标注
- 利润率：公司账号通过「利润设置」弹窗（`profit-config.js`）自设全局利润（百分比），系统自动算最终报价；客户版步进预设为 0.5/1/5（默认 1），管理员版折扣步进为 0.1/0.5/1（默认 0.1）
- 面价隐藏：公司账号下 discount-panel 改造为利润步进器（不显示面价/折扣规则，防止反推成本）
- 折扣弹窗：动态渲染，根据 `discount_rules` 配置自动生成任意数量品牌输入框
- 三菱库存：`POST /api/stock-query`（需 `X-Stock-Key` 认证 + 频率限制），QueryEngine 通过 GWT-RPC 直连三菱官网；终端客户检测逻辑根据响应数组长度动态选择索引位置（标准格式用固定索引 46/47，扩展格式用倒数第3/4位）
- **库存数据订阅门控**：免费版（plan=free）不显示静态库存快照（`appendResultRow` 删除 `fields.stock`，stock chip 与 rowData 一并失效），admin/stock_only 角色豁免；「库存查询」「三菱库存」两按钮也随 plan 隐藏。**架构边界**：静态 bundle（Supabase 公开桶）数据仍明文下发，DevTools 可见——这是 UI 层隔离，彻底隔离需 bundle 动态化/加密（架构级待办）。
- 统一入口：`apps/index.html` + authGate（旧的 `apps/login.html`、`apps/customer.html` 已删除）

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
- **Supabase 项目地址**优先级：环境变量 `SQ_SUPABASE_BASE_URL`（权威，调试/切换 bucket 时改 `.env` 即可，**改完需重启后端**）> 公司级 `meta.supabase_base_url`。后端 `_resolve_supabase_url` 统一解析，`/api/settings/datasource` 返回有效地址供 admin 上传 bundle——**配置中心已移除 `data_source` 卡片**，`base_url` 不再写入配置 JSON，避免多租户串读。
- **CSP**：`script-src 'self' https://browser.sentry-cdn.com`（SheetJS 已自托管至 `admin/lib/`，仅保留 Sentry SDK CDN 白名单）；`connect-src` 白名单：`*.supabase.co`/`.in`/`.net` + `*.sentry.io` + `*.railway.app` + `*.render.com`（`netlify.toml`，已移除 `https:` 通配防 XSS 外泄）
- **静态文件缓存策略**（`StaticCacheControlMiddleware` in `factory.py`）：HTML → `no-cache, must-revalidate`（每次通过 ETag 校验，部署后立即生效）；CSS/JS → `public, max-age=31536000, immutable`（永久缓存，靠 `?v=` 查询参数失效）；图片/字体 → `public, max-age=86400`。**改静态文件服务时不能删此中间件**——否则手机浏览器启用启发式缓存，部署后看不到更新。Netlify 部署时 `netlify.toml` 的 `[[headers]]` 提供等价策略。
- **生产环境必填**：`ADMIN_API_KEY`、`JWT_SECRET`、`SQ_LICENSE_SECRET`、`SQ_LICENSE`、`STOCK_QUERY_KEY`、`ALLOW_ORIGINS`（未设 `SQ_DEV` 时强制）；RSA 签名另需 `SQ_LICENSE_PUBLIC_KEY`（部署侧验签公钥，私钥只在供应商侧）。持久化备份另需 `SQ_SUPABASE_PROJECT_URL`（项目根地址）+ `SQ_SUPABASE_SERVICE_KEY` + `DB_BACKUP_BUCKET`，缺失时备份打 warning（去重）并可经 `GET /api/health/backup` 主动查询状态（configured/last_error 等），消除静默降级。**环境变量均启动时读一次，改动后须重启/重部署才生效**（开发模式订阅档位可用 `POST /api/dev/set-tier` 热切换，无需重启）。

## 运行与验证

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

- GUI 配置中心：`http://127.0.0.1:8001/admin/`
- API 健康检查：`http://127.0.0.1:8001/api/health`

测试命令：

```powershell
# Python 测试（主力，当前 119 全绿）
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
| team | 5 | 不限 | 500 | + admin_member_inheritance + tier_profit_grouping |

### 每租户 plan 解析语义（`resolve_subscription_plan`）

- **优先级**：显式 `company.meta.plan` → 供应商性质公司（`is_admin=true` 或 `default`）未设 plan 回退部署 license tier → 普通客户公司未设 plan **fail-closed 到 free**（防注册客户白嫖最高档）。
- **配额归属**：数据配额（`max_skus`/`max_brands`/`max_config_revisions`）用**数据归属公司**（`resolve_data_company_id`）的 plan——成员公司数据写入 parent，配额须与之一致；访问功能（`stock_query` + 日配额 + 水印）用**访问者公司**的 plan。
- **档位上限校验**：`_validate_plan_within_license(meta, auth)` 强制「分配的 plan ≤ 部署 license tier」（`get_license_tier()`），超档 402、非法档 422；**超管/开发模式豁免**（部署管理员可分配任意档位，如给客户演示高档位功能），此检查仅约束租户管理员（防 JWT 用户自我提权）；租户不可自改 `plan`/`tier`/`profit_margin`（黑名单过滤）。
- **`has_feature()` / `get_quota()` 已废弃**（全局 license 门控），仅 `max_companies`/`max_users` 保留全局；其余功能/配额一律走 `plan_has_feature` / `get_plan_quota`。
- **db_backup / custom_branding 为部署级能力**（环境变量启用，非租户 feature），已从 `TIER_PRESETS[team].features` 移除。

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

- **`data-feature` 属性**：HTML 元素加 `data-feature="xxx"`，`session-panel.js` 的 `applyFeatureGating()` 根据当前档位自动显示/隐藏。**超管角色（`role=superadmin`）和开发模式（`is_dev`）豁免**——`has` 判断加 `|| isDev || isSuperadmin`，平台管理员在生产环境也能看所有功能按钮（不受订阅档位限制）。
- **`hasFeature(feat)` 全局函数**：动态渲染的 UI（如成员创建按钮、Tier 管理面板）在 JS 中调用此函数判断是否渲染。`is_dev` 或 `role=superadmin` 返回 true。
- **配额前置阻断**：`window.SQ_QUOTA`（由 `/api/auth/session` 注入）供前端在用户操作前检查（如添加规则时检查 `max_brands`），避免保存时才报错。
- **水印**：免费版 `watermark=True`，`/api/public/company/{id}` 返回 `watermark` + `watermark_config` 字段。`watermark_config` 从环境变量读取（`WATERMARK_TEXT` / `WATERMARK_PHONE` / `WATERMARK_WECHAT_QR`），支持自定义文字 + 电话（点击拨号）+ 微信二维码（点击放大长按识别）。`apps/index.html` 条件渲染水印层。
- **客户侧门控（apps）**：`applyPlanGating(plan)` 按 plan 隐藏/显示「库存查询」「三菱库存」两个按钮（free 隐藏，pro/team 显示）；admin 角色（供应商自己）豁免付费墙；profile 加载失败时 fail-closed（按 free 隐藏）。`applyPlanBadge(plan)` 在页头显示档位徽标（免费灰/个人蓝/专业紫）。后端已强制，前端仅体验优化。

### License 生成

```powershell
# 1. 生成 RSA 密钥对（一次性）：私钥供应商保留，公钥发给客户部署侧
py scripts/generate_rsa_keys.py

# 2. RSA 签发 license（推荐，非对称）
py scripts/generate_license.py --tier pro --customer "客户A" --expires 2027-12-31 --private-key keys/license_private.pem

# 3. HMAC 签发（向后兼容，不推荐）
py scripts/generate_license.py --tier pro --customer "客户A" --expires 2027-12-31
```

输出 base64 字符串，设为客户部署端环境变量 `SQ_LICENSE`。RSA 时客户侧另设 `SQ_LICENSE_PUBLIC_KEY`（公钥），`SQ_LICENSE_PRIVATE_KEY` 只在供应商侧（本地生成时用）。

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
- [x] 合并双份 config-core.js（apps/ 与 admin/ 内容已统一，以 apps 版为基准 + scripts/sync-config-core.py 同步；新增 `tests/config-core-sync.test.js` 逐字节比对，纳入 node --test 防漂移）
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
| POST | `/api/admin/preview-tier` | Bearer (Superadmin) | 超管档位预览（生产可用），预览不同档位功能/配额，不影响真实 license |
| GET | `/api/license/info` | Bearer (Superadmin) | 获取完整 license 详情（customer/过期时间/配额），超管专属 |

### Admin UI

- 公司管理区新增「利润率分组」子面板（`#tierManager`）
- Tier 定义卡片支持增删改 + 颜色标识
- 公司卡片可拖拽（HTML5 Drag API），拖到 Tier 卡片上即完成分配
- 公司卡片显示 Tier 徽标（颜色 + 名称 + 利润率）
