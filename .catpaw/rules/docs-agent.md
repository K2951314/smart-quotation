# 文档 Agent

## 职责
让项目文档与实际代码对齐，消除漂移与矛盾，补全缺失文档。

## 必读文件（用 read_file 加载）
- 全部 `*.md`：`README.md`、`CLAUDE.md`、`_LOCAL-GUIDE.md`、`docs/*.md`
- 实际目录结构：用 `list_dir` 或 `glob_file_search` 确认

## 已发现的文档问题（已验证 2026-07-17）

### Q7: README 严重滞后
- `README.md:121-156` "项目结构"称单文件 `api.py`/`store.py`，实际已拆成 `api/`（9 文件）+ `store/`（9 文件）包。
- 未提 `plugins`/`license`/`erp`/`supabase`/`routes_merger`。
- 测试命令只列了 `unittest`，未提 `pytest`（当前主力）。

### Q8: 文档内部矛盾
- `docs/SECURITY-VERIFICATION.md:192,227` 称 `admin/app.js` 硬编码 `ADMIN_API_KEY="admin-secret-key"` 泄露。
- 实际 `admin/lib/admin-core.js` 从 `sessionStorage` 读取（默认 `""`），非硬编码。
- 真正的弱默认在后端 `auth.py`（仅 `SQ_DEV` 模式生效）。

### 缺失文档
- CLAUDE.md 路线图 P2 列了 `DEPLOYMENT.md` 但未写。
- README "项目结构"与 `docs/` 实际 5 篇文档未对应。

## 任务
1. 重写 README "项目结构"段，对齐 `api/` + `store/` 实际包结构。
2. 消解 `SECURITY-VERIFICATION.md` 与 `admin-core.js` 的矛盾，改为准确描述当前密钥加载链路。
3. 补 `DEPLOYMENT.md`（Netlify + Railway/Render + Supabase 部署步骤、环境变量清单）。
4. **同步机制**：每次 backend/frontend Agent 完成任务，自动 diff 变更并补/改对应文档。

## 禁区
- 不改代码。
- 不编造未实现的 API 端点（历史教训：曾写不存在的 customer 端点）。

## 交付标准
- 文档中描述的每个端点/文件都能在实际代码中用 `grep` 或 `glob_file_search` 找到对应。
- 文档与代码对同一事实的描述无矛盾。
- 用 `read_file` 交叉验证文档声明与代码实现一致。
