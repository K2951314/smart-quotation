# CLAUDE.md — 智能询价

## 项目概览

这是一个多租户配置驱动的智能询价系统，包含：

- `apps/`：静态前端报价台，基于远端配置和数据包运行。
- `admin/`：浏览器端 GUI 配置中心，面向非技术人员。
- `backend/`：FastAPI + SQLite 后端，提供多租户公司、配置、数据、审计和导入/回滚接口。
- `merger/`：品牌识别、价格/库存 Bundle 生成与导出工具。

## 主要规则

- 该系统的关键隔离单位是 `company_id`。几乎所有后端 API 都必须传入 `company_id`。
- `admin/` 前端和 `backend/` 后端共同构成多租户配置平台；`apps/` 是独立的静态报价台，不直接依赖 `admin/`。
- 配置发布与回滚：使用 `POST /api/companies/{id}/config/{revision}/publish`。
- 商品数据回滚/撤销：使用 `DELETE /api/companies/{id}/items/rollback?data_revision=...`。
- 配置文件 `config.example.json` 仅用于示例，**不应包含密钥、密码、Token 或任何机密值**。
- 如果需要写入密码或密钥，应在后端安全存储，不要硬编码到前端源码。

## 运行与验证

```powershell
pip install -r requirements.txt
py -m backend.smart_quotation
```

- GUI 配置中心：`http://127.0.0.1:8001/admin/`
- API 健康检查：`http://127.0.0.1:8001/api/health`

测试命令：

```powershell
py -m unittest tests.test_backend_v1 tests.test_admin_gui -v
```

## 文档指针

- `README.md`：项目概览、快速启动、功能列表、架构目录。
- `docs/gui-admin-guide.md`：用户操作手册，面向非技术人员。
- `docs/multitenant-config-v1-zh.md`：中文技术说明，含 API 参考和数据库模型。

## 记忆原则

- 不要把历史变更记录写入本文件。
- 本文件只保留项目架构、核心运行规则、重要边界和查阅指针。
- 具体实现细节、测试结果、每日日志保留在 `docs/` 或 `.workbuddy/memory/`。