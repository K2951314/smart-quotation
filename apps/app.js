let PRICE_DATA = { bySpec: {} };
let STOCK_DATA = { byCode: {} };
let PRICE_ROWS = [];
let STOCK_ROWS = [];
let PRICE_META = null;
let STOCK_META = null;
let DB = {};
let g_Results =[];
let g_DataReady = false;
let g_DataLoadingPromise = null;
let g_ToastTimer = null;
let g_DiscountPressState = null;
let g_RemoteDefaultDiscountConfig = null;
let g_HasLocalDefaultDiscountConfig = false;
let g_LayoutMetricsFrame = null;
const APP_BUILD_TAG = "v4-2026-06-18-13:48";
console.log("app.js", APP_BUILD_TAG, "loaded");
var HARDCODED_PROD_API = "https://mitsubishi-stock.up.railway.app";
let g_AppConfig = null;
let g_RuntimeConfigCache = null;
let g_RuntimeConfigDiscountFingerprint = null;
let g_SearchIndex = null;

const HOLD_START_DELAY_MS = 280;
const HOLD_REPEAT_INTERVAL_MS = 70;
const DEFAULT_DISCOUNT_STORAGE_KEY = "v9-default-discount-config";


window.addEventListener("error", (event) => {
  const msg = event?.message || "未知错误";
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `JS 错误：${msg}`;
    status.className = "status-badge danger";
  }
});

const DiscountEngine = window.DiscountUtils || {
  DEFAULT_DISCOUNT_CONFIG: Object.freeze({ ex: 32, osg: 36, mitsubishi: 55, other: 55 }),
  FALLBACK_DISCOUNT_CONFIG: Object.freeze({ ex: 32, osg: 36, mitsubishi: 55, other: 55 }),
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
    // 向后兼容：无 fallbackConfig 时用旧逻辑
    var source = config || {};
    var fb = fallbackConfig || this.FALLBACK_DISCOUNT_CONFIG;
    // 如果 window.DiscountUtils 可用，委托给它（支持动态键）
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.sanitizeDiscountConfig(source, fb);
    }
    return {
      ex: this.normalizePercent(source.ex, fb.ex || 32),
      osg: this.normalizePercent(source.osg, fb.osg || 36),
      mitsubishi: this.normalizePercent(source.mitsubishi, fb.mitsubishi || 55),
      other: this.normalizePercent(source.other, fb.other || 55)
    };
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
    const source = item || {};
    const compact = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
    const brandAndSpec = [source.brand, source.spec].filter(Boolean).join(" ");
    const name = String(source.name || source.n || "").trim();
    if (compact(source.special).includes("EX活动")) return "ex";
    if (/OSG/i.test(brandAndSpec)) return "osg";
    if (name === "刀具") return "mitsubishi";
    return "other";
  },
  getDefaultDiscountPreset(item, config, rules) {
    if (window.DiscountUtils && window.DiscountUtils !== this) {
      return window.DiscountUtils.getDefaultDiscountPreset(item, config, rules);
    }
    const normalized = this.sanitizeDiscountConfig(config);
    const category = this.getDiscountCategory(item);
    if (category === "ex") return { percent: normalized.ex, source: "ex-activity", category, label: "EX活动 " + this.formatDiscountPercent(normalized.ex) };
    if (category === "osg") return { percent: normalized.osg, source: "osg", category, label: "OSG " + this.formatDiscountPercent(normalized.osg) };
    if (category === "mitsubishi") return { percent: normalized.mitsubishi, source: "mitsubishi", category, label: "三菱 " + this.formatDiscountPercent(normalized.mitsubishi) };
    return { percent: normalized.other, source: "fallback", category, label: "其他 " + this.formatDiscountPercent(normalized.other) };
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

// ================== 字段配置化（Phase 1） ==================
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

function getFieldConfig() {
  const cfg = getAppConfig();
  const fields = {};
  (cfg.fields || []).forEach((field) => { fields[field.key] = field; });
  const copyColumns = (cfg.copy && cfg.copy.columns) || DEFAULT_COPY_COLUMNS;
  const copyPrefix = (cfg.copy && cfg.copy.price_prefix) || "含税";
  const stockPrefix = (cfg.labels && cfg.labels.stock_prefix) || "库存 ";
  return { fields, copyColumns, copyPrefix, stockPrefix };
}

function getFieldLabel(key) {
  const normalizedKey = normalizeFieldKey(key);
  if (window.ConfigCore) {
    const cfg = getAppConfig();
    const fields = cfg.fields || [];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].key === normalizedKey) return fields[i].label || normalizedKey;
    }
    return normalizedKey;
  }
  const { fields } = getFieldConfig();
  return (fields[normalizedKey] && fields[normalizedKey].label) || normalizedKey;
}

function getCopyColumns() {
  return getFieldConfig().copyColumns;
}
// ================== 字段配置化（Phase 1）结束 ==================

function normalizeFieldKey(key) {
  const map = { c: "code", p: "face_price", s: "special", i: "stock", r: "remark", b: "brand", n: "name", m: "mnemonic", a: "alias", price: "quote_price" };
  return map[key] || key;
}

function getAppConfig() {
  if (!window.ConfigCore) return window.APP_CONFIG || {};
  if (!g_AppConfig) g_AppConfig = window.ConfigCore.normalizeConfig(window.APP_CONFIG || {});
  return g_AppConfig;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function getRuntimeAppConfig() {
  if (!window.ConfigCore) return getAppConfig();
  const overrides = getDefaultDiscountConfig();
  // 动态 fingerprint：包含所有折扣键
  const keys = Object.keys(overrides).sort();
  const fingerprint = keys.map(function(k) { return k + "=" + overrides[k]; }).join("|");
  if (g_RuntimeConfigCache && fingerprint === g_RuntimeConfigDiscountFingerprint) return g_RuntimeConfigCache;
  const cfg = cloneConfig(getAppConfig());
  // 动态映射：从 discount_rules 的 id → percent 覆盖
  cfg.discount_rules = (cfg.discount_rules || []).map(function(rule) {
    var id = String(rule.id || "").toLowerCase();
    if (overrides[id] !== undefined && Number.isFinite(Number(overrides[id]))) {
      return Object.assign({}, rule, { percent: Number(overrides[id]) });
    }
    return rule;
  });
  delete cfg.rules;
  g_RuntimeConfigCache = window.ConfigCore.normalizeConfig(cfg);
  g_RuntimeConfigDiscountFingerprint = fingerprint;
  return g_RuntimeConfigCache;
}

function invalidateRuntimeConfigCache() {
  g_RuntimeConfigCache = null;
  g_RuntimeConfigDiscountFingerprint = null;
  g_SearchIndex = null;
  if (g_DataReady) rebuildSearchIndex();
}

function deriveLegacyDiscountConfig(config) {
  const cfg = window.ConfigCore ? window.ConfigCore.normalizeConfig(config || {}) : config || {};
  const out = {};
  // 动态：从 discount_rules 提取 ALL 规则的 percent，keyed by rule id
  (cfg.discount_rules || []).forEach(function(rule) {
    var id = String(rule.id || "").toLowerCase();
    if (id && Number.isFinite(Number(rule.percent))) {
      out[id] = Number(rule.percent);
    }
  });
  // 兜底：确保至少有 4 个基础键
  if (out.ex === undefined) out.ex = DiscountEngine.FALLBACK_DISCOUNT_CONFIG.ex;
  if (out.osg === undefined) out.osg = DiscountEngine.FALLBACK_DISCOUNT_CONFIG.osg;
  if (out.mitsubishi === undefined) out.mitsubishi = DiscountEngine.FALLBACK_DISCOUNT_CONFIG.mitsubishi;
  if (out.other === undefined) out.other = DiscountEngine.FALLBACK_DISCOUNT_CONFIG.other;
  return DiscountEngine.sanitizeDiscountConfig(out, out);
}

function applyAppConfig(rawConfig) {
  if (!window.ConfigCore) {
    window.APP_CONFIG = rawConfig || {};
    return;
  }
  window.APP_CONFIG = rawConfig || {};
  g_AppConfig = window.ConfigCore.normalizeConfig(rawConfig || {});
  invalidateRuntimeConfigCache();
  applyRemoteDefaultDiscountConfig(deriveLegacyDiscountConfig(g_AppConfig));
  syncPricingControlsFromConfig();
  syncStaticLabelsFromConfig();
  renderConfigDrivenControls();
}

let g_DefaultDiscountConfig = DiscountEngine.sanitizeDiscountConfig(DiscountEngine.DEFAULT_DISCOUNT_CONFIG);
let g_RemoteDiscountRules = null;

const ResultSortEngine = window.ResultSort || {
  sortResultsBySelection(results) {
    if (!Array.isArray(results)) return[];
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

function getSystemDefaultDiscountConfig() {
  // 动态合并：默认值 + 远程配置覆盖
  var base = DiscountEngine.FALLBACK_DISCOUNT_CONFIG;
  var remote = g_RemoteDefaultDiscountConfig || {};
  var merged = {};
  // 收集所有键
  Object.keys(base).forEach(function(k) { merged[k] = base[k]; });
  Object.keys(remote).forEach(function(k) { merged[k] = remote[k]; });
  return DiscountEngine.sanitizeDiscountConfig(merged, base);
}

function loadLocalDefaultDiscountConfig() {
  try {
    const raw = window.localStorage.getItem(DEFAULT_DISCOUNT_STORAGE_KEY);
    if (!raw) {
      g_HasLocalDefaultDiscountConfig = false;
      return null;
    }
    g_HasLocalDefaultDiscountConfig = true;
    return DiscountEngine.sanitizeDiscountConfig(JSON.parse(raw));
  } catch (error) {
    g_HasLocalDefaultDiscountConfig = false;
    return null;
  }
}

function persistDefaultDiscountConfig(config) {
  try {
    window.localStorage.setItem(DEFAULT_DISCOUNT_STORAGE_KEY, JSON.stringify(DiscountEngine.sanitizeDiscountConfig(config)));
    g_HasLocalDefaultDiscountConfig = true;
  } catch (error) {}
}

function getDefaultDiscountConfig() {
  var base = DiscountEngine.FALLBACK_DISCOUNT_CONFIG;
  return DiscountEngine.sanitizeDiscountConfig(g_DefaultDiscountConfig || getSystemDefaultDiscountConfig(), base);
}

function applyRemoteDefaultDiscountConfig(config) {
  // 动态：sanitizeDiscountConfig 保留所有规则键
  g_RemoteDefaultDiscountConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  var remoteRules = (g_AppConfig && g_AppConfig.discount_rules) || [];
  g_RemoteDiscountRules = remoteRules;
  g_DefaultDiscountConfig = getSystemDefaultDiscountConfig();
  syncDefaultDiscountButtonSummary();
  // 动态渲染折扣弹窗输入框
  buildDefaultDiscountForm(g_DefaultDiscountConfig, remoteRules);
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  refreshRowsWithDefaultDiscounts();
}

function getDefaultDiscountConfigSummary(config) {
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  var rules = (g_AppConfig && g_AppConfig.discount_rules) || [];
  // 动态：从 discount_rules 生成摘要，按规则顺序显示标签
  if (rules.length) {
    return rules.map(function(rule) {
      var id = String(rule.id || "").toLowerCase();
      var percent = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
        ? Number(safeConfig[id])
        : (Number.isFinite(Number(rule.percent)) ? Number(rule.percent) : 55);
      return (rule.label || rule.id) + " " + formatCompactNumber(percent) + "%";
    }).join(" / ");
  }
  // 兜底
  return [
    "EX " + formatCompactNumber(safeConfig.ex) + "%",
    "OSG " + formatCompactNumber(safeConfig.osg) + "%",
    "三菱 " + formatCompactNumber(safeConfig.mitsubishi) + "%",
    "其他 " + formatCompactNumber(safeConfig.other) + "%"
  ].join(" / ");
}

/**
 * 动态构建折扣弹窗输入框（根据 discount_rules 生成）
 * 替代 index.html 中硬编码的 4 个品牌输入框
 */
function buildDefaultDiscountForm(config, rules) {
  var grid = document.querySelector("#defaultDiscountModal .discount-config-grid");
  if (!grid) return;
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);

  // 清除旧内容
  grid.innerHTML = "";

  // 如果没有规则，使用兜底的 4 个品牌
  var displayRules = (Array.isArray(rules) && rules.length) ? rules : [
    { id: "ex", label: "EX活动", percent: safeConfig.ex || 32 },
    { id: "osg", label: "OSG", percent: safeConfig.osg || 36 },
    { id: "mitsubishi", label: "三菱", percent: safeConfig.mitsubishi || 55 },
    { id: "other", label: "其他", percent: safeConfig.other || 50, default: true }
  ];

  displayRules.forEach(function(rule) {
    var id = String(rule.id || "").toLowerCase();
    var label = rule.label || rule.id || "规则";
    var percent = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
      ? Number(safeConfig[id])
      : (Number.isFinite(Number(rule.percent)) ? Number(rule.percent) : 55);
    var inputId = "defaultDiscount-" + id;

    var html = '<label class="discount-config-field" for="' + inputId + '">'
      + '<span>' + label + '</span>'
      + '<div class="field-shell">'
      + '<input type="number" id="' + inputId + '" min="0" max="100" step="0.1" inputmode="decimal" data-discount-id="' + id + '">'
      + '<span class="field-unit">%</span>'
      + '</div>'
      + '</label>';
    grid.insertAdjacentHTML("beforeend", html);
  });
}

function syncDefaultDiscountForm(config) {
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  // 动态：查找所有 data-discount-id 输入框并填充值
  var inputs = document.querySelectorAll("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
  inputs.forEach(function(input) {
    var id = input.getAttribute("data-discount-id") || "";
    var value = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
      ? Number(safeConfig[id])
      : 55;
    input.value = formatCompactNumber(value);
  });
  // 兼容旧版 4 个固定输入框（给兜底场景用）
  var legacyMapping = { defaultDiscountEx: safeConfig.ex, defaultDiscountOsg: safeConfig.osg, defaultDiscountMitsubishi: safeConfig.mitsubishi, defaultDiscountOther: safeConfig.other };
  Object.keys(legacyMapping).forEach(function(elId) {
    var input = document.getElementById(elId);
    if (input) input.value = formatCompactNumber(legacyMapping[elId]);
  });
}

function readDefaultDiscountForm() {
  var out = {};
  // 动态读取
  var inputs = document.querySelectorAll("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
  inputs.forEach(function(input) {
    var id = input.getAttribute("data-discount-id") || "";
    if (id) out[id] = Number(input.value) || 55;
  });
  // 兜底：如果动态输入框为空，回退到旧版
  if (Object.keys(out).length === 0) {
    out = {
      ex: document.getElementById("defaultDiscountEx") ? document.getElementById("defaultDiscountEx").value : 32,
      osg: document.getElementById("defaultDiscountOsg") ? document.getElementById("defaultDiscountOsg").value : 36,
      mitsubishi: document.getElementById("defaultDiscountMitsubishi") ? document.getElementById("defaultDiscountMitsubishi").value : 55,
      other: document.getElementById("defaultDiscountOther") ? document.getElementById("defaultDiscountOther").value : 50
    };
  }
  return DiscountEngine.sanitizeDiscountConfig(out, out);
}

function syncDefaultDiscountButtonSummary() {
  const button = document.getElementById("btnDefaultDiscounts");
  if (!button) return;
  const summary = getDefaultDiscountConfigSummary(g_DefaultDiscountConfig);
  button.title = summary;
  button.setAttribute("aria-label", "默认折扣，当前为 " + summary);
}

function setDefaultDiscountModalState(open) {
  const modal = document.getElementById("defaultDiscountModal");
  if (!modal) return;
  modal.hidden = !open;
  document.body.classList.toggle("has-overlay", open);
}

function openDefaultDiscountConfig() {
  // 确保弹窗输入框已构建
  var rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  buildDefaultDiscountForm(g_DefaultDiscountConfig, rules);
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  setDefaultDiscountModalState(true);
  window.requestAnimationFrame(function() {
    var firstInput = document.querySelector("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
    if (firstInput) firstInput.focus();
  });
}

function closeDefaultDiscountConfig() {
  setDefaultDiscountModalState(false);
}

function resetDefaultDiscountConfig() {
  syncDefaultDiscountForm(getSystemDefaultDiscountConfig());
}

function applyDefaultDiscountPresetToRow(row, flash) {
  if (!row) return;
  const rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset(toCoreRow(row), getRuntimeAppConfig())
    : DiscountEngine.getDefaultDiscountPreset({ spec: row.spec, special: row.special, brand: row.brand, name: row.name }, getDefaultDiscountConfig(), rules);
  row.discountPercent = preset.percent;
  row.discountLabel = preset.label;
  row.discountCategory = preset.category || "";
  refreshRowPrice(row, flash === true);
}

function refreshRowsWithDefaultDiscounts() {
  g_Results.forEach((row) => {
    if (!row || row.hasCustomDiscount) return;
    applyDefaultDiscountPresetToRow(row, false);
  });
}

function saveDefaultDiscountConfig() {
  g_DefaultDiscountConfig = readDefaultDiscountForm();
  persistDefaultDiscountConfig(g_DefaultDiscountConfig);
  invalidateRuntimeConfigCache();
  syncDefaultDiscountButtonSummary();
  refreshRowsWithDefaultDiscounts();
  closeDefaultDiscountConfig();
  showToast("默认折扣已更新");
}

function syncPricingControlsFromConfig() {
  const cfg = getAppConfig();
  const decimalsInput = document.getElementById("decimals");
  const thresholdInput = document.getElementById("threshold");
  const stepInput = document.getElementById("discountStep");
  if (decimalsInput) decimalsInput.value = String(cfg.pricing?.decimal_places ?? 1);
  if (thresholdInput) thresholdInput.value = String(cfg.pricing?.rounding_threshold ?? 100);
  if (stepInput) stepInput.value = formatCompactNumber(cfg.pricing?.discount_step?.default ?? DiscountEngine.DEFAULT_STEP_PERCENT);
}

function syncStaticLabelsFromConfig() {
  const cfg = getAppConfig();
  const labels = cfg.labels || {};
  const title = document.querySelector(".brand-line h1");
  if (title) title.textContent = labels.app_title || "智能询价系统";
  const searchBtn = document.getElementById("btnSearch");
  const stockBtn = document.getElementById("btnRegexConvert");
  const mmcBtn = document.getElementById("btnMmc");
  const copyBtn = document.getElementById("btnCopy");
  if (searchBtn) { searchBtn.textContent = labels.search_button || "智能查询"; searchBtn.dataset.defaultText = searchBtn.textContent; }
  if (stockBtn) { stockBtn.textContent = labels.stock_search_button || "库存查询"; stockBtn.dataset.defaultText = stockBtn.textContent; }
  if (mmcBtn) mmcBtn.textContent = labels.mmc_button || "三菱库存";
  if (copyBtn) { copyBtn.textContent = labels.copy_button || "复制勾选"; copyBtn.dataset.baseText = copyBtn.textContent; }
  const queryInput = document.getElementById("queryInput");
  if (queryInput) queryInput.placeholder = labels.query_placeholder || queryInput.placeholder;
  const inputTitle = document.querySelector(".query-panel .section-head h2");
  const resultTitle = document.querySelector(".result-panel .section-head h2");
  if (inputTitle) inputTitle.textContent = labels.input_title || "输入";
  if (resultTitle) resultTitle.textContent = labels.result_title || "结果";
}

function makeCopyCheckboxId(field) {
  return "copy_" + String(field || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function renderConfigDrivenControls() {
  const cfg = getAppConfig();
  const stepWrap = document.getElementById("stepPresetControls");
  if (stepWrap) {
    const existingConfigButton = document.getElementById("btnDefaultDiscounts");
    stepWrap.innerHTML = "";
    (cfg.pricing?.discount_step?.presets || [0.1, 0.5, 1]).forEach((step) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "step-preset";
      button.dataset.step = String(step);
      button.textContent = formatCompactNumber(step);
      stepWrap.appendChild(button);
    });
    const configButton = existingConfigButton || document.createElement("button");
    configButton.id = "btnDefaultDiscounts";
    configButton.type = "button";
    configButton.className = "step-preset step-preset-action";
    configButton.textContent = cfg.labels?.config_button || "配置";
    stepWrap.appendChild(configButton);
  }

  const copyWrap = document.getElementById("copyColumnControls");
  if (copyWrap) {
    copyWrap.innerHTML = "";
    getCopyColumns().forEach((column) => {
      const label = document.createElement("label");
      label.className = "opt-lbl" + (column.field === "remark" ? " is-accent" : "");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = makeCopyCheckboxId(column.field);
      input.dataset.copyField = column.field;
      input.checked = column.default === true;
      label.appendChild(input);
      label.appendChild(document.createTextNode(column.label || getFieldLabel(column.field)));
      copyWrap.appendChild(label);
    });
  }

  syncDiscountStepInput(document.getElementById("discountStep")?.value || cfg.pricing?.discount_step?.default || DiscountEngine.DEFAULT_STEP_PERCENT);
  requestLayoutMetricsSync();
}

window.onload = async function () {
  g_DefaultDiscountConfig = loadLocalDefaultDiscountConfig() || getSystemDefaultDiscountConfig();
  applyAppConfig(window.APP_CONFIG || {});
  bindUiEvents();
  syncDefaultDiscountButtonSummary();
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  syncDiscountStepInput(document.getElementById("discountStep").value);
  requestLayoutMetricsSync();
  renderLoadingState("正在极速同步远程数据");
  updateResultCount();
  const ready = await ensureDataLoaded();
  if (ready) {
    renderEmptyState("输入规格后开始查询，可在结果卡中直接调价与勾选复制。");
  } else {
    renderErrorState("远程数据未就绪，请重试。");
  }
};

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.innerText = msg;
  el.className = "status-badge " + (type || "info");
}

function setSearchLoading(loading) {
  const searchBtn = document.getElementById("btnSearch");
  const stockBtn = document.getElementById("btnRegexConvert");
  if (!searchBtn || !stockBtn) return;
  if (loading) {
    if (!searchBtn.dataset.defaultText) searchBtn.dataset.defaultText = searchBtn.textContent;
    if (!stockBtn.dataset.defaultText) stockBtn.dataset.defaultText = stockBtn.textContent;
    searchBtn.textContent = "加速加载中...";
    stockBtn.textContent = "同步中...";
    searchBtn.disabled = true;
    stockBtn.disabled = true;
    return;
  }
  searchBtn.textContent = searchBtn.dataset.defaultText || "智能查询";
  stockBtn.textContent = stockBtn.dataset.defaultText || "库存查询";
  searchBtn.disabled = false;
  stockBtn.disabled = false;
  requestLayoutMetricsSync();
}

function bytesToUtf8(bytes) { return new TextDecoder().decode(bytes); }

// 分块 base64 解码：避免对超大字符串调用 atob 导致浏览器内存/调用栈失败
function base64ToBytes(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return new Uint8Array(0);
  // 去除可能的 data: 前缀
  const commaIdx = base64.indexOf(",");
  if (base64.startsWith("data:") && commaIdx >= 0) base64 = base64.slice(commaIdx + 1);
  // 去除空白
  base64 = base64.replace(/\s+/g, "");
  // 计算输出长度
  const padding = (base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0));
  const outLen = Math.floor(base64.length * 3 / 4) - padding;
  const out = new Uint8Array(outLen);
  // 分块解码（每块 64KB），减少 atob 调用栈压力
  const CHUNK = 0x10000; // 65536 chars
  let outPos = 0;
  for (let i = 0; i < base64.length; i += CHUNK) {
    const chunk = base64.slice(i, i + CHUNK);
    const raw = atob(chunk);
    const limit = Math.min(raw.length, outLen - outPos);
    for (let j = 0; j < limit; j++) out[outPos + j] = raw.charCodeAt(j);
    outPos += limit;
    if (outPos >= outLen) break;
  }
  return out;
}

function decodePlainPayload(payload) { return bytesToUtf8(base64ToBytes(payload)); }

async function decryptData(base64Data, password) {
  const encryptedData = base64ToBytes(base64Data);
  const salt = encryptedData.slice(0, 16);
  const iv = encryptedData.slice(16, 28);
  const data = encryptedData.slice(28);
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ================== 新版 Supabase 缓存加载模块开始 ==================
const SUPABASE_BASE_URL = "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/s-q";

function normalizeBaseUrl(value) {
  return String(value || SUPABASE_BASE_URL).replace(/\/+$/, "");
}

function getDataSourceConfig() {
  const cfg = getAppConfig();
  return {
    base_url: normalizeBaseUrl(cfg.data_source?.base_url || SUPABASE_BASE_URL),
    version_file: cfg.data_source?.version_file || "version.json",
    config_file: cfg.data_source?.config_file || "config.json",
    price_bundle_file: cfg.data_source?.price_bundle_file || "price.bundle.json",
    stock_bundle_file: cfg.data_source?.stock_bundle_file || "stock.bundle.json",
    cache_name: cfg.data_source?.cache_name || "quotation-cache-v4"
  };
}

function buildRemoteFileUrl(source, filename, query) {
  const name = String(filename || "");
  const separator = name.indexOf("?") >= 0 ? "&" : "?";
  if (/^https?:\/\//i.test(name)) return query ? name + separator + query : name;
  return `${source.base_url}/${name.replace(/^\/+/, "")}${query ? "?" + query : ""}`;
}

function getConfigCacheVersion(config) {
  if (window.ConfigCore && typeof window.ConfigCore.getConfigVersion === "function") {
    return window.ConfigCore.getConfigVersion(config || getAppConfig());
  }
  const cfg = config || getAppConfig() || {};
  return String(cfg.version || cfg.data_version || cfg.data_source?.cache_version || cfg.data_source?.version || "").trim();
}

async function fetchRemoteJson(url, label) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function loadRemoteConfig(source) {
  const configUrl = buildRemoteFileUrl(source, source.config_file, `t=${Date.now()}`);
  const config = await fetchRemoteJson(configUrl, source.config_file);
  applyAppConfig(config);
  return config;
}

async function loadLegacyVersion(source) {
  try {
    const versionUrl = buildRemoteFileUrl(source, source.version_file, `t=${Date.now()}`);
    const data = await fetchRemoteJson(versionUrl, source.version_file);
    return String(data.version || data.cache_version || "").trim();
  } catch (err) {
    console.warn("Legacy version file unavailable; falling back to a no-store cache key", err);
    return "";
  }
}

async function loadDataWithCache() {
  console.log("开始检查版本更新...");
  let source = getDataSourceConfig();

  // 如果配置已通过后端 API 加载，跳过 Supabase config.json 加载
  // 但仍需要加载 price/stock bundles
  const configLoadedFromApi = g_AppConfig && g_AppConfig._loadedFromApi;
  if (!configLoadedFromApi) {
    try {
      await loadRemoteConfig(source);
    } catch (err) {
      console.warn("远程配置加载失败，使用内置默认配置:", err);
      applyAppConfig(window.APP_CONFIG || {});
    }
  } else {
    console.log("[loadDataWithCache] 配置已从后端 API 加载，跳过 Supabase config.json");
  }

  source = getDataSourceConfig();
  const version = getConfigCacheVersion(getAppConfig()) || await loadLegacyVersion(source) || String(Date.now());
  await Promise.all([
    fetchFileWithCache(source.price_bundle_file, version, "bundle", source).then(data => { window.PRICE_BUNDLE = data; }),
    fetchFileWithCache(source.stock_bundle_file, version, "bundle", source).then(data => { window.STOCK_BUNDLE = data; })
  ]);

  console.log("✅ 数据与配置加载完毕，当前版本：", version);
}

async function fetchFileWithCache(filename, version, fileType, sourceConfig) {
  const source = sourceConfig || getDataSourceConfig();
  const cacheName = source.cache_name || "quotation-cache-v4";
  const fileUrl = buildRemoteFileUrl(source, filename, `v=${encodeURIComponent(version)}`);

  const cache = await caches.open(cacheName);
  let response = await cache.match(fileUrl);

  if (!response) {
    console.log(`[${filename}] 缓存未命中或版本更新，从 Supabase 下载...`);
    response = await fetch(fileUrl);
    if (response.ok) {
      await cache.put(fileUrl, response.clone());
      // 异步清理旧缓存，不阻塞流程
      cleanOldCache(cache, filename, fileUrl);
    } else {
      throw new Error(`${filename} 下载失败`);
    }
  }

  const text = await response.text();
  try {
    if (fileType === 'json') {
      applyAppConfig(JSON.parse(text));
    } else if (fileType === 'bundle') {
      // Bundle files are stored as pure JSON data, not executable JS.
      return JSON.parse(text);
    }
  } catch (e) {
    console.error(`[${filename}] JSON 解析失败:`, e);
    throw new Error(`${filename} 数据格式异常，无法解析`);
  }
  return null;
}

async function cleanOldCache(cache, filename, currentUrl) {
  const keys = await cache.keys();
  for (let request of keys) {
    if (request.url.includes(filename) && request.url !== currentUrl) {
      await cache.delete(request);
    }
  }
}
// ================== 新版 Supabase 缓存加载模块结束 ==================

function fastExtractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("数据格式异常，无法解析");
  return JSON.parse(text.substring(start, end + 1));
}

async function parsePriceBundle(priceObj) {
  if (!priceObj) throw new Error("未找到远程价格包");
  let jsonText = "";
  if (priceObj.secured) {
    setStatus("价格包已加密，请输入密码", "lock");
    const pwd = prompt("请输入价格包密码：");
    if (!pwd) throw new Error("未输入价格包密码");
    try {
      jsonText = await decryptData(priceObj.payload, pwd);
    } catch (err) {
      throw new Error("价格包解密失败，请确认密码");
    }
  } else {
    const t0 = performance.now();
    const rawLen = (priceObj.payload || "").length;
    console.log(`[parsePriceBundle] 解码 base64 长度 ${rawLen} (${(rawLen / 1024 / 1024).toFixed(2)} MB)...`);
    jsonText = decodePlainPayload(priceObj.payload || "");
    console.log(`[parsePriceBundle] base64 解码耗时 ${(performance.now() - t0).toFixed(0)}ms, jsonText 长度 ${jsonText.length}`);
  }
  if (!jsonText || jsonText.length < 10) {
    throw new Error(`价格包解码结果异常 (长度=${jsonText ? jsonText.length : 0})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error("[parsePriceBundle] JSON.parse 失败，前 200 字符:", jsonText.slice(0, 200));
    throw new Error("价格包 JSON 解析失败");
  }
  return { payload: parsed, meta: priceObj.meta || null };
}

function parseStockBundle(stockObj) {
  if (!stockObj) throw new Error("未找到远程库存包");
  if (stockObj.secured) throw new Error("库存包必须保持明文");
  const jsonText = decodePlainPayload(stockObj.payload || "");
  if (!jsonText) throw new Error("库存包解码结果为空");
  return { payload: JSON.parse(jsonText), meta: stockObj.meta || null };
}

// 彻底重构的 ensureDataLoaded（将旧版的 fetchWithMirrors 摘除，接入了最新的缓存机制）
async function ensureDataLoaded() {
  if (g_DataReady) return true;
  if (g_DataLoadingPromise) return g_DataLoadingPromise;

  g_DataLoadingPromise = (async () => {
    setSearchLoading(true);
    try {
      setStatus("正连接 Supabase 极速节点...", "info");
      
      // 核心：强制在此处等待缓存拉取和注入完成！解决竞态崩溃问题！
      await loadDataWithCache();

      let priceObj = window.PRICE_BUNDLE;
      let stockObj = window.STOCK_BUNDLE;

      if (!priceObj || !stockObj) {
         throw new Error("数据未能成功注入内存");
      }

      setStatus("秒级解构核心数据...", "info");

      const parsedPrice = await parsePriceBundle(priceObj);
      const parsedStock = parseStockBundle(stockObj);

      PRICE_DATA = parsedPrice.payload || { bySpec: {} };
      PRICE_META = parsedPrice.meta || null;
      STOCK_DATA = parsedStock.payload || { byCode: {} };
      STOCK_META = parsedStock.meta || null;

      console.log("[ensureDataLoaded] PRICE_DATA keys:", Object.keys(PRICE_DATA));
      console.log("[ensureDataLoaded] PRICE_DATA rows count:", PRICE_DATA.rows ? PRICE_DATA.rows.length : (PRICE_DATA.bySpec ? Object.keys(PRICE_DATA.bySpec).length : 0));
      console.log("[ensureDataLoaded] STOCK_DATA keys:", Object.keys(STOCK_DATA));

      updateVersionText();
      rebuildMergedDB();
      console.log("[ensureDataLoaded] DB size after rebuildMergedDB:", Object.keys(DB).length);
      rebuildSearchIndex();
      console.log("[ensureDataLoaded] g_SearchIndex size:", g_SearchIndex ? Object.keys(g_SearchIndex).length : null);
      g_DataReady = true;
      setStatus("数据库就绪", "ok");
      return true;
      
    } catch (err) {
      setStatus("同步失败", "error");
      showToast(err.message || "极速节点连接失败，请检查网络");
      console.error("加载链崩溃:", err);
      return false;
    } finally {
      setSearchLoading(false);
      g_DataLoadingPromise = null;
    }
  })();

  return g_DataLoadingPromise;
}

function rebuildMergedDB() {
  DB = {};
  const cfg = getRuntimeAppConfig();
  if (window.ConfigCore) {
    PRICE_ROWS = window.ConfigCore.adaptPricePayload(PRICE_DATA, cfg);
    STOCK_ROWS = window.ConfigCore.adaptStockPayload(STOCK_DATA, cfg);
    const rows = window.ConfigCore.mergePriceAndStockRows(PRICE_ROWS, STOCK_ROWS, cfg);
    rows.forEach((row) => {
      const key = row.key || window.ConfigCore.getFieldValue(row, window.ConfigCore.getPrimaryField(cfg));
      if (!key) return;
      DB[key] = createLegacyCompatibleItem(row);
    });
    return;
  }

  const bySpec = PRICE_DATA.bySpec || {};
  const byCode = STOCK_DATA.byCode || {};
  Object.keys(bySpec).forEach((spec) => {
    const item = bySpec[spec] || {};
    const code = item.c || "";
    DB[spec] = { c: code, p: Number(item.p) || 0, s: item.s || "", r: item.r || "", b: item.b || "", n: item.n || "", m: item.m || "", a: item.a || "", i: byCode[code] || "" };
  });
}

function createLegacyCompatibleItem(row) {
  const fields = row.fields || {};
  return {
    key: row.key,
    fields: fields,
    c: fields.code || "",
    p: Number(fields.face_price) || 0,
    s: fields.special || "",
    r: fields.remark || "",
    b: fields.brand || "",
    n: fields.name || "",
    m: fields.mnemonic || "",
    a: fields.alias || "",
    i: fields.stock || ""
  };
}

function rebuildSearchIndex() {
  if (!window.ConfigCore) { g_SearchIndex = null; return; }
  g_SearchIndex = {};
  const cfg = getRuntimeAppConfig();
  const searchableKeys = cfg.fields.filter(f => f.searchable).map(f => f.key);
  const allKeys = Object.keys(DB);
  for (let i = 0; i < allKeys.length; i++) {
    const key = allKeys[i];
    const item = DB[key];
    if (!item) continue;
    const fields = item.fields || {};
    const parts = [];
    for (let j = 0; j < searchableKeys.length; j++) {
      const val = String(fields[searchableKeys[j]] || "").trim();
      if (val) parts.push(val.toUpperCase());
    }
    g_SearchIndex[key] = parts.join(" ");
  }
}

function pickVersion(meta) {
  return String(meta?.updated_at || meta?.content_updated_at || meta?.generated_at || meta?.version || "-").trim() || "-";
}

function updateVersionText() {
  const versionsEl = document.getElementById("versions");
  if (!versionsEl) return;
  versionsEl.textContent = "价格版本: " + pickVersion(PRICE_META) + " | 库存版本: " + pickVersion(STOCK_META);
  requestLayoutMetricsSync();
}

function getQueryLines() {
  return document.getElementById("queryInput").value.split(/\r?\n/).filter((line) => line.trim());
}

function hasStockValue(text) {
  if (!window.QueryRegex || typeof window.QueryRegex.hasStockValue !== "function") return !!String(text || "").trim();
  return window.QueryRegex.hasStockValue(text);
}

function convertPlainLineToRegex(line) {
  if (!window.QueryRegex || typeof window.QueryRegex.convertPlainLineToRegex !== "function") throw new Error("正则模块未加载");
  return window.QueryRegex.convertPlainLineToRegex(line);
}

function matchRegexTarget(target, re) {
  if (!window.QueryRegex || typeof window.QueryRegex.matchRegexTarget !== "function") throw new Error("正则模块未加载");
  return window.QueryRegex.matchRegexTarget(target, re);
}

function toCoreRow(rowOrKey, item) {
  if (rowOrKey && rowOrKey.fields) return { key: rowOrKey.key || rowOrKey.spec || "", fields: rowOrKey.fields };
  if (item && item.fields) return { key: rowOrKey || item.key || "", fields: item.fields };
  const source = item || {};
  return {
    key: rowOrKey || source.spec || "",
    fields: {
      code: source.c || source.code || "",
      spec: rowOrKey || source.spec || "",
      face_price: Number(source.p || source.facePrice) || 0,
      quote_price: source.price || "",
      special: source.s || source.special || "",
      stock: source.i || source.stock || "",
      remark: source.r || source.remark || "",
      brand: source.b || source.brand || "",
      name: source.n || source.name || "",
      mnemonic: source.m || source.mnemonic || "",
      alias: source.a || source.alias || ""
    }
  };
}

function getConfiguredValue(row, fieldKey) {
  const key = normalizeFieldKey(fieldKey);
  if (row && row.fields && row.fields[key] !== undefined) return row.fields[key];
  if (row && row[key] !== undefined) return row[key];
  return "";
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function updateResultCount() {
  document.getElementById("resultCount").textContent = String(g_Results.length);
}

function getSelectedCount() {
  return g_Results.filter((row) => row.checked).length;
}

function syncToggleAllState() {
  const master = document.getElementById("toggleAllResults");
  if (!master) return;
  const checkboxes = Array.from(document.querySelectorAll('#resultBody input[type="checkbox"][data-id]'));
  if (!checkboxes.length) { master.checked = false; master.indeterminate = false; return; }
  const checkedCount = checkboxes.filter((cb) => cb.checked).length;
  master.checked = checkedCount === checkboxes.length;
  master.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

function updateSelectionUi() {
  const selectedCount = getSelectedCount();
  const selectedCountEl = document.getElementById("selectedCount");
  if (selectedCountEl) selectedCountEl.textContent = String(selectedCount);

  const copyBtn = document.getElementById("btnCopy");
  if (copyBtn) {
    if (!copyBtn.dataset.baseText) copyBtn.dataset.baseText = copyBtn.textContent || "复制勾选";
    copyBtn.textContent = selectedCount > 0 ? copyBtn.dataset.baseText + " (" + selectedCount + ")" : copyBtn.dataset.baseText;
  }
  syncToggleAllState();
  requestLayoutMetricsSync();
}

function renderStateCard(kind, title, message, hint) {
  const body = document.getElementById("resultBody");
  const skeleton = kind === "loading" ? '<div class="state-skeleton"><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line"></span><span class="skeleton-line skeleton-line-short"></span></div>' : "";
  body.innerHTML =[
    '<section class="state-card state-card--', kind, '">',
    '<span class="state-kicker">', escapeHtml(title), "</span>",
    "<h3>", escapeHtml(message), "</h3>",
    hint ? "<p>" + escapeHtml(hint) + "</p>" : "", skeleton,
    "</section>"
  ].join("");
  updateSelectionUi();
}

function renderLoadingState(message) { renderStateCard("loading", "数据同步", message, "仅在初次进入时拉取，后续皆为0延迟的极速缓存。"); }
function renderEmptyState(message) { renderStateCard("empty", "等待查询", message, getAppConfig().labels?.empty_hint || "支持规格、代码、助记码、别名、备注和特价关键词。"); }
function renderErrorState(message) { renderStateCard("error", "加载失败", message, "网络或节点连接失败，请稍后重试。"); }

function getCurrentPriceSettings() {
  const decimals = parseInt(document.getElementById("decimals").value, 10);
  const threshold = parseFloat(document.getElementById("threshold").value);
  return { decimals: Number.isFinite(decimals) ? decimals : 0, threshold: Number.isFinite(threshold) ? threshold : 100 };
}

function getCurrentDiscountStep() { return DiscountEngine.sanitizeStepPercent(document.getElementById("discountStep").value); }

function updateStepPresetState(stepValue) {
  const normalized = DiscountEngine.sanitizeStepPercent(stepValue);
  document.querySelectorAll(".step-preset").forEach((button) => {
    if (!button.dataset.step) { button.classList.remove("is-active"); return; }
    button.classList.toggle("is-active", DiscountEngine.sanitizeStepPercent(button.dataset.step) === normalized);
  });
}

function syncDiscountStepInput(value) {
  const normalized = DiscountEngine.sanitizeStepPercent(value);
  document.getElementById("discountStep").value = formatCompactNumber(normalized);
  updateStepPresetState(normalized);
}

function setDiscountStepPreset(button) {
  if (!button) return;
  syncDiscountStepInput(button.dataset.step || DiscountEngine.DEFAULT_STEP_PERCENT);
}

function normalizeExactText(value) { return String(value || "").trim().toUpperCase(); }
function isExactSpecMatch(inputLine, spec) {
  return normalizeExactText(inputLine) !== "" && normalizeExactText(inputLine) === normalizeExactText(spec);
}

function getSearchTarget(spec, item) {
  return { spec: spec || "", code: item.c || "", mnemonic: item.m || "", remark: item.r || "", alias: item.a || "", special: item.s || "" };
}

function findMatchesByRegex(line, allKeys, onlyInStock) {
  const re = convertPlainLineToRegex(line);
  if (!re) return [];
  const runtimeConfig = getRuntimeAppConfig();
  const tokens = line.toUpperCase().split(/\s+/).filter(Boolean);
  const useSearchIndex = window.ConfigCore && g_SearchIndex && tokens.length > 0;
  return allKeys.filter((key) => {
    const item = DB[key] || {};
    if (onlyInStock) {
      const stockVal = window.ConfigCore ? ((item.fields && item.fields.stock) || item.i) : item.i;
      if (!hasStockValue(stockVal)) return false;
    }
    if (useSearchIndex) {
      const combined = g_SearchIndex[key] || "";
      for (let t = 0; t < tokens.length; t++) {
        if (combined.indexOf(tokens[t]) < 0) return false;
      }
      return true;
    }
    if (window.ConfigCore) return window.ConfigCore.rowMatchesText(toCoreRow(key, item), line, runtimeConfig);
    return matchRegexTarget(getSearchTarget(key, item), re);
  });
}

function getRowById(id) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId)) return null;
  return g_Results.find((row) => row && row.id === rowId) || null;
}

function calcDiscountedPrice(facePrice, discount, decimals, threshold) {
  const rawCalc = facePrice * discount;
  const factor = Math.pow(10, decimals);
  let finalPrice = Math.ceil(rawCalc * factor) / factor;
  if (finalPrice > threshold) finalPrice = Math.ceil(rawCalc);
  const display = (finalPrice % 1 === 0 && finalPrice > threshold) ? finalPrice.toFixed(0) : finalPrice.toFixed(decimals);
  return { value: finalPrice, display: display };
}

function normalizeDiscountPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number.isFinite(Number(fallback)) ? Number(fallback) : 53;
  return Math.min(100, Math.max(0, Math.round(num * 100) / 100));
}

function flashPriceCell(priceCell) {
  if (!priceCell) return;
  if (priceCell._flashFrame) window.cancelAnimationFrame(priceCell._flashFrame);
  priceCell.classList.remove("is-flashing");
  priceCell._flashFrame = window.requestAnimationFrame(() => {
    priceCell.classList.add("is-flashing");
    priceCell._flashFrame = null;
  });
}

function refreshRowPrice(row, flash) {
  if (!row) return;
  const settings = getCurrentPriceSettings();
  const priceInfo = calcDiscountedPrice(row.facePrice, row.discountPercent / 100, settings.decimals, settings.threshold);
  row.price = priceInfo.display;
  if (!row.fields) row.fields = {};
  row.fields.quote_price = priceInfo.display;
  row.fields.price = priceInfo.display;

  const resultCard = row.cardEl || document.querySelector('.result-card[data-row-id="' + row.id + '"]');
  if (!resultCard) return;
  row.cardEl = resultCard;

  const priceCell = row.priceEl || resultCard.querySelector(".price");
  const discountInput = row.discountInputEl || resultCard.querySelector(".discount-manual");

  if (priceCell) row.priceEl = priceCell;
  if (discountInput) row.discountInputEl = discountInput;
  if (discountInput) discountInput.value = formatCompactNumber(row.discountPercent);
  if (priceCell) {
    priceCell.textContent = priceInfo.display;
    if (flash) flashPriceCell(priceCell);
  }
}

function refreshRenderedPrices() { g_Results.forEach((row) => refreshRowPrice(row, false)); }

function syncRowSelectionState(row) {
  if (!row) return;
  const resultCard = row.cardEl || document.querySelector('.result-card[data-row-id="' + row.id + '"]');
  if (!resultCard) return;
  row.cardEl = resultCard;
  resultCard.classList.toggle("is-selected", !!row.checked);
  resultCard.setAttribute("data-checked", row.checked ? "true" : "false");
}

function syncResultOrder() {
  const resultList = document.getElementById("resultBody");
  if (!resultList || !g_Results.length) return;
  g_Results = ResultSortEngine.sortResultsBySelection(g_Results);
  const fragment = document.createDocumentFragment();
  g_Results.forEach((row) => {
    syncRowSelectionState(row);
    if (row && row.cardEl) fragment.appendChild(row.cardEl);
  });
  resultList.appendChild(fragment);
}

function applyManualDiscount(id, rawValue) {
  const row = getRowById(id);
  if (!row) return;
  row.hasCustomDiscount = true;
  row.discountPercent = normalizeDiscountPercent(rawValue, row.discountPercent);
  refreshRowPrice(row, true);
}

function getDiscountButtonMarkup(rowId, direction) {
  const symbol = direction < 0 ? "-" : "+";
  const label = direction < 0 ? "降低折扣" : "提高折扣";
  return[
    '<button type="button" class="discount-stepper-btn"',
    ' data-row-id="', rowId, '" data-direction="', direction, '"',
    ' aria-label="', label, '">', symbol, "</button>"
  ].join("");
}

function appendResultRow(resultList, matchKey, item, shouldCheck, isExact, runtimeConfig) {
  const coreRow = toCoreRow(matchKey, item);
  const fields = { ...(coreRow.fields || {}) };
  if (!runtimeConfig) runtimeConfig = getRuntimeAppConfig();
  const rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset({ key: coreRow.key, fields }, runtimeConfig)
    : DiscountEngine.getDefaultDiscountPreset({ spec: matchKey, special: item.s || "", brand: item.b || "", name: item.n || "" }, getDefaultDiscountConfig(), rules);
  const settings = getCurrentPriceSettings();
  const facePrice = Number(fields.face_price !== undefined ? fields.face_price : item.p) || 0;
  const priceInfo = calcDiscountedPrice(facePrice, preset.percent / 100, settings.decimals, settings.threshold);
  fields.quote_price = priceInfo.display;
  fields.price = priceInfo.display;
  const rowData = {
    id: g_Results.length, orderIndex: g_Results.length, key: coreRow.key || matchKey, fields,
    code: fields.code || "", spec: fields.spec || matchKey,
    brand: fields.brand || "", name: fields.name || "", mnemonic: fields.mnemonic || "", alias: fields.alias || "",
    price: priceInfo.display, facePrice: facePrice, remark: fields.remark || "",
    special: fields.special || "", stock: fields.stock || "", discountPercent: preset.percent,
    discountLabel: preset.label, discountCategory: preset.category || "", hasCustomDiscount: false, checked: shouldCheck
  };
  g_Results.push(rowData);

  const layout = runtimeConfig.result_layout || {};
  const identityFields = (layout.identity || ["code", "spec"]).filter(Boolean);
  const primaryIdentity = identityFields[0] || "code";
  const titleIdentity = identityFields[1] || "spec";
  const chipFields = (layout.chips || ["stock", "special"]).filter(Boolean);
  const metricFields = (layout.metrics || ["face_price", "quote_price"]).filter(Boolean);
  const detailFields = (layout.details || ["remark"]).filter(Boolean);

  const identityLead = getConfiguredValue(rowData, primaryIdentity) || ("未设置" + getFieldLabel(primaryIdentity));
  const identityTitle = getConfiguredValue(rowData, titleIdentity) || rowData.key;
  const extraIdentityMarkup = identityFields.slice(2).map((field) => {
    const value = getConfiguredValue(rowData, field);
    return value ? '<span class="identity-code">' + escapeHtml(value) + "</span>" : "";
  }).join("");
  const chipMarkup = chipFields.map((field) => {
    const value = getConfiguredValue(rowData, field);
    if (!value) return "";
    const label = field === "stock" ? getFieldConfig().stockPrefix : "";
    const cls = field === "stock" ? "stock-chip" : "special-chip";
    return '<span class="' + cls + '">' + escapeHtml(label + value) + "</span>";
  }).join("");
  const detailMarkup = detailFields.map((field) => {
    const value = getConfiguredValue(rowData, field);
    return value ? '<span class="info-note info-note-inline">' + escapeHtml(value) + "</span>" : "";
  }).join("");
  const metaLineMarkup = (chipMarkup || detailMarkup) ? '<div class="meta-line">' + chipMarkup + detailMarkup + "</div>" : "";
  const metricMarkup = (function () {
    return metricFields.map((field) => {
      const value = field === "quote_price" ? priceInfo.display : getConfiguredValue(rowData, field);
      const display = field === "face_price" ? formatCompactNumber(value || 0) : value;
      const priceClass = field === "quote_price" ? " price" : "";
      const accentClass = field === "quote_price" ? " metric-inline-accent" : "";
      return '<div class="metric-inline' + accentClass + '"><span class="metric-label">' + escapeHtml(getFieldLabel(field)) + '</span><strong class="' + priceClass.trim() + '">' + escapeHtml(display) + '</strong></div>';
    }).join("");
  })();

  const resultCard = document.createElement("article");
  resultCard.className = "result-card" + (isExact ? " match-exact" : "");
  resultCard.setAttribute("data-row-id", String(rowData.id));
  // 公司账号视图：隐藏折扣调价按钮（成本价是固定的，不允许客户手动调折扣）
  const discountPanelMarkup = [
    '<div class="discount-panel"><div class="discount-stepper" data-id="', rowData.id, '">',
    getDiscountButtonMarkup(rowData.id, -1),
    '<label class="discount-input-shell"><input type="number" class="discount-manual" data-id="', rowData.id, '" min="0" max="100" step="0.1" inputmode="decimal" value="', escapeHtml(formatCompactNumber(rowData.discountPercent)), '"><span class="discount-unit">%</span></label>',
    getDiscountButtonMarkup(rowData.id, 1),
    "</div></div>"
  ].join("");
  resultCard.innerHTML =[
    '<div class="result-row">',
    '<label class="select-chip discount-select-chip"><input type="checkbox" data-id="', rowData.id, '" ', rowData.checked ? "checked" : "", '><span>', escapeHtml(runtimeConfig.labels?.selected_label || "勾选"), '</span></label>',
    '<div class="result-summary">',
    '<div class="identity-line"><div class="identity-code">', escapeHtml(identityLead), "</div>",
    '<h3 class="identity-spec">', escapeHtml(identityTitle), "</h3>", extraIdentityMarkup,
    '<div class="stock-live-placeholder" data-stock-id="', rowData.id, '" style="display:none"></div>',
    "</div>", metaLineMarkup,
    "</div>",
    '<div class="result-side"><div class="result-metrics">',
    metricMarkup,
    "</div>",
    discountPanelMarkup,
    "</div></div>"
  ].join("");

  rowData.cardEl = resultCard;
  rowData.priceEl = resultCard.querySelector(".price");
  rowData.discountInputEl = resultCard.querySelector(".discount-manual");
  syncRowSelectionState(rowData);
  resultList.appendChild(resultCard);
}

function renderSearchResults(lines, onlyInStock) {
  const resultList = document.getElementById("resultBody");
  resultList.innerHTML = "";
  g_Results =[];

  if (!lines.length) {
    renderEmptyState("请输入规格型号或关键字后再查询。");
    updateResultCount();
    return;
  }

  const allKeys = Object.keys(DB);
  const runtimeConfig = getRuntimeAppConfig();
  lines.forEach((line) => {
    const matches = findMatchesByRegex(line, allKeys, onlyInStock);
    const defaultChecked = matches.length === 1;
    matches.forEach((matchKey) => {
      const item = DB[matchKey];
      if (!item) return;
      const isExact = isExactSpecMatch(line, matchKey);
      appendResultRow(resultList, matchKey, item, isExact || defaultChecked, isExact, runtimeConfig);
    });
  });

  if (g_Results.length === 0) renderEmptyState("没有找到匹配项，请调整关键词或切换查询方式。");
  syncResultOrder();
  updateResultCount();
  updateSelectionUi();
}

async function doSearch() {
  const ready = await ensureDataLoaded();
  if (!ready) { renderErrorState("数据加载失败，请稍后重试。"); return; }
  console.log("[doSearch] DB size:", Object.keys(DB).length, "query:", getQueryLines());
  renderSearchResults(getQueryLines(), false);
}

async function doRegexSearchConverted() {
  const ready = await ensureDataLoaded();
  if (!ready) { renderErrorState("数据加载失败，请稍后重试。"); return; }
  renderSearchResults(getQueryLines(), true);
  showToast("已按库存查询并过滤无库存项");
}

function adjustRowDiscount(id, direction, flash) {
  const row = getRowById(id);
  if (!row) return;
  row.hasCustomDiscount = true;
  row.discountPercent = DiscountEngine.shiftDiscountPercent(row.discountPercent, getCurrentDiscountStep(), direction);
  refreshRowPrice(row, flash !== false);
}

function clearDiscountPressTimers(state) {
  if (!state) return;
  if (state.timeoutId) window.clearTimeout(state.timeoutId);
  if (state.intervalId) window.clearInterval(state.intervalId);
  state.timeoutId = null;
  state.intervalId = null;
}

function releasePressedButton(state) {
  if (!state || !state.button) return;
  state.button.classList.remove("is-pressing");
  if (typeof state.button.releasePointerCapture === "function" && state.pointerId !== null && state.pointerId !== undefined) {
    try { state.button.releasePointerCapture(state.pointerId); } catch (err) {}
  }
}

function stopDiscountPress(applySingleStep) {
  const state = g_DiscountPressState;
  if (!state) return;
  g_DiscountPressState = null;
  clearDiscountPressTimers(state);
  releasePressedButton(state);
  if (applySingleStep && !state.repeatStarted) adjustRowDiscount(state.id, state.direction);
}

function startDiscountPress(event, id, direction) {
  if (event && typeof event.button === "number" && event.button !== 0) return;
  stopDiscountPress(false);

  const state = {
    id: Number(id), direction: Number(direction) < 0 ? -1 : 1,
    button: event && event.currentTarget ? event.currentTarget : null,
    pointerId: event && event.pointerId !== undefined ? event.pointerId : null,
    repeatStarted: false, timeoutId: null, intervalId: null
  };

  if (state.button) {
    state.button.classList.add("is-pressing");
    if (typeof state.button.setPointerCapture === "function" && state.pointerId !== null) {
      try { state.button.setPointerCapture(state.pointerId); } catch (err) {}
    }
  }

  state.timeoutId = window.setTimeout(() => {
    if (g_DiscountPressState !== state) return;
    state.repeatStarted = true;
    adjustRowDiscount(state.id, state.direction, false);
    state.intervalId = window.setInterval(() => { adjustRowDiscount(state.id, state.direction, false); }, HOLD_REPEAT_INTERVAL_MS);
  }, HOLD_START_DELAY_MS);

  g_DiscountPressState = state;
  if (event) event.preventDefault();
}

function handleDiscountButtonClick(event, id, direction) {
  if (event && event.detail !== 0) return;
  adjustRowDiscount(id, direction);
}

function handleGlobalPointerUp(event) {
  if (!g_DiscountPressState) return;
  if (g_DiscountPressState.pointerId !== null && event && event.pointerId !== undefined && g_DiscountPressState.pointerId !== event.pointerId) return;
  stopDiscountPress(true);
}

function handleGlobalPointerCancel(event) {
  if (!g_DiscountPressState) return;
  if (g_DiscountPressState.pointerId !== null && event && event.pointerId !== undefined && g_DiscountPressState.pointerId !== event.pointerId) return;
  stopDiscountPress(false);
}

/**
 * 将列字段 ID 映射为行对象的属性名。
 * 注意：normalizeFieldKey 把 "price" 映射成了 "quote_price"，
 * 但行对象上实际是 `row.price`，需要修正。
 */
function fieldToRowProp(colField) {
  var normalized = normalizeFieldKey(colField);
  if (normalized === "quote_price") normalized = "price";
  return normalized;
}

function doCopy() {
  const checkboxes = document.querySelectorAll("#resultBody input[type=checkbox]");
  checkboxes.forEach((cb) => {
    const row = getRowById(cb.getAttribute("data-id"));
    if (row) { row.checked = cb.checked; syncRowSelectionState(row); }
  });
  syncResultOrder();

  const selected = g_Results.filter((row) => row.checked);
  if (selected.length === 0) { showToast("请先勾选需要复制的行"); return; }

  // 读取未税金额复选框状态，决定输出含税/未税价格
  const useUntaxed = (document.getElementById("chkUntaxedQuote")?.checked) ?? false;
  const settings = getCurrentPriceSettings();
  const decimals = settings.decimals;
  const factor = Math.pow(10, decimals);

  // 读取每个列的复选框状态
  const columns = getCopyColumns();
  const enabled = {};  // key = col.field, value = checked (boolean)
  columns.forEach(function (col) {
    var cbId = makeCopyCheckboxId(col.field);
    var cb = document.getElementById(cbId);
    enabled[col.field] = cb ? cb.checked : !!col.default;
  });

  // 找出价格列的 field ID（可能是 "price"/"c"/"p" 等）
  var priceField = null;
  columns.forEach(function (col) {
    var prop = fieldToRowProp(col.field);
    if (prop === "price" && enabled[col.field]) priceField = col.field;
  });

  const lines = selected.map(function (row) {
    const mainParts = [];
    const detailParts = [];
    columns.forEach(function (col) {
      if (!enabled[col.field]) return;
      var prop = fieldToRowProp(col.field);
      var lineGroup = col.line || "main";  // 默认 main

      if (prop === "price") {
        // 价格列：支持含税/未税切换
        var rawPrice = parseFloat(row.price) || 0;
        var displayPrice;
        if (useUntaxed) {
          displayPrice = Math.ceil(rawPrice / 1.13 * factor) / factor;
        } else {
          displayPrice = rawPrice;
        }
        var formatted = (decimals === 0 && displayPrice > settings.threshold)
          ? displayPrice.toFixed(0)
          : displayPrice.toFixed(decimals);
        var priceStr = (useUntaxed ? "未税" : "含税") + formatted;
        if (lineGroup === "detail") {
          detailParts.push(priceStr);
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
    // 主行 + 每个 detail 各占一行
    return [mainParts.join(" ")].concat(detailParts).join("\n");
  });

  const text = lines.join("\n") + "\n";
  copyToClipboard(text);
  showToast("已复制 " + selected.length + " 条");
}

function toggleAll(source) {
  const checkboxes = document.querySelectorAll("#resultBody input[type=checkbox]");
  checkboxes.forEach((cb) => {
    cb.checked = source.checked;
    const row = getRowById(cb.getAttribute("data-id"));
    if (row) { row.checked = cb.checked; syncRowSelectionState(row); }
  });
  syncResultOrder();
  updateSelectionUi();
}


function getApiBase() {
  if (typeof HARDCODED_PROD_API !== "undefined" && HARDCODED_PROD_API) {
    return HARDCODED_PROD_API.replace(/\/+$/, "");
  }
  var urlParam = new URLSearchParams(window.location.search).get("api");
  if (urlParam) return urlParam.replace(/\/+$/, "");
  if (location.protocol === "file:") return "http://127.0.0.1:8001";
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") return window.location.origin;
  // 生产：读取 localStorage 配置
  return localStorage.getItem("sq_api_base") || window.location.origin;
}

function parseStockResultLine(text) {
  // 从原始 API 的文本行中提取库存数据
  // 格式示例："CNMG120408-MA MP7135 上海库存501 日本库存1890"
  //          "CNMG120408-MA MP7135 无货"
  //          "CNMG120408-MA MP7135 登录失败，请检查账号密码"
  var result = { shanghai: 0, japan: 0, error: null };
  if (!text) { result.error = "无响应"; return result; }

  var shMatch = text.match(/上海库存(\d+)/);
  if (shMatch) result.shanghai = parseInt(shMatch[1], 10);

  var jpMatch = text.match(/日本库存(\d+)/);
  if (jpMatch) result.japan = parseInt(jpMatch[1], 10);

  // 检测错误信息（排除正常结果）
  var hasStock = (result.shanghai > 0 || result.japan > 0);
  if (!hasStock && !/上海库存|日本库存/.test(text) && !/无货/.test(text)) {
    // 提取冒号后的错误信息，或整行作为错误
    var errMatch = text.match(/[：:]\s*(.+)$/);
    result.error = errMatch ? errMatch[1] : text;
  }
  return result;
}

async function doMitsubishiStockQuery() {
  var selected = g_Results.filter(function (row) { return row.checked; });
  if (selected.length === 0) { showToast("请先勾选需要查询库存的规格"); return; }
  var total = selected.length;

  // 构建多行查询文本（每行 = spec 原文）
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
    var resp = await fetch(apiBase + "/api/stock-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: queryText }),
    });

    if (!resp.ok) {
      showToast("库存服务异常: " + resp.status);
      selected.forEach(function (row) { updateCardStock(row, null); });
      setBtnText(mmcBtn ? mmcBtn.dataset.defaultText : "三菱库存");
      if (mmcBtn) { mmcBtn.disabled = false; mmcBtn.classList.remove("btn-loading"); }
      return;
    }

    var data = await resp.json();
    var rawResults = data.results || [];

    // 解析每条文本结果
    var parsed = rawResults.map(function (line) {
      return parseStockResultLine(line);
    });

    // 逐张卡片渐进展示
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
        // 全部完成：剪贴板输出
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

/**
 * 构建三菱库存查询的多行剪贴板输出。
 * - 第一行：line: "main" 的列（代码/规格/报价）+ 库存信息
 * - 后续行：line: "detail" 的列（特价/位置/备注等）各占一行
 * 列复选框逻辑与 doCopy() 一致，但库存信息始终输出且不受「库存」复选框控制。
 * @returns {string|null} 多行文本（每行用 \n 分隔），或 null
 */
function buildStockClipboardLine(row, stockResult) {
  if (!row) return null;

  // 读取列复选框状态（与 doCopy 一致）
  var columns = getCopyColumns();
  var enabled = {};
  columns.forEach(function (col) {
    var cbId = makeCopyCheckboxId(col.field);
    var cb = document.getElementById(cbId);
    enabled[col.field] = cb ? cb.checked : !!col.default;
  });

  // 价格设置
  var useUntaxed = (document.getElementById("chkUntaxedQuote")?.checked) ?? false;
  var settings = getCurrentPriceSettings();
  var decimals = settings.decimals;
  var factor = Math.pow(10, decimals);

  // 将列按 line 分组：main / detail
  var mainParts = [];
  var detailParts = [];

  columns.forEach(function (col) {
    if (!enabled[col.field]) return;
    var prop = fieldToRowProp(col.field);
    var lineGroup = col.line || "main";  // 默认 main

    // 价格列特殊处理（含税/未税）
    if (prop === "price") {
      var rawPrice = parseFloat(row.price) || 0;
      var displayPrice = useUntaxed
        ? Math.ceil(rawPrice / 1.13 * factor) / factor
        : rawPrice;
      var formatted = (decimals === 0 && displayPrice > (settings.threshold || 100))
        ? displayPrice.toFixed(0)
        : displayPrice.toFixed(decimals);
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

  // 库存信息追加到 main 行末尾
  var stockStr = "";
  if (!stockResult) {
    stockStr = "查询失败(无结果)";
  } else if (stockResult.error) {
    stockStr = "查询失败(" + stockResult.error + ")";
  } else {
    var stockParts = [];
    if (stockResult.shanghai > 0) stockParts.push("上海库存" + stockResult.shanghai);
    if (stockResult.japan > 0) stockParts.push("日本库存" + stockResult.japan);
    stockStr = stockParts.length > 0 ? stockParts.join(" ") : "厂家无货";
  }
  mainParts.push(stockStr);

  // 拼接多行
  var resultLines = [];
  resultLines.push(mainParts.join(" "));
  for (var i = 0; i < detailParts.length; i++) {
    resultLines.push(detailParts[i]);
  }
  return resultLines.join("\n");
}

/**
 * 更新结果卡片的库存展示区。
 * @param {object} row - g_Results 行数据
 * @param {string|null} state - 'loading' | 'data' | 'error' | null(清除)
 * @param {object} result - 库存结果 { shanghai, japan, error }
 */
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
    if (result.shanghai > 0) parts.push("沪" + result.shanghai);
    if (result.japan > 0) parts.push("日" + result.japan);
    if (parts.length > 0) {
      stockEl.innerHTML = '<span class="stock-signal stock-live-data">' + parts.join(" · ") + '</span>';
    } else {
      stockEl.innerHTML = '<span class="stock-signal stock-live-data stock-zero">厂家无货</span>';
    }
    stockEl.style.display = "";
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showToast("已复制")).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed"; el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  try { document.execCommand("copy"); showToast("已复制"); } catch (err) {}
  document.body.removeChild(el);
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.innerText = msg; toast.style.display = "block";
  if (g_ToastTimer) window.clearTimeout(g_ToastTimer);
  g_ToastTimer = window.setTimeout(() => { toast.style.display = "none"; g_ToastTimer = null; }, 1500);
}

function scrollToTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

function syncLayoutMetrics() {
  const toolbar = document.querySelector(".toolbar");
  const rootStyle = document.documentElement.style;
  const toolbarHeight = toolbar ? Math.ceil(toolbar.getBoundingClientRect().height) : 0;
  rootStyle.setProperty("--toolbar-stack-height", toolbarHeight + "px");
}

function requestLayoutMetricsSync() {
  if (g_LayoutMetricsFrame) return;
  g_LayoutMetricsFrame = window.requestAnimationFrame(() => { g_LayoutMetricsFrame = null; syncLayoutMetrics(); });
}

function syncMobileActionDockState() {
  const backToTopButton = document.getElementById("btnBackToTop");
  const toolbarActions = document.querySelector(".toolbar-actions");
  if (toolbarActions) toolbarActions.classList.remove("is-stuck");
  syncLayoutMetrics();
  if (backToTopButton) {
    const shouldShowBackTop = window.innerWidth <= 720 && window.scrollY > 260;
    backToTopButton.classList.toggle("is-visible", shouldShowBackTop);
  }
}

function bindUiEvents() {
  const searchBtn = document.getElementById("btnSearch");
  const stockBtn = document.getElementById("btnRegexConvert");
  const mmcBtn = document.getElementById("btnMmc");
  const copyBtn = document.getElementById("btnCopy");
  const backTopBtn = document.getElementById("btnBackToTop");
  const stepWrap = document.getElementById("stepPresetControls");
  const toggleAllInput = document.getElementById("toggleAllResults");
  if (searchBtn) searchBtn.addEventListener("click", doSearch);
  if (stockBtn) stockBtn.addEventListener("click", doRegexSearchConverted);
  if (mmcBtn) mmcBtn.addEventListener("click", doMitsubishiStockQuery);
  if (copyBtn) copyBtn.addEventListener("click", doCopy);
  if (backTopBtn) backTopBtn.addEventListener("click", scrollToTop);
  if (toggleAllInput) toggleAllInput.addEventListener("change", function () { toggleAll(this); });
  if (stepWrap) {
    stepWrap.addEventListener("click", function (event) {
      const button = event.target && event.target.closest ? event.target.closest("button") : null;
      if (!button || !stepWrap.contains(button)) return;
      if (button.id === "btnDefaultDiscounts") { openDefaultDiscountConfig(); return; }
      if (button.classList.contains("step-preset")) setDiscountStepPreset(button);
    });
  }
  const closeDefaultBtn = document.getElementById("btnCloseDefaultDiscounts");
  const resetDefaultBtn = document.getElementById("btnResetDefaultDiscounts");
  const cancelDefaultBtn = document.getElementById("btnCancelDefaultDiscounts");
  const saveDefaultBtn = document.getElementById("btnSaveDefaultDiscounts");
  const defaultBackdrop = document.getElementById("defaultDiscountBackdrop");
  if (closeDefaultBtn) closeDefaultBtn.addEventListener("click", closeDefaultDiscountConfig);
  if (resetDefaultBtn) resetDefaultBtn.addEventListener("click", resetDefaultDiscountConfig);
  if (cancelDefaultBtn) cancelDefaultBtn.addEventListener("click", closeDefaultDiscountConfig);
  if (saveDefaultBtn) saveDefaultBtn.addEventListener("click", saveDefaultDiscountConfig);
  if (defaultBackdrop) defaultBackdrop.addEventListener("click", closeDefaultDiscountConfig);

  ["defaultDiscountEx", "defaultDiscountOsg", "defaultDiscountMitsubishi", "defaultDiscountOther"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("blur", function () {
      const key = id.replace("defaultDiscount", "").toLowerCase();
      const normalized = DiscountEngine.sanitizeDiscountConfig({ [key]: this.value });
      this.value = formatCompactNumber(normalized[key]);
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveDefaultDiscountConfig(); } });
  });
  const discountStep = document.getElementById("discountStep");
  if (discountStep) {
    discountStep.addEventListener("input", function () { updateStepPresetState(this.value); });
    discountStep.addEventListener("change", function () { syncDiscountStepInput(this.value); });
    discountStep.addEventListener("blur", function () { syncDiscountStepInput(this.value); });
  }
  const decimalsInput = document.getElementById("decimals");
  const thresholdInput = document.getElementById("threshold");
  if (decimalsInput) decimalsInput.addEventListener("change", refreshRenderedPrices);
  if (thresholdInput) thresholdInput.addEventListener("change", refreshRenderedPrices);
  const resultBody = document.getElementById("resultBody");
  resultBody.addEventListener("pointerdown", function (event) {
    const target = event.target && event.target.closest ? event.target.closest(".discount-stepper-btn") : null;
    if (!target) return;
    startDiscountPress(event, target.dataset.rowId, target.dataset.direction);
  });
  resultBody.addEventListener("click", function (event) {
    const target = event.target && event.target.closest ? event.target.closest(".discount-stepper-btn") : null;
    if (!target) return;
    handleDiscountButtonClick(event, target.dataset.rowId, target.dataset.direction);
  });
  resultBody.addEventListener("change", function (event) {
    const target = event.target;
    if (!target || typeof target.matches !== "function") return;
    if (target.matches('input[type="checkbox"][data-id]')) {
      const row = getRowById(target.getAttribute("data-id"));
      if (row) { row.checked = target.checked; syncRowSelectionState(row); }
      syncResultOrder(); updateSelectionUi(); return;
    }
    if (target.matches(".discount-manual")) applyManualDiscount(target.getAttribute("data-id"), target.value);
  });
  resultBody.addEventListener("keydown", function (event) {
    const target = event.target;
    if (target && target.matches(".discount-manual") && event.key === "Enter") { event.preventDefault(); target.blur(); }
  });
  window.addEventListener("pointerup", handleGlobalPointerUp);
  window.addEventListener("pointercancel", handleGlobalPointerCancel);
  window.addEventListener("blur", () => stopDiscountPress(false));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = document.getElementById("defaultDiscountModal");
    if (modal && !modal.hidden) closeDefaultDiscountConfig();
  });
  window.addEventListener("scroll", syncMobileActionDockState, { passive: true });
  window.addEventListener("resize", syncMobileActionDockState);
  window.requestAnimationFrame(syncMobileActionDockState);
  requestLayoutMetricsSync();
  updateSelectionUi();
}
