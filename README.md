# 智能询价系统

本项目包含三套子系统：

1. **客户门户**（`apps/index.html`）：统一登录门户，管理员/公司账号角色分离，品牌折扣定价 + 利润 + 含税/未税。
2. **多租户 GUI 配置平台**（`backend/` + `admin/`）：FastAPI + SQLite 后端，提供可视化配置中心，支持多公司、配置版本管理、客户账号管理、审计日志、一键回滚。
3. **静态前端报价台**（`apps/app.js`）：纯前端工具，通过远端 `config.json` + Supabase bundle 运行，无需后端。

---

## 多租户 GUI 配置平台

### 快速启动

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

打开浏览器：

- 配置中心 GUI：`http://127.0.0.1:8001/admin/`
- API 健康检查：`http://127.0.0.1:8001/api/health`

### 文档

- [GUI 配置中心操作手册](docs/gui-admin-guide.md) — 面向非技术人员，覆盖 9 个功能区的完整操作指南

### 功能概览

| 功能 | 说明 |
|------|------|
| 多公司隔离 | 所有数据按 `company_id` 完全隔离 |
| 可视化字段配置 | 定义字段、类型、Excel 别名、搜索/复制/显示区域 |
| 报价规则构建器 | 条件+动作可视化配置折扣规则，无需写代码 |
| 复制模板配置 | 自定义复制输出的列、前缀、行类型 |
| 页面显示配置 | 修改标题文案和结果卡布局，无需改前端代码 |
| 数据导入 + 预览 | JSON 导入 + 字段映射预览（高亮已定义字段） |
| 数据回滚/撤销 | 支持按 `data_revision` 撤销最近导入的数据版本 |
| 配置版本历史 | 查看所有 revision，一键回滚到任意历史版本 |
| 审计日志 | 按公司隔离，记录所有配置和数据操作 |
| 热加载 | 发布新配置无需重启，下次请求立即生效 |
| 三菱库存实时查询 | 勾选规格 → 自动查上海/日本库存并回写卡片（`POST /api/stock-query`，无认证） |

### 运行测试

```powershell
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v
```

当前 28 条 Python + 11 条 JS 测试全绿。

---

## 客户门户 + 生产部署

### 本地开发

打开 `http://127.0.0.1:8001/apps/index.html`（后端需先启动）。

测试账号：公司代码 `TJLH`，用户名 `cs`，密码 `cs`（管理员在 admin 后台管理客户密码）。

### 静态报价台（纯前端模式）

原始的纯前端模式仍可使用：访问非 index.html 的 apps/ 路径，由 `app.js` 驱动，无需登录，数据来自 Supabase 加密 bundle。

---

## 静态前端报价台（app.js 纯前端模式）

### 当前架构

```text
智能询价/
├─ apps/                     # 主站，Netlify publish 目录
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  └─ lib/
│     ├─ config-core.js      # 配置、字段、适配、复制、折扣规则核心
│     ├─ discount-utils.js
│     ├─ query-regex.js
│     └─ result-sort.js
├─ backend/                  # 多租户 GUI 配置平台后端
├─ admin/                    # GUI 配置中心前端（含品牌识别 + Bundle 生成）
│  ├─ app.js / customer-app.js / merger-app.js
│  ├─ lib/
│  │  ├─ config-core.js
│  │  ├─ data-utils.js       # Excel 数据解析 + Bundle 生成
│  │  ├─ bundle-utils.js     # Bundle 编解码
│  │  └─ export-utils.js     # 导出工具
│  └─ styles.css
├─ config.example.json       # schema v2 完整配置样例
├─ tests/                    # Node 原生测试 + Python 后端测试
└─ netlify.toml
```

### 运行方式

本地推荐用静态服务器打开，避免浏览器对 `file://` 的缓存和跨路径限制：

```powershell
python -m http.server 8080
```

然后访问：

- 主站：`http://localhost:8080/apps/`

Netlify 当前发布目录是 `apps`，线上根路径直接进入主站。

## 远端文件

主站默认从 Supabase 公共存储桶读取：

- `config.json`
- `price.bundle.json`
- `stock.bundle.json`

`config.json` 顶层的 `version` 字段用于 Cache Storage 失效。发布任意新配置或数据包后，更新 `config.json` 里的 `version` 即可。旧的 `version.json` 仍可作为兼容兜底，但不再是必需文件。

---

## 配置文件参考（schema v2）

配置文件使用 `schema_version: 2`，完整样例见 [config.example.json](config.example.json)。

### 顶层结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `schema_version` | number | 固定为 `2` |
| `version` | string | 当前配置和数据包版本，更新后主站会刷新价格/库存包缓存 |
| `data_source` | object | 远端文件地址和缓存配置 |
| `pricing` | object | 价格显示和折扣步进配置 |
| `fields` | array | 字段定义，决定搜索、复制和结果显示行为 |
| `copy` | object | 复制输出配置 |
| `result_layout` | object | 结果卡各区域的字段分组 |
| `discount_rules` | array | 折扣规则，按条件自动匹配默认折扣（v2 格式为 `conditions` 数组，v3 格式为 `when.all` 条件组，系统双向兼容）。折扣弹窗动态渲染，支持任意数量品牌。 |
| `merger` | object | merger 工具的数据处理配置 |
| `labels` | object | 主站按钮、标题、占位符等文案 |

---

### `data_source`

```json
"data_source": {
  "base_url": "https://...supabase.co/storage/v1/object/public/s-q",
  "version_file": "version.json",
  "config_file": "config.json",
  "price_bundle_file": "price.bundle.json",
  "stock_bundle_file": "stock.bundle.json",
  "cache_name": "quotation-cache-v3"
}
```

| 字段 | 说明 |
|------|------|
| `base_url` | 远端数据目录根 URL，不带末尾斜杠 |
| `version_file` | 旧版本文件名，仅在 `config.version` 未设置时作为兼容兜底 |
| `config_file` | 运行配置文件名 |
| `price_bundle_file` | 价格数据包文件名 |
| `stock_bundle_file` | 库存数据包文件名（明文，不加密） |
| `cache_name` | Cache Storage 存储桶名称，更新后需改名以强制失效 |

---

### `pricing`

```json
"pricing": {
  "decimal_places": 1,
  "rounding_threshold": 100,
  "discount_step": {
    "default": 0.1,
    "min": 0.1,
    "presets": [0.1, 0.5, 1]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `decimal_places` | number | 报价显示的小数位数，`0` 为整数，`1` 为一位小数 |
| `rounding_threshold` | number | 超过此面价时报价取整（向上取整到整数）；低于此值保留小数 |
| `discount_step.default` | number | 折扣调节步进的默认值，单位为百分比绝对值（如 `0.1` 表示每次增减 0.1%） |
| `discount_step.min` | number | 折扣步进的最小允许值，不能小于 `0.01` |
| `discount_step.presets` | number[] | 步进快捷切换按钮列表，所有值必须为正数 |

---

### `fields[]` — 字段定义（核心）

字段数组控制系统对每一列数据的完整行为：是否参与搜索、是否出现在复制输出、在结果卡的哪个区域显示、以及从 Excel 读取时识别哪些列名。

```json
{
  "key": "spec",
  "label": "规格型号",
  "type": "text",
  "source": "price",
  "excel_aliases": ["规格型号", "规格", "型号", "产品型号"],
  "searchable": true,
  "copyable": true,
  "result_area": "identity",
  "required": true
}
```

#### 字段属性说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | ✅ | 字段唯一标识，程序内部引用均用此 key |
| `label` | string | | 界面显示名称，省略时回退为 `key` |
| `type` | string | | 值类型，见下方 `type` 说明 |
| `source` | string | | 数据来源，见下方 `source` 说明 |
| `excel_aliases` | string[] | | Excel 列名别名列表，merger 工具按此列表识别列 |
| `searchable` | boolean | | 是否纳入搜索匹配，见下方详细说明 |
| `copyable` | boolean | | 是否允许出现在复制输出中，见下方详细说明 |
| `result_area` | string | | 结果卡显示区域，见下方详细说明 |
| `required` | boolean | | 是否为必填字段，见下方详细说明 |

---

#### `type` — 值类型

| 值 | 说明 |
|----|------|
| `"text"` | 普通文本，原样存储和显示 |
| `"number"` | 数值，merger 处理时自动去掉千分号并转为 number 类型，用于面价等数字字段 |
| `"computed"` | 运行时计算值，不从 Excel 读取，不存入数据包。目前仅 `quote_price`（报价）为此类型，由面价和折扣实时计算得出 |

---

#### `source` — 数据来源

| 值 | 说明 |
|----|------|
| `"price"` | 字段来自价格包（`price.bundle.json`） |
| `"stock"` | 字段来自库存包（`stock.bundle.json`），merger 处理时读取库存 Excel |
| `"both"` | 字段同时存在于价格包和库存包，两者均可写入 |
| `"computed"` | 运行时计算，不来自任何数据包 |

---

#### `searchable` — 是否参与搜索

**类型**：`boolean`，默认 `false`

用户在输入框输入关键词时，主站会遍历所有 `searchable: true` 的字段值进行模糊匹配。支持多关键词（空格分隔），所有词都需匹配才返回结果。

- `true`：该字段的值参与关键词搜索
- `false`：该字段不参与搜索（如面价、报价、库存数量等数值字段一般不搜索）

**典型设置**：
- `spec`（规格型号）→ `true`
- `mnemonic`（助记码）→ `true`，支持用简码搜索
- `face_price`（面价）→ `false`，数字不适合关键词搜索
- `stock`（库存）→ `false`，库存量不参与搜索

---

#### `copyable` — 是否允许复制

**类型**：`boolean`，默认 `false`

控制该字段是否可以出现在"复制勾选"的输出中。`copyable: true` 只是前提条件——字段是否实际出现在复制输出，还取决于 `copy.columns` 中的配置及用户的勾选状态。

- `true`：该字段可以在 `copy.columns` 中配置为复制列，用户勾选后会输出
- `false`：该字段不会出现在复制输出中，即使 `copy.columns` 中有定义也会忽略

**典型设置**：
- `spec`、`quote_price`、`remark` → `true`，通常需要复制给客户
- `brand`、`name`、`mnemonic` → `false`，内部字段，不对外复制

---

#### `result_area` — 结果卡显示区域

**类型**：`string`，默认 `"detail"`

控制该字段在查询结果卡中的视觉位置和显示方式。共有四个区域：

| 值 | 区域 | 说明 |
|----|------|------|
| `"identity"` | 标识区（卡片顶部） | 主要标识信息，大字展示。通常为 `spec`（规格）和 `code`（代码）。整个卡片以此区域的值为核心 |
| `"metric"` | 指标区（价格区） | 数值类指标，突出显示。通常为 `face_price`（面价）和 `quote_price`（报价），支持折扣调节 |
| `"chip"` | 标签区（标签行） | 辅助状态信息，以小标签（chip）形式展示。通常为 `special`（特价活动）和 `stock`（库存状态） |
| `"detail"` | 明细区（卡片底部） | 补充信息，折叠或小字展示。通常为 `remark`（备注）、`brand`（品牌）、`name`（名称）、`delivery`（交期）等 |

`result_layout` 中的四个数组（`identity`、`metrics`、`chips`、`details`）控制各区域的字段顺序，`result_area` 控制字段归属。两者需保持一致。

---

#### `required` — 是否必填

**类型**：`boolean`，默认 `false`

标记该字段在数据包中是否为必须存在的字段。主要影响两个环节：

- **merger 工具**：生成数据包时，若 `required: true` 的字段在某行 Excel 中缺失或为空，该行数据会被标记为异常（视实现而定）
- **配置校验**：`validateConfig()` 会检查 `merger.primary_field` 引用的字段是否存在，`required` 字段应有对应定义

通常只有作为主键或查询核心的字段才设为 `true`：

- `spec`（规格型号）→ `true`，价格包以规格为主键，缺失则无法建立索引
- 其他字段 → `false`，允许部分行数据不完整

---

### `copy` — 复制输出配置

控制"复制勾选"功能的输出格式和列定义。

```json
"copy": {
  "empty_value": "",
  "price_prefix": "含税",
  "columns": [
    { "field": "spec",        "label": "规格", "default": true,  "line": "main" },
    { "field": "quote_price", "label": "报价", "default": true,  "line": "main", "prefix": "含税" },
    { "field": "remark",      "label": "备注", "default": false, "line": "detail" },
    { "field": "delivery",    "label": "交期", "default": false, "line": "detail", "prefix": "交期 " }
  ]
}
```

#### `copy` 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `empty_value` | string | 字段为空时的替代输出，默认 `""`（空字符串，即跳过该列） |
| `price_prefix` | string | 报价列的前缀文字，默认 `"含税"` |
| `columns` | array | 可勾选的复制列定义列表，顺序决定输出顺序 |

#### `copy.columns[]` 字段

| 属性 | 类型 | 说明 |
|------|------|------|
| `field` | string | 对应 `fields[].key`，引用数据字段 |
| `label` | string | 复制面板中显示的列名 |
| `default` | boolean | 是否默认勾选。`true` 表示用户打开页面即勾选，`false` 需手动勾选 |
| `line` | string | 输出行类型：`"main"` 为主行（同一行用空格拼接），`"detail"` 为独立换行 |
| `prefix` | string | 输出该列值时自动加的前缀，如 `"含税"` 或 `"交期 "` |
| `suffix` | string | 输出该列值时自动加的后缀（可选） |

**输出规则**：所有 `line: "main"` 的已勾选字段在同一行用空格连接；每个 `line: "detail"` 的字段单独占一行，跟在主行之后。

---

### `result_layout` — 结果卡布局

```json
"result_layout": {
  "identity": ["code", "spec"],
  "chips":    ["stock", "special"],
  "metrics":  ["face_price", "quote_price"],
  "details":  ["remark", "delivery"]
}
```

每个数组列出对应区域内字段的显示顺序。数组中的 key 必须在 `fields[]` 中有定义，且与该字段的 `result_area` 保持一致。

| 属性 | 对应 `result_area` | 说明 |
|------|-------------------|------|
| `identity` | `"identity"` | 卡片顶部标识字段，按此顺序显示 |
| `chips` | `"chip"` | 标签行字段顺序 |
| `metrics` | `"metric"` | 价格指标字段顺序 |
| `details` | `"detail"` | 明细区字段顺序 |

---

### `discount_rules[]` — 折扣规则

系统按规则顺序匹配，命中第一条非默认规则即停止。设有 `"default": true` 的规则作为兜底。

```json
"discount_rules": [
  { "id": "ex",         "label": "EX活动", "percent": 32, "conditions": [{ "field": "special", "contains": "EX活动" }] },
  { "id": "osg",        "label": "OSG",    "percent": 36, "conditions": [{ "field": "brand",   "regex": "OSG" }] },
  { "id": "mitsubishi", "label": "三菱",   "percent": 55, "conditions": [{ "field": "name",    "equals": "刀具" }] },
  { "id": "other",      "label": "其他",   "percent": 55, "default": true, "conditions": [] }
]
```

#### `discount_rules[]` 字段

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 规则唯一标识，用于内部引用和日志 |
| `label` | string | 界面显示的规则名称 |
| `percent` | number | 折扣点数（百分比），如 `55` 表示 55 折，报价 = 面价 × 55% |
| `default` | boolean | 是否为兜底规则。设为 `true` 的规则在所有非默认规则都不匹配时生效 |
| `conditions` | array | 触发此规则的条件列表，所有条件需同时满足（AND 关系） |

#### `conditions[]` — 匹配条件

每条规则可包含多个条件，所有条件均满足时规则命中。

| 属性 | 类型 | 说明 |
|------|------|------|
| `field` | string | 要检查的字段 key，对应 `fields[].key` |
| `contains` | string | 包含匹配（忽略大小写和空白），字段值包含此字符串则匹配 |
| `equals` | string | 精确匹配，字段值与此字符串完全相等才匹配 |
| `regex` | string | 正则匹配（忽略大小写），字段值符合此正则则匹配 |

三种匹配方式选其一或组合使用，同一条件内多个属性同时存在时全部需满足。

---

### `merger` — 数据包生成配置

控制 merger 工具如何读取 Excel 并生成 bundle。

```json
"merger": {
  "primary_field": "spec",
  "stock_key_field": "code",
  "passthrough_fields": ["delivery"],
  "stock_format": "{warehouse}:{quantity}{status}",
  "stock_joiner": " | ",
  "stock_columns": {
    "code":      ["物料长代码", "代码", "物料编码", "编码"],
    "warehouse": ["发料仓库",   "仓库", "仓位", "仓"],
    "quantity":  ["库存数量",   "数量", "可用数量", "库存"],
    "status":    ["参考状态",   "状态", "备注"]
  },
  "brand_rules": {
    "defaultBrand": "UNMAPPED",
    "brands": [
      { "id": "MITSUBISHI", "prefixes": ["三菱", "MITSU"] },
      { "id": "OSG",        "prefixes": ["OSG"] }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `primary_field` | 价格包的主键字段 key（即行唯一标识），通常为 `"spec"` |
| `stock_key_field` | 库存包与价格包关联时使用的字段 key，通常为 `"code"` |
| `passthrough_fields` | 价格 Excel 中存在但未在核心字段中定义、需要透传进 bundle 的额外字段列表 |
| `stock_format` | 库存文本格式模板，`{warehouse}`/`{quantity}`/`{status}` 对应库存表各列 |
| `stock_joiner` | 多条库存记录（多仓）之间的拼接符，默认 `" | "` |
| `stock_columns` | 库存 Excel 各逻辑列的别名列表，merger 按此识别列 |
| `brand_rules.defaultBrand` | 无法按 prefixes 识别品牌时的兜底品牌 ID |
| `brand_rules.brands[]` | 品牌识别规则，`prefixes` 中任意一个前缀匹配行数据则识别为该品牌 |

---

### `labels` — 界面文案

主站所有可自定义的按钮和提示文案，均有内置默认值，不配置时自动回退。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `app_title` | `"智能询价系统"` | 页面标题 |
| `search_button` | `"智能查询"` | 主查询按钮文字 |
| `stock_search_button` | `"库存查询"` | 库存查询按钮文字 |
| `mmc_button` | `"三菱库存"` | 三菱库存按钮文字 |
| `copy_button` | `"复制勾选"` | 复制按钮文字 |
| `selected_label` | `"勾选"` | 已勾选数量前缀 |
| `config_button` | `"配置"` | 配置面板按钮文字 |
| `input_title` | `"输入"` | 输入区标题 |
| `result_title` | `"结果"` | 结果区标题 |
| `query_placeholder` | （多行提示） | 输入框占位符文本 |
| `empty_hint` | （搜索提示） | 无结果时显示的提示文字 |
| `stock_prefix` | `"库存 "` | 库存标签前缀 |

---

## 数据包格式

### 新版价格包（schema v2）

解码后的 payload：

```json
{
  "schema_version": 2,
  "primary_field": "spec",
  "rows": [
    { "key": "WNMG080408", "fields": { "code": "C001", "spec": "WNMG080408", "face_price": 100 } }
  ]
}
```

### 新版库存包（schema v2）

```json
{
  "schema_version": 2,
  "key_field": "code",
  "rows": [
    { "key": "C001", "fields": { "code": "C001", "stock": "上海:2" } }
  ]
}
```

### 旧版包兼容

主站自动识别旧包结构：

- 旧价格包：`bySpec`，字段使用单字母缩写 `c/p/s/r/b/n/m/a`
- 旧库存包：`byCode`

兼容映射：

| 旧 key | 新 key |
|--------|--------|
| `c` | `code` |
| `p` | `face_price` |
| `s` | `special` |
| `r` | `remark` |
| `b` | `brand` |
| `n` | `name` |
| `m` | `mnemonic` |
| `a` | `alias` |
| `i` | `stock` |

---

## 数据拼接与 Bundle 生成流程

品牌识别、价格/库存 Bundle 生成功能已集成到 admin GUI 配置中心（`admin/merger-app.js` + `admin/lib/`）。在 admin 页面的「数据拼接区」完成全部操作：

1. 打开 `http://127.0.0.1:8001/admin/`，切换到「数据拼接区」。
2. 阶段 1 上传原始品牌 Excel，按配置中的 `merger.brand_rules` 识别品牌，必要时手动修正并导出品牌分包。
3. 阶段 2 上传处理后的品牌文件，加载并导出 `price.bundle.json`。
4. 上传库存 Excel，按 `merger.stock_columns` 解析并导出 `stock.bundle.json`。
5. 填写 Supabase Anon Key 后可一键部署到 Supabase Storage，或导出本地备份。

价格包可加密；库存包保持明文，便于主站库存过滤。

---

## 发布流程

1. 在 admin GUI 的「数据拼接区」导出新的 `price.bundle.json`、`stock.bundle.json`，或一键部署到 Supabase。
2. 上传两个数据包到 `data_source.base_url` 指向的远端目录。
3. 在 admin GUI 发布配置后自动更新远端 `config.json` 的顶层 `version`，例如：

```json
"version": "2026-06-01.1"
```

4. 打开主站验证版本号、查询、库存查询、折扣步进和复制输出。

---

## 测试与检查

当前使用 Node 原生测试，不需要安装依赖：

```powershell
node --test tests\*.test.js
node --check apps\app.js
node --check apps\lib\*.js
node --check admin\app.js
node --check admin\lib\*.js
```

浏览器验收建议覆盖：

- 缺失远端配置时使用内置默认配置。
- 旧 `bySpec/byCode` 包和新 schema v2 包都能查询。
- 字段、复制列、结果卡布局、默认步进和折扣规则随配置变化。
- admin GUI 数据拼接区可以校验配置、预览字段、导出 `config.json` 和 v2 bundle。

---

## 安全说明

- 配置文件是公开运行配置，不能放密码、token 或任何秘密。
- Supabase anon key 仅用于 admin GUI 保存远端配置；不要把 service_role key 填进浏览器。
- 已移除前端硬编码 MMC 密码。
- 数据包使用 JSON 解析，不再注入远端脚本。
- Netlify 配置了基础安全响应头和 CSP；如未来主站加载第三方脚本，需要同步调整 CSP。
