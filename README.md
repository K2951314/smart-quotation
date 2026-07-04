# 智能询价系统

> B2B 刀具/工具行业报价工具。管理员配置价格/折扣/品牌规则，销售/客户看报价+调利润率。
> 所有功能在独立 HTML 中可用，数据从 Supabase 加载，无需运行服务器。

---

## 快速开始

```bash
# 管理员版（完整功能，双击即用）
python3 build_standalone.py

# 公司版（无面价，硬编码利润率/税率）
python3 build_standalone.py --company --name "公司名称" --profit 10 --tax 13
```

生成的文件在项目根目录：
- `standalone.html` — **管理员版**：面价/折扣/配置全功能
- `company.html` — **公司版**：无面价、无折扣配置、可调利润率

双击对应文件即可在浏览器中使用（数据从云端加载，需联网）。

---

## 项目结构

```
智能询价/
├── apps/                        # 前端源码
│   ├── index.html               # 管理员版 HTML（免登录）
│   ├── app.js                   # 主逻辑（管理员+公司统一代码）
│   ├── styles.css               # 样式
│   ├── standalone.html          # 构建产物：管理员版
│   ├── company.html             # 构建产物：公司版
│   └── lib/                     # 工具库
│       ├── query-regex.js       # 模糊查询引擎
│       ├── discount-utils.js    # 折扣计算工具
│       ├── result-sort.js       # 结果排序
│       └── config-core.js       # 配置核心
├── backend/                     # FastAPI 后端（配置后台 API + SQLite）
├── admin/                       # 配置后台（浏览器 GUI）
│   ├── index.html               # 后台页面
│   ├── app.js                   # 后台逻辑
│   └── styles.css               # 后台样式
├── build_standalone.py          # 构建脚本（管理员版+公司版）
├── docs/                        # 文档
│   └── promotion-plan.md        # 推广文档（含剪映剪辑指引）
└── remotion-videos/             # 宣传视频（Remotion 项目）
```

---

## 构建命令

| 命令 | 产物 | 用途 |
|------|------|------|
| `python3 build_standalone.py` | `apps/standalone.html` | 管理员版：面价/折扣/配置全功能 |
| `python3 build_standalone.py --company --profit 10 --tax 13` | `apps/company.html` | 公司版：无面价、利润率预设 10% |
| `python3 build_standalone.py --company --name "某公司" --profit 8 --tax 13` | `apps/company.html` | 公司版：自定义公司名和利润率 |

管理员版特点：**免登录**、面价/折扣/品牌配置全可见、所有功能完整。

公司版特点：**免登录**、面价和折扣配置**代码级隐藏**（不存在于文件中）、利润率/税率由管理员通过构建参数预设。

---

## 核心公式

**每一步独立取整，取整方式可通过工具栏下拉框切换：**

| 模式 | 含税价 | 未税价 |
|------|--------|--------|
| 管理员 | `rounding(面价 × 折扣%)` | `rounding(含税价 / 1.13)` |
| 公司 | `rounding(含税价 × (1 + 利润率%))` | `rounding(含利润含税价 / 1.13)` |

### 取整方式选项
- **向上取整**（默认）— `Math.ceil`
- **四舍五入** — `Math.round`
- **向下取整** — `Math.floor`

---

## 角色功能对比

| 功能 | 管理员 | 公司 |
|------|--------|------|
| 面价显示 | ✅ | ❌ CSS 隐藏 |
| 折扣调价 | ✅（± 按钮调折扣%） | ✅（± 按钮调利润率%，同位置） |
| 利润率调价 | ❌ | ✅ 每条卡独立+工具栏步进 |
| 折扣配置 | ✅ | ❌ 按钮隐藏 |
| 含税/未税切换 | ✅ | ✅ |
| 三菱库存 | ✅ | ✅ |
| 模糊查询 | ✅ | ✅ |
| 一键复制 | ✅ | ✅ |

### 公司版特有行为

- 工具栏「折扣步长」→ **步进**（控制利润 ± 按钮每次加减量，默认 1）
- 折扣配置按钮 → 隐藏
- 每条结果卡的折扣面板 → **利润率面板**（无"利润"文字标签）
- 默认利润率/税率在 `--profit`/`--tax` 参数中预设
- 默认显示含税价；勾选「未税」后报价除 1.13

---

## 数据流

```
Supabase Storage (config.json + price.bundle.json + stock.bundle.json)
    ↓
fetchFileWithCache() → Cache API 缓存（file:// 下直连 fetch）
    ↓
app.js 解析 → PRICE_DATA / STOCK_DATA → 构建搜索索引
    ↓
用户输入 → 模糊匹配 → 渲染结果卡片
    ↓
调价/未税/取整 → 实时重算
```

---

## 三菱库存模块

- 调用 Railway 服务端 API（`/api/stock-query`）
- 勾选规格 → 点击「三菱库存」→ 逐卡展示上海/日本仓库库存
- 结果自动复制到剪贴板
- 需联网使用

---

## 取整方式下拉框

位于工具栏「配置」按钮旁。三种方式实时切换，所有计算步骤（含税折扣价→利润→未税除税）都用同一取整方式。

---

## 环境要求

- Python 3.12+
- 浏览器（Chrome/Edge/Firefox 均可）
- 网络连接（用于加载云数据 + 三菱库存查询）
- WSL 或 Linux/macOS 开发环境

---

## 开发说明

### 浮点数校正
JavaScript 浮点运算可能导致 `28 × 1.1 = 30.800000000000004`，`applyRounding()` 中 `Math.ceil` 前减 `1e-9` 避免越界。

### 关于 row.price 的使用规则
`row.price` 始终是当前显示的数值（由 `refreshRowPrice()` 维护）。所有输出路径（复制、三菱库存剪贴板）**不得对 `row.price` 再次除税**，否则未税价会被二次计算。

### 事件绑定
全局侦听器（未税复选框、取整方式下拉框）绑定在 `bindAuthEvents()` 中，`window.onload` 调用一次，不会因重复调用导致叠加。

---

## 推广视频

推广文档见 `docs/promotion-plan.md`，包含：
- 各平台文案（微信视频号/抖音/小红书/朋友圈）
- 剪映剪辑操作指引（配音、字幕、BGM、导出设置）
- 视频标题建议

视频 Remotion 项目在 `remotion-videos/` 目录下，29.5 秒/60fps，5 场流程。