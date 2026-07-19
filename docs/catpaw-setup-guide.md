# CatPaw 配置指南 — 最大化 Agent 能力的设置方案

> 本文档基于 CatPaw 的真实工具能力编写（2026-07-17），回答三个问题：
> 1. `.catpaw/rules/` 和 `.catpaw/mcp.json` 该怎么配？
> 2. 设置中的"自定义 Agent"有什么用？这个项目推荐设置吗？
> 3. "Prompt & Rules"该怎么设置才能发挥最大能力？

---

## 一、配置体系全景

CatPaw 的配置分两层：

### 项目级（随仓库走，团队共享）

| 配置 | 位置 | 作用 | 本项目状态 |
|---|---|---|---|
| 规则文件 | `.catpaw/rules/*.md` | 自动注入 Agent 上下文的团队规范 | ✅ 已配 6 个文件 |
| 项目说明 | `CLAUDE.md` | 项目架构与核心规则 | ✅ 已更新 |
| 项目设置 | `.claude/settings.json` | 环境变量、Python 路径 | ✅ 已配 `SQ_DEV=1` |
| ~~MCP 服务器~~ | ~~`.catpaw/mcp.json`~~ | ~~外部工具挂载~~ | ❌ 已删除（见下方说明） |

### 用户级（IDE 设置界面，不随仓库走）

| 配置 | 位置 | 作用 |
|---|---|---|
| 自定义 Agent | 设置 → Agent | 预设系统提示词/模型/工具权限的 Agent 模板 |
| Prompt & Rules | 设置 → Prompt | 全局提示词和规则 |
| MCP 服务器 | 设置 → MCP | 全局或项目级 MCP 工具 |

---

## 二、为什么删除了 `.catpaw/mcp.json`

### 原配置的问题

原 `.catpaw/mcp.json` 配置了 4 个"MCP 服务器"：

```json
{
  "local-backend": { "command": "py", "args": ["-m", "backend.smart_quotation"] },
  "test-runner": { "command": "py", "args": ["-m", "pytest", "tests/", "-v"] },
  "sqlite-inspect": { "command": "py", "args": ["-c", "..."] },
  "git-helper": { "command": "git", "args": ["-C", "E:/Ingulf/智能询价"] }
}
```

**这些全部是失效配置**，原因：

1. **MCP 服务器必须实现 Model Context Protocol**（stdio JSON-RPC 协议）。`py -m backend.smart_quotation` 启动的是 FastAPI Web 服务器，`py -m pytest` 是一次性命令——它们都不实现 MCP 协议，CatPaw 尝试加载会失败或无响应。
2. **CatPaw 自带 `run_terminal_cmd` 工具**可以直接跑这些命令，根本不需要 MCP 包装。
3. **保留失效配置会误导 Agent**：规则文件里写"用 test-runner MCP 跑测试"，但该 MCP 无法加载，Agent 会困惑。

### 正确做法

删除 `.catpaw/mcp.json`，在 `.catpaw/rules/best-practices.md` 中直接列出常用命令，Agent 用 `run_terminal_cmd` 执行：

```powershell
# 跑测试
py -m pytest tests/ -v

# 启动后端
$env:SQ_DEV = "1"; py -m backend.smart_quotation

# 查 SQLite
py -c "import sqlite3; ..."
```

### 什么时候才需要 MCP

只有当你有**真正的 MCP 服务器**（实现了 stdio JSON-RPC 协议的程序）时才配 `.catpaw/mcp.json`。例如：

- `@modelcontextprotocol/server-sqlite` — 官方 SQLite MCP（提供结构化查询接口）
- `mcp-server-fetch` — 官方网页抓取 MCP
- 自研 MCP 服务器（用 `mcp` Python SDK 或 `@modelcontextprotocol/sdk` 编写）

本项目当前不需要 MCP——自带的 `run_terminal_cmd` + `codebase_search` + `grep` + `read_file` + `BrowserUse` 已覆盖所有需求。

---

## 三、`.catpaw/rules/` 的设计思路

### 为什么用 6 个规则文件

CatPaw 的规则文件会**自动注入 Agent 上下文**。本项目有清晰模块边界（后端/前端/测试/文档/安全），拆成 6 个文件让 Agent 在不同任务场景下有明确的职责指引。

| 文件 | 职责 | 何时生效 |
|---|---|---|
| `best-practices.md` | 全员通用底线 | 所有任务 |
| `backend-agent.md` | 后端架构/性能 | 改 `backend/**` 时 |
| `frontend-agent.md` | 前端模块化/去重 | 改 `apps/**`、`admin/**` 时 |
| `qa-agent.md` | 测试守护 | 改 `tests/**` 或需验证回归时 |
| `docs-agent.md` | 文档对齐 | 改 `*.md` 时 |
| `security-agent.md` | 安全审计 | 涉及密钥/脱敏/CSP 时 |

### 与旧版本的区别

| 维度 | 旧版（其他 AI 创建） | 新版（对齐 CatPaw 真实能力） |
|---|---|---|
| 工具引用 | 引用不存在的 MCP（test-runner 等） | 引用真实工具（`run_terminal_cmd`/`codebase_search`/`grep`/`read_file`/`MultiEdit`/`read_lints`/`BrowserUse`） |
| 命令列出 | 依赖 MCP 包装 | 直接写 PowerShell 命令，Agent 可复制执行 |
| 任务状态 | 称"测试门失效"（失实） | 准确标注 28/28 全绿 |
| 优先级 | 无 P0 高危 | 明确标注 P0（admin 折扣泄露） |
| 篇幅 | 冗长含错误信息 | 精简可执行 |

---

## 四、自定义 Agent — 是否推荐及如何设置

### 什么是自定义 Agent

CatPaw 设置中的"自定义 Agent"允许你创建**预设配置的 Agent 模板**，每个模板可定义：
- **系统提示词**（System Prompt）：预置的工作指令
- **模型选择**：指定用哪个模型（如日常任务用快速模型，复杂重构用推理模型）
- **工具权限**：限制可用工具范围（如"文档 Agent"不允许改代码）
- **预加载上下文**：自动读入指定文件

### 本项目推荐设置吗

**结论：不推荐额外设置自定义 Agent。** 原因：

1. **`.catpaw/rules/` 已实现上下文注入**：6 个规则文件自动注入对应职责的指引，效果等同于预设系统提示词。
2. **标准 Agent 模式足够灵活**：CatPaw 的 Agent 模式会自动读取所有规则文件 + `CLAUDE.md`，根据任务自行判断该用哪个人格，无需手动切换。
3. **自定义 Agent 增加管理负担**：需要在 IDE 设置中维护，不随仓库走，团队成员各配各的容易不一致。
4. **工具限制反而可能碍事**：本项目改动常跨模块（如修 admin 折扣需同时改前端+验证后端），限制工具权限反而不方便。

### 什么场景才推荐自定义 Agent

- 你有**固定的、高频重复的**单一任务（如"只做代码审查，不改代码"）
- 你想为不同任务用**不同模型**（如简单任务用快速模型省额度）
- 你需要**限制工具权限**做安全隔离（如让外部协作者只能读不能写）

本项目以上场景都不典型，所以不推荐。

### 如果仍想设置（可选）

如果你坚持要设自定义 Agent，以下是两个有用的模板：

**模板 1: 代码审查 Agent（只读）**
- 系统提示词：`你是一个严格的代码审查员。只读代码，不做修改。重点检查：安全漏洞、逻辑错误、测试覆盖。输出结构化审查报告。`
- 工具权限：只开 `read_file` / `codebase_search` / `grep` / `run_terminal_cmd`（只读命令）
- 模型：推理模型（深度分析）

**模板 2: 快速修复 Agent（日常小改）**
- 系统提示词：`你是一个高效的代码修复助手。接收明确的修复指令，快速定位问题并修复，修完跑测试验证。不做大范围重构。`
- 工具权限：全开
- 模型：快速模型（省额度）

---

## 五、Prompt & Rules 最优设置

### 项目级 Rules（已配好，无需额外操作）

`.catpaw/rules/*.md` 会自动注入，你不需要在 IDE 设置中再配一遍。当前 6 个文件已经覆盖：
- 通用编码规范
- 后端/前端/测试/文档/安全的职责划分
- 具体命令和工具使用方式
- 禁区和交付标准

### 全局 Prompt 建议（可选，在 IDE 设置 → Prompt 中配置）

如果你想在所有项目中都有一个通用的"工作纪律"，可以在全局 Prompt 中配以下内容：

```
你是 CatPaw AI 编程助手。工作纪律：

1. 改代码前先读代码——用 read_file/read_file 确认上下文，不要凭猜测改。
2. 探索用 codebase_search（语义）+ grep（精确），不要只读一个文件就动手。
3. 编辑用 MultiEdit 批量原子操作，改完用 read_lints 检查错误。
4. 跑命令用 run_terminal_cmd，不要等用户手动操作。
5. 复杂任务（3+ 步）用 todo_write 规划，完成一步标记一步。
6. 不确定的事用 AskQuestion 问用户，不要瞎猜。
7. 改完代码必须跑测试验证，不要说"应该没问题"。
8. 涉及安全相关代码（密钥/认证/加密），改完必须人工评审。
```

> 这段提示词会在我每次启动时注入，强化"先读后改、跑测试验证"的纪律。

### CLAUDE.md（已配好）

`CLAUDE.md` 是项目级说明文件，自动注入。当前已包含：
- 项目概览与架构
- 主要规则（多租户隔离、配置驱动、安全纪律）
- 运行与验证命令
- 产品化路线图（P0/P1 已完成项 + P2 待办）

---

## 六、配置完成后的验证清单

运行以下命令确认配置生效：

```powershell
# 1. 确认规则文件就位
Get-ChildItem .catpaw\rules\*.md | Select-Object Name, Length

# 2. 确认 MCP 配置已删除（应返回 False）
Test-Path .catpaw\mcp.json

# 3. 确认测试全绿
py -m pytest tests/ -v

# 4. 确认后端可启动
$env:SQ_DEV = "1"; py -m backend.smart_quotation
# 访问 http://127.0.0.1:8001/api/health 应返回 {"status":"ok"}
```

---

## 七、配置优化总结

| 配置项 | 旧状态 | 新状态 | 收益 |
|---|---|---|---|
| `.catpaw/mcp.json` | 4 个失效 MCP 配置 | 已删除 | 避免 Agent 困惑和加载错误 |
| `.catpaw/rules/*.md` | 引用不存在 MCP + 失实信息 | 6 个精简文件，引用真实工具 | Agent 指令可执行、不误导 |
| `CLAUDE.md` | P2 模块化标为未完成 | 标为已完成 + 补充新 P2 任务 | 路线图准确 |
| 自定义 Agent | 未设置 | 不推荐设置（rules 已覆盖） | 减少管理负担 |
| 全局 Prompt | 未设置 | 可选配工作纪律提示词 | 强化先读后改纪律 |

配置已就绪，可以开始执行 P0 任务了。
