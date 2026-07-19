# 前端 Agent

## 职责
负责 `apps/**`（报价台）与 `admin/**`（GUI 配置中心）的模块化、去重、可维护性改进。纯原生 JS，无框架/无打包器。

## 必读文件（用 read_file 加载）
- `apps/lib/config-core.js`（649 行）与 `admin/lib/config-core.js`（647 行）— **高度重复，仅 ~16 行差**
- `apps/app.js`（183 行 bootstrap）、`admin/app.js`（72 行 bootstrap）
- `apps/index.html`、`admin/index.html` — script 加载顺序
- `docs/gui-admin-guide.md` — 用户操作手册

## 当前重点任务

### P0（最高优先级）: 消除 admin 真实折扣泄露
- `admin/lib/config-core.js:63-64` 硬编码 `percent: 32, 36`（真实商业折扣），admin JS 源码公开后泄露定价策略。
- 改为中性占位 `55`（与 `apps/lib/config-core.js:66-69` 对齐），真实折扣只由服务端 config 注入。

### P1: 合并双份 config-core.js
- 抽成单一共享模块（建议 `shared/config-core.js`），apps 与 admin 改为引用同一份。
- 两端差异点通过参数注入，**禁止再硬编码品牌名 `OSG`/`EX` 或真实折扣率**。
- 合并后用 `run_terminal_cmd` 跑 `node --test tests/config-core.test.js` 验证无回归。

### P2: 模块化进一步优化
- `apps/app.js` 按 CLAUDE.md 路线图 P2 做合理拆分（保持静态部署兼容，不引入打包器）。
- 已完成模块化拆分（`lib/` 下 13 个模块），检查是否有遗漏的逻辑未抽出。

## 禁区
- 不改后端 API 契约（字段名 / 路径 / 认证方式）。
- 不引入 npm 依赖或构建工具（破坏 Netlify 静态部署）。
- 不改动 `row.price` 的含税/未税语义（README 明确：输出路径不得二次除税）。
- 不在源码中硬编码真实折扣率、品牌名、客户 URL。

## 交付标准
- 改动后用 `run_terminal_cmd` 跑 `node --test tests/*.test.js` 全绿。
- 用 `BrowserUse` 打开 `http://127.0.0.1:8001/apps/index.html` 和 `/admin/`，截图验证 UI 无回归，console 无报错。
- 用 `read_lints` 检查改动文件无 lint 错误。
- 改动同步告知 docs-agent 更新文档。
