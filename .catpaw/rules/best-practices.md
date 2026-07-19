# 通用编码规范

> 智能询价系统全员底线。项目性质：多租户配置驱动的 B2B 刀具报价系统（FastAPI + 原生 JS + SQLite + Supabase + 三菱 GWT-RPC）。

## 工具使用纪律

- **探索代码**：优先用 `codebase_search`（语义检索）+ `grep`（精确文本）+ `read_file`，不要凭猜测改代码。
- **编辑代码**：用 `read_file` 先读全貌 → `MultiEdit` 批量原子编辑 → `read_lints` 检查错误。不要用 `write` 覆盖整个文件除非必要。
- **跑命令**：用 `run_terminal_cmd` 直接执行，无需 MCP 包装。常用命令见下方。
- **验证 UI**：用 `BrowserUse` 打开 `http://127.0.0.1:8001/apps/index.html` 或 `/admin/`，截图验证无回归。
- **任务管理**：复杂任务（3+ 步）用 `todo_write` 规划，完成一步标记一步。

## 常用命令（PowerShell）

```powershell
# 跑测试（回归闸门，当前 28/28 全绿）
py -m pytest tests/ -v

# 跑 JS 测试
node --test tests/*.test.js

# 启动后端（本地开发，SQ_DEV=1 跳过强校验）
$env:SQ_DEV = "1"; py -m backend.smart_quotation

# 只读查 SQLite
py -c "import sqlite3; c=sqlite3.connect('quotation.db'); print(c.execute('SELECT * FROM companies').fetchall())"

# 备份数据库（改 schema 前必须做）
copy quotation.db quotation.db.bak
```

## 不可逾越的底线

1. **改代码前先读代码**：涉及 `auth.py` / `license.py` / `store/bundles.py`（AES-GCM）等安全文件，改动后必须跑 `py -m pytest tests/`。
2. **任何 DB schema 变更**必须先 `copy quotation.db quotation.db.bak` 备份，并写迁移说明，禁止静默 DROP。
3. **前端不得引入框架或打包器**：`apps/` 与 `admin/` 是纯原生 JS、无 node_modules、静态部署 Netlify。
4. **不硬编码业务数据**：品牌名、折扣率、客户/部署 URL 一律走 config.json 或环境变量。`admin/lib/config-core.js` 残留真实折扣 `32/36` 属违规（高危，P0 任务）。
5. **密钥比较用 `secrets.compare_digest`**（防时序攻击），不要自己写 `==`。
6. **源码不得硬编码真实 URL**（Supabase/Railway），一律环境变量或 admin 配置中心注入。

## 代码风格

- **Python**：PEP 8；用 `logging` 而非 `print()`；捕获异常保留原始链（`raise ... from e` 或 `logger.exception`）。
- **JS**：中英文之间加空格；函数写 docstring；避免全局变量滥用（token/key 仅存 sessionStorage/localStorage）。
- **浮点校正**：JS 中 `Math.ceil` 前减 `1e-9`，避免 `28 × 1.1 = 30.800000000000004` 越界。

## 提交与文档

- 每个任务完成后用 `run_terminal_cmd` 执行 git 提交（中文 Conventional Commits：`feat:`/`fix:`/`refactor:`/`docs:`/`test:`）。
- 代码改动若影响用户可见行为或配置格式，必须同步更新 README / `docs/` / `CLAUDE.md`。
- 严禁编造未实现的 API 端点写进文档。
