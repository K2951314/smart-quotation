/**
 * admin-core.js — 管理后台核心：全局状态、认证、API 请求、工具函数。
 *
 * 这是 admin 前端的基础模块，必须在所有其他 admin 模块之前加载。
 * 声明了全局状态变量（apiBase、ADMIN_API_KEY、state）、认证逻辑、
 * API 请求封装（request）、通用工具函数（$、setStatus、escapeHtml、run）。
 */

// ─── 常量 ──────────────────────────────────────────────────

/**
 * 后端 API 地址动态探测。
 *
 * 优先级（从高到低）：
 *   1. window.SQ_PROD_API_BASE（Netlify Snippet injection 或构建期注入）
 *   2. URL 参数 ?api=URL（临时切换/测试用）
 *   3. localStorage.sq_admin_api_base（管理员手动持久化）
 *   4. file:// 协议 → 本地开发默认 http://127.0.0.1:8001
 *   5. localhost/127.0.0.1 → 同源（本地开发后端同源代理）
 *   6. 生产环境 → 同源（admin 与后端同域部署，最安全的默认）
 *
 * 安全策略：
 *   - 生产环境（非 localhost）禁止回退到 http:，强制 HTTPS（防止 API Key 明文传输）
 *   - 不硬编码任何真实后端域名，地址必须由部署方注入
 */
function getApiBase() {
  // 1. 构建期/运行期注入（window.SQ_PROD_API_BASE，Netlify Snippet injection 或构建工具替换）
  if (typeof window !== "undefined" && window.SQ_PROD_API_BASE) {
    return String(window.SQ_PROD_API_BASE).replace(/\/+$/, "");
  }
  // 2. URL 参数 ?api=URL 仅在本地开发环境生效，防止生产环境被 ?api=https://evil.com 劫持
  //    生产环境（Netlify 独立部署）应通过 Netlify Snippet injection 注入 window.SQ_PROD_API_BASE
  var isDev = location.protocol === "file:" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost";
  if (isDev) {
    var urlParam = new URLSearchParams(window.location.search).get("api");
    if (urlParam) return urlParam.replace(/\/+$/, "");
  }
  // 3. localStorage 持久化（管理员手动设置，跨会话生效）
  try {
    var stored = localStorage.getItem("sq_admin_api_base");
    if (stored) return stored.replace(/\/+$/, "");
  } catch (e) {}
  // 4. file:// 协议（本地直接打开 HTML 文件）
  if (location.protocol === "file:") return "http://127.0.0.1:8001";
  // 5. localhost / 127.0.0.1 → 同源（本地开发后端同源代理）
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    return window.location.origin;
  }
  // 6. 生产环境默认同源（admin 与后端部署在同一域名下最安全）
  return window.location.origin;
}

/**
 * 设置后端地址（持久化到 localStorage，跨会话生效）。
 * 传入空字符串或 null 清除自定义地址，回退到同源。
 */
function setApiBase(url) {
  try {
    if (url && url.trim()) {
      localStorage.setItem("sq_admin_api_base", url.trim().replace(/\/+$/, ""));
    } else {
      localStorage.removeItem("sq_admin_api_base");
    }
  } catch (e) {}
}

const apiBase = getApiBase();
let g_AdminEventsBound = false;
let sbAnonKeyInput = null;    // Supabase anon key input（在 bind() 中赋值）
let sbBaseUrlInput = null;    // Supabase base URL input（在 bind() 中赋值）

// ─── Admin API Key 管理（sessionStorage，不持久化）─────────
// 安全策略：API Key 不硬编码在源码中，通过登录界面输入，存于 sessionStorage。
// 页签关闭即失效，避免长期暴露。额外安全：30 分钟无操作自动登出。
const ADMIN_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟
let ADMIN_API_KEY = (function () {
  try { return sessionStorage.getItem("sq_admin_api_key") || ""; } catch (e) { return ""; }
})();
let _adminSessionTimer = null;

function setAdminApiKey(key) {
  ADMIN_API_KEY = key || "";
  try {
    if (key) {
      sessionStorage.setItem("sq_admin_api_key", key);
      _resetSessionTimer();
    } else {
      sessionStorage.removeItem("sq_admin_api_key");
      if (_adminSessionTimer) { clearTimeout(_adminSessionTimer); _adminSessionTimer = null; }
    }
  } catch (e) { }
}

function _resetSessionTimer() {
  if (_adminSessionTimer) clearTimeout(_adminSessionTimer);
  _adminSessionTimer = setTimeout(function () {
    setAdminApiKey("");
    showLoginOverlay();
    var errDiv = document.getElementById("loginError");
    if (errDiv) { errDiv.textContent = "会话超时，请重新登录"; errDiv.style.display = "block"; }
  }, ADMIN_SESSION_TIMEOUT_MS);
}

function isAdminAuthenticated() {
  return Boolean(ADMIN_API_KEY);
}

function logoutAdmin() {
  setAdminApiKey("");
  showLoginOverlay();
}

function showLoginOverlay() {
  var overlay = document.getElementById("loginOverlay");
  if (overlay) {
    overlay.style.display = "flex";
    var input = document.getElementById("loginApiKeyInput");
    if (input) { input.value = ""; input.focus(); }
    var err = document.getElementById("loginError");
    if (err) err.style.display = "none";
  }
}

function hideLoginOverlay() {
  var overlay = document.getElementById("loginOverlay");
  if (overlay) overlay.style.display = "none";
}

async function tryLogin() {
  var input = document.getElementById("loginApiKeyInput");
  var errDiv = document.getElementById("loginError");
  if (!input) return;
  var key = input.value.trim();
  if (!key) {
    if (errDiv) { errDiv.textContent = "请输入 API Key"; errDiv.style.display = "block"; }
    return;
  }
  try {
    var response = await fetch(apiBase + "/api/companies", {
      headers: { "Authorization": "Bearer " + key }
    });
    if (response.ok) {
      setAdminApiKey(key);
      hideLoginOverlay();
      if (typeof bind === "function") bind();
      if (typeof initApp === "function") initApp();
    } else if (response.status === 429) {
      if (errDiv) { errDiv.textContent = "尝试次数过多，请 5 分钟后再试（或清除 quotation.db 中的 security_events 表）"; errDiv.style.display = "block"; }
    } else if (response.status === 401) {
      if (errDiv) { errDiv.textContent = "API Key 无效，请检查后重试"; errDiv.style.display = "block"; }
    } else {
      if (errDiv) { errDiv.textContent = "登录失败（HTTP " + response.status + "）"; errDiv.style.display = "block"; }
    }
  } catch (err) {
    if (errDiv) { errDiv.textContent = "连接失败：" + err.message; errDiv.style.display = "block"; }
  }
}

// ─── 多租户：当前操作的公司 ID ───────────────────────────
let g_CurrentCompanyId = (function () {
  try { return localStorage.getItem("sq_admin_company_id") || "default"; } catch (e) { return "default"; }
})();

function getCurrentCompanyId() { return g_CurrentCompanyId || "default"; }

function setCurrentCompanyId(cid) {
  g_CurrentCompanyId = cid || "default";
  try { localStorage.setItem("sq_admin_company_id", g_CurrentCompanyId); } catch (e) { }
}

/** 给需要 company_id 的 API 路径追加参数 */
function withCompany(path) {
  var cid = getCurrentCompanyId();
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  if (/\/api\/(config|items|audit|quote)/.test(path)) {
    return path + sep + "company_id=" + encodeURIComponent(cid);
  }
  return path;
}

// ─── 全局状态 ──────────────────────────────────────────────
const state = {
  config: defaultConfig(),
  uploadedRows: null,
  uploadFilename: "",
  selectedUploadFile: null,
};

// ─── 工具函数 ──────────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, isError) {
  $("statusText").textContent = text;
  $("statusText").classList.toggle("danger", Boolean(isError));
}

function setJsStatus(text) {
  const el = $("jsStatus");
  if (el) el.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function parseListInput(str) {
  return (str || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function request(path, options) {
  if (!isAdminAuthenticated()) {
    showLoginOverlay();
    throw new Error("未登录，请输入 API Key");
  }
  const headers = { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) };
  headers["Authorization"] = "Bearer " + ADMIN_API_KEY;
  path = withCompany(path);
  const response = await fetch(apiBase + path, {
    headers: headers,
    ...options,
  });
  if (response.status === 401) {
    setAdminApiKey("");
    showLoginOverlay();
    throw new Error("API Key 无效或已过期，请重新登录");
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    if (!response.ok) throw new Error(`服务器返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
    throw new Error("服务器返回了非 JSON 格式的响应");
  }
  if (!response.ok) {
    const err = new Error(data.detail || response.statusText);
    err.status = response.status;
    throw err;
  }
  if (isAdminAuthenticated()) _resetSessionTimer();
  return data;
}

async function run(task) {
  try {
    await task();
  } catch (err) {
    setStatus(err.message, true);
  }
}

// ─── 默认配置模板 ──────────────────────────────────────────

function defaultConfig() {
  return {
    schema_version: 3,
    revision: new Date().toISOString().slice(0, 10) + ".1",
    version: "",
    data_source: {
      base_url: (typeof window !== "undefined" && window.SQ_SUPABASE_BASE_URL) || "",
      config_file: "config.json",
      price_bundle_file: "price.bundle.json",
      stock_bundle_file: "stock.bundle.json",
      version_file: "version.json",
      cache_name: "quotation-cache-v3",
    },
    pricing: {
      currency: "CNY",
      decimal_places: 1,
      discount_step: { default: 0.1, min: 0.1, presets: [0.1, 0.5, 1] },
      rounding: { mode: "ceil", integer_above: 100 },
      default_formula: "face_price * discount_percent / 100",
    },
    fields: [
      { key: "code", label: "代码", type: "text", source: "price", excel_aliases: ["代码", "物料编码"], searchable: true, copyable: true, required: false, result_area: "identity" },
      { key: "spec", label: "规格型号", type: "text", source: "price", excel_aliases: ["规格型号", "规格", "型号"], searchable: true, copyable: true, required: true, result_area: "identity" },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价", "面价"], searchable: false, copyable: false, required: false, result_area: "metric" },
      { key: "quote_price", label: "报价", type: "computed", source: "computed", excel_aliases: [], searchable: false, copyable: true, required: false, result_area: "metric" },
      { key: "special", label: "特价", type: "text", source: "price", excel_aliases: ["特价", "活动"], searchable: true, copyable: true, required: false, result_area: "chip" },
      { key: "stock", label: "库存", type: "text", source: "stock", excel_aliases: ["库存", "库存数量"], searchable: false, copyable: true, required: false, result_area: "chip" },
      { key: "remark", label: "备注", type: "text", source: "price", excel_aliases: ["备注", "说明"], searchable: true, copyable: true, required: false, result_area: "detail" },
      { key: "brand", label: "品牌", type: "text", source: "price", excel_aliases: ["品牌", "厂家"], searchable: true, copyable: false, required: false, result_area: "detail" },
      { key: "name", label: "名称", type: "text", source: "price", excel_aliases: ["名称", "品名"], searchable: true, copyable: false, required: false, result_area: "detail" },
      { key: "mnemonic", label: "助记码", type: "text", source: "price", excel_aliases: ["助记码", "简码"], searchable: true, copyable: false, required: false, result_area: "detail" },
      { key: "alias", label: "别名", type: "text", source: "price", excel_aliases: ["别名", "旧型号"], searchable: true, copyable: false, required: false, result_area: "detail" },
    ],
    rules: [
      { id: "ex_activity", label: "EX 活动", priority: 10, when: { all: [{ field: "special", op: "contains", value: "EX活动" }] }, actions: [{ type: "set_discount", percent: 55 }] },
      { id: "default", label: "默认折扣", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 55 }] },
    ],
    copy: {
      empty_value: "",
      price_prefix: "含税",
      line_template: "",
      columns: [
        { field: "code", label: "代码", default: true, line: "main" },
        { field: "spec", label: "规格", default: true, line: "main" },
        { field: "quote_price", label: "报价", default: true, line: "main", prefix: "含税" },
        { field: "special", label: "特价", default: false, line: "main" },
        { field: "stock", label: "库存", default: false, line: "main" },
        { field: "remark", label: "备注", default: false, line: "detail" },
      ],
    },
    ui: {
      app_title: "智能询价系统",
      result_layout: {
        identity: ["code", "spec"],
        metrics: ["face_price", "quote_price"],
        chips: ["special", "stock"],
        details: ["remark"],
      },
    },
    labels: {
      app_title: "智能询价系统",
      search_button: "智能查询",
      stock_search_button: "库存查询",
      mmc_button: "三菱库存",
      copy_button: "复制勾选",
      selected_label: "勾选",
      config_button: "配置",
      input_title: "输入",
      result_title: "结果",
      query_placeholder: "请输入规格型号...\n支持多关键词",
      empty_hint: "支持规格、代码、助记码、别名、备注和特价关键词。",
      stock_prefix: "库存 ",
    },
    integrations: {},
  };
}
