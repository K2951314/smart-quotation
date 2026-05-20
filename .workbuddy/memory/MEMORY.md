# Memory - 智能询价项目

## 项目架构
- 纯前端询价工具，部署 Netlify，数据源 Supabase 公开存储桶
- 字段映射：单字母键 c/p/s/r/b/n/m/a/i 硬编码在 app.js
- AES-GCM 解密（PBKDF2 100k iterations SHA-256）加密价格包
- 动态脚本注入加载 bundle（已标记为安全风险）
- Cache Storage API（quotation-cache-v1）+ version.json 版本失效
- 品牌折扣引擎（EX活动/OSG/三菱/其他）+ localStorage 持久化

## 上线前全检结论 (2026-05-16)
- **No-Go**：2 个阻断项需修复
- P0-1: MMC 密码硬编码在前端（app.js:18），必须移除
- P0-2: 远程脚本注入无校验（app.js:382-386），应改为 JSON.parse
- P0-3: 缺少安全响应头（CSP/X-Frame-Options/X-Content-Type-Options）
- 完整报告：deliverables/gstack/pre-launch-check-quotation-2026-05-16.md

## 字段配置化方案
- config.json 扩展：fields（字段映射+标签）、copy_columns（复制列）、copy_prefix、stock_prefix
- 5 Phase 渐进改造，Phase 1-2 零风险（1h），Phase 3-4 中风险（3.5h）
- 仅改显示层和复制层，不改数据合并层
