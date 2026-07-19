/**
 * app.js — 管理后台启动入口（bootstrap）。
 *
 * 此文件是 admin 前端的编排层，仅包含：
 *   - 全局错误捕获
 *   - DOMContentLoaded：认证检查 + 登录表单绑定
 *   - 初始渲染 + 键盘快捷键
 *
 * 所有业务逻辑已拆分到 lib/ 目录下的模块中：
 *   admin-core.js        — 全局状态、认证、API 请求、工具函数、默认配置
 *   companies.js         — 公司管理 UI
 *   supabase-deploy.js   — Supabase Storage 上传工具
 *   standalone-html.js   — 独立报价单 HTML 生成
 *   config-collect.js    — 表单收集配置对象
 *   config-render.js     — 配置渲染到表单
 *   config-api.js        — 配置 API 调用（加载/保存/校验/历史/审计/导入导出）
 *   event-bindings.js    — 所有 UI 事件绑定
 */

// ─── 全局错误捕获 ──────────────────────────────────────────
window.addEventListener("error", (event) => {
  const msg = event?.message || "未知错误";
  setStatus(`JS 错误：${msg}`, true);
  setJsStatus("异常");
});

// ─── 启动逻辑（认证优先）────────────────────────────────────
window.addEventListener("DOMContentLoaded", function () {
  if (isAdminAuthenticated()) {
    // 已有 session key，验证是否仍有效
    fetch(apiBase + "/api/companies", { headers: { "Authorization": "Bearer " + ADMIN_API_KEY } })
      .then(function (resp) {
        if (resp.ok) {
          hideLoginOverlay();
          bind();
          run(loadCompanies);
        } else {
          setAdminApiKey("");
          showLoginOverlay();
        }
      })
      .catch(function () {
        // 网络错误，但仍尝试加载（可能是本地开发）
        hideLoginOverlay();
        bind();
        run(loadCompanies);
      });
  } else {
    showLoginOverlay();
  }
});

// 登录表单回车提交
window.addEventListener("DOMContentLoaded", function () {
  var loginInput = document.getElementById("loginApiKeyInput");
  if (loginInput) {
    loginInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); tryLogin(); }
    });
  }
  var loginBtn = document.getElementById("loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", function (e) { e.preventDefault(); tryLogin(); });
  }
});

// ─── 初始渲染 ──────────────────────────────────────────────
setJsStatus("已就绪");
renderAll();

// Ctrl+Shift+S 保存快捷键（避免与浏览器 Ctrl+S 冲突）
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "s") {
    e.preventDefault();
    run(() => saveConfig("draft"));
  }
});
