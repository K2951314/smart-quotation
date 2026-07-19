/**
 * data-load.js — 远程数据加载、缓存、Bundle 解析。
 *
 * 依赖：state.js, config-helpers.js, auth.js (getCompanyId/getApiBase/withToken/withAuthHeaders/isBackendUrl)
 */

function bytesToUtf8(bytes) { return new TextDecoder().decode(bytes); }

// 分块 base64 解码：避免对超大字符串调用 atob 导致浏览器内存/调用栈失败
function base64ToBytes(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return new Uint8Array(0);
  const commaIdx = base64.indexOf(",");
  if (base64.startsWith("data:") && commaIdx >= 0) base64 = base64.slice(commaIdx + 1);
  base64 = base64.replace(/\s+/g, "");
  const padding = (base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0));
  const outLen = Math.floor(base64.length * 3 / 4) - padding;
  const out = new Uint8Array(outLen);
  const CHUNK = 0x10000;
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

// ─── 数据源配置 ──────────────────────────────────────────────

function normalizeBaseUrl(value) {
  return String(value || SUPABASE_BASE_URL).replace(/\/+$/, "");
}

function getDataSourceConfig() {
  const cfg = getAppConfig();
  // 优先用配置中的 Supabase 地址；为空时回退到后端 API 地址（后端代理 bundle）
  var baseUrl = normalizeBaseUrl(cfg.data_source?.base_url || SUPABASE_BASE_URL);
  if (!baseUrl) baseUrl = (getApiBase() || "").replace(/\/+$/, "");
  return {
    base_url: baseUrl,
    version_file: cfg.data_source?.version_file || "version.json",
    config_file: cfg.data_source?.config_file || "config.json",
    price_bundle_file: cfg.data_source?.price_bundle_file || "price.bundle.json",
    stock_bundle_file: cfg.data_source?.stock_bundle_file || "stock.bundle.json",
    cache_name: cfg.data_source?.cache_name || "quotation-cache-v4",
    company_id: (cfg._companyId || getCompanyId() || "default")
  };
}

function buildRemoteFileUrl(source, filename, query) {
  const name = String(filename || "");
  const separator = name.indexOf("?") >= 0 ? "&" : "?";
  if (/^https?:\/\//i.test(name)) return query ? name + separator + query : name;
  var url = `${source.base_url}/${name.replace(/^\/+/, "")}${query ? "?" + query : ""}`;
  if (!source.base_url && source.company_id && source.company_id !== "default") {
    url += (url.indexOf("?") >= 0 ? "&" : "?") + "company_id=" + encodeURIComponent(source.company_id);
  }
  return url;
}

function getConfigCacheVersion(config) {
  if (window.ConfigCore && typeof window.ConfigCore.getConfigVersion === "function") {
    return window.ConfigCore.getConfigVersion(config || getAppConfig());
  }
  const cfg = config || getAppConfig() || {};
  return String(cfg.version || cfg.data_version || cfg.data_source?.cache_version || cfg.data_source?.version || "").trim();
}

async function fetchRemoteJson(url, label) {
  if (isBackendUrl(url)) {
    url = withToken(url);
    var response = await fetch(url, { cache: "no-store", headers: withAuthHeaders() });
  } else {
    var response = await fetch(url, { cache: "no-store" });
  }
  if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function loadRemoteConfig(source) {
  var companyId = getCompanyId();
  if (companyId && companyId !== "default") {
    try {
      var apiBase = getApiBase();
      var apiConfigUrl = apiBase + "/api/config/active?company_id=" + encodeURIComponent(companyId);
      apiConfigUrl = withToken(apiConfigUrl);
      console.log("[loadRemoteConfig] 从后端 API 加载配置: company_id=" + companyId);
      var resp = await fetch(apiConfigUrl, { cache: "no-store", headers: withAuthHeaders() });
      if (resp.ok) {
        var config = await resp.json();
        config._loadedFromApi = true;
        config._companyId = companyId;
        applyAppConfig(config);
        return config;
      }
      console.warn("后端 API 加载配置失败 (" + resp.status + ")，回退到 Supabase");
    } catch (err) {
      console.warn("后端 API 加载配置异常，回退到 Supabase:", err);
    }
  }
  var configUrl = buildRemoteFileUrl(source, source.config_file, "t=" + Date.now());
  var config = await fetchRemoteJson(configUrl, source.config_file);
  var supabaseUrl = (config.data_source || {}).base_url || "";
  if (supabaseUrl && !source.base_url) {
    try {
      console.log("[loadRemoteConfig] 从 Supabase 加载真实配置: " + supabaseUrl);
      var supaSource = { ...source, base_url: supabaseUrl };
      var supaConfigUrl = buildRemoteFileUrl(supaSource, source.config_file, "t=" + Date.now());
      var supaConfig = await fetchRemoteJson(supaConfigUrl, source.config_file);
      if (!supaConfig.data_source) {
        supaConfig.data_source = config.data_source;
      }
      applyAppConfig(supaConfig);
      return supaConfig;
    } catch (err) {
      console.warn("从 Supabase 加载真实配置失败，使用引导配置:", err);
    }
  }
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
  var configVer = getConfigCacheVersion(getAppConfig());
  var dataVer = await loadLegacyVersion(source);
  var version = (configVer && dataVer)
    ? (configVer + "_" + dataVer)
    : (configVer || dataVer || String(Date.now()));
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
    console.log(`[${filename}] 缓存未命中或版本更新，从 ${isBackendUrl(fileUrl) ? "后端" : "Supabase"} 下载...`);
    // 走后端时必须带 X-Company-Token 头（公开端点需要认证）
    var fetchOpts = isBackendUrl(fileUrl)
      ? { cache: "no-store", headers: withAuthHeaders() }
      : { cache: "no-store" };
    response = await fetch(fileUrl, fetchOpts);
    if (response.ok) {
      await cache.put(fileUrl, response.clone());
      cleanOldCache(cache, filename, fileUrl);
    } else {
      throw new Error(`${filename} 下载失败 (${response.status})`);
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

// ─── 数据加载主流程 ──────────────────────────────────────────

async function ensureDataLoaded() {
  if (g_DataReady) return true;
  if (g_DataLoadingPromise) return g_DataLoadingPromise;
  g_DataLoadingPromise = (async () => {
    setSearchLoading(true);
    try {
      setStatus("正连接 Supabase 极速节点...", "info");
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
