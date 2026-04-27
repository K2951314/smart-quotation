let PRICE_DATA = { bySpec: {} };
let STOCK_DATA = { byCode: {} };
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

const HOLD_START_DELAY_MS = 280;
const HOLD_REPEAT_INTERVAL_MS = 70;
const MMC_URL = "https://mcweb.mitsubishi-materials.com/concerto-mmsc-ec/login.jsp";
const MMC_PASSWORD = "%461971#";
const DEFAULT_DISCOUNT_STORAGE_KEY = "v9-default-discount-config";
const SEARCH_MODE = "spec-first"; // 可选：spec-only | spec-first | all-fields

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
  const preset = DiscountEngine.getDefaultDiscountPreset({
    spec: row.spec, special: row.special, brand: row.brand, name: row.name
  }, getDefaultDiscountConfig());
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
  syncDefaultDiscountButtonSummary();
  refreshRowsWithDefaultDiscounts();
  closeDefaultDiscountConfig();
  showToast("默认折扣已更新");
}

window.onload = async function () {
  g_DefaultDiscountConfig = loadLocalDefaultDiscountConfig() || getSystemDefaultDiscountConfig();
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
const SUPABASE_BASE_URL = "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/quotation-data";

async function loadDataWithCache() {
  console.log("开始检查版本更新...");
  const versionRes = await fetch(`${SUPABASE_BASE_URL}/version.json?t=${Date.now()}`);
  const { version } = await versionRes.json();

  await Promise.all([
    fetchFileWithCache(`config.json`, version, 'json'),
    fetchFileWithCache(`price.bundle.js`, version, 'js'),
    fetchFileWithCache(`stock.bundle.js`, version, 'js')
  ]);

  console.log("✅ 数据与配置加载完毕，当前版本：", version);
  
  // ========================================================
  // ⭐ 神奇的魔法：将云端 config.json 完美对接到你原有的系统中
  // ========================================================
  if (window.APP_CONFIG) {
    // 1. 同步折扣到原项目的远程配置项
    if (window.APP_CONFIG.discounts) {
      applyRemoteDefaultDiscountConfig({
        ex: window.APP_CONFIG.discounts["EX"],
        osg: window.APP_CONFIG.discounts["OSG"],
        mitsubishi: window.APP_CONFIG.discounts["三菱"],
        other: window.APP_CONFIG.discounts["其他"]
      });
    }
    // 2. 自动填入 取整阈值 和 小数位数 的输入框
    if (window.APP_CONFIG.rounding_threshold !== undefined) {
      const thresholdInput = document.getElementById("threshold");
      if (thresholdInput) thresholdInput.value = window.APP_CONFIG.rounding_threshold;
    }
    if (window.APP_CONFIG.decimal_places !== undefined) {
      const decimalsInput = document.getElementById("decimals");
      if (decimalsInput) decimalsInput.value = window.APP_CONFIG.decimal_places;
    }
    // 3. 完美处理：自动勾选默认展示列
    if (window.APP_CONFIG.default_checked && Array.isArray(window.APP_CONFIG.default_checked)) {
      // 建立配置文字和 HTML id 的映射关系
      const mapping = {
        "代码": "chk_code",
        "规格": "chk_spec",
        "报价": "chk_price",
        "特价": "chk_special",
        "库存": "chk_stock",
        "备注": "chk_remark"
      };
      
      // 第一步：先将页面上的列全部取消勾选
      Object.values(mapping).forEach(id => {
        const chk = document.getElementById(id);
        if (chk) chk.checked = false;
      });
      
      // 第二步：根据云端配置，精准勾选需要的列
      window.APP_CONFIG.default_checked.forEach(name => {
        const id = mapping[name];
        if (id) {
          const chk = document.getElementById(id);
          if (chk) chk.checked = true;
        }
      });
    }
  }
}

async function fetchFileWithCache(filename, version, fileType) {
  const cacheName = `quotation-cache-v1`; 
  const fileUrl = `${SUPABASE_BASE_URL}/${filename}?v=${version}`;

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
  if (fileType === 'json') {
    window.APP_CONFIG = JSON.parse(text);
  } else if (fileType === 'js') {
    const script = document.createElement('script');
    script.text = text;
    document.body.appendChild(script);
  }
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
  return { bySpec: parsed.bySpec || {}, meta: priceObj.meta || null };
}

function parseStockBundle(stockObj) {
  if (!stockObj) throw new Error("未找到远程库存包");
  if (stockObj.secured) throw new Error("库存包必须保持明文");
  const parsed = JSON.parse(decodePlainPayload(stockObj.payload || "") || "{}");
  return { byCode: parsed.byCode || {}, meta: stockObj.meta || null };
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

      PRICE_DATA = { bySpec: parsedPrice.bySpec || {} };
      PRICE_META = parsedPrice.meta || null;
      STOCK_DATA = { byCode: parsedStock.byCode || {} };
      STOCK_META = parsedStock.meta || null;

      updateVersionText();
      rebuildMergedDB();
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
  const bySpec = PRICE_DATA.bySpec || {};
  const byCode = STOCK_DATA.byCode || {};

  Object.keys(bySpec).forEach((spec) => {
    const item = bySpec[spec] || {};
    const code = item.c || "";
    DB[spec] = {
      c: code, p: Number(item.p) || 0, s: item.s || "",
      r: item.r || "", b: item.b || "", n: item.n || "",
      m: item.m || "", a: item.a || "", i: byCode[code] || ""
    };
  });
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
function renderEmptyState(message) { renderStateCard("empty", "等待查询", message, "默认优先规格型号匹配，无结果时再扩展关键词匹配。"); }
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

function filterKeysByStock(allKeys, onlyInStock) {
  return allKeys.filter((key) => {
    const item = DB[key] || {};
    if (onlyInStock && !hasStockValue(item.i)) return false;
    return true;
  });
}

function findMatchesBySpecRegex(re, allKeys, onlyInStock) {
  return filterKeysByStock(allKeys, onlyInStock).filter((key) => matchRegexTarget({ spec: key || "" }, re));
}

function findMatchesByAllFieldsRegex(re, allKeys, onlyInStock) {
  return filterKeysByStock(allKeys, onlyInStock).filter((key) => {
    const item = DB[key] || {};
    return matchRegexTarget(getSearchTarget(key, item), re);
  });
}

function findMatchesByRegex(line, allKeys, onlyInStock) {
  const re = convertPlainLineToRegex(line);
  if (!re) return[];
  if (SEARCH_MODE === "spec-only") return findMatchesBySpecRegex(re, allKeys, onlyInStock);
  if (SEARCH_MODE === "all-fields") return findMatchesByAllFieldsRegex(re, allKeys, onlyInStock);

  const specMatches = findMatchesBySpecRegex(re, allKeys, onlyInStock);
  if (specMatches.length > 0) return specMatches;
  return Array.from(new Set(findMatchesByAllFieldsRegex(re, allKeys, onlyInStock)));
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
    ' onpointerdown="startDiscountPress(event, ', rowId, ", ", direction, ')"',
    ' onclick="handleDiscountButtonClick(event, ', rowId, ", ", direction, ')"',
    ' aria-label="', label, '">', symbol, "</button>"
  ].join("");
}

function appendResultRow(resultList, matchKey, item, shouldCheck, isExact) {
  const preset = DiscountEngine.getDefaultDiscountPreset({ spec: matchKey, special: item.s || "", brand: item.b || "", name: item.n || "" }, getDefaultDiscountConfig());
  const settings = getCurrentPriceSettings();
  const priceInfo = calcDiscountedPrice(item.p, preset.percent / 100, settings.decimals, settings.threshold);
  const rowData = {
    id: g_Results.length, orderIndex: g_Results.length, code: item.c || "", spec: matchKey,
    brand: item.b || "", name: item.n || "", mnemonic: item.m || "", alias: item.a || "",
    price: priceInfo.display, facePrice: Number(item.p) || 0, remark: item.r || "",
    special: item.s || "", stock: item.i || "", discountPercent: preset.percent,
    discountLabel: preset.label, discountCategory: preset.category || "", hasCustomDiscount: false, checked: shouldCheck
  };
  g_Results.push(rowData);

  const stockMarkup = hasStockValue(rowData.stock) ? '<span class="stock-chip">库存 ' + escapeHtml(rowData.stock) + "</span>" : "";
  const specialMarkup = rowData.special ? '<span class="special-chip">' + escapeHtml(rowData.special) + "</span>" : "";
  const remarkMarkup = rowData.remark ? '<span class="info-note info-note-inline">' + escapeHtml(rowData.remark) + "</span>" : "";
  const metaLineMarkup = (specialMarkup || remarkMarkup) ? '<div class="meta-line">' + specialMarkup + remarkMarkup + "</div>" : "";

  const resultCard = document.createElement("article");
  resultCard.className = "result-card" + (isExact ? " match-exact" : "");
  resultCard.setAttribute("data-row-id", String(rowData.id));
  resultCard.innerHTML =[
    '<div class="result-row">',
    '<label class="select-chip discount-select-chip"><input type="checkbox" data-id="', rowData.id, '" ', rowData.checked ? "checked" : "", '><span>勾选</span></label>',
    '<div class="result-summary">',
    '<div class="identity-line"><div class="identity-code">', escapeHtml(rowData.code || "未设置代码"), "</div>",
    '<h3 class="identity-spec">', escapeHtml(matchKey), "</h3>", stockMarkup, "</div>", metaLineMarkup, "</div>",
    '<div class="result-side"><div class="result-metrics">',
    '<div class="metric-inline"><span class="metric-label">面价</span><strong>', escapeHtml(formatCompactNumber(item.p || 0)), '</strong></div>',
    '<div class="metric-inline metric-inline-accent"><span class="metric-label">报价</span><strong class="price">', escapeHtml(priceInfo.display), '</strong></div>',
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
  lines.forEach((line) => {
    const matches = findMatchesByRegex(line, allKeys, onlyInStock);
    const defaultChecked = matches.length === 1;
    matches.forEach((matchKey) => {
      const item = DB[matchKey];
      if (!item) return;
      const isExact = isExactSpecMatch(line, matchKey);
      appendResultRow(resultList, matchKey, item, isExact || defaultChecked, isExact);
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

  const showCode = document.getElementById("chk_code").checked;
  const showSpec = document.getElementById("chk_spec").checked;
  const showPrice = document.getElementById("chk_price").checked;
  const showSpecial = document.getElementById("chk_special").checked;
  const showStock = document.getElementById("chk_stock").checked;
  const showRemark = document.getElementById("chk_remark").checked;

  let text = "";
  selected.forEach((row) => {
    const line1Parts =[];
    if (showCode) line1Parts.push(row.code);
    if (showSpec) line1Parts.push(row.spec);
    if (showPrice) line1Parts.push("含税" + row.price);
    if (showSpecial && row.special) line1Parts.push(row.special);
    if (showStock && row.stock) line1Parts.push(row.stock);
    text += line1Parts.join(" ") + "\n";
    if (showRemark && row.remark) text += row.remark + "\n";
  });
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

function openMmcLogin() { copyToClipboard(MMC_PASSWORD); showToast("已复制密码"); window.open(MMC_URL, "_blank", "noopener"); }

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

function bindUiEvents() {["defaultDiscountEx", "defaultDiscountOsg", "defaultDiscountMitsubishi", "defaultDiscountOther"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("blur", function () {
      const key = id.replace("defaultDiscount", "").toLowerCase();
      const normalized = DiscountEngine.sanitizeDiscountConfig({ [key]: this.value });
      this.value = formatCompactNumber(normalized[key]);
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveDefaultDiscountConfig(); } });
  });
  document.getElementById("discountStep").addEventListener("input", function () { updateStepPresetState(this.value); });
  document.getElementById("discountStep").addEventListener("change", function () { syncDiscountStepInput(this.value); });
  document.getElementById("discountStep").addEventListener("blur", function () { syncDiscountStepInput(this.value); });
  document.getElementById("decimals").addEventListener("change", refreshRenderedPrices);
  document.getElementById("threshold").addEventListener("change", refreshRenderedPrices);
  document.getElementById("resultBody").addEventListener("change", function (event) {
    const target = event.target;
    if (!target || typeof target.matches !== "function") return;
    if (target.matches('input[type="checkbox"][data-id]')) {
      const row = getRowById(target.getAttribute("data-id"));
      if (row) { row.checked = target.checked; syncRowSelectionState(row); }
      syncResultOrder(); updateSelectionUi(); return;
    }
    if (target.matches(".discount-manual")) applyManualDiscount(target.getAttribute("data-id"), target.value);
  });
  document.getElementById("resultBody").addEventListener("keydown", function (event) {
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
