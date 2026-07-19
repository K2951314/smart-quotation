/**
 * config-helpers.js — 配置访问、字段映射、定价控件渲染。
 *
 * 依赖：state.js
 */

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

function normalizeFieldKey(key) {
  const map = { c: "code", p: "face_price", s: "special", i: "stock", r: "remark", b: "brand", n: "name", m: "mnemonic", a: "alias", price: "quote_price" };
  return map[key] || key;
}

function getAppConfig() {
  if (!window.ConfigCore) return window.APP_CONFIG || {};
  if (!g_AppConfig) g_AppConfig = window.ConfigCore.normalizeConfig(window.APP_CONFIG || {});
  return g_AppConfig;
}

// 税率从全局 config.pricing.tax_rate 读取
function getTaxRate() {
  const cfg = getAppConfig();
  const tax = cfg.pricing?.tax_rate;
  const num = Number(tax);
  return Number.isFinite(num) && num >= 0 ? num : 13;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function getRuntimeAppConfig() {
  if (!window.ConfigCore) return getAppConfig();
  const overrides = getDefaultDiscountConfig();
  const keys = Object.keys(overrides).sort();
  const fingerprint = keys.map(function(k) { return k + "=" + overrides[k]; }).join("|");
  if (g_RuntimeConfigCache && fingerprint === g_RuntimeConfigDiscountFingerprint) return g_RuntimeConfigCache;
  const cfg = cloneConfig(getAppConfig());
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
  (cfg.discount_rules || []).forEach(function(rule) {
    var id = String(rule.id || "").toLowerCase();
    if (id && Number.isFinite(Number(rule.percent))) {
      out[id] = Number(rule.percent);
    }
  });
  if (out.other === undefined) out.other = DiscountEngine.FALLBACK_DISCOUNT_CONFIG.other || 55;
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
