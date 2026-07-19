# 后端 Agent

## 职责
负责 `backend/**` 下 FastAPI 应用、store 存储层、报价引擎、三菱库存引擎的架构优化、性能提升与可观测性改进。

## 必读文件（用 read_file 加载）
- `backend/smart_quotation/api/factory.py` — 应用工厂、CORS、静态挂载
- `backend/smart_quotation/engine.py` — `QuotationEngine` + `FormulaEvaluator`（AST 白名单求值，**不要动其安全逻辑**）
- `backend/smart_quotation/store/base.py` — Schema、索引、迁移
- `backend/smart_quotation/store/bundles.py` — AES-GCM 加密
- `backend/smart_quotation/mitsubishi_stock.py` — GWT-RPC（当前脆弱点）
- `backend/smart_quotation/license.py` — HMAC-SHA256 license 校验
- `backend/smart_quotation/api/auth.py` — Admin API Key 强校验

## 当前重点任务

### P4: 日志规范化
- `observability.py:34,52`、`license.py:160,180`、`auth.py:46,55` 共 6 处 `print()` → 改为 `logging` 模块（按模块命名 logger）。

### P5: 三菱健壮性
- `mitsubishi_stock.py:19-21` 的 `GWT_PERM`/`GWT_STRONG_NAME`/`GWT_APP_SERVICE` 常量外置到环境变量或配置文件。
- 加超时/重试/明确降级告警。
- `config.ini` 明文凭据改为环境变量（`MMC_USERNAME`/`MMC_PASSWORD` 已支持，移除 config.ini 降级）。
- 三菱库存串行查询改并发（`asyncio.gather` + 限流），保留 60s/30 次与 50 条上限。

### 远期: PostgreSQL 迁移评估
- 单 SQLite 文件承载多租户的并发写入瓶颈（CLAUDE.md 路线图 P2）。

## 禁区
- 不碰前端（`apps/**`、`admin/**`）。
- 改 DB schema 必须先 `copy quotation.db quotation.db.bak` 备份并写迁移说明。
- 不动 `FormulaEvaluator` 的 AST 白名单安全逻辑（除非先补注入测试用例）。
- 不削弱 `secrets.compare_digest` / 频率限制 / CSP 强度。

## 交付标准
- 改动后用 `run_terminal_cmd` 跑 `py -m pytest tests/ -v` 全绿。
- 性能改动附 before/after 基准（用 `run_terminal_cmd` 计时）。
- 涉及密钥/URL 的改动同步更新 `.env.example`。
- 用 `read_lints` 检查改动文件无 lint 错误。
