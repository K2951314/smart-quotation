/**
 * app.js — 管理后台启动入口（bootstrap）。
 *
 * 此文件是 admin 前端的编排层，仅包含：
 *   - 全局错误捕获
 *   - DOMContentLoaded：认证检查 + 登录表单绑定
 *   - 初始渲染
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

// ─── 手机版侧栏菜单 ────────────────────────────────────────
(function initMobileMenu() {
  var menuToggle = document.getElementById("menuToggle");
  var sidebar = document.getElementById("sidebarRail");
  var overlay = document.getElementById("sidebarOverlay");

  if (!menuToggle || !sidebar || !overlay) return;

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("show");
    document.body.style.overflow = "";
  }

  menuToggle.addEventListener("click", function (e) {
    e.stopPropagation();
    if (sidebar.classList.contains("open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  // 关闭按钮
  var closeBtn = document.getElementById("closeSidebarBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", closeSidebar);
  }

  overlay.addEventListener("click", closeSidebar);

  // 点击导航链接后关闭侧栏
  sidebar.querySelectorAll(".nav a").forEach(function (link) {
    link.addEventListener("click", function () {
      // 延迟关闭，让导航先滚动
      setTimeout(closeSidebar, 150);
    });
  });

  // ESC 键关闭
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && sidebar.classList.contains("open")) {
      closeSidebar();
    }
  });

  // 窗口 resize 到桌面端时自动关闭
  var mql = window.matchMedia("(min-width: 769px)");
  mql.addEventListener("change", function (e) {
    if (e.matches && sidebar.classList.contains("open")) {
      closeSidebar();
    }
  });
})();

// ─── 章节快速定位条：滚动感知高亮（chip 导航 + 侧栏联动）─────────
(function initSectionScrollspy() {
  var chipNav = document.getElementById("chipNav");
  if (!chipNav || !("IntersectionObserver" in window)) return;

  var chips = Array.prototype.slice.call(chipNav.querySelectorAll("a"));
  if (!chips.length) return;
  var drawerLinks = Array.prototype.slice.call(
    document.querySelectorAll('#sidebarRail .nav a[href^="#"]')
  );

  var sections = chips
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  function setActive(id) {
    chips.forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("href") === "#" + id);
    });
    drawerLinks.forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("href") === "#" + id);
    });
    // 当前 chip 自动滚动到定位条中间
    var active = chipNav.querySelector("a.active");
    if (active && chipNav.scrollWidth > chipNav.clientWidth) {
      var navRect = chipNav.getBoundingClientRect();
      var aRect = active.getBoundingClientRect();
      var target = chipNav.scrollLeft + (aRect.left - navRect.left) - (navRect.width - aRect.width) / 2;
      chipNav.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
  }

  var currentId = null;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) currentId = entry.target.id;
    });
    if (currentId) setActive(currentId);
  }, { rootMargin: "-30% 0px -55% 0px", threshold: 0 });

  sections.forEach(function (sec) { io.observe(sec); });
  // 初始高亮第一个区块
  if (sections.length) setActive(sections[0].id);
})();

// ─── 启动逻辑（认证优先）────────────────────────────────────
window.addEventListener("DOMContentLoaded", function () {
  if (isAdminAuthenticated()) {
    // 已有 token（JWT 或 API Key），验证是否仍有效
    fetch(apiBase + "/api/companies", { headers: { "Authorization": "Bearer " + getAuthToken() } })
      .then(function (resp) {
        if (resp.ok) {
          hideLoginOverlay();
          // JWT 用户：从 storage 恢复 company_id（sessionStorage 优先）
          if (JWT_TOKEN) {
            var savedCid = sessionStorage.getItem("sq_admin_company_id") || localStorage.getItem("sq_admin_company_id");
            if (savedCid) setCurrentCompanyId(savedCid);
          }
          bind();
          run(loadCompanies);
          // 加载 license 档位徽标（超管模式才有效，非超管静默跳过）
          if (window.loadLicenseBadge) run(window.loadLicenseBadge);
        } else {
          // token 失效，清除并显示登录
          setAdminApiKey("");
          setJwtToken("");
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
    // 未登录，检查是否有注册/登录页的入口
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
