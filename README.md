# 智能询价系统

一个纯前端静态询价工具，主站部署在 `apps/`，数据包生成工具在 `merger/`。系统通过远端 `config.json`、`price.bundle.json`、`stock.bundle.json` 和 `version.json` 运行，不需要 Node 服务端或构建流程。

## 当前架构

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
├─ merger/                   # Excel 拼接与 bundle 生成工具
│  ├─ index.html
│  ├─ app.js
│  ├─ brand-config.json      # 旧品牌规则兼容入口
│  └─ lib/
│     ├─ data-utils.js
│     ├─ bundle-utils.js
│     └─ export-utils.js
├─ config.example.json       # schema v2 完整配置样例
├─ tests/                    # Node 原生测试
└─ netlify.toml
```

## 运行方式

本地推荐用静态服务器打开，避免浏览器对 `file://` 的缓存和跨路径限制：

```powershell
python -m http.server 8080
```

然后访问：

- 主站：`http://localhost:8080/apps/`
- 生成器：`http://localhost:8080/merger/`

Netlify 当前发布目录是 `apps`，线上根路径直接进入主站。

## 远端文件

主站默认从 Supabase 公共存储桶读取：

- `version.json`
- `config.json`
- `price.bundle.json`
- `stock.bundle.json`

`version.json` 中的 `version` 字段用于 Cache Storage 失效。发布任意新配置或数据包后，都应同步更新该版本。

## 配置化能力

配置文件使用 `schema_version: 2`，参考 [config.example.json](config.example.json)。核心配置项：

- `data_source`：远端 base URL、文件名和缓存名。
- `pricing`：小数位、取整阈值、默认折扣步进、步进预设。
- `fields[]`：字段 key、显示名、类型、来源、Excel 列别名、是否搜索、是否复制、结果区位置、是否必填。
- `copy`：复制列、默认勾选、前缀、主行/明细行输出。
- `result_layout`：结果卡里的身份字段、标签字段、指标字段、明细字段。
- `discount_rules[]`：按字段 `contains`、`equals`、`regex` 匹配默认折扣。
- `merger`：价格主键、库存关联键、库存列别名、品牌识别规则、透传字段。
- `labels`：主站按钮、标题、占位符和状态文案。

字段示例：

```json
{
  "key": "delivery",
  "label": "交期",
  "type": "text",
  "source": "price",
  "excel_aliases": ["交期", "货期"],
  "searchable": true,
  "copyable": true,
  "result_area": "detail",
  "required": false
}
```

这样不同公司的 Excel 列名和报价字段可以通过配置兼容，不需要改主站代码。

## 数据包格式

新版价格包解码后的 payload：

```json
{
  "schema_version": 2,
  "primary_field": "spec",
  "rows": [
    { "key": "WNMG080408", "fields": { "code": "C001", "spec": "WNMG080408", "face_price": 100 } }
  ]
}
```

新版库存包解码后的 payload：

```json
{
  "schema_version": 2,
  "key_field": "code",
  "rows": [
    { "key": "C001", "fields": { "code": "C001", "stock": "上海:2" } }
  ]
}
```

主站仍兼容旧包：

- 旧价格 `bySpec`：`c/p/s/r/b/n/m/a`
- 旧库存 `byCode`

兼容映射为：`code/spec/face_price/special/remark/brand/name/mnemonic/alias/stock`。

## merger 使用流程

1. 打开 `http://localhost:8080/merger/`。
2. 在“运行配置”中编辑或粘贴 `config.json`，点击“校验并预览配置”。
3. 阶段 1 上传原始品牌 Excel，按配置中的 `merger.brand_rules` 识别品牌，必要时手动修正并导出品牌分包。
4. 阶段 2 上传处理后的品牌文件，加载并导出 `price.bundle.json`。
5. 上传库存 Excel，按 `merger.stock_columns` 解析并导出 `stock.bundle.json`。
6. 可点击“导出 config.json”把当前配置和数据包一起发布到远端。

价格包可加密；库存包保持明文，便于主站库存过滤。

## 发布流程

1. 用 `merger/` 导出新的 `config.json`、`price.bundle.json`、`stock.bundle.json`。
2. 上传到 `data_source.base_url` 指向的远端目录。
3. 更新远端 `version.json`，例如：

```json
{ "version": "2026-05-20-001" }
```

4. 打开主站验证版本号、查询、库存查询、折扣步进和复制输出。

## 测试与检查

当前使用 Node 原生测试，不需要安装依赖：

```powershell
node --test tests\*.test.js
node --check apps\app.js
node --check apps\lib\*.js
node --check merger\app.js
node --check merger\lib\*.js
```

浏览器验收建议覆盖：

- 缺失远端配置时使用内置默认配置。
- 旧 `bySpec/byCode` 包和新 schema v2 包都能查询。
- 字段、复制列、结果卡布局、默认步进和折扣规则随配置变化。
- `merger/` 可以校验配置、预览字段、导出 `config.json` 和 v2 bundle。

## 安全说明

- 配置文件是公开运行配置，不能放密码、token 或任何秘密。
- 已移除前端硬编码 MMC 密码。
- 数据包使用 JSON 解析，不再注入远端脚本。
- Netlify 配置了基础安全响应头和 CSP；如未来主站加载第三方脚本，需要同步调整 CSP。
