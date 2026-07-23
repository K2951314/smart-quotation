/**
 * auth.js — 认证网关、公司 profile、公司模式定价补丁。
 *
 * 依赖：state.js, config-helpers.js, discount-config.js, search-render.js
 *
 * 重要：此模块对 search-render.js 中的 appendResultRow 和 calcDiscountedPrice
 * 执行 monkey-patch，为公司模式注入利润率/税务逻辑。因此必须在 search-render.js 之后加载。
 */

// ─── 认证 Profile ──────────────────────────────────────────

function getAuthProfile() {
  if (window.__COMPANY_PROFILE__) return window.__COMPANY_PROFILE__;
  if (g_AuthProfile) return g_AuthProfile;
  try {
    const raw = _authRead(AUTH_STORAGE_KEY);
    if (raw) g_AuthProfile = JSON.parse(raw);
  } catch (e) {}
  return g_AuthProfile;
}

function saveAuthProfile(profile) {
  g_AuthProfile = profile;
  try { _authWrite(AUTH_STORAGE_KEY, JSON.stringify(profile)); } catch (e) {}
}

function clearAuthProfile() {
  g_AuthProfile = null;
  _authClear(AUTH_STORAGE_KEY);
}

function isCompanyMode() {
  const p = getAuthProfile();
  return p && (p.role === "company" || p.role === "stock_only");
}

// stock_only 角色：仅能查库存，不能看任何价格信息
function isStockOnlyMode() {
  const p = getAuthProfile();
  return p && p.role === "stock_only";
}

function applyCompanyMode(profile) {
  if (profile && (profile.role === "company" || profile.role === "stock_only")) {
    document.body.classList.add("is-company");
    var badge = document.getElementById("userBadge");
    var text = document.getElementById("userBadgeText");
    if (badge) badge.style.display = "";
    if (text) {
      if (profile.role === "stock_only") {
        text.textContent = "📦 库存查询模式（不显示价格）";
      } else {
        text.textContent = "🏢 " + (profile.companyName || "公司账号") + " | 利润率 " + (profile.profitMargin !== undefined ? profile.profitMargin : 10) + "% 税率 " + (profile.taxRate !== undefined ? profile.taxRate : 13) + "%";
      }
    }
  }
}

function applyAdminMode() {
  document.body.classList.remove("is-company");
}

// ─── 认证网关 ──────────────────────────────────────────────

function initAuthGate() {
  var gate = document.getElementById("authGate");
  if (!gate) return true;

  var forceAuth = new URLSearchParams(location.search).get("test_auth") === "1";

  // 本地开发模式：直接放行
  if (!forceAuth && (location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
    gate.style.display = "none";
    return true;
  }

  // 生产模式：检查 company_id + token
  var companyId = getCompanyId();
  var token = getCompanyToken();
  var stockKey = getStockQueryKey();
  var hasCompany = companyId && companyId !== "default";
  var hasToken = Boolean(token);

  if ((hasCompany && hasToken) || stockKey) {
    gate.style.display = "none";
    return true;
  }

  // 缺少必要凭证：显示 authGate
  gate.style.display = "flex";
  var linkInput = document.getElementById("authGateLink");
  var companyInput = document.getElementById("authGateCompanyId");
  var tokenInput = document.getElementById("authGateToken");
  var keyInput = document.getElementById("authGateStockKey");
  var enterBtn = document.getElementById("btnAuthGateEnter");

  if (companyInput && companyId && companyId !== "default") {
    companyInput.value = companyId;
  }

  function parsePastedLink(raw) {
    if (!raw) return null;
    var text = raw.trim();
    var params = {};
    var hashIdx = text.indexOf("#");
    if (hashIdx >= 0) {
      var hashParams = new URLSearchParams(text.substring(hashIdx + 1));
      ["company_id", "token", "stockkey"].forEach(function(k) {
        var v = hashParams.get(k);
        if (v) params[k] = v;
      });
    }
    var queryIdx = text.indexOf("?");
    if (queryIdx >= 0) {
      var queryParams = new URLSearchParams(text.substring(queryIdx + 1, hashIdx >= 0 ? hashIdx : undefined));
      ["company_id", "token", "stockkey"].forEach(function(k) {
        if (!params[k]) {
          var v = queryParams.get(k);
          if (v) params[k] = v;
        }
      });
    }
    if (!params.company_id && !params.token) {
      var parts = text.split(/[,\s&]+/);
      parts.forEach(function(part) {
        var eq = part.indexOf("=");
        if (eq > 0) {
          var key = part.substring(0, eq).replace(/^#/, "").replace(/^\?/, "");
          var val = part.substring(eq + 1);
          if (["company_id", "token", "stockkey"].indexOf(key) >= 0 && val) {
            params[key] = val;
          }
        }
      });
    }
    return params;
  }

  if (enterBtn) {
    enterBtn.onclick = function () {
      var linkText = linkInput ? linkInput.value.trim() : "";
      var parsed = parsePastedLink(linkText);
      var cid = "", tk = "", sk = "";
      if (parsed && (parsed.company_id || parsed.token || parsed.stockkey)) {
        cid = parsed.company_id || "";
        tk = parsed.token || "";
        sk = parsed.stockkey || "";
      } else {
        cid = (companyInput && companyInput.value || "").trim();
        tk = (tokenInput && tokenInput.value || "").trim();
        sk = (keyInput && keyInput.value || "").trim();
      }
      // 保持登录偏好必须先于 _authWrite 写入（_authWrite 读它路由存储位置）。
      // 复选框 DOM 缺失时视为勾选（默认保持登录）。
      var keepCb = document.getElementById("authGateKeepLogin");
      var keepLogin = keepCb ? !!keepCb.checked : true;
      try { localStorage.setItem("sq_keep_login", keepLogin ? "1" : "0"); } catch (e) {}
      if (cid) {
        try { localStorage.setItem("sq_company_id", cid); } catch (e) {}
      }
      if (tk && !cid) {
        // 例外：无 company_id 的 admin token 永远只写 sessionStorage（admin 见未脱敏数据）
        try { sessionStorage.setItem("sq_company_token", tk); } catch (e) {}
        try { localStorage.removeItem("sq_company_token"); } catch (e) {}
      } else if (tk) {
        _authWrite("sq_company_token", tk);
      }
      if (sk) {
        _authWrite("sq_stock_key", sk);
      }
      gate.style.display = "none";
      location.reload();
    };
  }
  if (linkInput) {
    linkInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter" && !e.shiftKey && enterBtn) { e.preventDefault(); enterBtn.click(); }
    });
  }
  if (keyInput) {
    keyInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter" && enterBtn) enterBtn.click();
    });
  }
  if (tokenInput) {
    tokenInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter" && keyInput) keyInput.focus();
    });
  }
  if (companyInput) {
    companyInput.addEventListener("keypress", function (e) {
      if (e.key === "Enter" && tokenInput) tokenInput.focus();
    });
  }
  return false;
}

function bindAuthEvents() {
  var untaxedChk = document.getElementById("chkUntaxedQuote");
  if (untaxedChk) {
    untaxedChk.addEventListener("change", function () {
      if (isCompanyMode()) refreshAllCompanyPrices();
      else refreshRenderedPrices();
    });
  }
  var roundingSel = document.getElementById("roundingMethod");
  if (roundingSel) {
    roundingSel.addEventListener("change", function () {
      if (isCompanyMode()) refreshAllCompanyPrices();
      else refreshRenderedPrices();
    });
  }
  // 退出登录：JS 绑定而非内联 onclick（生产 CSP script-src 无 'unsafe-inline'，内联会被阻断）
  var logoutBtn = document.getElementById("btnLogout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () { clearAllAuth(); });
  }
}

// ─── 公司模式补丁：appendResultRow ────────────────────────
// 公司模式下，将折扣面板替换为利润率面板

var _origAppendResultRow = appendResultRow;
appendResultRow = function (resultList, matchKey, item, shouldCheck, isExact, runtimeConfig) {
  if (isCompanyMode()) {
    if (!runtimeConfig) runtimeConfig = getRuntimeAppConfig();
    _origAppendResultRow(resultList, matchKey, item, shouldCheck, isExact, runtimeConfig);
    var lastCard = resultList.lastElementChild;
    if (lastCard) {
      var panel = lastCard.querySelector(".discount-panel");
      if (panel) {
        var stepper = panel.querySelector(".discount-stepper");
        var rowId = parseInt(stepper?.getAttribute("data-id") || "0");
        var row = getRowById(rowId);
        var defaultProfit = getCompanyProfitMargin();
        if (row) {
          row.profitMargin = row.profitMargin !== undefined ? row.profitMargin : defaultProfit;
        }
        var input = panel.querySelector(".discount-manual");
        if (input) {
          input.value = formatCompactNumber(row ? row.profitMargin : defaultProfit);
          input.step = "0.5";
          input.min = "0";
          input.max = "100";
          input.setAttribute("data-profit-id", String(rowId));
        }
      }
    }
    return;
  }
  _origAppendResultRow(resultList, matchKey, item, shouldCheck, isExact, runtimeConfig);
};

// ─── 公司模式补丁：calcDiscountedPrice ────────────────────
// 公司模式下，在折扣价基础上叠加利润率和税务

function getCompanyProfitMargin(row) {
  if (row && row.profitMargin !== undefined) return row.profitMargin;
  var profile = getAuthProfile();
  return (profile && profile.profitMargin !== undefined) ? profile.profitMargin : 0;
}

function refreshAllCompanyPrices() {
  if (!g_Results || !g_Results.length) return;
  g_Results.forEach(function (row) {
    if (!row) return;
    if (row.profitMargin === undefined) {
      row.profitMargin = getCompanyProfitMargin();
    }
    refreshRowPrice(row, false);
  });
}

var _origCalcDiscountedPrice = calcDiscountedPrice;
calcDiscountedPrice = function (facePrice, discount, decimals, threshold) {
  if (isCompanyMode()) {
    var profit = getCompanyProfitMargin();
    var tax = getTaxRate();
    var useUntaxed = document.getElementById("chkUntaxedQuote")?.checked ?? false;
    var factor = Math.pow(10, decimals);
    var method = getRoundingMethod();
    var base = calculateBaseDiscountedPrice(facePrice, discount, decimals, threshold);
    var withProfit = applyRounding(base.value * (1 + profit / 100), factor, method);
    return calculateDisplayedPrice(withProfit, { decimals: decimals, threshold: threshold }, useUntaxed, tax);
  }
  var base = _origCalcDiscountedPrice(facePrice, discount, decimals, threshold);
  return base;
};

// ─── 加载公司 profile（从后端获取利润率）──────────────────

async function loadCompanyProfile(companyId) {
  try {
    var apiBase = getApiBase();
    var url = apiBase + "/api/public/company/" + encodeURIComponent(companyId);
    url = withToken(url);
    var resp = await fetch(url, { cache: "no-store", headers: withAuthHeaders() });
    if (resp.status === 401) {
      // token 已轮换/失效：清空本地凭证并提示重新索取链接（token 轮换出口）
      console.warn("[authGate] 公司链接已失效（401），请重新向管理员索取");
      alert("链接失效请重新索取");
      clearAllAuth();
      return false;
    }
    if (resp.ok) {
      var profile = await resp.json();
      // 后端根据 meta.is_admin 返回 role；admin 角色看完整数据，company 角色看脱敏数据
      var role = profile.role === "admin" ? "admin" : "company";
      saveAuthProfile({
        role: role,
        companyName: profile.name,
        profitMargin: profile.profit_margin,
      });
      if (role === "company") {
        applyCompanyMode(getAuthProfile());
      } else {
        applyAdminMode();
      }
      console.log("[authGate] 已加载公司 profile:", profile.name, "角色", role, "利润率", profile.profit_margin + "%");
      return true;
    }
  } catch (err) {
    console.warn("[authGate] 获取公司 profile 失败:", err);
  }
  return false;
}
