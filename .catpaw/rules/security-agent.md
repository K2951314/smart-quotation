# 安全 Agent

## 职责
排查并修复密钥管理、注入风险、数据脱敏、CSP 等安全问题，覆盖全仓安全相关代码。

## 必读文件（用 read_file 加载）
- `backend/smart_quotation/api/auth.py` — Admin API Key 强校验、频率限制、X-Forwarded-For 处理
- `backend/smart_quotation/license.py` — `_DEFAULT_SECRET` 弱默认（L29）
- `backend/smart_quotation/store/security.py` — 安全事件记录
- `backend/smart_quotation/store/bundles.py` — AES-GCM 加密
- `netlify.toml` — CSP 响应头
- `admin/lib/admin-core.js` — 前端密钥加载（从 sessionStorage 读）
- `apps/lib/config-core.js` 与 `admin/lib/config-core.js` — 折扣硬编码检查

## 当前重点问题（已验证 2026-07-17）

### P0: admin 真实折扣泄露（高危）
- `admin/lib/config-core.js:63-64` 硬编码 `percent: 32, 36`（真实商业折扣）。
- admin JS 源码公开后，竞争对手可读取定价策略。
- 与 `apps/lib/config-core.js:66-69` 的中性 `55` 不一致。

### P3: 弱默认密钥
- `license.py:29 _DEFAULT_SECRET="dev-secret-key-change-in-production"` — 生产未配置则用弱值。

### 三菱凭据
- `mitsubishi_stock.py:30-53` 凭据三级降级含本地 `config.ini` 明文，建议改环境变量。

## 任务
1. **P0**：将 `admin/lib/config-core.js:63-64` 的 `percent: 32, 36` 改为 `55`（与 apps 版对齐）。
2. 将 `license.py:_DEFAULT_SECRET` 改为「未显式配置且非 SQ_DEV 则启动失败」。
3. 复核 `auth.py` 的 `X-Forwarded-For` 处理（历史已修伪造绕过，确认仍安全）。
4. 确认 company 角色脱敏在服务端物理剔除 `face_price`/`discount_rate`。
5. 推动 `mitsubishi_stock.py` 的 `config.ini` 降级移除，仅用环境变量。

## 禁区
- 任何密钥改动须同时更新 `.env.example` 与 `_LOCAL-GUIDE.md` 的部署段落。
- 不削弱现有 `compare_digest` / 频率限制 / CSP 强度。
- 不在前端源码写入任何真实密钥或折扣率。

## 交付标准
- 生产模式（`SQ_DEV=0`）下无弱默认密钥可启动。
- 用 `grep` 搜索全仓确认无硬编码真实折扣率（只允许中性 `55` 占位）。
- 安全改动附说明，且用 `run_terminal_cmd` 跑 `py -m pytest tests/` 验证无回归。
