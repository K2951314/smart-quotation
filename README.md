# 智能询价系统

> 多租户配置驱动的 B2B 刀具/工具行业报价系统。
> 管理员通过 GUI 配置中心管理价格/折扣/品牌规则，销售/客户看报价 + 调利润率，三菱库存实时查询。

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  admin/ (浏览器端 GUI 配置中心)                     │
│  字段配置 · 报价规则 · 数据拼接 · Bundle 生成 · 发布 │
└────────────────────┬────────────────────────────────┘
                     │ POST /api/companies/{id}/config
                     ▼
┌─────────────────────────────────────────────────────┐
│  backend/ (FastAPI + SQLite)                         │
│  多租户 company_id 隔离 · CRUD · 审计 · Bundle 部署  │
└────────────────────┬────────────────────────────────┘
                     │ 部署 Bundle (config + price + stock)
                     ▼
┌─────────────────────────────────────────────────────┐
│  Supabase Storage (公开桶)                          │
│  config.json · price.bundle.json · stock.bundle.json│
└────────────────────┬────────────────────────────────┘
                     │ fetch + Cache API
                     ▼
┌─────────────────────────────────────────────────────┐
│  apps/ (静态前端报价台)                              │
│  模糊查询 · 折扣/利润计算 · 含税/未税切换 · 复制     │
│  三菱库存实时查询（POST /api/stock-query）           │
└─────────────────────────────────────────────────────┘
```

---

## 快速开始

### 1. 安装依赖

```powershell
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入真实值：

```powershell
copy .env.example .env
```

关键字段：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_API_KEY` | ✅ | admin 后台 API 密钥，至少 16 字符；未设置时后端拒绝启动 |
| `SQ_DEV` | 本地开发 | 设为 `1` 可跳过 ADMIN_API_KEY 强校验（仅限本地） |
| `STOCK_QUERY_KEY` | 生产必填 | 三菱库存查询专用密钥；**必须独立于 `ADMIN_API_KEY`**，生产环境为空时库存查询返回 503 |
| `MMC_USERNAME` / `MMC_PASSWORD` | 可选 | 三菱官网登录凭据（仅部署在服务端） |
| `ALLOW_ORIGINS` | 生产 | 逗号分隔的允许来源；留空则允许所有但不带凭证 |

生成强随机密钥：

```powershell
py -c "import secrets; print(secrets.token_urlsafe(32))"
```

### 3. 启动后端

```powershell
# 本地开发（跳过强校验）
$env:SQ_DEV = "1"
py -m backend.smart_quotation
```

访问：
- GUI 配置中心：<http://127.0.0.1:8001/admin/>
- 客户报价台：<http://127.0.0.1:8001/apps/index.html>
- API 健康检查：<http://127.0.0.1:8001/api/health>

---

## 核心概念

### 多租户隔离

系统的关键隔离单位是 `company_id`。所有业务表（`quotation_configs`、`quotation_items`、`audit_events`）都有 `company_id` 列，所有 CRUD 都按公司过滤。默认公司 ID 为 `default`（单租户兼容模式）。

**管理员公司**：通过 `meta.is_admin=true` 标记的公司，通过令牌访问客户前端时看完整数据（面价/折扣/配置入口）；普通公司看脱敏数据。在 admin UI 一键设置。

### 配置驱动

一切由 `config.json` 驱动：
- **fields**：字段定义（key、label、类型、Excel 别名、是否可搜索/复制）
- **rules**：报价规则（按字段条件匹配品牌 → 应用折扣）
- **copy**：复制模板（哪些字段、前缀、单行/多行）
- **ui**：页面显示布局
- **data_source**：Supabase Storage 地址

前端代码不含任何业务硬编码（品牌名、折扣率等），全部从配置读取。

### 定价公式

| 模式 | 含税价 | 未税价 |
|------|--------|--------|
| admin | `rounding(面价 × 折扣%)` | `rounding(含税价 / (1 + 税率%))` |
| company | `rounding(含税价 × (1 + 利润率%))` | `rounding(含利润含税价 / (1 + 税率%))` |

每一步独立取整，取整方式（ceil / round / floor）可通过工具栏下拉框实时切换。

> **税率与含税属性**：税率为全局配置（`config.pricing.tax_rate`，默认 13%），在「定价设置」中统一配置。面价含税属性由 `config.pricing.face_price_tax_inclusive` 标注（默认含税）；上传未税价格表时系统自动转为含税存储。

### 三菱库存查询

`POST /api/stock-query`（需 `X-Stock-Key` 请求头 + 频率限制 60s/30 次 + 单次上限 50 条）。后端通过 GWT-RPC 直连三菱官网，返回上海/日本仓库实时库存。

---

## 项目结构

```
智能询价/
├── apps/                        # 前端报价台（静态部署到 Netlify）
│   ├── index.html               # 统一入口（authGate 覆盖层）
│   ├── app.js                   # 主逻辑（bootstrap）
│   ├── styles.css
│   └── lib/                     # 13 个模块
│       ├── config-core.js       # 配置核心（v2/v3 兼容）
│       ├── discount-utils.js    # 折扣计算
│       ├── query-regex.js       # 模糊查询
│       ├── result-sort.js       # 结果排序
│       ├── search-render.js     # 结果渲染
│       ├── stock-query.js       # 三菱库存查询
│       ├── auth.js / data-load.js / state.js / ui-helpers.js ...
├── admin/                       # 浏览器端 GUI 配置中心
│   ├── index.html
│   ├── app.js                   # bootstrap
│   ├── merger-app.js            # 数据拼接
│   └── lib/                     # 12 个模块
│       ├── config-core.js       # 与 apps/lib/config-core.js 同步（见 scripts/sync-config-core.py）
│       ├── bundle-utils.js      # Bundle 生成/加密
│       ├── admin-core.js / companies.js / config-api.js ...
├── backend/                     # FastAPI 后端
│   └── smart_quotation/
│       ├── api/                 # API 层（9 个模块）
│       │   ├── factory.py       # 应用工厂（CORS、静态挂载）
│       │   ├── auth.py          # 认证 + 频率限制
│       │   ├── routes_public.py # 公开端点（config/data 代理）
│       │   ├── routes_companies.py  # 公司 CRUD + 令牌管理
│       │   ├── routes_config.py     # 配置 CRUD（save/publish/rollback）
│       │   ├── routes_items.py      # 商品数据 CRUD
│       │   ├── routes_merger.py     # 品牌识别 + Bundle 生成/部署
│       │   ├── routes_stock.py      # 三菱库存查询
│       │   ├── models.py / supabase.py
│       ├── store/               # 存储层（9 个模块）
│       │   ├── base.py          # Schema、索引、迁移、ConfigCache
│       │   ├── configs.py       # 配置 CRUD
│       │   ├── items.py         # 商品数据 CRUD
│       │   ├── companies.py     # 公司管理
│       │   ├── bundles.py       # AES-GCM 价格包加密
│       │   ├── audit.py / security.py / excel.py
│       ├── engine.py            # 报价引擎（规则匹配 + AST 安全公式求值）
│       ├── config.py            # 配置规范化
│       ├── license.py           # HMAC-SHA256 license 校验
│       ├── mitsubishi_stock.py  # 三菱 GWT-RPC 查询引擎
│       ├── observability.py     # Sentry 错误监控
│       ├── plugins.py / erp.py
├── scripts/
│   └── sync-config-core.py      # config-core.js 同步脚本（apps → admin）
├── tests/                       # 32 个 Python 测试 + 3 个 JS 测试文件
├── config.example.json           # 配置示例（不含敏感值）
├── .env.example                  # 环境变量示例
├── requirements.txt
├── netlify.toml                  # Netlify 部署 + 安全响应头（CSP 白名单）
├── Procfile                      # Railway/Render 后端启动
└── docs/
    ├── gui-admin-guide.md        # GUI 操作手册（面向非技术人员）
    ├── SECURITY-VERIFICATION.md  # 安全验证（对抗式审查）
    └── PRODUCT-GUIDE.md          # 产品说明（面向 PM/客户）
```

---

## 部署

### 本地开发

```powershell
$env:SQ_DEV = "1"
py -m backend.smart_quotation
```

FastAPI 同源代理 `apps/` 和 `admin/`，前后端同一端口。

### 生产部署

**后端**（Railway / Render）：
- Procfile: `web: uvicorn backend.smart_quotation.api:create_app --host 0.0.0.0 --port $PORT --factory`
- 必须设置 `ADMIN_API_KEY`（≥ 16 字符）、`STOCK_QUERY_KEY`（独立于 admin key）
- 三菱凭据 `MMC_USERNAME` / `MMC_PASSWORD` 设置在服务端
- 生产模式（`SQ_DEV` 未设）**必须设置 `ALLOW_ORIGINS`**，否则启动报错并输出诊断信息
- 后端同源挂载 `/admin` 和 `/apps`，可直接通过 `https://<后端域名>/admin/` 访问管理后台

**前端**（Netlify 或后端同源）：
- `apps/` 部署 Netlify：客户报价台
- `admin/` 可部署 Netlify（独立站点）或用后端同源 `/admin/`
- 前端通过 `getApiBase()` 自动探测后端地址，优先级：
  1. 构建期/运行期注入 `window.SQ_PROD_API_BASE`（生产首选，Netlify Snippet injection）
  2. URL 参数 `?api=URL`（**仅本地开发**：localhost/127.0.0.1/file: 生效，防生产 API 劫持）
  3. `localStorage.sq_api_base`
  4. 同源（后端同源部署时默认）
- Netlify 独立部署时还需配置 `BACKEND_URL` 环境变量（被 `netlify.toml` rewrite 规则引用，把 `/api/*`、`/config.json`、`/price.bundle.json` 等透明代理到后端，作为 Snippet injection 的双保险）
- 三菱库存 key 通过 URL fragment `#stockkey=xxx` 注入（不发送到服务器，防日志泄露），也可在 authGate 手动输入
- CSP `script-src` 白名单：`'self'` + `https://cdn.sheetjs.com`（SheetJS）+ `https://browser.sentry-cdn.com`（Sentry SDK）

**数据源**（Supabase Storage）：
- 通过 admin 配置中心写入 `config.json` 的 `data_source.base_url`
- 或通过 `window.SQ_SUPABASE_BASE_URL` 前端注入

---

## API 端点速览

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 无 | 健康检查 |
| GET | `/api/public/company/{company_id}` | X-Company-Token | 获取公司 profile（名称 + 利润率 + 税率） |
| GET | `/api/config/active?company_id=X` | X-Company-Token | 公开获取指定公司的已发布配置（company 角色脱敏） |
| GET | `/config.json?company_id=X` | X-Company-Token | 配置代理（同上，兼容旧路径） |
| GET | `/price.bundle.json?company_id=X` | X-Company-Token | 价格包（company 角色脱敏，无面价） |
| GET | `/stock.bundle.json?company_id=X` | X-Company-Token | 库存包 |
| GET | `/version.json?company_id=X` | X-Company-Token | 数据版本号（用于缓存失效） |
| * | `/api/companies/*` | Bearer (Admin) | 公司 CRUD + 令牌管理 |
| * | `/api/config/*` | Bearer (Admin) | 配置 CRUD（list/get/save/publish/delete/export/import） |
| * | `/api/items/*` | Bearer (Admin) | 商品数据 CRUD（stats/replace/upload/rollback） |
| GET | `/api/quote?q=...&company_id=X` | Bearer (Admin) | 报价查询（admin 预览用） |
| POST | `/api/merger/detect-brands` | Bearer (Admin) | 品牌识别 |
| POST | `/api/merger/bundle/generate` | Bearer (Admin) | Bundle 生成 + 可选部署（部署时强制脱敏） |
| POST | `/api/merger/bundle/deploy` | Bearer (Admin) | Bundle 部署到 Supabase（从数据库重建脱敏 bundle） |
| POST | `/api/stock-query` | X-Stock-Key | 三菱库存查询（频率限制 60s/30 次，单次上限 50 条） |
| GET | `/api/audit?company_id=X` | Bearer (Admin) | 审计日志（按公司隔离） |

---

## 安全设计

- **ADMIN_API_KEY 强校验**：未设置或弱值拒绝启动（本地开发用 `SQ_DEV=1` 跳过）
- **secrets.compare_digest**：所有 key 比较使用恒定时间比较，防时序攻击
- **频率限制**：三菱库存查询 60s/30 次/IP
- **单次条数上限**：三菱库存查询单次最多 50 条
- **CSP 安全响应头**：`netlify.toml` 配置 X-Content-Type-Options / X-Frame-Options / Referrer-Policy / CSP（`script-src` 白名单：self + SheetJS + Sentry CDN）
- **多租户隔离**：所有业务表 `company_id` 过滤，删除公司级联清理
- **源码无硬编码 URL**：Supabase/Railway 地址全部通过环境变量或 admin 配置中心注入

---

## 开发说明

### 浮点数校正

JavaScript 浮点运算可能导致 `28 × 1.1 = 30.800000000000004`，`applyRounding()` 在 `Math.ceil` 前减 `1e-9` 避免越界。

### row.price 使用规则

`row.price` 始终是当前显示的数值（由 `refreshRowPrice()` 维护）。所有输出路径（复制、三菱库存剪贴板）**不得对 `row.price` 再次除税**，否则未税价会被二次计算。

### 事件绑定

全局侦听器（未税复选框、取整方式下拉框）绑定在 `bindAuthEvents()` 中，`window.onload` 调用一次，不会因重复调用导致叠加。

---

## 许可证

私有项目。未经授权不得复制、分发或商用。
