/**
 * session-panel.js — 会话信息 + 订阅档位 + 开发模式切换器 + 全局配额注入。
 *
 * 从 /api/auth/session 加载当前会话状态，在 topbar 右侧显示：
 * - 角色徽标（超管 / 租户 / 开发模式）
 * - 订阅档位徽标（免费版 / 个人版 / 专业版）
 * - 开发模式 tier 切换器（仅 SQ_DEV=1 时显示，弹出式面板）
 *
 * 全局配额注入：
 * - 加载成功后把 session.quota 写入 window.SQ_QUOTA
 * - 供 event-bindings.js / config-render.js 等模块做前置阻断
 *   （如 addRuleBtn 点击时检查 max_brands，不让用户超限添加）
 *
 * 设计原则：
 * - 所有认证用户都能看到自己的角色和档位（不只是超管）
 * - 开发模式下可一键切换 free/pro/team 档位，无需重启后端
 * - 加载失败静默降级，不阻塞配置中心正常使用
 * - 配额阻断在 UI 层（前置），后端层（兜底）双重保险
 */
(function () {
  "use strict";

  var TIER_LABELS = {
    free: "免费版",
    pro: "个人版",
    team: "专业版",
  };

  var TIER_COLORS = {
    free: "#95a5a6",
    pro: "#3498db",
    team: "#9b59b6",
  };

  var ROLE_LABELS = {
    superadmin: "超管",
    tenant: "租户",
    dev: "开发模式",
  };

  var ROLE_COLORS = {
    superadmin: "#e74c3c",
    tenant: "#27ae60",
    dev: "#f39c12",
  };

  // 默认配额（未知 license 时兜底，最严格）
  var DEFAULT_QUOTA = {
    max_companies: 1,
    max_users: 1,
    max_skus: 500,
    max_brands: 2,
    max_config_revisions: 3,
    stock_query_daily_limit: 0,
    audit_log_days: 7,
    watermark: true,
  };

  /**
   * 加载会话信息并渲染面板 + 注入全局配额。
   */
  async function loadLicenseBadge() {
    var apiBase = (window.getApiBase && window.getApiBase()) || "";
    var token = (window.getAuthToken && window.getAuthToken()) || "";
    if (!token) return; // 未登录，跳过

    var session;
    try {
      var resp = await fetch(apiBase + "/api/auth/session", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) return;
      session = await resp.json();
    } catch {
      return; // 网络错误，静默跳过
    }

    if (!session) return;

    // ── 注入全局配额（供 event-bindings.js 做前置阻断）──
    window.SQ_QUOTA = session.quota || DEFAULT_QUOTA;
    window.SQ_SESSION = session;

    renderSessionPanel(session);
    refreshQuotaIndicators();
    applyFeatureGating();
  }

  /**
   * 渲染会话面板到 topbar 右侧（退出按钮之前）。
   */
  function renderSessionPanel(session) {
    // topbar 的 actions 区域
    var actions = document.querySelector(".top-actions");
    if (!actions) {
      // 兜底：如果没有 topbar actions，回退到 brand 区
      renderToBrand(session);
      return;
    }

    // 移除旧面板
    var old = document.getElementById("sessionPanel");
    if (old) old.remove();

    var panel = document.createElement("div");
    panel.id = "sessionPanel";
    panel.className = "session-panel";

    // ── 角色徽标 ──
    var roleLabel = ROLE_LABELS[session.role] || session.role;
    var roleColor = ROLE_COLORS[session.role] || "#95a5a6";
    var roleBadge = document.createElement("span");
    roleBadge.className = "session-badge session-role";
    roleBadge.style.background = roleColor;
    roleBadge.textContent = roleLabel;
    if (session.role === "dev") {
      roleBadge.title = "开发模式：认证校验已放宽，仅限本地开发";
    } else if (session.role === "superadmin") {
      roleBadge.title = "超级管理员：通过 Admin API Key 登录，全平台权限";
    } else if (session.role === "tenant") {
      roleBadge.title = "租户用户：" + (session.email || "?");
    }
    panel.appendChild(roleBadge);

    // 租户用户显示邮箱
    if (session.role === "tenant" && session.email) {
      var emailSpan = document.createElement("span");
      emailSpan.className = "session-email";
      emailSpan.textContent = session.email;
      emailSpan.title = session.email;
      panel.appendChild(emailSpan);
    }

    // ── 订阅档位徽标（可点击跳转 billing）──
    var tier = session.tier || "free";
    var tierLabel = TIER_LABELS[tier] || tier;
    var tierColor = TIER_COLORS[tier] || "#95a5a6";
    var tierBadge = document.createElement("a");
    tierBadge.className = "session-badge session-tier";
    tierBadge.style.background = tierColor;
    tierBadge.href = "billing.html";
    tierBadge.target = "_blank";
    tierBadge.title = "当前订阅：" + tierLabel + "（点击查看订阅方案详情）";
    tierBadge.textContent = "◈ " + tierLabel;
    panel.appendChild(tierBadge);

    // ── 开发模式标记 + tier 切换器 ──
    if (session.is_dev) {
      var devSwitcher = createDevTierSwitcher(session);
      panel.appendChild(devSwitcher);
    }

    // 插入到 secondary-actions 之前（primary-actions 之后）
    var secondary = actions.querySelector(".secondary-actions");
    if (secondary) {
      actions.insertBefore(panel, secondary);
    } else {
      actions.appendChild(panel);
    }
  }

  /**
   * 兜底渲染到 brand 区（无 topbar 时）。
   */
  function renderToBrand(session) {
    var brand = document.querySelector(".brand");
    if (!brand) return;

    var old = document.getElementById("sessionPanel");
    if (old) old.remove();

    var panel = document.createElement("div");
    panel.id = "sessionPanel";
    panel.className = "session-panel session-panel--compact";
    brand.appendChild(panel);

    var tier = session.tier || "free";
    var tierLabel = TIER_LABELS[tier] || tier;
    var tierColor = TIER_COLORS[tier] || "#95a5a6";
    var tierBadge = document.createElement("span");
    tierBadge.className = "session-badge session-tier";
    tierBadge.style.background = tierColor;
    tierBadge.textContent = "◈ " + tierLabel;
    panel.appendChild(tierBadge);

    if (session.is_dev) {
      var devSwitcher = createDevTierSwitcher(session);
      panel.appendChild(devSwitcher);
    }
  }

  /**
   * 创建开发模式 tier 切换器（下拉菜单式）。
   */
  function createDevTierSwitcher(session) {
    var wrapper = document.createElement("div");
    wrapper.className = "dev-tier-switcher";

    var currentOverride = session.dev_tier_override;
    var currentLabel = currentOverride
      ? TIER_LABELS[currentOverride] + " (测试)"
      : TIER_LABELS[session.tier || "free"];

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dev-tier-trigger";
    btn.innerHTML = '<span class="dev-tier-icon">🔧</span>' +
      '<span class="dev-tier-label">' + currentLabel + '</span>' +
      '<span class="dev-tier-arrow">▾</span>';
    btn.title = "开发模式：切换订阅档位测试功能门控和配额限制";

    var menu = document.createElement("div");
    menu.className = "dev-tier-menu";
    menu.style.display = "none";

    var tiers = [
      { key: "free", label: "免费版", desc: "500 SKU / 2 规则 / 有水印" },
      { key: "pro", label: "个人版", desc: "5000 SKU / 不限规则 / 无水印" },
      { key: "team", label: "专业版", desc: "不限 / 全功能" },
      { key: null, label: "清除覆盖", desc: "恢复默认 license 档位" },
    ];

    tiers.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "dev-tier-item";
      var isActive = currentOverride === t.key ||
        (t.key === null && !currentOverride);
      if (isActive) item.classList.add("active");

      var nameEl = document.createElement("div");
      nameEl.className = "dev-tier-item-name";
      nameEl.textContent = t.label;
      item.appendChild(nameEl);

      var descEl = document.createElement("div");
      descEl.className = "dev-tier-item-desc";
      descEl.textContent = t.desc;
      item.appendChild(descEl);

      item.onclick = function () {
        menu.style.display = "none";
        if (!isActive) switchDevTier(t.key);
      };
      menu.appendChild(item);
    });

    btn.onclick = function (e) {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
    };

    // 点击外部关闭菜单
    document.addEventListener("click", function () {
      menu.style.display = "none";
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    return wrapper;
  }

  /**
   * 切换开发模式 tier 覆盖。
   */
  async function switchDevTier(tier) {
    var apiBase = (window.getApiBase && window.getApiBase()) || "";
    var token = (window.getAuthToken && window.getAuthToken()) || "";
    if (!token) return;

    try {
      var resp = await fetch(apiBase + "/api/dev/set-tier", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ tier: tier }),
      });
      if (!resp.ok) {
        var data = await resp.json().catch(function () { return {}; });
        throw new Error(data.detail || "HTTP " + resp.status);
      }
      var result = await resp.json();
      // 重新加载面板 + 配额
      await loadLicenseBadge();
      // 刷新所有配额指示器
      refreshQuotaIndicators();
      if (window.setStatus) {
        window.setStatus(result.message || "档位已切换", false);
      }
    } catch (err) {
      if (window.setStatus) {
        window.setStatus("切换档位失败: " + err.message, true);
      } else {
        alert("切换档位失败: " + err.message);
      }
    }
  }

  /**
   * 根据订阅档位功能列表，显示/隐藏带 data-feature 属性的 UI 元素。
   *
   * 工作原理：
   * - 遍历所有 [data-feature] 元素
   * - 如果元素的 data-feature 值不在 session.features 列表中，
   *   则隐藏该元素（display:none）或禁用（disabled + 提示）
   * - 档位切换后重新调用，会恢复显示
   *
   * 当前门控的 UI 元素：
   * - data-feature="audit_log"：审计日志导航链接 + 审计日志区块
   * - data-feature="bundle_encryption"：价格包密码输入框
   * - data-feature="stock_query"：库存查询入口（如有）
   * - data-feature="supabase_deploy"：Supabase 部署按钮（如有）
   */
  function applyFeatureGating() {
    var session = window.SQ_SESSION;
    var features = (session && session.features) || [];
    var isDev = session && session.is_dev;

    var gated = document.querySelectorAll("[data-feature]");
    gated.forEach(function (el) {
      var feat = el.getAttribute("data-feature");
      var has = features.indexOf(feat) >= 0 || isDev;
      if (has) {
        // 恢复显示（档位切换后从隐藏恢复）
        el.style.display = "";
        el.classList.remove("feature-locked");
        // 恢复 input/button
        var inputs = el.querySelectorAll("input, button, select");
        inputs.forEach(function (inp) {
          inp.disabled = false;
          inp.removeAttribute("data-locked-by-tier");
        });
      } else {
        // 隐藏或禁用
        el.style.display = "none";
        el.classList.add("feature-locked");
        // 标记被锁定的 input
        var lockedInputs = el.querySelectorAll("input, button, select");
        lockedInputs.forEach(function (inp) {
          inp.disabled = true;
          inp.setAttribute("data-locked-by-tier", feat);
        });
      }
    });
  }

  /**
   * 刷新所有配额指示器（规则计数器、SKU 计数器等）。
   * 在档位切换后 + 页面加载后调用。
   */
  function refreshQuotaIndicators() {
    var quota = window.SQ_QUOTA;
    if (!quota) return;

    // state 是 admin-core.js 中的全局 const，不在 window 上
    // 用 typeof 安全检查
    var cfg = (typeof state !== "undefined" && state && state.config) ? state.config : {};

    // 规则计数器
    var rules = cfg.rules || [];
    updateQuotaCounter("ruleQuota", rules.length, quota.max_brands, "规则");
    updateAddButton("addRuleBtn", rules.length, quota.max_brands);

    // 字段计数器（license 无 max_fields，不加阻断，但可显示数量）
    var fields = cfg.fields || [];
    updateQuotaCounter("fieldQuota", fields.length, -1, "字段");
  }

  /**
   * 更新配额计数器 DOM。
   * count: 当前数量, max: 上限（-1 = 不限）
   */
  function updateQuotaCounter(id, count, max, label) {
    var el = document.getElementById(id);
    if (!el) return;
    if (max < 0) {
      el.textContent = label + "：" + count + " / 不限";
      el.className = "quota-counter quota-unlimited";
    } else {
      el.textContent = label + "：" + count + " / " + max;
      el.className = "quota-counter" +
        (count >= max ? " quota-exceeded" : count >= max * 0.8 ? " quota-warning" : "");
    }
  }

  /**
   * 根据配额禁用/启用"添加"按钮。
   */
  function updateAddButton(btnId, count, max) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    if (max >= 0 && count >= max) {
      btn.disabled = true;
      btn.classList.add("btn-quota-exceeded");
      btn.title = "已达当前订阅上限（" + max + "），请升级订阅或删除多余项";
    } else {
      btn.disabled = false;
      btn.classList.remove("btn-quota-exceeded");
      btn.title = "";
    }
  }

  // 暴露到全局
  window.loadLicenseBadge = loadLicenseBadge;
  window.switchDevTier = switchDevTier;
  window.refreshQuotaIndicators = refreshQuotaIndicators;
  window.applyFeatureGating = applyFeatureGating;
  window.hasFeature = function (feat) {
    var session = window.SQ_SESSION;
    if (!session) return false;
    if (session.is_dev) return true; // 开发模式全功能
    var features = session.features || [];
    return features.indexOf(feat) >= 0;
  };
})();
