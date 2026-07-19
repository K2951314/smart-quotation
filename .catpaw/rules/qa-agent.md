# 测试 Agent

## 职责
守护回归闸门，按模块补齐单元测试覆盖，确保所有改动不引入回归。

## 必读文件（用 read_file 加载）
- `tests/test_backend_v1.py`（391 行，20 用例）— 后端核心逻辑测试
- `tests/test_admin_gui.py`（100 行，8 用例）— admin GUI 结构断言
- `tests/config-core.test.js`、`tests/data-utils.test.js`、`tests/export-utils.test.js` — JS 单测
- `requirements.txt`、`CLAUDE.md`（测试命令段）

## 当前测试门状态（已验证 2026-07-17）
- ✅ **Python 测试全绿**：`py -m pytest tests/ -v` → **28 passed**（pytest 9.0.2 已装）
- ✅ **多租户隔离用例**：20 个后端用例覆盖配置/数据/审计的 company_id 隔离
- ⚠️ **无 `pyproject.toml` / `conftest.py`**：测试能跑但缺少正式配置
- ⚠️ **JS 测试**：`node --test` 可跑，覆盖率低
- ⚠️ **无覆盖率报告**：缺 `pytest-cov`

## 任务

### 第一步: 补测试基础设施
- 加 `pyproject.toml`（pytest 配置 + `httpx` + `pytest-cov` 进依赖）。
- 加 `conftest.py`（共享 fixture：临时 store、测试 config、TestClient）。

### 第二步: 补覆盖（按优先级）
- `engine.py`：公式求值正例 + 注入负例（`__import__`/`eval`/属性访问/关键字参数）。
- `store/bundles.py`：AES-GCM 加解密 round-trip、错误密码降级。
- `config-core.js`：v2/v3 兼容解析、gt/gte/lt/lte 比较操作符。
- `mitsubishi_stock.py`：本地 stub 模拟 GWT-RPC 响应，验证 `_parse_gwt`/`_extract_stock`。
- `license.py`：篡改 payload/过期/错误密钥/缓存失效。

### 第三步: CI 集成
- GitHub Actions 跑 `pytest tests/` + `node --test tests/*.test.js`，PR 合并闸门。

## 禁区
- 不写业务代码。
- 不降低既有断言的严格度（不为让测试通过而删断言）。
- 不引入重型测试框架（保持 unittest/pytest + node:test 轻量栈）。

## 交付标准
- 用 `run_terminal_cmd` 执行 `py -m pytest tests/ -v` 全绿，贴出真实输出。
- 核心路径（engine/store/config-core）覆盖率 > 70%。
- 新增用例附说明（测什么攻击向量 / 什么回归场景）。
