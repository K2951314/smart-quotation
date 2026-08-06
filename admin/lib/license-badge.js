/**
 * License 档位徽标 + 用量进度条模块。
 *
 * 从 /api/license/info 加载当前 license 状态，在侧边栏显示档位徽标，
 * 在顶部状态栏显示用量进度条（SKU 数 / 上限、库存查询次数 / 上限）。
 *
 * 设计原则（简约）：
 * - 不新建独立 UI 组件库，只往现有 DOM 槽位注入
 * - 超管模式（ADMIN_API_KEY）才加载（租户看不到 license 详情）
 * - 加载失败静默降级，不阻塞配置中心正常使用
 */
(function () {
  "use strict";

  const TIER_LABELS = {
    free: "免费版",
    pro: "个人版",
    team: "专业版",
  };

  const TIER_COLORS = {
    free: "#95a5a6",
    pro: "#3498db",
    team: "#9b59b6",
  };

  /**
   * 加载 license 信息并渲染徽标 + 用量。
   * 只在超管模式调用（/api/license/info 需超管权限）。
   */
  async function loadLicenseBadge() {
    const apiBase = (window.getApiBase && window.getApiBase()) || "";
    const token = (window.getAuthToken && window.getAuthToken()) || "";
    if (!token) return; // 未登录，跳过

    let info;
    try {
      const resp = await fetch(apiBase + "/api/license/info", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) return; // 非超管或未配置，静默跳过
      info = await resp.json();
    } catch {
      return; // 网络错误，静默跳过
    }

    if (!info || !info.valid) {
      renderNoLicense();
      return;
    }

    renderBadge(info);
    await loadUsage(info);
  }

  function renderBadge(info) {
    const tier = info.tier || "free";
    const label = TIER_LABELS[tier] || tier;
    const color = TIER_COLORS[tier] || "#95a5a6";

    // 徽标注入到 brand 区域
    const brand = document.querySelector(".brand");
    if (!brand) return;
    let badge = document.getElementById("tierBadge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "tierBadge";
      badge.style.cssText =
        "margin-top:4px;font-size:11px;font-weight:600;color:#fff;" +
        "background:" + color + ";padding:2px 8px;border-radius:10px;" +
        "display:inline-block;cursor:pointer;";
      badge.title = "点击查看订阅方案";
      badge.onclick = function () {
        window.location.href = "billing.html";
      };
      brand.appendChild(badge);
    }
    badge.textContent = label;

    // 过期时间提示（30 天内黄色，7 天内红色）
    if (info.expires_at) {
      const expiry = new Date(info.expires_at);
      const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
      if (daysLeft < 30) {
        badge.style.background = daysLeft < 7 ? "#e74c3c" : "#f39c12";
        badge.title = `订阅将在 ${daysLeft} 天后过期（${info.expires_at}），点击续费`;
      }
    }
  }

  function renderNoLicense() {
    const brand = document.querySelector(".brand");
    if (!brand) return;
    let badge = document.getElementById("tierBadge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "tierBadge";
      badge.style.cssText =
        "margin-top:4px;font-size:11px;font-weight:600;color:#fff;" +
        "background:#e74c3c;padding:2px 8px;border-radius:10px;" +
        "display:inline-block;cursor:pointer;";
      badge.onclick = function () {
        window.location.href = "billing.html";
      };
      brand.appendChild(badge);
    }
    badge.textContent = "未授权";
    badge.title = "未检测到有效 License，点击查看订阅方案";
  }

  /**
   * 加载用量数据（SKU 数、库存查询次数）。
   * 只在超管模式调用。
   */
  async function loadUsage(info) {
    const apiBase = (window.getApiBase && window.getApiBase()) || "";
    const token = (window.getAuthToken && window.getAuthToken()) || "";

    // SKU 用量
    if (info.max_skus && info.max_skus > 0) {
      try {
        const resp = await fetch(
          apiBase + "/api/items/stats?company_id=" + encodeURIComponent(info.company_id || "default"),
          { headers: { Authorization: "Bearer " + token } }
        );
        if (resp.ok) {
          const stats = await resp.json();
          renderUsageBar("SKU", stats.count || 0, info.max_skus, "件");
        }
      } catch {
        // 静默
      }
    }
  }

  function renderUsageBar(label, current, max, unit) {
    const topbar = document.querySelector(".topbar-fields");
    if (!topbar) return;
    let bar = document.getElementById("usageBar_" + label);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "usageBar_" + label;
      bar.style.cssText =
        "font-size:11px;color:#666;padding:2px 6px;border:1px solid #ddd;border-radius:4px;";
      topbar.appendChild(bar);
    }
    const pct = Math.min(100, Math.round((current / max) * 100));
    const color = pct >= 90 ? "#e74c3c" : pct >= 70 ? "#f39c12" : "#27ae60";
    bar.innerHTML =
      label + ": " +
      '<span style="color:' + color + ';font-weight:600;">' + current + "</span>" +
      " / " + max + unit +
      ' <span style="color:' + color + ';">(' + pct + "%)</span>";
  }

  // 暴露到全局，供 admin-core.js 初始化时调用
  window.loadLicenseBadge = loadLicenseBadge;
})();
