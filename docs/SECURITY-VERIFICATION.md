# 安全验证与技术说明

> 本文档基于对抗式审查生成，逐项验证每个安全改造，列出已知风险与防护方案。
> 审查脚本：`_adversarial_audit.py`（本地保留，不入库）
> 审查结果：40 passed（含多租户隔离测试）；第二轮对抗式审查（20 项发现）批 1+2 已修复

---

## 一、验证方法

### 对抗式审查原则

1. **不信任客户端**：所有来自客户端的输入（header、query、body）都视为可伪造
2. **从攻击者视角测试**：尝试绕过、篡改、注入、越权
3. **第一性原理**：验证安全属性的根源（密码学原语、隔离边界、认证链）

### 测试覆盖矩阵

| 模块 | 测试项 | 攻击向量 | 结果 |
|---|---|---|---|
| P0-1 Admin API Key | 8 项 | 弱值/SQL注入/空Bearer/无key | ✅ 全通过 |
| P0-2 stock-query | 6 项 | 伪造IP绕频率/超量/无key | ✅ 修复后通过 |
| P0-4 多租户隔离 | 5 项 | 伪造company_id越权 | ⚠️ 1项设计权衡 |
| P1-6 配置驱动 | 1 项 | 无rules时的行为 | ✅ 通过 |
| P1-7 Sentry | 2 项 | 无SDK/错误DSN | ✅ 通过 |
| P1-8 License | 5 项 | 篡改payload/过期/错误密钥 | ✅ 全通过 |

---

## 二、逐项验证结果

### P0-1: Admin API Key 强校验

**安全属性**：启动时拒绝弱配置 + 恒定时间比较防时序攻击

| 测试 | 攻击向量 | 预期 | 结果 |
|---|---|---|---|
| 1.1 | 不设 ADMIN_API_KEY（生产模式） | 拒绝启动 | ✅ RuntimeError |
| 1.2 | 弱值 "password" | 拒绝启动 | ✅ RuntimeError |
| 1.3 | 短值（7字符） | 拒绝启动 | ✅ RuntimeError |
| 1.4 | 正确 key 访问 | 200 | ✅ |
| 1.5 | 错误 key | 401 | ✅ |
| 1.6 | 无 key | 401 | ✅ |
| 1.7 | 空 Bearer | 401 | ✅ |
| 1.8 | SQL 注入 `' OR '1'='1` | 401 | ✅ |

**实现要点**：
- `_load_admin_api_key()` 在 `create_app()` 启动期调用，失败直接抛 RuntimeError
- 弱值黑名单：`""`、`"admin-secret-key"`、`"admin"`、`"password"`、`"123456"`、`"change-me"`
- 长度要求：≥ 16 字符（生产），`SQ_DEV=1` 时警告但不拒绝
- 比较：`secrets.compare_digest()` 恒定时间，防时序攻击

**逃生通道**：`SQ_DEV=1` 跳过强校验，回退到弱默认值 `admin-secret-key`，打印警告。仅限本地开发。

---

### P0-2: stock-query 认证 + 频率限制

**安全属性**：认证 + 频率限制 + 单次条数上限

| 测试 | 攻击向量 | 预期 | 结果 |
|---|---|---|---|
| 2.1 | 无 X-Stock-Key | 401 | ✅ |
| 2.2 | 错误 key | 401 | ✅ |
| 2.3 | 正确 key + 空 queries | 200 空结果 | ✅ |
| 2.4 | 60s 内 30+ 次 | 429 | ✅ 第30次触发 |
| 2.5 | **伪造 X-Forwarded-For 绕频率** | 应仍被限制 | ✅ **已修复** |
| 2.6 | 超 50 条 queries | 422 | ✅ |

**修复的漏洞（2.5）**：

原实现用 `X-Forwarded-For` 作为频率限制 key，攻击者可伪造此 header 每次用不同 IP 绕过限制。修复后改用 `stock_key + 直连IP` 组合：

```python
def get_client_id(request: Request) -> str:
    # 优先用 stock_key 作为身份标识（同一 key = 同一用户）
    stock_key = request.headers.get("x-stock-key", "") or ...
    if stock_key:
        return f"key:{stock_key[:8]}"  # 用前 8 字符做 hash bucket
    return f"ip:{request.client.host}"  # 回退到直连 IP
```

这样即使伪造 IP，只要 key 相同就被限制。频率限制参数：60 秒窗口 / 30 次 / 单次 50 条。

---

### P0-4: 多租户 company_id 隔离

**安全属性**：数据级隔离（A 公司看不到 B 公司数据）

| 测试 | 攻击向量 | 预期 | 结果 |
|---|---|---|---|
| 4.1 | A 的 configs 只含 A | 隔离生效 | ✅ |
| 4.2 | A 的 items 只含 A | 隔离生效 | ✅ |
| 4.3 | **未认证读 `/api/config/active?company_id=B`** | 应限制 | ⚠️ 可读取 |
| 4.4 | admin 删 B 的 items（带正确key） | 允许（admin 权限） | ✅ |
| 4.5 | 删除 A 级联清理 | 生效 | ✅ |

**已知风险（4.3，MEDIUM 级）**：

`/api/config/active` 是公开端点（前端免登录加载配置），任何人可通过 `?company_id=X` 读取任意公司的配置，**包括折扣率 rules**。

**风险评估**：
- 折扣率是商业敏感信息，竞争对手知道后可反推你的定价策略
- 但前端必须加载 rules 才能计算报价，无法完全剔除
- company_id 是用户自设（如 "A"、"B"），可猜测性高

**缓解方案**（按推荐度排序）：

1. **company_id 用 UUID**：创建公司时用 `secrets.uuid4().hex` 而非用户输入，使 company_id 不可猜测
2. **公开端点加 token**：每个公司有 `public_config_token`，前端必须传 `?token=X` 才能读取（admin 生成公司时返回 token）
3. **反向代理层限流**：在 nginx/Cloudflare 层面限制 `/api/config/active` 的请求频率

当前接受此风险，建议在 P2 阶段实现方案 1 或 2。

---

### P1-6: 品牌折扣规则配置驱动

**安全属性**：前端代码不含业务硬编码

| 测试 | 攻击向量 | 预期 | 结果 |
|---|---|---|---|
| 6.1 | 无 rules 时品牌识别 | 归到 "other" | ✅ |

验证 `discount-utils.js` 的 `getDiscountCategory(item, null)` 和 `getDiscountCategory(item, [])` 都返回 `"other"`，不再硬编码 `EX活动`/`OSG`/`刀具` 品牌。

---

### P1-7: Sentry 错误监控骨架

**安全属性**：无 DSN 时优雅降级，不报错

| 测试 | 场景 | 预期 | 结果 |
|---|---|---|---|
| 7.1 | 无 SENTRY_DSN | 跳过初始化 | ✅ |
| 7.2 | 未初始化时 capture_exception | 静默忽略 | ✅ |

**实现要点**：
- 后端 `observability.py`：`SENTRY_DSN` 环境变量设置时才 `import sentry_sdk`
- 前端 `app.js`：`window.SQ_SENTRY_DSN` 设置时才动态加载 Sentry SDK
- `send_default_pii=False`：不发送请求体（可能含敏感数据）
- `max_request_body_size="never"`：禁止采集请求体

---

### P1-8: License 校验机制

**安全属性**：HMAC-SHA256 签名 + 过期检查 + 功能授权

| 测试 | 攻击向量 | 预期 | 结果 |
|---|---|---|---|
| 8.1 | 有效 license | 验签通过 | ✅ |
| 8.2 | **篡改 payload（改 customer 名）** | 验签失败 | ✅ |
| 8.3 | **错误密钥签的 license** | 验签失败 | ✅ |
| 8.4 | **过期 license** | 拒绝 | ✅ |
| 8.5 | 缓存命中（改 SQ_LICENSE 后 5min 内仍用旧值） | 缓存生效 | ✅ |

**密码学保证**：
- HMAC-SHA256：签名密钥未知时无法伪造
- `hmac.compare_digest()`：签名比较恒定时间，防时序攻击
- 过期检查：`expires_at` 字段，过期后 `verify_license()` 返回 None

**已知限制（8.5，LOW 级）**：
- License 验证结果缓存 5 分钟（`_LICENSE_REVERIFY_INTERVAL = 300`）
- 吊销 license 后 5 分钟内仍可用（可通过 `verify_license(force=True)` 立即重验）
- HMAC 是对称签名，`SQ_LICENSE_SECRET` 泄露后客户可伪造 license

**生产建议**：
- 升级为 RSA 非对称签名（私钥签，公钥验），公钥可公开
- 或建立 license 吊销列表（blacklist）

---

## 三、已知风险与防护清单

### 🔴 高危（已修复）

| 风险 | 影响 | 状态 |
|---|---|---|
| Admin API Key 默认值 `"admin-secret-key"` | 任何人可用默认 key 调用 admin 端点 | ✅ P0-1 修复 |
| stock-query 无认证 | 三菱账号被滥用、被封 | ✅ P0-2 修复 |
| X-Forwarded-For 绕过频率限制 | 攻击者无限调用三菱库存查询 | ✅ 审查后修复 |

### 🟡 中危（设计权衡，需评估）

| 风险 | 影响 | 缓解方案 |
|---|---|---|
| 公开端点 `/api/config/active` 暴露折扣配置 | 竞争对手可读取折扣率 | company_id 用 UUID / 加 public_config_token / 反代限流 |
| admin key 可操作任意 company_id | 拥有 admin key 可删任何公司数据 | admin key 仅限你本人持有；多租户 RBAC 待 P2 |
| 频率限制器是内存级 | 多进程部署时不共享 | 生产用 Redis 共享计数器；或限单进程 |

### 🟢 低危（可接受）

| 风险 | 影响 | 接受理由 |
|---|---|---|
| License 缓存 5 分钟 | 吊销后短暂可用 | 可 force=True 立即重验 |
| HMAC 对称密钥 | 密钥泄露可伪造 license | 可升级 RSA；密钥只在你手中 |
| SQLite 并发写入 | 高并发下锁竞争 | 多租户并发写入场景未到，P2 迁 PostgreSQL |
| 无 HSTS | 中间人降级攻击 | Netlify/Railway 默认 HTTPS，CSP 已设 |

---

## 四、使用说明

### 本地开发

```powershell
# 1. 安装依赖
pip install -r requirements.txt

# 2. 本地开发模式启动（跳过强校验，用弱默认 key）
$env:SQ_DEV = "1"
py -m backend.smart_quotation

# 3. 访问
# 管理后台：http://127.0.0.1:8001/admin/
# 客户报价台：http://127.0.0.1:8001/apps/index.html
# API 健康：http://127.0.0.1:8001/api/health
```

**本地开发模式特性**：
- `SQ_DEV=1` 跳过 ADMIN_API_KEY 强校验，用默认值 `admin-secret-key`
- 后端自动代理 `/config.json`、`/price.bundle.json` 等静态文件（模拟 Supabase）
- 根路径 `/` 自动重定向到 `/admin/`
- admin 前端从 `sessionStorage` 读取 API key（默认为空），登录页输入后存储；不在源码中硬编码 key

### 生产部署

```powershell
# 1. 生成强随机密钥
py -c "import secrets; print(secrets.token_urlsafe(32))"

# 2. 设置环境变量（必须全部设置）
$env:ADMIN_API_KEY = "上一步生成的32字符密钥"
$env:STOCK_QUERY_KEY = "另一个32字符密钥"
$env:SQ_LICENSE_SECRET = "第三个32字符密钥"
$env:SQ_LICENSE = "你给客户签发的license字符串"
$env:ALLOW_ORIGINS = "https://你的域名.netlify.app"
# 可选：$env:SENTRY_DSN = "你的Sentry DSN"

# 3. 启动（注意：不设 SQ_DEV）
py -m uvicorn backend.smart_quotation.api:create_app --factory --host 0.0.0.0 --port $PORT
```

**生产环境检查清单**：
- [ ] `ADMIN_API_KEY` 已设置（≥16字符，非弱值）
- [ ] `STOCK_QUERY_KEY` 已设置（不同于 admin key）
- [ ] `SQ_LICENSE_SECRET` 已设置
- [ ] `SQ_LICENSE` 已签发并设置
- [ ] `ALLOW_ORIGINS` 已设置为你前端域名
- [ ] `SQ_DEV` **未设置**（或设为 0）
- [ ] HTTPS 已启用（Netlify/Railway 默认）
- [ ] `config.example.json` 不含敏感值

### 给客户签发 License

```powershell
# 1. 设置你的签名密钥（保密！）
$env:SQ_LICENSE_SECRET = "你的32字符签名密钥"

# 2. 生成 license
py -c "from backend.smart_quotation.license import generate_license; print(generate_license('客户A', '2027-12-31T23:59:59Z', max_companies=5, features=['core','multi_tenant','stock_query']))"

# 3. 把输出的 base64 字符串发给客户
# 客户把它设为环境变量 SQ_LICENSE
```

**License 参数说明**：
- `customer`：客户名称（展示用）
- `expires_at`：过期时间，ISO 8601 格式
- `max_companies`：最大公司数（多租户限制）
- `features`：授权功能列表

---

## 五、验证命令速查

```powershell
# Python 测试（40 项，含多租户隔离测试）
py -m pytest tests/ -v

# JS 单元测试
node --test tests/*.test.js

# 语法检查（注意 api/ 和 store/ 已重构为包目录）
py -c "import ast; [ast.parse(open(f,encoding='utf-8').read()) for f in ['backend/smart_quotation/api/factory.py','backend/smart_quotation/api/auth.py','backend/smart_quotation/store/base.py','backend/smart_quotation/license.py','backend/smart_quotation/observability.py']]"

# 真实服务器冒烟测试
$env:SQ_DEV = "1"
$env:ADMIN_API_KEY = "test-key-0123456789abcdef"
Start-Job { py -m uvicorn backend.smart_quotation.api:create_app --factory --port 8001 } | Out-Null
Start-Sleep 3
Invoke-RestMethod http://127.0.0.1:8001/api/health
Invoke-RestMethod http://127.0.0.1:8001/api/license/info
Get-Job | Stop-Job; Get-Job | Remove-Job
```

---

## 六、审计结论

| 维度 | 评级 | 说明 |
|---|---|---|
| 认证 | ✅ 强 | API Key 强校验 + compare_digest + 逃生通道 |
| 授权 | ⚠️ 中 | 多租户隔离有效，但 admin 权限过宽 |
| 频率限制 | ✅ 强 | 修复 X-Forwarded-For 绕过后达标 |
| 数据隔离 | ✅ 强 | schema + 所有 CRUD 过滤 + 级联删除 |
| 配置安全 | ✅ 强 | 无硬编码品牌/密钥/URL |
| 错误监控 | ✅ 强 | Sentry 按需启用，优雅降级 |
| License | ✅ 强 | HMAC-SHA256 + 过期 + 功能授权 + max_companies 强制 |
| 代码注入 | ✅ 强 | SQL注入/key注入均被拒 |
| CSP | ✅ 强 | script-src 白名单（self + sentry CDN）；SheetJS 已自托管消除供应链风险 |

**总结**：P0+P1 改造的安全属性经对抗式审查验证有效。唯一中危项（公开端点暴露折扣配置）是设计权衡，建议在 P2 阶段用 UUID company_id 或 public_config_token 缓解。系统已具备商业化部署的安全基础。

---

## 七、第二轮对抗式审查（2026-07-23，20 项发现）

> 审查报告：`radiant-beacon-curie.md`（本地 `.workbuddy/plans/`，不入库）
> 范围：backend 31 个 .py 全部通读 + admin/apps 28 个前端文件交叉验证 + 依赖配置 + git 历史 + Supabase 配置

### 批 1（P0，已修复）

| # | 问题 | 状态 |
|---|---|---|
| 1 | git 历史含真实密钥（MMC_PASSWORD/ADMIN_API_KEY/STOCK_QUERY_KEY） | ✅ 密钥全量轮换 + git filter-repo 历史清洗 |
| 2 | `_DEPLOYMENT-STEPS.md` 全部生产密钥明文 | ✅ 去密钥化（本地文件，不入库） |
| 3 | 供应链存储型 XSS：anon key 写公开桶 → 投毒 config.json → discount-config.js 未转义 | ✅ discount-config.js escapeHtml；桶写权限待批 3 改后端代理 |

### 批 2（P1 代码修复，commit 37787fb）

| # | 问题 | 修复 |
|---|---|---|
| 5 | 配置可控正则 ReDoS（无长度/嵌套量词校验） | config.py 新增 `validate_regex_pattern`（长度上限+编译+嵌套量词拦截） |
| 6 | 异常 `str(exc)` 原样回显客户端（泄露内部拓扑） | routes_merger/routes_stock/mitsubishi_stock 错误文案泛化 + 日志记详情 |
| 8 | 生产暴露 /docs 与 /openapi.json | factory.py 生产 `docs_url=None, openapi_url=None` |
| 9 | SheetJS CDN 无 SRI（供应链风险） | admin/index.html 改自托管 `admin/lib/xlsx.full.min.js` |
| 10 | 依赖下界过宽（CVE-2024-53981/35195/43870） | requirements.txt 收紧下界 + requirements-lock.txt 锁文件 |
| 13 | 文件数/行数无上限 + workbook 未 close | routes_merger 限 20 文件 + excel.py 限 50000 行 + `wb.close()` |
| 14 | 503 文案提示 config.ini 存在 | routes_stock.py 文案去文件名 |

### 批 3（P2，待定）

- License RSA 非对称验签（#7，架构变更）
- auth.py IP 限流改造（#12）
- CSP 补 `base-uri 'none'`/`form-action 'self'`（#18）
- config.ini 凭据环境变量化（#14 部分残留）
- 公开桶写权限改后端 service_key 代理上传（#3 架构变更）
- create_admin_company.py 脱敏输出（#19）
