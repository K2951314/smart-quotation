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

      // 修改密码入口（仅 JWT 租户用户；超管 API Key 无"用户密码"概念）
      panel.appendChild(createChangePasswordButton());
    }

    // ── 订阅档位徽标（可点击跳转 billing）──
    // 账号级订阅带到期时间：显示剩余天数，7 天内变橙提醒
    var tier = session.plan || session.tier || "free";
    var tierLabel = TIER_LABELS[tier] || tier;
    var tierColor = TIER_COLORS[tier] || "#95a5a6";
    var expiresInfo = "";
    if (session.plan_expires_at) {
      try {
        var expDate = new Date(session.plan_expires_at);
        if (!isNaN(expDate.getTime())) {
          var daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
          if (daysLeft < 0) {
            expiresInfo = "（已过期）";
          } else {
            expiresInfo = "（剩 " + daysLeft + " 天）";
            if (daysLeft <= 7) {
              tierColor = "#e67e22"; // 临期提醒
            }
          }
        }
      } catch (e) { /* 忽略解析失败 */ }
    }
    var tierBadge = document.createElement("a");
    tierBadge.className = "session-badge session-tier";
    tierBadge.style.background = tierColor;
    tierBadge.href = "billing.html";
    tierBadge.target = "_blank";
    tierBadge.title = "当前订阅：" + tierLabel + expiresInfo + "（点击查看订阅方案详情）";
    tierBadge.textContent = "◈ " + tierLabel + expiresInfo;
    panel.appendChild(tierBadge);

    // ── 开发模式标记 + tier 切换器 ──
    // 仅平台侧角色可见（租户点击也用不了，纯属干扰）：
    // - 开发模式（SQ_DEV=1）+ 超管/dev：dev tier 切换器（调 /api/dev/set-tier）
    // - 超管（非 dev）：档位预览切换器（调 /api/admin/preview-tier）
    var isPlatformSide = session.role === "superadmin" || session.role === "dev";
    if (session.is_dev && isPlatformSide) {
      var devSwitcher = createDevTierSwitcher(session);
      panel.appendChild(devSwitcher);
    } else if (session.role === "superadmin") {
      var previewSwitcher = createPreviewTierSwitcher(session);
      if (previewSwitcher) panel.appendChild(previewSwitcher);
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

    var tier = session.plan || session.tier || "free";
    var tierLabel = TIER_LABELS[tier] || tier;
    var tierColor = TIER_COLORS[tier] || "#95a5a6";
    var tierBadge = document.createElement("span");
    tierBadge.className = "session-badge session-tier";
    tierBadge.style.background = tierColor;
    tierBadge.textContent = "◈ " + tierLabel;
    panel.appendChild(tierBadge);

    if (session.is_dev && (session.role === "superadmin" || session.role === "dev")) {
      var devSwitcher = createDevTierSwitcher(session);
      panel.appendChild(devSwitcher);
    } else if (session.role === "superadmin") {
      var previewSwitcher = createPreviewTierSwitcher(session);
      if (previewSwitcher) panel.appendChild(previewSwitcher);
    }
  }

  // ── 修改密码（仅 JWT 租户用户）──────────────────────────

  /**
   * 读取 JWT token（sessionStorage 优先，localStorage 兜底）。
   * 与 users.js readToken 一致：新标签页 sessionStorage 快照缺失时回退。
   */
  function readJwtToken() {
    try {
      return sessionStorage.getItem("sq_jwt_token") ||
             localStorage.getItem("sq_jwt_token") || "";
    } catch (e) { return ""; }
  }

  /**
   * 创建"修改密码"按钮。样式对齐 session-email（var(--muted) 灰字），
   * hover 加下划线提示可点击——不用 session-badge（白字需要背景色）。
   * 超管（API Key 登录）不显示——API Key 来自环境变量，无用户密码可改。
   */
  function createChangePasswordButton() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session-email session-chgpw";
    btn.textContent = "修改密码";
    btn.title = "修改当前账号的登录密码";
    btn.style.cssText =
      "border:none;background:none;cursor:pointer;font:inherit;" +
      "font-size:11px;color:var(--muted,#6b7280);padding:3px 2px;flex-shrink:0;";
    btn.onmouseenter = function () {
      btn.style.textDecoration = "underline";
    };
    btn.onmouseleave = function () {
      btn.style.textDecoration = "none";
    };
    btn.onclick = function () { openChangePasswordModal(); };
    return btn;
  }

  /**
   * 修改密码弹窗。样式内联——session-panel.js 被多个页面共用，
   * 不能假设页面里已有弹窗 CSS。
   */
  function openChangePasswordModal() {
    var root = document.getElementById("sqChgpwModalRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "sqChgpwModalRoot";
      document.body.appendChild(root);
    }
    root.innerHTML = "";

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;" +
      "display:flex;align-items:center;justify-content:center;";

    var card = document.createElement("div");
    card.style.cssText =
      "background:#fff;border-radius:12px;padding:28px;width:360px;max-width:90vw;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:inherit;";

    var title = document.createElement("h3");
    title.textContent = "修改密码";
    title.style.cssText = "margin:0 0 6px;font-size:18px;color:#1a1a2e;";
    card.appendChild(title);

    var subtitle = document.createElement("p");
    subtitle.textContent = "为账号设置新的登录密码（至少 8 位）";
    subtitle.style.cssText = "margin:0 0 4px;font-size:13px;color:#6b7280;";
    card.appendChild(subtitle);

    function field(labelText, placeholder) {
      var label = document.createElement("label");
      label.textContent = labelText;
      label.style.cssText =
        "display:block;font-size:13px;font-weight:500;color:#374151;margin:10px 0 4px;";
      var input = document.createElement("input");
      input.type = "password";
      input.placeholder = placeholder;
      input.autocomplete = "new-password";
      input.style.cssText =
        "width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:8px;" +
        "font-size:14px;box-sizing:border-box;";
      label.appendChild(input);
      card.appendChild(label);
      return input;
    }

    var oldInput = field("旧密码", "输入当前密码");
    var newInput = field("新密码", "至少 8 位");
    var confirmInput = field("确认新密码", "再次输入新密码");

    var errEl = document.createElement("div");
    errEl.style.cssText = "color:#dc2626;font-size:13px;margin-top:10px;min-height:18px;";
    card.appendChild(errEl);

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;margin-top:14px;";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText =
      "flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;" +
      "cursor:pointer;font-size:14px;";
    cancelBtn.onclick = function () { root.innerHTML = ""; };

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.textContent = "确认修改";
    submitBtn.style.cssText =
      "flex:1;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:#fff;" +
      "cursor:pointer;font-size:14px;font-weight:600;";
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    root.appendChild(overlay);

    // 点遮罩关闭（点卡片本身不关）
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) root.innerHTML = "";
    });

    submitBtn.onclick = async function () {
      var oldPassword = oldInput.value;
      var newPassword = newInput.value;
      errEl.style.color = "#dc2626";
      errEl.textContent = "";
      if (!oldPassword) { errEl.textContent = "请输入旧密码"; return; }
      if (newPassword.length < 8) { errEl.textContent = "新密码至少 8 位"; return; }
      if (newPassword !== confirmInput.value) { errEl.textContent = "两次输入的新密码不一致"; return; }

      var apiBase = (window.getApiBase && window.getApiBase()) || "";
      var token = readJwtToken();
      if (!token) { errEl.textContent = "登录状态已失效，请重新登录"; return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "提交中...";
      try {
        var resp = await fetch(apiBase + "/api/auth/change-password", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
        });
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.detail || "HTTP " + resp.status);
        errEl.style.color = "#059669";
        errEl.textContent = "密码已修改";
        submitBtn.textContent = "已完成";
        setTimeout(function () { root.innerHTML = ""; }, 1500);
      } catch (err) {
        errEl.textContent = err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = "确认修改";
      }
    };
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
      : TIER_LABELS[session.plan || session.tier || "free"];

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
   * 创建超管档位预览切换器（下拉菜单式）。
   * 与 dev tier switcher 的区别：调 /api/admin/preview-tier，不要求 SQ_DEV=1。
   */
  function createPreviewTierSwitcher(session) {
    var wrapper = document.createElement("div");
    wrapper.className = "dev-tier-switcher";

    var currentPreview = session.preview_plan;
    var currentLabel = currentPreview
      ? TIER_LABELS[currentPreview] + " (预览)"
      : TIER_LABELS[session.plan || session.tier || "free"];

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dev-tier-trigger";
    btn.innerHTML = '<span class="dev-tier-icon">👁</span>' +
      '<span class="dev-tier-label">' + currentLabel + '</span>' +
      '<span class="dev-tier-arrow">▾</span>';
    btn.title = "超管档位预览：预览不同档位的功能门控和配额（不影响真实 license）";

    var menu = document.createElement("div");
    menu.className = "dev-tier-menu";
    menu.style.display = "none";

    var tiers = [
      { key: "free", label: "免费版", desc: "500 SKU / 2 规则 / 有水印" },
      { key: "pro", label: "个人版", desc: "5000 SKU / 不限规则 / 无水印" },
      { key: "team", label: "专业版", desc: "不限 / 全功能" },
      { key: null, label: "恢复真实档位", desc: "取消预览，用真实 license 档位" },
    ];

    tiers.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "dev-tier-item";
      var isActive = currentPreview === t.key ||
        (t.key === null && !currentPreview);
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
        if (!isActive) switchPreviewTier(t.key);
      };
      menu.appendChild(item);
    });

    btn.onclick = function (e) {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
    };

    document.addEventListener("click", function () {
      menu.style.display = "none";
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    return wrapper;
  }

  /**
   * 切换超管档位预览。
   */
  async function switchPreviewTier(tier) {
    var apiBase = (window.getApiBase && window.getApiBase()) || "";
    var token = (window.getAuthToken && window.getAuthToken()) || "";
    if (!token) return;

    try {
      var resp = await fetch(apiBase + "/api/admin/preview-tier", {
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
      refreshQuotaIndicators();
      if (window.setStatus) {
        window.setStatus(result.message || "档位预览已切换", false);
      }
    } catch (err) {
      if (window.setStatus) {
        window.setStatus("切换档位预览失败: " + err.message, true);
      } else {
        alert("切换档位预览失败: " + err.message);
      }
    }
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
    var isSuperadmin = session && session.role === "superadmin";

    // 平台级操作（用户管理）仅平台侧角色可见——
    // 注意用 role 判断而非 session.is_dev：is_dev 是部署级开关（SQ_DEV=1 时
    // 租户的 session 里也是 true），用它会让租户在开发部署下看到超管按钮。
    var isPlatformRole = session.role === "superadmin" || session.role === "dev";
    document.querySelectorAll("[data-superadmin-only]").forEach(function (el) {
      el.style.display = isPlatformRole ? "" : "none";
    });

    var gated = document.querySelectorAll("[data-feature]");
    gated.forEach(function (el) {
      var feat = el.getAttribute("data-feature");
      var has = features.indexOf(feat) >= 0 || isDev || isSuperadmin;
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
  window.switchPreviewTier = switchPreviewTier;
  window.refreshQuotaIndicators = refreshQuotaIndicators;
  window.applyFeatureGating = applyFeatureGating;
  window.hasFeature = function (feat) {
    var session = window.SQ_SESSION;
    if (!session) return false;
    // 开发模式 + 超管角色 → 全功能（平台管理员不受订阅档位限制）
    if (session.is_dev) return true;
    if (session.role === "superadmin") return true;
    var features = session.features || [];
    return features.indexOf(feat) >= 0;
  };
})();
