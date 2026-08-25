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

const apiBase = getApiBase();
let g_AdminEventsBound = false;
let sbAnonKeyInput = null;    // Supabase anon key input（在 bind() 中赋值）
let sbBaseUrlInput = null;    // Supabase base URL input（在 bind() 中赋值）

// ─── 认证管理（API Key + JWT 双模式）─────────────────────────
// API Key 模式：超管通过登录界面输入 ADMIN_API_KEY，存于 sessionStorage（页签关闭即失效）
// JWT 模式：租户管理员通过 register.html/login.html 登录获取 JWT；
//   默认存 sessionStorage（页签关闭即失效），勾选「保持登录」才存 localStorage（7 天有效）
// 优先级：JWT > API Key（JWT 用户自动登录，不需要再输入 API Key）
const ADMIN_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无操作自动登出（仅 API Key 模式）
let ADMIN_API_KEY = (function () {
  try { return sessionStorage.getItem("sq_admin_api_key") || ""; } catch (e) { return ""; }
})();
// JWT 令牌（默认 sessionStorage，勾选「保持登录」才存 localStorage；读取时 sessionStorage 优先）
let JWT_TOKEN = (function () {
  try { return sessionStorage.getItem("sq_jwt_token") || localStorage.getItem("sq_jwt_token") || ""; } catch (e) { return ""; }
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

function setJwtToken(token, keepLoggedIn) {
  JWT_TOKEN = token || "";
  try {
    if (token) {
      if (keepLoggedIn) {
        localStorage.setItem("sq_jwt_token", token);
        sessionStorage.removeItem("sq_jwt_token");
      } else {
        sessionStorage.setItem("sq_jwt_token", token);
        localStorage.removeItem("sq_jwt_token");
      }
    } else {
      sessionStorage.removeItem("sq_jwt_token");
      localStorage.removeItem("sq_jwt_token");
    }
  } catch (e) { }
}

// 获取当前认证 token
// 优先级：API Key（超管）> JWT（租户）
// 原因：admin 配置中心是管理界面，用户进入就是为了管理。
// 如果同时有 API Key 和 JWT，应使用 API Key（超管权限），
// 否则租户身份会被档位上限检查拦住（如分配 team 档位）。
function getAuthToken() {
  return ADMIN_API_KEY || JWT_TOKEN;
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
  return Boolean(JWT_TOKEN || ADMIN_API_KEY);
}

function logoutAdmin() {
  setAdminApiKey("");
  setJwtToken("");
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
      run(loadCompanies);
      // 加载会话面板（角色 + 档位 + 开发模式切换器）
      if (window.loadLicenseBadge) run(window.loadLicenseBadge);
    } else if (response.status === 429) {
      if (errDiv) { errDiv.textContent = "尝试次数过多，请 5 分钟后再试"; errDiv.style.display = "block"; }
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
  try { return sessionStorage.getItem("sq_admin_company_id") || localStorage.getItem("sq_admin_company_id") || "default"; } catch (e) { return "default"; }
})();

function getCurrentCompanyId() { return g_CurrentCompanyId || "default"; }

function setCurrentCompanyId(cid) {
  g_CurrentCompanyId = cid || "default";
  try {
    // 同时写 sessionStorage 与 localStorage，兼容会话级/持久化两种 JWT 模式
    sessionStorage.setItem("sq_admin_company_id", g_CurrentCompanyId);
    localStorage.setItem("sq_admin_company_id", g_CurrentCompanyId);
  } catch (e) { }
}

/** 给需要 company_id 的 API 路径追加参数 */
function withCompany(path) {
  var cid = getCurrentCompanyId();
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  if (/\/api\/(config|items|audit|quote|settings)/.test(path)) {
    return path + sep + "company_id=" + encodeURIComponent(cid);
  }
  return path;
}

// ─── 全局状态 ──────────────────────────────────────────────
// 用 var（非 const）使 window.state 可用——merger-app.js 等独立脚本
// 需要通过 window.state.config 读取配置中心编辑的配置
var state = {
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

/**
 * 订阅档位限制浮层（402/403 时弹）。
 *
 * 手机版上 topbar 的 setStatus 提示在页面下方操作时不可见，免费版用户点
 * 创建公司/发布/导入等按钮超限后只看到"没反应"。此浮层在屏幕底部弹出，
 * 带"查看订阅方案"入口，覆盖所有走 request 的按钮，统一提示升级。
 */
function showPlanBlockedHint(message) {
  var existing = document.getElementById("planBlockedToast");
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.id = "planBlockedToast";
  toast.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1200;" +
    "display:flex;align-items:center;gap:10px;max-width:92vw;padding:12px 16px;" +
    "border-radius:12px;background:linear-gradient(180deg,#fffdf8,#f7f3ec);" +
    "border:1px solid rgba(18,108,105,0.28);box-shadow:0 12px 32px -8px rgba(47,37,20,0.32);" +
    "font-size:12px;color:#1f2e38;line-height:1.4;";
  function mk(tag, text, cssText) {
    var n = document.createElement(tag);
    n.textContent = text; // textContent 自动转义，message 来自后端 detail
    n.style.cssText = cssText;
    return n;
  }
  var icon = mk("span", "🔒", "flex-shrink:0;font-size:16px;");
  var msg = mk("span", message || "当前订阅档位不支持此操作", "flex:1;min-width:0;");
  var link = mk("a", "查看订阅方案",
    "flex-shrink:0;padding:6px 14px;border-radius:999px;background:#126c69;color:#fff;" +
    "font-weight:600;font-size:11px;text-decoration:none;white-space:nowrap;");
  link.href = "billing.html";
  link.target = "_blank";
  var closeBtn = mk("button", "×",
    "flex-shrink:0;width:24px;height:24px;border:none;background:transparent;color:#5e6d78;font-size:18px;cursor:pointer;border-radius:50%;");
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.onclick = function () { toast.remove(); };
  toast.appendChild(icon);
  toast.appendChild(msg);
  toast.appendChild(link);
  toast.appendChild(closeBtn);
  document.body.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.remove(); }, 6000);
}

function setJsStatus(text) {
  const el = $("jsStatus");
  if (el) el.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

async function request(path, options) {
  if (!isAdminAuthenticated()) {
    showLoginOverlay();
    throw new Error("未登录，请输入 API Key 或通过登录页登录");
  }
  const headers = { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) };
  headers["Authorization"] = "Bearer " + getAuthToken();
  path = withCompany(path);
  const response = await fetch(apiBase + path, {
    headers: headers,
    ...options,
  });
  if (response.status === 401) {
    setAdminApiKey("");
    setJwtToken("");
    showLoginOverlay();
    throw new Error("认证失效，请重新登录");
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
    // 402（档位/配额超限）/403（功能未授权）：弹醒目升级浮层，
    // 避免手机版 topbar 提示被忽略导致"点了没反应"
    if (response.status === 402 || response.status === 403) {
      showPlanBlockedHint(data.detail);
    }
    throw err;
  }
  if (isAdminAuthenticated()) _resetSessionTimer();
  return data;
}

async function run(task) {
  try {
    await task();
  } catch (err) {
    // 402/403 已由 request → showPlanBlockedHint 提示，不重复打 topbar
    if (err && (err.status === 402 || err.status === 403)) return;
    setStatus(err.message, true);
  }
}

// ─── 默认配置模板 ──────────────────────────────────────────

function defaultConfig() {
  return {
    schema_version: 3,
    revision: new Date().toISOString().slice(0, 10),
    data_source: {
      base_url: "",
      version_file: "version.json",
      config_file: "config.json",
      price_bundle_file: "price.bundle.json",
      stock_bundle_file: "stock.bundle.json",
      cache_name: "quotation-cache-v3",
    },
    pricing: {
      currency: "CNY",
      decimal_places: 1,
      rounding: { mode: "ceil", integer_above: 100 },
      default_formula: "face_price * discount_percent / 100",
      tax_rate: 13,
      face_price_tax_inclusive: true,
      discount_step: { default: 1, min: 1, presets: [0.5, 1, 5] },
    },
    fields: [
      { key: "code", label: "代码", type: "text", source: "both", excel_aliases: ["代码", "货号", "物料编码", "编码", "物料长代码"], searchable: true, copyable: true, required: false, result_area: "identity" },
      { key: "spec", label: "型号", type: "text", source: "price", excel_aliases: ["规格型号", "规格", "型号", "产品型号"], searchable: true, copyable: true, required: false, result_area: "identity" },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价", "面价", "目录价", "含税单价", "单价"], searchable: false, copyable: false, required: false, result_area: "metric" },
      { key: "quote_price", label: "报价", type: "computed", source: "computed", excel_aliases: [], searchable: false, copyable: true, required: false, result_area: "metric" },
      { key: "special", label: "特价", type: "text", source: "price", excel_aliases: ["特价", "活动", "促销"], searchable: true, copyable: true, required: false, result_area: "chip" },
      { key: "stock", label: "库存", type: "text", source: "stock", excel_aliases: ["库存", "库存数量", "可用数量", "数量"], searchable: false, copyable: true, required: false, result_area: "chip" },
      { key: "remark", label: "备注", type: "text", source: "price", excel_aliases: ["补充说明", "备注", "说明"], searchable: true, copyable: true, required: false, result_area: "detail" },
      { key: "brand", label: "品牌", type: "text", source: "price", excel_aliases: ["品牌", "厂家"], searchable: false, copyable: false, required: false, result_area: "detail" },
      { key: "name", label: "名称", type: "text", source: "price", excel_aliases: ["名称", "品名", "类别"], searchable: false, copyable: false, required: false, result_area: "detail" },
      { key: "mnemonic", label: "助记码", type: "text", source: "price", excel_aliases: ["助记码", "简码"], searchable: false, copyable: false, required: false, result_area: "detail" },
      { key: "alias", label: "别名", type: "text", source: "price", excel_aliases: ["别名", "旧型号"], searchable: false, copyable: false, required: false, result_area: "detail" },
    ],
    rules: [
      { id: "MIS", label: "三菱", priority: 1, default: false, actions: [{ type: "set_discount", percent: 55 }], when: { all: [{ field: "name", op: "contains", value: "刀具" }] } },
      { id: "EX", label: "EX", priority: 2, default: false, actions: [{ type: "set_discount", percent: 32.5 }], when: { all: [{ field: "remark", op: "contains", value: "EX活动" }] } },
      { id: "OSG", label: "OSG", priority: 3, default: false, actions: [{ type: "set_discount", percent: 37 }], when: { all: [{ field: "spec", op: "contains", value: "OSG" }] } },
      { id: "CH", label: "长合", priority: 5, default: false, actions: [{ type: "set_discount", percent: 46 }], when: { all: [{ field: "code", op: "contains", value: "15.03." }] } },
      { id: "new_rule", label: "其他", priority: 100, default: true, actions: [{ type: "set_discount", percent: 55 }] },
    ],
    copy: {
      columns: [
        { field: "code", label: "代码", line: "main", default: true, prefix: "" },
        { field: "spec", label: "型号", line: "main", default: true, prefix: "" },
        { field: "quote_price", label: "报价", line: "main", default: true, prefix: "含税" },
        { field: "stock", label: "库存", line: "main", default: false, prefix: "" },
        { field: "special", label: "特价", line: "detail", default: false, prefix: "" },
        { field: "remark", label: "备注", line: "detail", default: false, prefix: "" },
      ],
      empty_value: "",
      price_prefix: "含税",
      line_template: "",
    },
    ui: {
      app_title: "智能询价系统",
      result_layout: {
        identity: ["spec"],
        metrics: ["face_price", "quote_price"],
        chips: [],
        details: [],
      },
    },
    integrations: {},
    version: "",
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
      query_placeholder: "请输入规格型号...支持多关键词",
      empty_hint: "支持规格、代码、助记码、别名、备注和特价关键词。",
      stock_prefix: "库存",
    },
    result_layout: {
      identity: ["code", "spec"],
      metrics: ["face_price", "quote_price"],
      chips: ["special", "stock"],
      details: ["remark"],
    },
    status: "draft",
  };
}

// 规范化从后端/Supabase/导入加载的 config，确保 admin 需要的数组/对象字段存在。
// 注意：不使用 ConfigCore.normalizeConfig，因为它面向前端报价台（discount_rules），
// admin 用的是 rules（when/actions 结构）。
function normalizeAdminConfig(raw) {
  var cfg = raw || {};
  // 确保数组字段存在
  if (!Array.isArray(cfg.fields)) cfg.fields = [];
  if (!Array.isArray(cfg.rules)) cfg.rules = [];
  // 确保 copy 对象及其 columns 数组存在
  if (!cfg.copy || typeof cfg.copy !== "object") cfg.copy = {};
  if (!Array.isArray(cfg.copy.columns)) cfg.copy.columns = [];
  // 确保其他对象字段存在
  if (!cfg.data_source || typeof cfg.data_source !== "object") cfg.data_source = {};
  if (!cfg.pricing || typeof cfg.pricing !== "object") cfg.pricing = {};
  if (!cfg.labels || typeof cfg.labels !== "object") cfg.labels = {};
  if (!cfg.result_layout || typeof cfg.result_layout !== "object") cfg.result_layout = {};
  if (!cfg.ui || typeof cfg.ui !== "object") cfg.ui = {};
  return cfg;
}
