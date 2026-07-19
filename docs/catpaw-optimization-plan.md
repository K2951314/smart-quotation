# 智能询价系统 · 基于 CatPaw AI 的完善与优化方案

> 本文基于**实读代码**制定（2026-07-17 核实），所有结论均有具体文件/行数佐证。
> 配套配置已落到 `.catpaw/rules/`（6 个规则文件）与 `.catpaw/mcp.json`（4 个 MCP 工具），开箱即用。

---

## 0. 前置说明

### CatPaw 的真实能力

CatPaw 是美团自研的 AI IDE（猫爪 IDE），以「**Agent 与开发者协作**」为核心范式。本方案编写时 Agent 正运行在 **Windows 11** 环境上，以下能力已验证可用：

- **两种对话模式**：`Ask`（快速问答/项目逻辑咨询）与 `Agent`（自动检索整个 Workspace 上下文、做项目级完整分析、分步执行复杂任务）。
- **规则注入**：通过 `.catpaw/rules/*.md` 定义团队规范，自动进入 Agent 上下文。**本项目已配置 6 个规则文件**。
- **工具扩展**：通过 MCP 协议挂载外部工具（终端命令、浏览器自动化、数据库查询等），让 Agent 能真跑命令而非空谈。**本项目已配置 4 个 MCP 工具**。
- **语义检索**：`codebase_search` 按含义而非文本搜索代码，适合探索不熟悉的代码库。
- **前端闭环**：内置浏览器自动化（`BrowserUse`），可截图、填表、看 console，验证 UI 改动。
- **文件级编辑**：`read_file` / `string_replace` / `MultiEdit` 精确编辑，支持批量原子操作。
- **持久记忆**：`update_memory` 跨会话记住项目约定与历史决策。

### 核心原则

1. **不跳过评审**：Agent 产出仍需人工或另一个 Agent 评审（与本项目既有 superpowers 评审纪律一致），禁止"AI 说完成就完成"。
2. **测试门优先**：任何改动合并前必须 `pytest tests/` 全绿（当前 28/28 通过）。
3. **小步快跑**：每个 Agent 任务粒度控制在"一次提交可完成"的范围内，避免大范围重构失控。

---

## 1. 项目现状分析（基于实读）

### 1.1 架构与技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | FastAPI + Uvicorn + SQLite（WAL） | 应用工厂 `api/factory.py:create_app()`，按 `company_id` 多租户隔离 |
| 配置引擎 | `engine.py` 的 `QuotationEngine` + `FormulaEvaluator` | **用 `ast` 白名单做安全公式求值**（仅允许 `+ - * /` 与 ceil/floor/round/min/max/abs）——质量亮点，不可削弱 |
| 前端 | **纯原生 JS，无框架/无打包器/无 node_modules** | `apps/`（报价台）+ `admin/`（GUI 配置中心），静态部署 Netlify |
| 加密 | `cryptography` AES-GCM | `store/bundles.py` 生成加密价格包 |
| 外部服务 | Supabase Storage（公开桶） + 三菱官网 GWT-RPC（via `requests`） | Bundle 部署 + 实时库存查询 |
| 部署 | Netlify（前端）+ Railway/Render（后端） | `Procfile` 启动 uvicorn |

### 1.2 模块地图与规模（实读数）

- **后端 `backend/smart_quotation/`**：约 30 个 `.py`、~3500 行。已拆成 `api/`（9 文件：auth/factory/models/routes_companies/routes_config/routes_items/routes_merger/routes_public/routes_stock/supabase）、`store/`（9 文件：base/bundles/configs/companies/excel/items/audit/security/__init__）、以及 `engine.py`/`config.py`/`license.py`/`mitsubishi_stock.py`/`plugins.py`/`observability.py`/`erp.py`。
- **前端 `admin/`**：~3500 行 JS，已模块化为 `app.js`(72行 bootstrap) + `merger-app.js` + `lib/`（12 个模块：admin-core/bundle-utils/companies/config-api/config-collect/config-core/config-render/data-utils/event-bindings/export-utils/standalone-html/supabase-deploy）。
- **前端 `apps/`**：~3400 行 JS，已模块化为 `app.js`(183行 bootstrap) + `lib/`（13 个模块：auth/config-core/config-helpers/copy-clipboard/data-load/discount-config/discount-utils/query-regex/result-sort/search-render/state/stock-query/ui-helpers）。
- **测试 `tests/`**：`test_backend_v1.py`(391 行，20 用例) + `test_admin_gui.py`(100 行，8 用例) + 3 个 JS 测试（config-core/data-utils/export-utils）。

### 1.3 已验证的质量短板（Agent 要啃的清单）

> 以下每条都有实据，已作为各 Agent 的"禁区/任务"写进 `.catpaw/rules/`。

| # | 问题 | 证据 | 风险 | 状态 |
|---|---|---|---|---|
| Q1 | ~~测试门失效~~ | ~~无 conftest.py~~ | — | ✅ **已解决**：28/28 全绿（pytest 9.0.2 已装） |
| Q2 | **双份 config-core.js** | `admin/lib/config-core.js`(647行) 与 `apps/lib/config-core.js`(649行) 仅 ~16 行差 | 双份维护、改一漏一 | 🔴 待修 |
| Q3 | ~~admin 源码泄露真实折扣~~ | ~~`admin/lib/config-core.js:63-64` 硬编码 `percent: 32, 36`~~ | — | ✅ **已解决**：改为中性 `55`（与 apps 版对齐） |
| Q4 | **弱默认密钥** | `license.py:29 _DEFAULT_SECRET="dev-secret-key-change-in-production"` | 生产未配置则用弱值 | 🟡 待修 |
| Q5 | **print() 启动日志** | `observability.py:34,52`、`license.py:160,180`、`auth.py:46,55` 共 6 处 `print()` | 无结构化日志、出事后难查 | 🟡 待修 |
| Q6 | **三菱 GWT-RPC 脆弱** | `mitsubishi_stock.py:19-21` 硬编码 permutation/strong-name；凭据三级降级含 `config.ini` 明文 | 三菱改版即挂、明文凭据风险 | 🟡 待修 |
| Q7 | **README 严重滞后** | README "项目结构"(L121-156) 称单文件 `api.py`/`store.py`，实际已拆成 `api/`+`store/` 包 | 新人不信文档 | 🟡 待修 |
| Q8 | **文档内部矛盾** | `SECURITY-VERIFICATION.md:192,227` 称 `admin/app.js` 硬编码 `ADMIN_API_KEY`，实际 `admin-core.js` 从 sessionStorage 读 | 误导安全审计 | 🟡 待修 |
| Q9 | ~~单 SQLite 无索引~~ | — | — | ✅ **已解决**：`store/base.py:89-122` 已有 4 个复合索引 |

### 1.4 已有的质量亮点（保留不动）

- `engine.py` 的 `FormulaEvaluator`：AST 白名单求值，拒绝属性访问/下标/比较/布尔运算，防注入。
- `api/factory.py:47-52`：生产环境强制 `ALLOW_ORIGINS`，未设置拒绝启动。
- `store/base.py:58-63`：WAL 模式 + busy_timeout 5s，减少锁冲突。
- `api/auth.py`：`secrets.compare_digest` 恒定时间比较 + 弱值黑名单 + X-Forwarded-For 伪造已修复。
- `license.py`：HMAC-SHA256 签名 + 过期检查 + 功能授权 + 5min 缓存。

---

## 2. CatPaw 中 Agent 的配置与职责划分

> CatPaw 的 Agent 模式 = **Rules 文件 + MCP 工具 + 语义检索**的组合人格。
> 本项目用 `.catpaw/rules/` 下 6 个规则文件，把 Agent 塑造成 6 个"职责人格"，每个文件用自然语言定义：**职责边界 / 必读文件 / 当前任务 / 禁区 / 交付标准**。

### 2.1 人格总表

| 规则文件 | 人格定位 | 扫描范围 | 核心禁区 |
|---|---|---|---|
| `best-practices.md` | 全员通用底线（编码规范） | 全仓 | 不跳过测试；不改 schema 不先备份 |
| `backend-agent.md` | 后端架构/性能/安全 | `backend/**` | 不碰前端；改 DB schema 须先备份并写迁移说明 |
| `frontend-agent.md` | 前端模块化/去重 | `apps/**`、`admin/**` | 不改后端 API 契约（字段名/路径/认证） |
| `qa-agent.md` | 测试守护与补覆盖 | `tests/**` | 不写业务代码；不降低既有断言严格度 |
| `docs-agent.md` | 文档对齐实际 | `*.md`、`docs/**` | 不改代码；不编造未实现的端点 |
| `security-agent.md` | 密钥/注入/脱敏/CSP | 全仓安全相关 | 任何密钥改动须同时更新 `.env.example` 与部署指南 |

### 2.2 各人格的"上下文注入"清单（已写进规则文件头部）

- **backend-agent** 必读：`api/factory.py`、`engine.py`、`store/base.py`、`store/bundles.py`、`mitsubishi_stock.py`、`CLAUDE.md`、`README.md`。
- **frontend-agent** 必读：`apps/lib/config-core.js`、`admin/lib/config-core.js`、`apps/app.js`、`admin/app.js`、`docs/gui-admin-guide.md`。
- **qa-agent** 必读：`tests/`、`requirements.txt`、`CLAUDE.md`（测试命令段）。
- **docs-agent** 必读：全部 `*.md` + 实际目录结构。
- **security-agent** 必读：`api/auth.py`、`license.py`、`store/security.py`、`netlify.toml`、`admin/lib/admin-core.js`。

### 2.3 MCP 工具挂载（`.catpaw/mcp.json`，已配置）

让 Agent 能**真跑**命令而非空谈：

| 工具 | 命令 | 用途 |
|---|---|---|
| `local-backend` | `py -m backend.smart_quotation` | 启动 FastAPI 后端，联调与库存链路验证 |
| `test-runner` | `py -m pytest tests/ -v` | 回归闸门（当前 28/28 全绿） |
| `sqlite-inspect` | `py -c "import sqlite3..."` | 只读查 `quotation.db`，多租户数据核对 |
| `git-helper` | `git -C E:/Ingulf/智能询价` | 提交/建分支/看 diff |

> 另有内置工具：`codebase_search`（语义检索）、`read_file`/`string_replace`/`MultiEdit`（文件编辑）、`BrowserUse`（浏览器自动化验证 UI）。

### 2.4 Agent 职责划分详解

#### backend-agent（后端架构师）
- ** owns**：`backend/**` 全部 Python 代码
- **核心任务**：日志规范化（Q5）、三菱并发+超时（Q6）、异常收敛
- **红线**：不动 `FormulaEvaluator` 的 AST 白名单（除非先补注入测试用例）；改 schema 必须备份 + 写迁移说明
- **协作**：性能改动后请 qa-agent 跑回归；涉及密钥请 security-agent 评审

#### frontend-agent（前端架构师）
- **owns**：`apps/**`、`admin/**` 全部 JS/HTML/CSS
- **核心任务**：合并双份 config-core.js（Q2）、消除 admin 源码真实折扣（Q3）
- **红线**：不引入 npm 依赖或构建工具（破坏 Netlify 静态部署）；不改 `row.price` 含税/未税语义
- **协作**：合并 config-core 后请 qa-agent 跑 `config-core.test.js`；请 docs-agent 更新模块说明

#### qa-agent（测试守护者）
- **owns**：`tests/**` + 测试基础设施
- **核心任务**：加 `pyproject.toml`/`conftest.py`、补覆盖率、CI 集成
- **红线**：不写业务代码；不降低断言严格度
- **协作**：所有 Agent 改动后由 qa-agent 跑回归闸门

#### docs-agent（文档对齐者）
- **owns**：`*.md`、`docs/**`
- **核心任务**：修 README 项目结构（Q7）、消解 SECURITY-VERIFICATION 矛盾（Q8）、补 DEPLOYMENT.md
- **红线**：不改代码；不编造端点
- **协作**：backend/frontend Agent 完成任务后自动 diff 变更并同步文档

#### security-agent（安全审计员）
- **owns**：全仓安全相关代码
- **核心任务**：消除弱默认密钥（Q4）、三菱凭据改环境变量、复核脱敏链路
- **红线**：不削弱 `compare_digest`/频率限制/CSP 强度
- **协作**：密钥改动同步更新 `.env.example` 与 `_LOCAL-GUIDE.md`

---

## 3. 系统性改进：质量 / 性能 / 测试 / 文档 如何用 Agent

### 3.1 代码质量

| 任务 | 负责人格 | 具体 Agent 指令（自然语言） | 对应问题 |
|---|---|---|---|
| **合并双份 config-core.js** | frontend-agent | "把 `admin/lib/config-core.js` 与 `apps/lib/config-core.js` 抽成单一共享模块 `shared/config-core.js`，消除 16 行重复；apps 与 admin 改为引用同一份；两端差异点（折扣默认值）通过参数注入，**禁止再硬编码品牌名或真实折扣率**。" | Q2/Q3 |
| **消除 admin 真实折扣泄露** | security-agent + frontend-agent | "`admin/lib/config-core.js:63-64` 的 `percent: 32, 36` 是真实商业折扣，admin JS 源码公开后泄露定价策略。改为中性占位 `55`（与 apps 版对齐），真实折扣只由服务端 config 注入。" | Q3（高危） |
| **去 print/收敛异常** | backend-agent | "把 `backend/` 下 6 处 `print()`（observability.py:34,52 / license.py:160,180 / auth.py:46,55）改为 `logging` 模块（按模块命名 logger）；保留异常链。" | Q5 |
| **消除弱默认** | security-agent | "将 `license.py:29 _DEFAULT_SECRET` 改为「未显式配置且非 SQ_DEV 则启动失败」；同步更新 `.env.example`。" | Q4 |

### 3.2 性能优化

- **已好的部分**（不要动）：
  - `FormulaEvaluator` 的 AST 白名单求值（安全且高效）
  - `store/base.py` 已有 4 个复合索引 + WAL 模式 + busy_timeout
  - `ConfigCache` 内存缓存避免重复读已发布配置
- **瓶颈 ①**：三菱库存为**串行**查询（`mitsubishi_stock.py` 的 `QueryEngine.search` 逐个型号调用）
  - **Agent 动作**（backend-agent）：改为 `asyncio.gather` 并发 + 限流（保留 60s/30 次 + 50 条上限），附 before/after 基准
- **瓶颈 ②**：三菱 GWT-RPC 常量硬编码（`GWT_PERM`/`GWT_STRONG_NAME`），三菱改版即挂
  - **Agent 动作**（backend-agent）：常量外置到配置文件或环境变量；加超时/重试/降级告警；`config.ini` 明文凭据改环境变量
- **瓶颈 ③**（远期）：单 SQLite 文件承载多租户
  - **Agent 动作**（backend-agent，P2 阶段）：PostgreSQL 迁移评估（CLAUDE.md 路线图已列）

### 3.3 测试覆盖

- **第一步（补基础设施，qa-agent）**：
  - 加 `pyproject.toml`（pytest 配置 + `httpx`/`pytest-cov` 进依赖）
  - 加 `conftest.py`（共享 fixture：临时 store、测试 config、测试 client）
  - 确认 `pytest tests/ --cov=backend --cov-report=term-missing` 真能跑
- **第二步（补覆盖，按优先级）**：
  - `engine.py`：公式求值正例 + 注入负例（`__import__`/`eval`/属性访问/关键字参数）
  - `store/bundles.py`：AES-GCM 加解密 round-trip、错误密码降级
  - `config-core.js`：v2/v3 兼容解析、gt/gte/lt/lte 比较操作符
  - `mitsubishi_stock.py`：本地 stub 模拟 GWT-RPC 响应，验证 `_parse_gwt`/`_extract_stock`
  - `license.py`：篡改 payload/过期/错误密钥/缓存失效
- **第三步（CI 集成）**：
  - GitHub Actions 跑 `pytest tests/` + `node --test tests/*.test.js`
  - PR 合并闸门：测试不全绿不准合并

### 3.4 文档完善

- **docs-agent 主任务**：
  - 重写 README "项目结构"段（L121-156），对齐 `api/`+`store/` 实际包结构，补 `plugins`/`license`/`erp`/`supabase`/`routes_merger`
  - 消解 `SECURITY-VERIFICATION.md:192,227` 与 `admin-core.js` 的矛盾（实际从 sessionStorage 读，非硬编码）
  - 补 `DEPLOYMENT.md`（CLAUDE.md 路线图 P2 已列但未写）：Netlify + Railway/Render + Supabase 部署步骤、环境变量清单
- **同步机制**：每次 backend/frontend Agent 完成任务，docs-agent 自动 diff 变更并补/改对应文档，避免再次漂移

---

## 4. 完整使用流程：从初始化到持续优化

### 阶段 A — 准备期（已完成）

1. ✅ `.catpaw/rules/*.md`（6 个规则文件）已就位
2. ✅ `.catpaw/mcp.json`（4 个 MCP 工具）已就位
3. ✅ 测试门已验证（28/28 全绿）

### 阶段 B — 接入期（当前）

4. 用 CatPaw 打开本仓库根目录（`e:/Ingulf/智能询价`）
5. 规则文件已自动注入 Agent 上下文；MCP 工具可通过终端命令调用
6. 确认环境：`py -m pytest tests/ -v` 应返回 28 passed

### 阶段 C — 启动体检

7. **Ask 模式**快速校准：问"这个项目的多租户隔离是怎么实现的？"验证 Agent 对 `company_id` 过滤链路的理解
8. **Agent 模式**全仓体检：下达"对本仓库做一次完整代码体检，输出 `docs/catpaw-audit-<日期>.md`，逐条对应 Q2-Q8 给出当前状态与证据"

### 阶段 D — 分模块攻坚（按优先级派发任务）

9. **优先级顺序**（见 §5）：
   - **P0**：消除 admin 真实折扣泄露（Q3，高危）→ security-agent + frontend-agent
   - **P1**：合并双份 config-core.js（Q2）→ frontend-agent
   - **P2**：文档对齐（Q7/Q8）→ docs-agent
   - **P3**：消除弱默认密钥（Q4）→ security-agent
   - **P4**：日志规范化（Q5）→ backend-agent
   - **P5**：三菱并发+常量外置（Q6）→ backend-agent
10. 每个任务用"§3 的具体指令"作为目标，指定 `context` 为对应文件
11. 每个 Agent 产出后：qa-agent 跑测试门 → docs-agent 同步文档 → security-agent 做评审（涉及密钥时）

### 阶段 E — 验证闭环

12. 用浏览器自动化打开 `http://127.0.0.1:8001/apps/index.html`，截图验证 UI 无回归
13. 每次合并前：`git-helper` 建分支 + 中文 Conventional Commits 结构化提交；`test-runner` 做回归闸门

### 阶段 F — 持续优化

14. 把高频修复沉淀为新的 `.catpaw/rules/*.md`（例如"三菱 GWT-RPC 改动必须先本地 stub 验证"）
15. 定期任务：每周扫 `requirements.txt` 依赖更新；每月跑一次全仓安全自检
16. P2 远期：PostgreSQL 迁移、多租户客户登录、前端模块化进一步拆分

---

## 5. 优先级与节奏建议

| 顺序 | 任务 | 人格 | 对应问题 | 为什么排这里 |
|---|---|---|---|---|
| 1 | ~~消除 admin 真实折扣泄露~~ | ~~security + frontend~~ | ~~Q3~~ | ✅ 已完成（2026-07-17） |
| 2 | 合并双份 config-core.js | frontend | Q2 | 去重 + 消除硬编码，低风险高收益 |
| 3 | 文档对齐 | docs | Q7/Q8 | 让后续 Agent 有可信上下文 |
| 4 | 消除弱默认密钥 | security | Q4 | 安全底线，改动小 |
| 5 | 日志规范化 | backend | Q5 | 可观测性，为性能排查铺路 |
| 6 | 三菱并发+常量外置 | backend | Q6 | 性能与健壮性，需 stub 验证 |
| 7 | 测试基础设施+补覆盖 | qa | — | 提升回归信心 |
| 8 | PostgreSQL 迁移评估 | backend | P2 | 视业务节奏，远期 |

---

## 6. 风险与注意事项

- **不盲信 Agent**：每个 Agent 产出必须过测试门 + 人工/另一 Agent 评审，尤其涉及 `auth.py`/`license.py`/加密逻辑时。
- **三菱链路高风险**：任何 GWT-RPC 改动先在本仓用 stub 模拟响应验证，再连真网；`config.ini` 明文凭据建议改为环境变量（与本项目"密钥不硬编码"原则一致）。
- **schema 变更**：`store/` 任何表结构改动须先备份 `quotation.db` 并写迁移说明，禁止静默 `DROP`。
- **前端部署兼容**：不引入 npm 依赖或构建工具，保持 Netlify 静态部署链路。
- **额度管理**：复杂重构（三菱 GWT-RPC、config-core 合并）消耗高，优先用 Thinking 模型；零散任务用 Flash。

---

## 附录：已有配置清单

### `.catpaw/rules/`（6 个规则文件）

| 文件 | 大小 | 人格 |
|---|---|---|
| `best-practices.md` | 2.7KB | 全员通用底线 |
| `backend-agent.md` | 1.7KB | 后端架构师 |
| `frontend-agent.md` | 1.6KB | 前端架构师 |
| `qa-agent.md` | 1.7KB | 测试守护者 |
| `docs-agent.md` | 1.6KB | 文档对齐者 |
| `security-agent.md` | 1.7KB | 安全审计员 |

### `.catpaw/mcp.json`（4 个 MCP 工具）

| 工具 | 命令 | 用途 |
|---|---|---|
| `local-backend` | `py -m backend.smart_quotation` | 启动后端联调 |
| `test-runner` | `py -m pytest tests/ -v` | 回归闸门 |
| `sqlite-inspect` | `py -c "import sqlite3..."` | 只读查 DB |
| `git-helper` | `git -C E:/Ingulf/智能询价` | 提交/建分支 |
