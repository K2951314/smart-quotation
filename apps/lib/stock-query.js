/**
 * stock-query.js — 三菱库存查询 + 公司令牌/company_id 管理。
 *
 * 依赖：state.js, config-helpers.js, search-render.js, copy-clipboard.js
 *
 * 此模块包含后端地址探测、访问令牌管理（getCompanyToken/getCompanyId/getStockQueryKey），
 * 以及三菱库存查询流程（doMitsubishiStockQuery）。
 */

// ─── 后端地址探测 ──────────────────────────────────────────

function _isDevOrigin() {
  return location.protocol === "file:" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost";
}

function getApiBase() {
  var hardcoded = (typeof _readHardcodedProdApi === "function") ? _readHardcodedProdApi() : "";
  if (hardcoded) {
    return hardcoded.replace(/\/+$/, "");
  }
  // ?api= URL 参数仅在本地开发环境生效，防止生产环境被 ?api=https://evil.com 劫持
  // 生产环境（Netlify 独立部署）应通过 Netlify Snippet injection 注入 window.SQ_PROD_API_BASE
  if (_isDevOrigin()) {
    var urlParam = new URLSearchParams(window.location.search).get("api");
    if (urlParam) return urlParam.replace(/\/+$/, "");
  }
  if (location.protocol === "file:") return "http://127.0.0.1:8001";
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") return window.location.origin;
  return localStorage.getItem("sq_api_base") || window.location.origin;
}

// ─── 凭证存储路由 ──────────────────────────────────────────
// 登录持久化（ADR-005 方案B）：
// - sq_keep_login !== "0"（默认保持登录）→ 凭证写 localStorage，跨会话免输链接；
// - sq_keep_login === "0"（公用电脑）→ 凭证只写 sessionStorage，页签关闭即失效。
// 写入时同步清除另一个存储的同键，防止双存储分裂出两份不同凭证。

function _authWrite(key, val) {
  var keep = true;
  try { keep = localStorage.getItem("sq_keep_login") !== "0"; } catch (e) {}
  if (keep) {
    try { localStorage.setItem(key, val); } catch (e) {}
    try { sessionStorage.removeItem(key); } catch (e) {}
  } else {
    try { sessionStorage.setItem(key, val); } catch (e) {}
    try { localStorage.removeItem(key); } catch (e) {}
  }
}

function _authRead(key) {
  var val = null;
  try { val = localStorage.getItem(key); } catch (e) {}
  if (val) return val;
  try { val = sessionStorage.getItem(key); } catch (e) { val = null; }
  return val;
}

function _authClear(key) {
  try { localStorage.removeItem(key); } catch (e) {}
  try { sessionStorage.removeItem(key); } catch (e) {}
}

// 双清所有登录凭证并刷新页面（退出登录 / 链接失效出口）。
function clearAllAuth() {
  _authClear("sq_company_token");
  _authClear("sq_stock_key");
  _authClear(AUTH_STORAGE_KEY);
  _authClear("sq_company_id");
  try { localStorage.removeItem("sq_keep_login"); } catch (e) {}
  try { sessionStorage.removeItem("sq_keep_login"); } catch (e) {}
  g_AuthProfile = null;
  location.reload();
}

// ─── 公司访问令牌（token）──────────────────────────────────
// 安全策略：
// - 凭证存储位置由 _authWrite 按 sq_keep_login 路由（默认 localStorage 持久化）。
// - 链接即凭证：URL 携带的 token 一律强制写 localStorage（忽略 sq_keep_login）。
// - 首次传递优先使用 URL fragment（#token=xxx），因为 fragment 不会发送到服务器。
// - 向后端传输只用 X-Company-Token 头，不走 URL query（防日志泄露）。

function getCompanyToken() {
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var hashToken = hashParams.get("token");
  if (hashToken) {
    var token = hashToken.trim();
    if (token) {
      // 链接即凭证：URL 进入一律强制持久化到 localStorage（忽略 sq_keep_login）
      try { localStorage.setItem("sq_company_token", token); } catch (e) {}
      try { sessionStorage.removeItem("sq_company_token"); } catch (e) {}
      _stripTokenFromUrl();
      return token;
    }
  }
  var urlParam = new URLSearchParams(window.location.search).get("token");
  if (urlParam) {
    var token = urlParam.trim();
    if (token) {
      try { localStorage.setItem("sq_company_token", token); } catch (e) {}
      try { sessionStorage.removeItem("sq_company_token"); } catch (e) {}
      _stripTokenFromUrl();
      return token;
    }
  }
  var stored = _authRead("sq_company_token");
  if (stored) return stored.trim();
  if (window.__COMPANY_PROFILE__ && window.__COMPANY_PROFILE__.token) {
    return window.__COMPANY_PROFILE__.token;
  }
  return "";
}

function _stripTokenFromUrl() {
  try {
    var url = new URL(window.location.href);
    url.searchParams.delete("token");
    url.searchParams.delete("stockkey");
    if (url.hash) {
      var hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      hashParams.delete("token");
      hashParams.delete("stockkey");
      var remaining = hashParams.toString();
      url.hash = remaining ? "#" + remaining : "";
    }
    window.history.replaceState({}, document.title, url.toString());
  } catch (e) {
    var href = window.location.href;
    href = href.replace(/[?&]token=[^&]*/, function(match, offset) {
      return match.charAt(0) === "?" ? (offset === href.length - match.length ? "" : "?") : "";
    });
    href = href.replace(/[?&]stockkey=[^&]*/, function(match, offset) {
      return match.charAt(0) === "?" ? (offset === href.length - match.length ? "" : "?") : "";
    });
    href = href.replace(/#token=[^&]*/, "");
    href = href.replace(/&token=[^&]*/, "");
    href = href.replace(/#stockkey=[^&]*/, "");
    href = href.replace(/&stockkey=[^&]*/, "");
    window.history.replaceState({}, document.title, href);
  }
}

// withToken 已废弃。token 统一通过 X-Company-Token 头传输。
// 保留函数签名仅为向后兼容，不再向 URL 追加 token。
function withToken(url) {
  return url;
}

function withAuthHeaders(extra) {
  var headers = extra || {};
  var token = getCompanyToken();
  if (token) {
    headers["X-Company-Token"] = token;
  }
  return headers;
}

function isBackendUrl(url) {
  if (!url) return false;
  var isSameOrigin = url.indexOf("/") === 0 || url.indexOf(window.location.origin) === 0;
  var apiBase = getApiBase();
  var isApiUrl = apiBase && url.indexOf(apiBase) === 0;
  return isSameOrigin || isApiUrl;
}

function getStockQueryKey() {
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var hashKey = hashParams.get("stockkey");
  if (hashKey) {
    var key = hashKey.trim();
    if (key) {
      // 链接即凭证：强制持久化（同 getCompanyToken）
      try { localStorage.setItem("sq_stock_key", key); } catch (e) {}
      try { sessionStorage.removeItem("sq_stock_key"); } catch (e) {}
      _stripTokenFromUrl();
      return key;
    }
  }
  var urlKey = new URLSearchParams(window.location.search).get("stockkey");
  if (urlKey) {
    var key = urlKey.trim();
    if (key) {
      try { localStorage.setItem("sq_stock_key", key); } catch (e) {}
      try { sessionStorage.removeItem("sq_stock_key"); } catch (e) {}
      _stripTokenFromUrl();
      return key;
    }
  }
  var stored = _authRead("sq_stock_key");
  if (stored) return stored.trim();
  return "";
}

// ─── 多租户 company_id ──────────────────────────────────────

function getCompanyId() {
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var hashId = hashParams.get("company_id");
  if (hashId) {
    var cid = hashId.trim();
    if (cid) {
      try { localStorage.setItem("sq_company_id", cid); } catch (e) {}
      return cid;
    }
  }
  var urlParam = new URLSearchParams(window.location.search).get("company_id");
  if (urlParam) {
    var cid = urlParam.trim();
    if (cid) {
      try { localStorage.setItem("sq_company_id", cid); } catch (e) {}
      return cid;
    }
  }
  var stored = localStorage.getItem("sq_company_id");
  if (stored) return stored.trim();
  if (window.__COMPANY_PROFILE__ && window.__COMPANY_PROFILE__.companyId) {
    return window.__COMPANY_PROFILE__.companyId;
  }
  return "default";
}

// ─── 三菱库存查询 ──────────────────────────────────────────

function parseStockResultLine(text) {
  var result = { shanghai: 0, japan: 0, error: null };
  if (!text) { result.error = "无响应"; return result; }
  var shMatch = text.match(/上海库存(\d+)/);
  if (shMatch) result.shanghai = parseInt(shMatch[1], 10);
  var jpMatch = text.match(/日本库存(\d+)/);
  if (jpMatch) result.japan = parseInt(jpMatch[1], 10);
  var hasStock = (result.shanghai > 0 || result.japan > 0);
  if (!hasStock && !/上海库存|日本库存/.test(text) && !/无货/.test(text)) {
    var errMatch = text.match(/[：:]\s*(.+)$/);
    result.error = errMatch ? errMatch[1] : text;
  }
  return result;
}

async function doMitsubishiStockQuery() {
  var selected = g_Results.filter(function (row) { return row.checked; });
  if (selected.length === 0) { showToast("请先勾选需要查询库存的规格"); return; }
  var total = selected.length;

  var queryText = selected.map(function (row) {
    return (row.spec || "").trim();
  }).filter(Boolean).join("\n");

  if (!queryText) { showToast("选中的规格为空"); return; }

  var mmcBtn = document.getElementById("btnMmc");
  var setBtnText = function (text) {
    if (mmcBtn) { mmcBtn.textContent = text; }
  };

  if (mmcBtn) {
    if (!mmcBtn.dataset.defaultText) mmcBtn.dataset.defaultText = mmcBtn.textContent || "三菱库存";
    setBtnText("正在连接...");
    mmcBtn.disabled = true;
    mmcBtn.classList.add("btn-loading");
  }

  selected.forEach(function (row) { updateCardStock(row, 'loading'); });

  try {
    var apiBase = getApiBase();
    setBtnText("查询 " + total + " 项...");
    // 带上公司令牌：后端接受 X-Company-Token 作为库存查询认证（已登录用户无需单独 stock-key）
    var reqHeaders = Object.assign({ "Content-Type": "application/json" }, withAuthHeaders());
    var stockKey = getStockQueryKey();
    if (stockKey) reqHeaders["X-Stock-Key"] = stockKey;
    var resp = await fetch(apiBase + "/api/stock-query", {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ queries: queryText }),
    });

    if (!resp.ok) {
      var errHint = resp.status === 401 ? "（未授权：请登录或填写库存查询密钥）" : "";
      showToast("库存服务异常: " + resp.status + errHint);
      selected.forEach(function (row) { updateCardStock(row, null); });
      setBtnText(mmcBtn ? mmcBtn.dataset.defaultText : "三菱库存");
      if (mmcBtn) { mmcBtn.disabled = false; mmcBtn.classList.remove("btn-loading"); }
      return;
    }

    var data = await resp.json();
    var rawResults = data.results || [];
    var parsed = rawResults.map(function (line) {
      return parseStockResultLine(line);
    });

    var errorCount = 0;
    var doneCount = 0;
    var updateNext = function () {
      if (doneCount >= selected.length) return;
      var idx = doneCount;
      doneCount++;
      setBtnText("已完成 " + doneCount + "/" + total);
      if (idx < parsed.length) {
        var r = parsed[idx];
        if (r.error) errorCount++;
        updateCardStock(selected[idx], r.error ? "error" : "data", r);
      }
      if (doneCount < selected.length) {
        setTimeout(updateNext, 80);
      } else {
        var lines = [];
        selected.forEach(function (row, i) {
          var r = i < parsed.length ? parsed[i] : null;
          var out = buildStockClipboardLine(row, r);
          if (out) lines.push(out);
        });
        var toastMsg = "已复制 " + lines.length + " 条库存信息";
        if (errorCount > 0) toastMsg += "（" + errorCount + " 条失败）";
        copyToClipboard(lines.join("\n") + "\n");
        showToast(toastMsg);
        setBtnText(mmcBtn ? mmcBtn.dataset.defaultText : "三菱库存");
        if (mmcBtn) { mmcBtn.disabled = false; mmcBtn.classList.remove("btn-loading"); }
      }
    };
    updateNext();

  } catch (err) {
    showToast("库存查询失败，请检查服务是否运行 (127.0.0.1:8001)");
    selected.forEach(function (row) { updateCardStock(row, null); });
    setBtnText(mmcBtn ? mmcBtn.dataset.defaultText : "三菱库存");
    if (mmcBtn) { mmcBtn.disabled = false; mmcBtn.classList.remove("btn-loading"); }
  }
}

function buildStockClipboardLine(row, stockResult) {
  if (!row) return null;
  var columns = getCopyColumns();
  var enabled = {};
  columns.forEach(function (col) {
    var cbId = makeCopyCheckboxId(col.field);
    var cb = document.getElementById(cbId);
    enabled[col.field] = cb ? cb.checked : !!col.default;
  });

  var useUntaxed = (document.getElementById("chkUntaxedQuote")?.checked) ?? false;
  var settings = getCurrentPriceSettings();
  var decimals = settings.decimals;
  var factor = Math.pow(10, decimals);

  var mainParts = [];
  var detailParts = [];

  columns.forEach(function (col) {
    if (!enabled[col.field]) return;
    var prop = fieldToRowProp(col.field);
    var lineGroup = col.line || "main";

    if (prop === "price") {
      var rawPrice = parseFloat(row.price) || 0;
      var formatted = (decimals === 0 && rawPrice > (settings.threshold || 100))
        ? rawPrice.toFixed(0)
        : rawPrice.toFixed(decimals);
      var priceStr = (useUntaxed ? "未税" : "含税") + formatted;
      if (lineGroup === "detail") {
        detailParts.push((col.label || "") + " " + priceStr);
      } else {
        mainParts.push(priceStr);
      }
    } else {
      var val = row[prop];
      if (val == null || val === "") return;
      if (lineGroup === "detail") {
        detailParts.push(val);
      } else {
        mainParts.push(val);
      }
    }
  });

  var stockStr = "";
  if (!stockResult) {
    stockStr = "查询失败(无结果)";
  } else if (stockResult.error) {
    stockStr = "查询失败(" + stockResult.error + ")";
  } else {
    var stockParts = [];
    if (stockResult.shanghai > 0) stockParts.push("上海" + stockResult.shanghai);
    if (stockResult.japan > 0) stockParts.push("日本" + stockResult.japan);
    stockStr = stockParts.length > 0 ? stockParts.join(" ") : "厂家无货";
  }
  mainParts.push(stockStr);

  var resultLines = [];
  resultLines.push(mainParts.join(" "));
  for (var i = 0; i < detailParts.length; i++) {
    resultLines.push(detailParts[i]);
  }
  return resultLines.join("\n");
}

function updateCardStock(row, state, result) {
  if (!row || row.id === undefined) return;
  var stockEl = document.querySelector('[data-stock-id="' + row.id + '"]');
  if (!stockEl) {
    var card = document.querySelector('[data-row-id="' + row.id + '"]');
    if (card) {
      stockEl = card.querySelector('[data-stock-id="' + row.id + '"]');
    }
  }
  if (!stockEl) return;

  if (state === null) {
    stockEl.innerHTML = "";
    stockEl.style.display = "none";
  } else if (state === "loading") {
    stockEl.innerHTML = '<span class="stock-signal stock-loading">等待查询</span>';
    stockEl.style.display = "";
  } else if (state === "error") {
    stockEl.innerHTML = '<span class="stock-signal stock-live-data stock-error">查询失败</span>';
    stockEl.style.display = "";
  } else if (state === "data" && result) {
    var parts = [];
    if (result.shanghai > 0) parts.push("上海" + result.shanghai);
    if (result.japan > 0) parts.push("日本" + result.japan);
    if (parts.length > 0) {
      stockEl.innerHTML = '<span class="stock-signal stock-live-data">' + parts.join(" · ") + '</span>';
    } else {
      stockEl.innerHTML = '<span class="stock-signal stock-live-data stock-zero">厂家无货</span>';
    }
    stockEl.style.display = "";
  }
}
