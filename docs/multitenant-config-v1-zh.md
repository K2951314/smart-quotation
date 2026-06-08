# 多租户 GUI 配置平台 — 技术说明 v1

本文档面向开发人员，覆盖架构概览、数据库模型、完整 API 参考、配置 schema、测试验证和已知限制。

非技术人员的 GUI 操作指南见：[配置中心操作手册](./gui-admin-guide.md)

---

## 启动

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

- API 健康检查：`http://127.0.0.1:8001/api/health`
- GUI 配置中心：`http://127.0.0.1:8001/admin/`

---

## 已实现内容

### 后端

- FastAPI 应用工厂，按公司 ID 隔离所有端点。
- SQLite 持久化：公司、已发布/草稿配置、商品数据、审计事件。
- schema v2 → v3 配置自动迁移。
- JSON / YAML 配置导入导出。
- 热加载：发布时按公司失效配置缓存，报价台下次请求即使用新版本。
- 安全规则 DSL：折扣/动作条件；报价公式使用 Python AST 白名单安全求值。
- 插件注册表（`PluginRegistry`）和 ERPNext 适配器接口，预留供未来扩展。
- 配置版本历史列表与一键回滚。
- 数据统计端点（条数 + 当前数据版本）。
- 审计事件日志，按公司隔离。
- 公司列表端点。
- 公司管理：软删除、重命名、状态修改。
- 文件上传导入：Excel/CSV 自动按 `excel_aliases` 映射字段，支持预览和确认写入。
- 配置校验：`engine.validate_config()` 五项检查（默认规则、字段引用、动作类型、公式安全、复制模板）。
- 数据拼接 / Bundle 生成：品牌识别、价格包（AES-GCM 加密可选）、库存包生成与 Supabase 部署。

### GUI 配置中心（admin/）

- **公司配置**：创建公司；列出所有公司，一键切换当前 company_id；重命名/停用公司。
- **字段配置**：增删改字段，维护 Excel 别名映射。
- **报价规则**：条件+动作规则构建器，可视化配置折扣规则。
- **复制模板**：配置复制列及前后缀。
- **页面显示**（新增）：配置应用标题、结果卡四个区域布局、报价公式、小数位、取整模式和整数阈值，全 GUI 操作，无需手写 JSON。
- **数据拼接区**：品牌识别→数据合并→Bundle生成（AES-GCM加密可选）→Supabase部署
- **数据拼接**（新增）：品牌识别（多文件上传+自动检测+手动修正）、Bundle 生成（价格包+库存包，AES-GCM 加密可选）、Supabase 一键部署。
- **ERPNext**：连接配置和测试（v1 为 stub）。
- **发布配置**：保存草稿、发布、导出 JSON/YAML、导入 JSON。
- **版本历史**（新增）：列出所有 revision，状态徽章；一键回滚到任意历史版本。
- **审计日志**（新增）：最近 50 条审计事件，按当前公司隔离。

---

## API 参考

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 返回服务运行状态 |

### 公司管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/companies` | 列出所有公司 |
| `POST` | `/api/companies` | 创建公司，body：`{"name": "xx", "code": "xx"}` |
| `DELETE` | `/api/companies/{id}` | 软删除公司（status → inactive） |
| `PATCH` | `/api/companies/{id}` | 修改公司信息，body：`{"name": "新名称"}` |

### 配置管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/companies/{id}/config` | 获取当前已发布配置 |
| `POST` | `/api/companies/{id}/config` | 保存配置（草稿或发布），body：`{"config": {...}, "status": "draft"\|"published"}` |
| `GET` | `/api/companies/{id}/configs` | 列出所有配置版本（revision 列表） |
| `POST` | `/api/companies/{id}/config/{revision}/publish` | 将指定旧 revision 重新发布（回滚） |
| `GET` | `/api/companies/{id}/config/{revision}/export` | 导出指定版本，`?format=json`（默认）或 `?format=yaml` |
| `POST` | `/api/companies/{id}/config/import` | 从 JSON/YAML 导入配置，body：`{"content": "...", "format": "json"\|"yaml"}` |
| `GET` | `/api/companies/{id}/config/validate` | 校验当前配置合法性，返回错误列表 |

### 数据管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/companies/{id}/items` | 替换当前商品数据（覆盖），body：`{"data_revision": "xx", "rows": [...]}` |
| `POST` | `/api/companies/{id}/items/upload` | 文件上传导入，`multipart/form-data`；`?write=false` 预览，`?write=true` 写入 |
| `DELETE` | `/api/companies/{id}/items/rollback` | 按 `data_revision` 撤销最近导入的数据版本，删除该版本的所有行 |
| `GET` | `/api/companies/{id}/items/stats` | 数据统计，返回 `{data_revision, count}` |

### 数据拼接 / Bundle

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/companies/{id}/merger/detect-brands` | 上传多文件识别品牌，`multipart/form-data`（field: `files`） |
| `POST` | `/api/companies/{id}/merger/bundle/generate` | 生成价格包+库存包，body：`{"password": "", "deploy": false, "anon_key": ""}` |
| `POST` | `/api/companies/{id}/merger/bundle/deploy` | 部署已有 Bundle 到 Supabase，body：`{"price_bundle": {...}, "stock_bundle": {...}, "anon_key": "..."}` |

### 报价查询

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/companies/{id}/quote?q=关键词` | 执行报价查询，返回匹配商品和计算结果 |

### 审计日志

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/companies/{id}/audit?limit=50` | 获取审计日志，`limit` 默认 50，最大 200 |

### ERPNext（预留 stub）

```
POST /api/companies/{id}/integrations/erpnext/test
POST /api/companies/{id}/integrations/erpnext/sync/items
POST /api/companies/{id}/integrations/erpnext/sync/prices
POST /api/companies/{id}/integrations/erpnext/sync/stock
POST /api/companies/{id}/quotations/{quote_id}/push-to-erpnext
```

---

## 配置 Schema（schema_version 3）

```json
{
  "schema_version": 3,
  "company_id": "demo-company",
  "revision": "2026-06-03.1",
  "pricing": {
    "currency": "CNY",
    "decimal_places": 1,
    "rounding": {
      "mode": "ceil",
      "integer_above": 100
    },
    "default_formula": "face_price * discount_percent / 100"
  },
  "fields": [
    {
      "key": "spec",
      "label": "规格型号",
      "type": "text",
      "source": "price",
      "excel_aliases": ["规格型号", "型号", "规格"],
      "searchable": true,
      "copyable": true,
      "required": true,
      "result_area": "identity"
    },
    {
      "key": "face_price",
      "label": "面价",
      "type": "number",
      "source": "price",
      "excel_aliases": ["销售单价", "面价"],
      "result_area": "metric"
    }
  ],
  "rules": [
    {
      "id": "ex_activity",
      "label": "EX 活动",
      "priority": 10,
      "when": {
        "all": [{ "field": "special", "op": "contains", "value": "EX活动" }]
      },
      "actions": [{ "type": "set_discount", "percent": 32 }]
    },
    {
      "id": "default",
      "label": "默认折扣",
      "priority": 9999,
      "default": true,
      "actions": [{ "type": "set_discount", "percent": 55 }]
    }
  ],
  "copy": {
    "columns": [
      { "field": "spec",        "label": "规格", "default": true,  "line": "main" },
      { "field": "quote_price", "label": "报价", "default": true,  "line": "main", "prefix": "含税" }
    ]
  },
  "ui": {
    "app_title": "智能询价系统",
    "result_layout": {
      "identity": ["code", "spec"],
      "metrics":  ["face_price", "quote_price"],
      "chips":    ["stock", "special"],
      "details":  ["remark", "delivery"]
    }
  },
  "integrations": {
    "erpnext": {
      "enabled": false,
      "base_url": "",
      "item_code_field": "code",
      "price_list": "Standard Selling",
      "warehouse_map": {}
    }
  }
}
```

### schema v2 → v3 迁移

系统自动将旧版 v2 配置转换为 v3，规则如下：

| v2 结构 | v3 映射 |
|---------|---------|
| `discount_rules[].percent` | `rules[].actions[0].percent` |
| `discount_rules[].conditions[].contains` | `rules[].when.all[].op: "contains"` |
| `result_layout.metrics` → `discount_rules` 兜底 | `rules[].default: true` |
| `labels.app_title` | `ui.app_title` |
| `pricing.rounding_threshold` | `pricing.rounding.integer_above` |

---

## 数据库模型

SQLite 核心表（`quotation.db`）：

```sql
-- 公司
companies(id TEXT, name TEXT, code TEXT UNIQUE, status TEXT, created_at TEXT)

-- 配置版本
quotation_configs(
  id INTEGER PRIMARY KEY,
  company_id TEXT,
  revision TEXT,
  status TEXT,          -- 'draft' | 'published' | 'archived'
  config_json TEXT,
  created_by TEXT,
  published_at TEXT,
  created_at TEXT
)

-- 商品数据
quotation_items(
  id INTEGER PRIMARY KEY,
  company_id TEXT,
  data_revision TEXT,
  item_key TEXT,
  fields_json TEXT
)

-- 审计事件
audit_events(
  id INTEGER PRIMARY KEY,
  company_id TEXT,
  actor_id TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  created_at TEXT
)
```

---

## 报价引擎工作流程

1. 根据 `company_id` 加载已发布配置（从缓存，若无则从 DB 读取）。
2. 按 `fields[].searchable=true` 的字段做全文匹配，支持多关键词（空格分隔，AND 语义）。
3. 按 `rules[].priority` 升序执行，命中第一条非默认规则即停止；无命中则使用 `default=true` 规则。
4. 按 `pricing.default_formula` 计算报价，使用 Python AST 白名单求值。
5. 按 `pricing.rounding` 规则对超过 `integer_above` 的面价取整。
6. 按 `ui.result_layout` 返回结果结构；按 `copy.columns` 返回复制文本。

### 安全公式求值

公式只允许以下内容：
- 字段 key（如 `face_price`、`discount_percent`）
- 算术运算符：`+`、`-`、`*`、`/`、`**`
- 内置函数白名单：`ceil`、`floor`、`round`、`min`、`max`
- 数值常量

任何不在白名单内的节点（函数调用、属性访问、导入等）均会拒绝并报错。

---

## 热加载机制

```python
class ConfigCache:
    # 缓存 key = (company_id, revision)
    # 发布新配置时调用 invalidate_company(company_id)
    # 下一次请求自动重新加载最新已发布版本
```

发布/回滚 → `invalidate_company` 清空该公司所有 revision 缓存 → 下一次 `/quote` 请求加载新版本。无需重启服务。

---

## 测试验证

```powershell
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v
```

当前 16 条测试全绿，覆盖：

| 测试项 | 文件 |
|--------|------|
| v2 配置迁移为 v3 | test_backend_v1 |
| 规则优先级、取整、复制输出 | test_backend_v1 |
| 多租户数据隔离 | test_backend_v1 |
| 配置缓存失效（发布后生效） | test_backend_v1 |
| 版本回滚 | test_backend_v1 |
| 版本历史列表 | test_backend_v1 |
| 数据统计（条数+版本） | test_backend_v1 |
| 公司列表 | test_backend_v1 |
| 审计日志记录 | test_backend_v1 |
| 配置校验边界（缺默认规则/禁止公式/非法动作） | test_backend_v1 |
| GUI 导航区元素存在性 | test_admin_gui |
| GUI 渲染/API 函数存在性 | test_admin_gui |
| GUI 新增区域（版本历史/审计日志/UI 配置） | test_admin_gui |

> `test_backend_api_and_extensions.py` 需要 `httpx` 包（`fastapi.testclient` 依赖），在当前环境因 SSL 限制无法通过 pip 安装。该测试在有网络访问时可正常运行。

---

## 代码结构

```
backend/smart_quotation/
├── __main__.py     # 启动入口，挂载 admin/ 静态文件
├── api.py          # FastAPI 路由定义，所有 HTTP 端点
├── store.py        # SQLite 数据层：CRUD、版本历史、审计、统计
├── engine.py       # 报价引擎：规则匹配、公式求值、取整
├── config.py       # 配置校验、v2→v3 迁移、ConfigCache
├── plugins.py      # 插件注册表接口（预留）
└── erp.py          # ERPNext 适配器接口（预留 stub）

admin/
├── index.html      # GUI 单页应用，10 个功能区
├── app.js          # 所有 GUI 逻辑：状态管理、API 调用、渲染
└── styles.css      # 样式
```

---

## 已知限制（v1）

| 限制 | 说明 |
|------|------|
| 无用户认证 | v1 单用户模式，GUI 直接操作指定 company_id，无登录/权限控制 |
| ERPNext 为 stub | 所有 ERPNext 同步端点均为预留接口，尚未实现 |
| httpx 不可用 | `test_backend_api_and_extensions.py` 需要网络安装 httpx 才能运行 |
| SQLite only | v1 仅支持 SQLite；PostgreSQL 迁移能力已在架构预留 |

---

## 相关文档

- [GUI 配置中心操作手册](./gui-admin-guide.md)（面向非技术人员）
- `config.example.json`：schema v2 完整样例（静态前端兼容格式）
- `README.md`：项目总览和静态前端架构说明
