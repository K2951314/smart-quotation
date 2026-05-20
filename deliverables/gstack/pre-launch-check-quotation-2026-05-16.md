# 智能询价系统上线前全检报告

**日期**：2026-05-16
**场景**：上线前检查（代码审查 + 安全审计 + QA测试）
**参与成员**：产品官 + 安全卫士 + 质量门神

---

## TL;DR（执行摘要）

- 整体结论：**🔴 No-Go** — 存在 2 个阻断项，必须修复后方可上线
- 阻塞项：(1) MMC 密码硬编码在前端源码；(2) 远程脚本注入无完整性校验（RCE 等效）
- 去重后问题总览：🔴 3 / 🟠 6 / 🟡 7 / 🟢 3
- 下一步：修复 2 个阻断项 + 补全安全头后转为 Conditional Go，字段配置化改造建议 Phase 1-2 先行

---

## 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🔴 No-Go |
| 严重度分布 | 🔴 3 / 🟠 6 / 🟡 7 / 🟢 3 |
| 关键行动项 | 5 条（含 2 条 P0 必修） |
| 建议负责人 | 张坤（决策）+ 开发（实施） |

---

## 1. 各成员核心结论

### 产品官（代码审查 & 字段配置化方案）
- 核心判断：代码质量中等偏上，核心流程（搜索/折扣/复制）完整可用，但存在幽灵函数（fallback 53 vs 55 不一致）和大量硬编码标签
- 关键建议：字段配置化分 5 个 Phase 渐进改造，Phase 1-2（约 1h）零风险立即可做，Phase 3-4（约 3.5h）本周完成

### 安全卫士（OWASP+STRIDE 审计）
- 核心判断：评级 D，2 个高危（远程脚本注入=RCE等效、密码明文暴露）+ 4 个中危，STRIDE 六类中有四类存在🔴级风险
- 关键建议：Sprint 0 必须修复脚本注入（改 JSON 解析）+ 移除硬编码密码 + 配置安全头，总工时约 3.5h

### 质量门神（QA 测试与发布）
- 核心判断：健康度 72/100，核心功能正常但缺重试/去重/降级机制，发布就绪度 5/10
- 关键建议：两个 No-Go 阻断项必须先修，修复后可 Conditional Go；浮点精度和搜索去重应排入上线后首修

---

## 2. 综合审查发现（去重合并后按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🔴 | 安全 | app.js:18 | MMC 密码 `%461971#` 硬编码在前端，任何人查看源码可获取 | 移除硬编码，改为用户手动输入或从安全通道获取 | 产品官+安全卫士+质量门神 |
| 2 | 🔴 | 安全 | app.js:382-386 | 动态注入远程脚本无完整性校验，Supabase 被投毒则所有用户执行恶意代码 | 将 bundle 格式从 JS 改为 JSON，用 `JSON.parse()` 替代 `script.text + appendChild()` | 产品官+安全卫士 |
| 3 | 🔴 | 代码 | app.js:648-652 vs discount-utils.js:38 | `normalizeDiscountPercent` 幽灵函数 fallback=53，与 `DiscountEngine.normalizePercent` fallback=55 不一致 | 删除 app.js 中的重复实现，统一使用 `DiscountEngine.normalizePercent` | 产品官+质量门神 |
| 4 | 🟠 | 安全 | _headers / netlify.toml | 缺少 CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 等安全响应头 | 在 netlify.toml 中为 `/` 路径添加安全头配置 | 安全卫士+质量门神 |
| 5 | 🟠 | 安全 | Supabase 公开桶 | 完整价格数据可被任意爬取，CORS 为 `*`，curl 可直接下载所有 bundle | 考虑启用 RLS 或签名 URL，至少限制 CORS 来源 | 安全卫士 |
| 6 | 🟠 | 安全 | app.js `openMmcLogin` | 使用 `prompt()` 获取密码，安全性不足 | 替换为自定义模态框 | 安全卫士 |
| 7 | 🟠 | 健壮性 | app.js:297-357 | `loadDataWithCache` 无 try/catch 包裹，version.json fetch/parse 失败导致整条链崩溃且不可恢复 | 增加顶层 try/catch + 错误重试机制 + "重新加载"按钮 | 产品官+质量门神 |
| 8 | 🟠 | 功能 | app.js:773-800 renderSearchResults | 多行搜索同一 spec 时无去重，产生重复结果卡 | 维护 `Set<string>` 已添加 spec，跳过重复 | 质量门神 |
| 9 | 🟠 | 正确性 | app.js:639-646 calcDiscountedPrice | 浮点乘法精度问题，`Math.ceil` 可能多算报价 | 使用 `Math.round(rawCalc * factor) / factor` 或引入 epsilon 校正 | 质量门神 |
| 10 | 🟡 | 健壮性 | app.js:381/403/421/428 | 多处 `JSON.parse` 无异常保护，解析失败导致应用无法启动 | 每个 parse 加 try/catch，给用户可操作的反馈 | 产品官 |
| 11 | 🟡 | 健壮性 | app.js:509-511 | 搜索输入无行数/长度限制，粘贴上万行可致浏览器卡死 | 添加 `lines.slice(0, MAX_LINES)` 限制 + textarea maxlength | 产品官+质量门神 |
| 12 | 🟡 | 健壮性 | app.js:120 | `persistDefaultDiscountConfig` 静默吞掉 localStorage 错误 | 用户提示保存失败 | 产品官 |
| 13 | 🟡 | CSS | styles.css:2559 | `min-width: 2.9rem5rem;` 语法错误，声明被忽略 | 修正为 `min-width: 2.9rem;` | 质量门神 |
| 14 | 🟡 | 健壮性 | app.js:360-387 fetchFileWithCache | 网络返回非 200 时不写缓存，无降级策略，每次刷新重复请求失败资源 | 保留上一次成功缓存作为降级 | 质量门神 |
| 15 | 🟡 | 代码 | app.js:21-73 vs lib/discount-utils.js | DiscountEngine 双源，app.js 内联 fallback 与外部 lib 必须保持同步 | 确保同步或移除内联 fallback | 产品官 |
| 16 | 🟡 | 代码 | discount-utils.js:66-87 | 品牌识别逻辑硬编码（"EX活动"/"OSG"/name==="刀具"），新增品牌需改代码 | 考虑纳入配置 | 产品官 |
| 17 | 🟢 | 性能 | app.js:773-800 | `renderSearchResults` 逐条 appendChild 可能触发重排 | 改用 DocumentFragment 批量插入 | 产品官 |
| 18 | 🟢 | 代码 | app.js 全文 | 15+ 全局变量、30+ 全局函数，无模块化封装 | 至少用 IIFE 或 namespace 包裹 | 产品官 |
| 19 | 🟢 | 代码 | app.js:802-806 | `doSearch()` 无防抖，快速点击触发多次搜索 | 添加 debounce | 产品官 |

---

## 3. 字段配置化改造方案摘要

### config.json 扩展结构

```json
{
  "discounts": { "EX": 32, "OSG": 36, "三菱": 55, "其他": 55 },
  "rounding_threshold": 100,
  "decimal_places": 1,
  "fields": {
    "c":     { "label": "代码",   "source": "data" },
    "spec":  { "label": "规格型号", "source": "key" },
    "p":     { "label": "面价",   "source": "data" },
    "price": { "label": "报价",   "source": "computed" },
    "s":     { "label": "特价",   "source": "data" },
    "i":     { "label": "库存",   "source": "data" },
    "r":     { "label": "备注",   "source": "data" },
    "b":     { "label": "品牌",   "source": "data" },
    "n":     { "label": "名称",   "source": "data" },
    "m":     { "label": "助记码", "source": "data" },
    "a":     { "label": "别名",   "source": "data" }
  },
  "copy_columns": [
    { "field": "c",     "id": "chk_code",    "label": "代码", "default": true },
    { "field": "spec",  "id": "chk_spec",    "label": "规格", "default": true },
    { "field": "price", "id": "chk_price",   "label": "报价", "default": true },
    { "field": "s",     "id": "chk_special", "label": "特价", "default": false },
    { "field": "i",     "id": "chk_stock",   "label": "库存", "default": false },
    { "field": "r",     "id": "chk_remark",  "label": "备注", "default": false }
  ],
  "copy_prefix": "含税",
  "stock_prefix": "库存 "
}
```

### 改造路线图

| Phase | 内容 | 风险 | 工时 |
|-------|------|------|------|
| Phase 1 | 新增 `getFieldConfig()` 辅助函数 + 默认值 + 旧版兼容 | 极低 | 0.5h |
| Phase 2 | 替换硬编码标签（"库存"/"含税"/"面价"/"报价"→配置驱动） | 低 | 0.5h |
| Phase 3 | 配置驱动复制列（doCopy 动态遍历 copyColumns） | 中 | 2h |
| Phase 4 | 动态生成复制列 HTML（checkbox 从配置渲染） | 中 | 1.5h |
| Phase 5 | 结果卡动态渲染（可选，暂缓） | 高 | 4h |

**建议执行**：Phase 1-2 立即做（1h），Phase 3-4 本周做（3.5h），Phase 5 看需求做

---

## 4. 安全修复方案（Sprint 0）

### 4.1 远程脚本注入 → JSON 解析

**当前**（app.js:382-386）：
```js
const script = document.createElement('script');
script.text = text;
document.body.appendChild(script);
```

**改为**：
```js
try {
  window.PRICE_BUNDLE = JSON.parse(text);
} catch (e) {
  console.error('价格包解析失败:', e);
  throw e;
}
```

> ⚠️ 注意：此改动需要同步修改 `merger/` 中的 bundle 生成逻辑，将输出格式从 JS（`window.PRICE_BUNDLE = {...}`）改为纯 JSON。

### 4.2 移除硬编码密码

**当前**（app.js:17-18）：
```js
const MMC_PASSWORD = "%461971#";
```

**改为**：删除此行，`openMmcLogin` 中改为用户手动输入密码，或从 config.json 中获取（config 本身在公开存储桶中也不安全，最佳方案是用户手动输入）。

### 4.3 安全头配置

在 `netlify.toml` 中添加：

```toml
[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "DENY"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Content-Security-Policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src https://*.supabase.co; img-src 'self' data:; font-src 'self'"
```

---

## 5. 上线后优先修复清单

| 优先级 | 问题 | 预估工时 |
|--------|------|----------|
| P0 | 搜索结果去重（Bug #4） | 0.5h |
| P0 | 数据加载失败重试（Bug #2） | 1h |
| P1 | JSON.parse 加 try/catch 保护 | 1h |
| P1 | 搜索输入行数限制 | 0.5h |
| P1 | 浮点精度修正（calcDiscountedPrice） | 0.5h |
| P1 | CSS 语法错误修复（styles.css:2559） | 5min |
| P2 | normalizeDiscountPercent 统一删除 | 0.5h |
| P2 | DiscountEngine 双源同步 | 0.5h |

---

## 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 移除 MMC_PASSWORD 硬编码，改为用户手动输入 | 开发 | P0 | 上线前 |
| 2 | 将 bundle 格式从 JS 改为 JSON，消除 script.text 注入 | 开发 | P0 | 上线前 |
| 3 | 在 netlify.toml 补全安全响应头（CSP/X-Frame-Options/X-Content-Type-Options） | 开发 | P0 | 上线前 |
| 4 | 字段配置化 Phase 1-2（新增 getFieldConfig + 替换硬编码标签） | 开发 | P1 | 本周 |
| 5 | 字段配置化 Phase 3-4（配置驱动复制列 + 动态生成 checkbox） | 开发 | P1 | 本周 |

---

## 待完善 / 已知局限

- 本次审查基于代码静态分析，未在运行环境中执行端到端测试
- Supabase 存储桶的访问控制需在 Supabase 平台侧配置，前端无法独立解决
- 字段配置化改造仅覆盖显示层和复制层，数据合并层（rebuildMergedDB）的键名映射受 bundle 格式约束，需更高层级改造
- 品牌折扣规则的配置化（discount-utils.js 中硬编码的 "EX活动"/"OSG" 识别逻辑）建议排入后续迭代

---

## 成员产出索引

- gstack-product-reviewer（产品官）原始产出：代码审查 16 项发现 + 字段配置化 5 Phase 方案 + config.json 扩展结构设计
- gstack-security-officer（安全卫士）原始产出：OWASP+STRIDE 审计，2高危+4中危，含完整修复代码方案
- gstack-qa-lead（质量门神）原始产出：功能测试矩阵 + 12 项 Bug + 发布检查清单 + 回归风险提示

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
