/**
 * state.js — 全局状态变量、常量、Sentry 初始化、错误处理。
 *
 * 这是 apps 前端的基础模块，必须在所有其他模块之前加载。
 * 声明了所有全局状态变量和常量，供其他模块共享。
 */

// ─── 数据状态 ──────────────────────────────────────────────
let PRICE_DATA = { bySpec: {} };
let STOCK_DATA = { byCode: {} };
let PRICE_ROWS = [];
let STOCK_ROWS = [];
let PRICE_META = null;
let STOCK_META = null;
let DB = {};
let g_Results = [];
let g_DataReady = false;
let g_DataLoadingPromise = null;

// ─── UI 状态 ──────────────────────────────────────────────
let g_ToastTimer = null;
let g_DiscountPressState = null;
let g_LayoutMetricsFrame = null;

// ─── 配置状态 ──────────────────────────────────────────────
let g_AppConfig = null;
let g_RuntimeConfigCache = null;
let g_RuntimeConfigDiscountFingerprint = null;
let g_SearchIndex = null;
let g_RemoteDefaultDiscountConfig = null;
let g_HasLocalDefaultDiscountConfig = false;
let g_DefaultDiscountConfig = null;  // 在 discount-config.js 中初始化
let g_RemoteDiscountRules = null;
let g_AuthProfile = null;

// ─── 常量 ──────────────────────────────────────────────────
const APP_BUILD_TAG = "v6-2026-07-14-sentry";
console.log("app.js", APP_BUILD_TAG, "loaded");

var HARDCODED_PROD_API = "";
const HOLD_START_DELAY_MS = 280;
const HOLD_REPEAT_INTERVAL_MS = 70;
const DEFAULT_DISCOUNT_STORAGE_KEY = "v9-default-discount-config";
const AUTH_STORAGE_KEY = "sq-auth-profile";
const SUPABASE_BASE_URL = (typeof window !== "undefined" && window.SQ_SUPABASE_BASE_URL) || "";

// ─── Sentry 前端错误监控 ──────────────────────────────────
// 通过 window.SQ_SENTRY_DSN 注入 DSN；未设置时不加载 Sentry。
(function initFrontendSentry() {
  var dsn = (typeof window !== "undefined" && window.SQ_SENTRY_DSN) || "";
  if (!dsn) return;
  var script = document.createElement("script");
  script.src = "https://browser.sentry-cdn.com/7.118.0/bundle.min.js";
  script.crossOrigin = "anonymous";
  script.onload = function () {
    if (typeof Sentry !== "undefined") {
      Sentry.init({
        dsn: dsn,
        environment: window.SQ_SENTRY_ENVIRONMENT || "production",
        release: "smart-quotation-frontend@" + APP_BUILD_TAG,
        tracesSampleRate: 0.1,
        sendDefaultPii: false,
      });
      console.log("[sentry] 前端错误监控已初始化");
    }
  };
  document.head.appendChild(script);
})();

// ─── 全局错误捕获 ──────────────────────────────────────────
window.addEventListener("error", (event) => {
  const msg = event?.message || "未知错误";
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `JS 错误：${msg}`;
    status.className = "status-badge danger";
  }
});

// ─── DiscountEngine（回退实现，优先使用 window.DiscountUtils）───
const DiscountEngine = window.DiscountUtils || {
  DEFAULT_DISCOUNT_CONFIG: Object.freeze({ other: 55 }),
  FALLBACK_DISCOUNT_CONFIG: Object.freeze({ other: 55 }),
  DEFAULT_STEP_PERCENT: 0.1,
  normalizePercent(value, fallback) {
    const num = Number(value);
    const safe = Number.isFinite(num) ? num : Number(fallback);
    const base = Number.isFinite(safe) ? safe : 55;
    return Math.min(100, Math.max(0, Math.round(base * 100) / 100));
  },
  sanitizeStepPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0.1;
    return Math.max(0.1, Math.round(num * 100) / 100);
  },
  sanitizeDiscountConfig(config, fallbackConfig) {
    var source = config || {};
    var fb = fallbackConfig || this.FALLBACK_DISCOUNT_CONFIG;
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.sanitizeDiscountConfig(source, fb);
    }
    var allKeys = {};
    Object.keys(fb).forEach(function (k) { allKeys[k] = true; });
    Object.keys(source).forEach(function (k) { allKeys[k] = true; });
    var out = {};
    Object.keys(allKeys).forEach(function (key) {
      var fallback = (fb[key] !== undefined) ? fb[key] : 55;
      out[key] = this.normalizePercent(source[key], fallback);
    }, this);
    return out;
  },
  buildDiscountConfigFromRules(rules, fallbackConfig) {
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.buildDiscountConfigFromRules(rules, fallbackConfig);
    }
    return this.FALLBACK_DISCOUNT_CONFIG;
  },
  getDiscountCategory(item, rules) {
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.getDiscountCategory(item, rules);
    }
    return "other";
  },
  getDefaultDiscountPreset(item, config, rules) {
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.getDefaultDiscountPreset(item, config, rules);
    }
    const normalized = this.sanitizeDiscountConfig(config);
    const category = this.getDiscountCategory(item, rules);
    const percent = normalized[category] !== undefined ? normalized[category] : 55;
    return { percent: percent, source: category, category: category, label: category + " " + this.formatDiscountPercent(percent) };
  },
  formatDiscountPercent(value) {
    const normalized = this.normalizePercent(value, 55);
    return normalized.toFixed(2).replace(/\.?0+$/, "") + "%";
  },
  shiftDiscountPercent(currentPercent, stepPercent, direction) {
    const current = this.normalizePercent(currentPercent, 55);
    const step = Number.isFinite(Number(stepPercent)) && Number(stepPercent) > 0 ? Math.max(0.1, Number(stepPercent)) : 0.1;
    const dir = Number(direction) < 0 ? -1 : 1;
    const next = current + step * dir;
    return Math.min(100, Math.max(0, Math.round(next * 100) / 100));
  }
};

// ─── ResultSortEngine（回退实现，优先使用 window.ResultSort）───
const ResultSortEngine = window.ResultSort || {
  sortResultsBySelection(results) {
    if (!Array.isArray(results)) return [];
    return results
      .map((row, index) => ({
        row,
        checked: !!(row && row.checked),
        orderIndex: Number.isFinite(Number(row && row.orderIndex)) ? Number(row.orderIndex) : (Number.isFinite(Number(row && row.id)) ? Number(row.id) : index)
      }))
      .sort((left, right) => {
        if (left.checked !== right.checked) return left.checked ? -1 : 1;
        return left.orderIndex - right.orderIndex;
      })
      .map((entry) => entry.row);
  }
};

// ─── 默认字段配置（配置未定义时的回退）──────────────────
const DEFAULT_FIELDS = {
  "c":     { label: "代码",   source: "data" },
  "spec":  { label: "规格型号", source: "key" },
  "p":     { label: "面价",   source: "data" },
  "price": { label: "报价",   source: "computed" },
  "s":     { label: "特价",   source: "data" },
  "i":     { label: "库存",   source: "data" },
  "r":     { label: "备注",   source: "data" },
  "b":     { label: "品牌",   source: "data" },
  "n":     { label: "名称",   source: "data" },
  "m":     { label: "助记码", source: "data" },
  "a":     { label: "别名",   source: "data" }
};

const DEFAULT_COPY_COLUMNS = [
  { field: "c",     id: "chk_code",    label: "代码", default: true },
  { field: "spec",  id: "chk_spec",    label: "规格", default: true },
  { field: "price", id: "chk_price",   label: "报价", default: true },
  { field: "s",     id: "chk_special", label: "特价", default: false },
  { field: "i",     id: "chk_stock",   label: "库存", default: false },
  { field: "r",     id: "chk_remark",  label: "备注", default: false }
];

// 初始化默认折扣配置（ DiscountEngine 已定义）
g_DefaultDiscountConfig = DiscountEngine.sanitizeDiscountConfig(DiscountEngine.DEFAULT_DISCOUNT_CONFIG);
