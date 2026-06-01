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
let g_AppConfig = null;
let g_RuntimeConfigCache = null;
let g_RuntimeConfigDiscountFingerprint = null;
let g_SearchIndex = null;

const HOLD_START_DELAY_MS = 280;
const HOLD_REPEAT_INTERVAL_MS = 70;
const MMC_URL = "https://mcweb.mitsubishi-materials.com/concerto-mmsc-ec/login.jsp";
const DEFAULT_DISCOUNT_STORAGE_KEY = "v9-default-discount-config";

const DiscountEngine = window.DiscountUtils || {
  DEFAULT_DISCOUNT_CONFIG: Object.freeze({ ex: 32, osg: 36, mitsubishi: 55, other: 55 }),
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
  sanitizeDiscountConfig(config) {
    const source = config || {};
    return {
      ex: this.normalizePercent(source.ex, this.DEFAULT_DISCOUNT_CONFIG.ex),
      osg: this.normalizePercent(source.osg, this.DEFAULT_DISCOUNT_CONFIG.osg),
      mitsubishi: this.normalizePercent(source.mitsubishi, this.DEFAULT_DISCOUNT_CONFIG.mitsubishi),
      other: this.normalizePercent(source.other, this.DEFAULT_DISCOUNT_CONFIG.other)
    };
  },
  getDiscountCategory(item) {
    const source = item || {};
    const compact = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
    const brandAndSpec = [source.brand, source.spec].filter(Boolean).join(" ");
    const name = String(source.name || source.n || "").trim();
    if (compact(source.special).includes("EX活动")) return "ex";
    if (/OSG/i.test(brandAndSpec)) return "osg";
    if (name === "刀具") return "mitsubishi";
    return "other";
  },
  getDefaultDiscountPreset(item, config) {
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
  const fingerprint = overrides.ex + "|" + overrides.osg + "|" + overrides.mitsubishi + "|" + overrides.other;
  if (g_RuntimeConfigCache && fingerprint === g_RuntimeConfigDiscountFingerprint) return g_RuntimeConfigCache;
  const cfg = cloneConfig(getAppConfig());
  const legacyMap = { ex: "ex", osg: "osg", mitsubishi: "mitsubishi", other: "other" };
  cfg.discount_rules = (cfg.discount_rules || []).map((rule) => {
    const id = String(rule.id || "").toLowerCase();
    const key = Object.keys(legacyMap).find((name) => legacyMap[name] === id);
    return key ? { ...rule, percent: overrides[key] } : rule;
  });
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
  (cfg.discount_rules || []).forEach((rule) => {
    const id = String(rule.id || "").toLowerCase();
    if (id === "ex") out.ex = rule.percent;
    if (id === "osg") out.osg = rule.percent;
    if (id === "mitsubishi") out.mitsubishi = rule.percent;
    if (id === "other" || rule.default) out.other = rule.percent;
  });
  return DiscountEngine.sanitizeDiscountConfig(out);
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
  return DiscountEngine.sanitizeDiscountConfig({
    ...DiscountEngine.DEFAULT_DISCOUNT_CONFIG,
    ...(g_RemoteDefaultDiscountConfig || {})
  });
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
  return DiscountEngine.sanitizeDiscountConfig(g_DefaultDiscountConfig || getSystemDefaultDiscountConfig());
}

function applyRemoteDefaultDiscountConfig(config) {
  g_RemoteDefaultDiscountConfig = DiscountEngine.sanitizeDiscountConfig(config);
  if (g_HasLocalDefaultDiscountConfig) return;
  g_DefaultDiscountConfig = getSystemDefaultDiscountConfig();
  syncDefaultDiscountButtonSummary();
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  refreshRowsWithDefaultDiscounts();
}

function getDefaultDiscountConfigSummary(config) {
  const safeConfig = DiscountEngine.sanitizeDiscountConfig(config);
  return[
    "EX " + formatCompactNumber(safeConfig.ex) + "%",
    "OSG " + formatCompactNumber(safeConfig.osg) + "%",
    "三菱 " + formatCompactNumber(safeConfig.mitsubishi) + "%",
    "其他 " + formatCompactNumber(safeConfig.other) + "%"
  ].join(" / ");
}

function syncDefaultDiscountForm(config) {
  const safeConfig = DiscountEngine.sanitizeDiscountConfig(config);
  const mapping = { defaultDiscountEx: safeConfig.ex, defaultDiscountOsg: safeConfig.osg, defaultDiscountMitsubishi: safeConfig.mitsubishi, defaultDiscountOther: safeConfig.other };
  Object.keys(mapping).forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = formatCompactNumber(mapping[id]);
  });
}

function readDefaultDiscountForm() {
  return DiscountEngine.sanitizeDiscountConfig({
    ex: document.getElementById("defaultDiscountEx").value,
    osg: document.getElementById("defaultDiscountOsg").value,
    mitsubishi: document.getElementById("defaultDiscountMitsubishi").value,
    other: document.getElementById("defaultDiscountOther").value
  });
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
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  setDefaultDiscountModalState(true);
  window.requestAnimationFrame(() => {
    const input = document.getElementById("defaultDiscountEx");
    if (input) input.focus();
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
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset(toCoreRow(row), getRuntimeAppConfig())
    : DiscountEngine.getDefaultDiscountPreset({ spec: row.spec, special: row.special, brand: row.brand, name: row.name }, getDefaultDiscountConfig());
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
    const resultStat = stepWrap.querySelector(".result-stat");
    const selectAll = stepWrap.querySelector(".select-all-toggle");
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
    if (resultStat) stepWrap.appendChild(resultStat);
    if (selectAll) stepWrap.appendChild(selectAll);
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

function base64ToBytes(base64) {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
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
    cache_name: cfg.data_source?.cache_name || "quotation-cache-v2"
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

  try {
    await loadRemoteConfig(source);
  } catch (err) {
    console.warn("远程配置加载失败，使用内置默认配置:", err);
    applyAppConfig(window.APP_CONFIG || {});
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
  const cacheName = source.cache_name || "quotation-cache-v2";
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
    jsonText = decodePlainPayload(priceObj.payload || "");
  }
  const parsed = JSON.parse(jsonText || "{}");
  return { payload: parsed, meta: priceObj.meta || null };
}

function parseStockBundle(stockObj) {
  if (!stockObj) throw new Error("未找到远程库存包");
  if (stockObj.secured) throw new Error("库存包必须保持明文");
  const parsed = JSON.parse(decodePlainPayload(stockObj.payload || "") || "{}");
  return { payload: parsed, meta: stockObj.meta || null };
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

      updateVersionText();
      rebuildMergedDB();
      rebuildSearchIndex();
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
  g_SearchIndex = {};
  if (!window.ConfigCore) return;
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
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset({ key: coreRow.key, fields }, runtimeConfig)
    : DiscountEngine.getDefaultDiscountPreset({ spec: matchKey, special: item.s || "", brand: item.b || "", name: item.n || "" }, getDefaultDiscountConfig());
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
  const metricMarkup = metricFields.map((field) => {
    const value = field === "quote_price" ? priceInfo.display : getConfiguredValue(rowData, field);
    const display = field === "face_price" ? formatCompactNumber(value || 0) : value;
    const priceClass = field === "quote_price" ? " price" : "";
    const accentClass = field === "quote_price" ? " metric-inline-accent" : "";
    return '<div class="metric-inline' + accentClass + '"><span class="metric-label">' + escapeHtml(getFieldLabel(field)) + '</span><strong class="' + priceClass.trim() + '">' + escapeHtml(display) + '</strong></div>';
  }).join("");

  const resultCard = document.createElement("article");
  resultCard.className = "result-card" + (isExact ? " match-exact" : "");
  resultCard.setAttribute("data-row-id", String(rowData.id));
  resultCard.innerHTML =[
    '<div class="result-row">',
    '<label class="select-chip discount-select-chip"><input type="checkbox" data-id="', rowData.id, '" ', rowData.checked ? "checked" : "", '><span>', escapeHtml(runtimeConfig.labels?.selected_label || "勾选"), '</span></label>',
    '<div class="result-summary">',
    '<div class="identity-line"><div class="identity-code">', escapeHtml(identityLead), "</div>",
    '<h3 class="identity-spec">', escapeHtml(identityTitle), "</h3>", extraIdentityMarkup, "</div>", metaLineMarkup, "</div>",
    '<div class="result-side"><div class="result-metrics">',
    metricMarkup,
    "</div>",
    '<div class="discount-panel"><div class="discount-stepper" data-id="', rowData.id, '">',
    getDiscountButtonMarkup(rowData.id, -1),
    '<label class="discount-input-shell"><input type="number" class="discount-manual" data-id="', rowData.id, '" min="0" max="100" step="0.1" inputmode="decimal" value="', escapeHtml(formatCompactNumber(rowData.discountPercent)), '"><span class="discount-unit">%</span></label>',
    getDiscountButtonMarkup(rowData.id, 1),
    "</div></div></div></div>"
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

function doCopy() {
  const checkboxes = document.querySelectorAll("#resultBody input[type=checkbox]");
  checkboxes.forEach((cb) => {
    const row = getRowById(cb.getAttribute("data-id"));
    if (row) { row.checked = cb.checked; syncRowSelectionState(row); }
  });
  syncResultOrder();

  const selected = g_Results.filter((row) => row.checked);
  if (selected.length === 0) { showToast("请先勾选需要复制的行"); return; }

  const selectedFields = Array.from(document.querySelectorAll('#copyColumnControls input[type="checkbox"][data-copy-field]:checked')).map((input) => input.dataset.copyField);
  const text = window.ConfigCore
    ? window.ConfigCore.renderCopyText(selected.map((row) => toCoreRow(row)), getRuntimeAppConfig(), selectedFields)
    : selected.map((row) => [row.code, row.spec, getFieldConfig().copyPrefix + row.price].filter(Boolean).join(" ")).join("\n") + "\n";
  copyToClipboard(text);
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

function openMmcLogin() { window.open(MMC_URL, "_blank", "noopener"); }

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
  if (mmcBtn) mmcBtn.addEventListener("click", openMmcLogin);
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
