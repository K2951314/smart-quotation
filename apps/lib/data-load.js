/**
 * data-load.js — 远程数据加载、缓存、Bundle 解析。
 *
 * 依赖：state.js, config-helpers.js, auth.js (getCompanyId/getApiBase/withAuthHeaders/isBackendUrl)
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

// 管理员加密价格包文件名：一键同步时 admin 后台额外生成的完整数据包
// （含 face_price，用公司 access_token AES-GCM 加密）。admin 角色下载后
// 用本地登录令牌自动解密；公开桶上的文件被第三方下载也无法解开。
var ADMIN_PRICE_BUNDLE_FILE = "price.admin.bundle.json";
// admin 加密包拉取失败（404/网络）→ 回退脱敏包。ensureDataLoaded 成功后保留此警告，
// 否则「管理员数据包未生成」会被「数据库就绪」覆盖，用户不知为何看不到面价。
var g_AdminBundleMissing = false;

function isAdminRole() {
  try {
    var profile = (typeof getAuthProfile === "function") ? getAuthProfile() : null;
    return !!(profile && profile.role === "admin");
  } catch (e) {
    return false;
  }
}

function normalizeBaseUrl(value) {
  return String(value || SUPABASE_BASE_URL).replace(/\/+$/, "");
}

function getDataSourceConfig() {
  const cfg = getAppConfig();
  // 优先用配置中的 Supabase 地址；为空时回退到后端 API 地址（后端代理 bundle）
  var supaUrl = normalizeBaseUrl(cfg.data_source?.base_url || SUPABASE_BASE_URL);
  var baseUrl = supaUrl || (getApiBase() || "").replace(/\/+$/, "");
  var publicPriceFile = cfg.data_source?.price_bundle_file || "price.bundle.json";
  // admin 角色（供应商自己，需要面价调折扣）：
  // - 有 Supabase 公开桶 → 拉取管理员加密包（完整数据，token 加密）；
  //   公开桶的普通包是强制脱敏版（无 face_price），直连会显示价格 0。
  // - 无 Supabase（后端代理）→ 普通文件名即可，后端 /price.bundle.json
  //   按角色生成（admin 返回完整数据）。
  var priceFile = (isAdminRole() && supaUrl) ? ADMIN_PRICE_BUNDLE_FILE : publicPriceFile;
  return {
    base_url: baseUrl,
    version_file: cfg.data_source?.version_file || "version.json",
    config_file: cfg.data_source?.config_file || "config.json",
    price_bundle_file: priceFile,
    public_price_bundle_file: publicPriceFile,
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
  // 后端代理 URL 必须带 company_id（本地开发无 token 时后端无法反查公司，会退回 default 公司数据）；
  // Supabase 直连是单份公开 bundle，无需 company_id。
  if (isBackendUrl(url) && source.company_id && source.company_id !== "default") {
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
  var companyId = getCompanyId() || "default";
  if (getApiBase()) {
    try {
      var apiBase = getApiBase();
      var apiConfigUrl = apiBase + "/api/config/active?company_id=" + encodeURIComponent(companyId);
      console.log("[loadRemoteConfig] 从后端 API 加载配置: company_id=" + companyId);
      var resp = await fetch(apiConfigUrl, { cache: "no-store", headers: withAuthHeaders() });
      if (resp.ok) {
        var config = await resp.json();
        // 新公司无配置（_bootstrap 模式）：从 Supabase 加载已有 config.json
        // 后端返回 _bootstrap 含 data_source.base_url（Supabase 地址），
        // 前端据此拉取 Supabase 上已有的完整配置（其他公司已发布的 config.json）
        if (config._bootstrap) {
          console.log("[loadRemoteConfig] 公司无配置，从 Supabase 加载已有配置");
          var bootSource = getDataSourceConfig();
          if (config.data_source && config.data_source.base_url) {
            bootSource = { ...bootSource, base_url: config.data_source.base_url };
          }
          var bootConfigUrl = buildRemoteFileUrl(bootSource, bootSource.config_file, "t=" + Date.now());
          var bootConfig = await fetchRemoteJson(bootConfigUrl, bootSource.config_file);
          bootConfig._loadedFromApi = false;
          bootConfig._companyId = companyId;
          bootConfig._bootstrap = true;
          applyAppConfig(bootConfig);
          return bootConfig;
        }
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
    fetchFileWithCache(source.price_bundle_file, version, "bundle", source)
      .catch(async function (err) {
        if (source.price_bundle_file !== ADMIN_PRICE_BUNDLE_FILE) throw err;
        console.warn("[data-load] 管理员加密包未找到:", err && err.message);
        // 先尝试后端 /price.bundle.json 按角色生成完整数据（后端可达时不依赖双 bundle 上传，
        // 后端用 X-Company-Token 判定 role，is_admin 公司返回含面价的完整包；与 140ad0a 的可靠路径一致）。
        var apiBase = (getApiBase() || "").replace(/\/+$/, "");
        if (apiBase) {
          try {
            var backendData = await fetchFileWithCache(apiBase + "/price.bundle.json", version, "bundle", source);
            console.log("[data-load] 已从后端按角色获取完整价格包（admin 可见面价）");
            return backendData;
          } catch (e2) {
            console.warn("[data-load] 后端价格包也失败，回退公开脱敏包:", e2 && e2.message);
          }
        }
        // 后端不可达 → 回退公开脱敏包，报价由 quote_price 兜底（无面价），给出明确指引。
        g_AdminBundleMissing = true;
        setStatus("管理员数据包未生成：请到配置中心执行「一键同步」（当前仅显示报价，无面价）", "lock");
        return fetchFileWithCache(source.public_price_bundle_file, version, "bundle", source);
      })
      .then(data => { window.PRICE_BUNDLE = data; }),
    fetchFileWithCache(source.stock_bundle_file, version, "bundle", source).then(data => { window.STOCK_BUNDLE = data; })
  ]);
  console.log("✅ 数据与配置加载完毕，当前版本：", version);
}

// 带重试 + 超时的 fetch：大 bundle 在移动/弱网下首包易失败或超时，
// 重试 2 次（指数退避）+ 60s 超时。404/401/403 等终端状态不重试（让上层 catch 回退）。
async function fetchWithRetry(url, opts, retries) {
  var lastErr = null;
  for (var i = 0; i <= retries; i++) {
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 60000);
      var resp = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(timer);
      if (resp.status === 404 || resp.status === 401 || resp.status === 403) return resp;
      if (resp.ok) return resp;
      lastErr = new Error("HTTP " + resp.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) {
      console.warn("[fetchWithRetry] " + url + " 第" + (i + 1) + "次失败，重试:", lastErr && lastErr.message);
      await new Promise(function (r) { setTimeout(r, 800 * (i + 1)); });
    }
  }
  throw lastErr || new Error("下载失败");
}

async function fetchFileWithCache(filename, version, fileType, sourceConfig) {
  const source = sourceConfig || getDataSourceConfig();
  const cacheName = source.cache_name || "quotation-cache-v4";
  const fileUrl = buildRemoteFileUrl(source, filename, `v=${encodeURIComponent(version)}`);
  // Cache API 可能因存储配额、隐私模式或网络波动而失败（特别是大文件 + wifi 不稳定场景）。
  // 所有缓存操作都用 try-catch 包裹，失败时安全降级到「仅内存」模式，不阻断数据加载。
  let cache = null;
  try {
    cache = await caches.open(cacheName);
  } catch (e) {
    console.warn(`[${filename}] Cache API 不可用（将跳过缓存）:`, e);
  }
  let response = null;
  if (cache) {
    try {
      response = await cache.match(fileUrl);
    } catch (e) {
      console.warn(`[${filename}] 缓存读取失败，尝试重新下载:`, e);
      response = null;
    }
  }
  if (!response) {
    console.log(`[${filename}] 缓存未命中或版本更新，从 ${isBackendUrl(fileUrl) ? "后端" : "Supabase"} 下载...`);
    // 走后端时必须带 X-Company-Token 头（公开端点需要认证）
    var fetchOpts = isBackendUrl(fileUrl)
      ? { cache: "no-store", headers: withAuthHeaders() }
      : { cache: "no-store" };
    response = await fetchWithRetry(fileUrl, fetchOpts, 2);
    if (response.ok) {
      if (cache) {
        // 大文件在 wifi 不稳定时 cache.put 可能抛 "network error"，
        // 降级处理：只下载、不持久化，保证当前会话可用
        try {
          await cache.put(fileUrl, response.clone());
          cleanOldCache(cache, filename, fileUrl);
        } catch (cacheErr) {
          console.warn(`[${filename}] 缓存写入失败（数据已加载到内存，不影响使用）:`, cacheErr);
        }
      }
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
  try {
    const keys = await cache.keys();
    for (let request of keys) {
      if (request.url.includes(filename) && request.url !== currentUrl) {
        try { await cache.delete(request); } catch (e) { /* 单条删除失败不影响整体 */ }
      }
    }
  } catch (e) {
    console.warn(`[${filename}] 清理旧缓存失败（不影响数据加载）:`, e);
  }
}

async function parsePriceBundle(priceObj) {
  if (!priceObj) throw new Error("未找到远程价格包");
  let jsonText = "";
  if (priceObj.secured) {
    // 管理员加密包（price.admin.bundle.json）：密码 = 公司登录令牌，
    // admin 后台一键同步时用该 token 加密，此处用本地令牌自动解密。
    var autoPassword = "";
    try {
      if (isAdminRole() && typeof getCompanyToken === "function") {
        autoPassword = getCompanyToken() || "";
      }
    } catch (e) { autoPassword = ""; }
    if (autoPassword) {
      try {
        jsonText = await decryptData(priceObj.payload, autoPassword);
      } catch (err) {
        throw new Error("管理员数据包解密失败（公司令牌可能已轮换），请到配置中心重新「一键同步」生成新数据包");
      }
    } else {
      setStatus("价格包已加密，请输入密码", "lock");
      const pwd = prompt("请输入价格包密码：");
      if (!pwd) throw new Error("未输入价格包密码");
      try {
        jsonText = await decryptData(priceObj.payload, pwd);
      } catch (err) {
        throw new Error("价格包解密失败，请确认密码");
      }
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
      // 保留管理员数据包缺失警告（避免被「数据库就绪」覆盖，否则用户不知 admin 包未生成 → 看不到面价）
      if (g_AdminBundleMissing) {
        setStatus("数据库就绪（⚠️ 管理员数据包未生成：仅显示报价无面价，请到配置中心「一键同步」）", "lock");
      } else {
        setStatus("数据库就绪", "ok");
      }
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
