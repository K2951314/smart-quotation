# 智能询价项目说明

## 1. 项目概述

本项目包含两个彼此配套的前端工具：

- 根目录主站：`智能询价系统`
  用于加载价格包与库存包，完成规格检索、库存筛选、折扣调价、结果勾选与复制。
- `merger/` 目录：`拼接器与双包生成器`
  用于把原始 Excel 数据整理成项目主站可消费的 `price.bundle.js` 和 `stock.bundle.js`。这是生成包工具，必须保留。

项目整体是一个纯前端静态站点，没有 Node 服务端，也没有本地构建流程。主站运行依赖远端数据包；`merger` 用于在本地浏览器中处理 Excel 并导出新的数据包。

## 2. 当前目录结构

```text
智能询价/
├─ app.js                    # 主站核心逻辑
├─ index.html                # 主站页面入口
├─ styles.css                # 主站样式
├─ lib/
│  ├─ discount-utils.js      # 折扣规则与折扣步长工具
│  ├─ query-regex.js         # 查询文本转正则、匹配辅助
│  └─ result-sort.js         # 勾选结果排序逻辑
├─ merger/                   # 数据包生成工具，必须保留
│  ├─ app.js                 # merger 页面逻辑
│  ├─ brand-config.json      # 品牌识别配置
│  ├─ index.html             # merger 页面入口
│  └─ lib/
│     ├─ bundle-utils.js     # price/stock bundle 编码与加密
│     ├─ data-utils.js       # Excel 数据标准化与数据集生成
│     └─ export-utils.js     # 导出 bundle 脚本
├─ netlify.toml              # Netlify 部署配置
├─ _headers                  # 静态托管响应头配置
└─ .gitignore
```

## 3. 本次清理内容

本次删除的是仓库内已经没有任何入口引用、也不参与当前功能的遗留文件与代码：

- 已删除 `lib/remote-source-utils.js`
  该文件未被任何页面或脚本加载，也没有被项目中其他模块引用。
- 已删除 `lib/version-utils.js`
  虽然曾在 `index.html` 中被加载，但主程序实际使用的是 `app.js` 内部的版本处理逻辑，属于重复遗留文件。
- 已移除 `merger/lib/data-utils.js` 中未被调用的 `joinPriceStock`
- 已移除 `merger/lib/export-utils.js` 中未被调用的 `createMergedDb`

清理原则是“只删确定无引用、无运行入口、无生成职责的内容”，因此 `merger/` 目录整体予以保留。

## 4. 主站功能说明

主站页面位于 [index.html](E:/Ingulf/智能询价/index.html)，核心逻辑位于 [app.js](E:/Ingulf/智能询价/app.js)。

主要能力如下：

- 从远端 Supabase 存储拉取：
  - `config.json`
  - `price.bundle.js`
  - `stock.bundle.js`
- 使用 Cache Storage 做本地缓存，加快二次访问速度
- 按规格、代码、助记码、别名、备注、特价关键词进行查询
- 支持仅查库存项
- 支持默认折扣配置与本地持久化
- 支持步进式调价与手工输入折扣
- 支持勾选结果后复制报价文本
- 支持显示价格版本与库存版本

### 数据来源

主站当前通过 `app.js` 中的 `SUPABASE_BASE_URL` 常量访问远端静态数据：

```js
const SUPABASE_BASE_URL = "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/quotation-data";
```

如果后续更换存储桶、CDN 或数据发布路径，优先修改该常量及对应远端文件结构。

### 主站依赖的远端文件

主站至少需要远端存在以下文件：

- `version.json`
- `config.json`
- `price.bundle.js`
- `stock.bundle.js`

其中：

- `config.json` 用于控制默认折扣、四舍五入阈值、小数位数、默认勾选列等
- `price.bundle.js` 为价格包，可按需加密
- `stock.bundle.js` 为库存包，当前设计要求保持明文

## 5. merger 生成工具说明

`merger/` 是这个项目的数据包生成器，页面入口是 [merger/index.html](E:/Ingulf/智能询价/merger/index.html)，逻辑文件是 [merger/app.js](E:/Ingulf/智能询价/merger/app.js)。

它的职责不是提供询价查询，而是把原始 Excel 整理成主站可直接消费的 bundle 文件。

### merger 的处理流程

#### 阶段 1：按品牌拆分原始价格文件

1. 打开 `merger/index.html`
2. 检查或编辑品牌规则配置 `brand-config.json`
3. 上传品牌原始 Excel 文件
4. 点击“分析文件并识别品牌”
5. 如识别有误，可手工修正品牌
6. 点击“导出各品牌文件”

这一步会得到按品牌拆分后的中间 Excel 文件。

#### 阶段 2：合并价格文件

1. 上传阶段 1 处理后的品牌文件
2. 点击“加载阶段2文件”
3. 点击“仅导出价格包”或后续统一导出

该流程会生成 `price.bundle.js`。

#### 阶段 3：导入库存文件

1. 上传库存 Excel 文件
2. 点击“加载库存文件”
3. 点击“仅导出库存包”或统一导出

该流程会生成 `stock.bundle.js`。

#### 阶段 4：导出完整产物

点击“全部导出（总表 + 价格包 + 库存包）”后，会导出：

- `price_all_merged.xlsx`
- `price.bundle.js`
- `stock.bundle.js`

如果填写了“价格包密码”，则价格包会使用 AES-GCM 加密；主站在读取价格包时会提示输入密码。

## 6. 本地使用方式

### 方式一：直接静态打开

如果浏览器对本地文件访问策略较宽松，可以直接双击打开：

- [index.html](E:/Ingulf/智能询价/index.html)
- [merger/index.html](E:/Ingulf/智能询价/merger/index.html)

但更推荐使用本地静态服务器，以避免浏览器对缓存、脚本和文件协议的限制。

### 方式二：使用本地静态服务器

在项目根目录执行任一命令：

```powershell
python -m http.server 8080
```

或：

```powershell
npx serve .
```

然后访问：

- `http://localhost:8080/`
- `http://localhost:8080/merger/`

## 7. 部署说明

项目当前包含：

- [netlify.toml](E:/Ingulf/智能询价/netlify.toml)
- [_headers](E:/Ingulf/智能询价/_headers)

说明该仓库可直接作为静态站点部署到 Netlify 或其他静态托管平台。

部署时需要关注两件事：

1. 主站本身是静态页面，但数据来自远端 Supabase 存储。
2. 如果发布了新的 `price.bundle.js`、`stock.bundle.js` 或 `config.json`，应同步更新远端 `version.json`，让主站缓存按新版本失效。

## 8. 维护建议

- 不要删除 `merger/`，它是生成主站数据包的关键工具。
- 如果调整主站字段结构，需要同步修改：
  - [app.js](E:/Ingulf/智能询价/app.js)
  - [merger/lib/data-utils.js](E:/Ingulf/智能询价/merger/lib/data-utils.js)
  - [merger/lib/export-utils.js](E:/Ingulf/智能询价/merger/lib/export-utils.js)
- 如果新增品牌识别规则，优先修改 [merger/brand-config.json](E:/Ingulf/智能询价/merger/brand-config.json)
- 如果修改默认折扣、默认勾选列、保留小数位等参数，优先通过远端 `config.json` 控制，而不是直接改前端默认值
- 如果需要切换远端数据源，优先核对 [app.js](E:/Ingulf/智能询价/app.js) 中的远端地址与缓存策略

## 9. 后续建议

当前仓库没有自动化测试，也没有数据发布脚本。后续如果要继续维护，建议补上以下内容：

- 一个最小的“数据包发布说明”
- `config.json` / `version.json` 的字段约定文档
- 一个用于校验 `price.bundle.js` / `stock.bundle.js` 格式的简单脚本
- 一个发布前检查清单，避免价格包与库存包版本不一致
