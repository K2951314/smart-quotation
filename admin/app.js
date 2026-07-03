const apiBase = "";
const ADMIN_API_KEY = "admin-secret-key";
let g_AdminEventsBound = false;
let sbAnonKeyInput = null;    // Supabase anon key input（在 bind() 中赋值）
let sbBaseUrlInput = null;    // Supabase base URL input（在 bind() 中赋值）

window.addEventListener("error", (event) => {
  const msg = event?.message || "未知错误";
  setStatus(`JS 错误：${msg}`, true);
  setJsStatus("异常");
});

const state = {
  config: defaultConfig(),
  uploadedRows: null,
  uploadFilename: "",
  selectedUploadFile: null,
};

function $(id) {
  return document.getElementById(id);
}

// ─── Supabase 部署工具函数（顶级作用域，供 saveConfig / rollbackToRevision 调用）───

const SB_KEY = "quotation-admin-sb-anon-key";

function sbAutoFillBaseUrl() {
  if (!sbBaseUrlInput || sbBaseUrlInput.value.trim()) return;
  try {
    const cfg = collectConfig();
    const baseUrl = (cfg.data_source && cfg.data_source.base_url) ? cfg.data_source.base_url : "";
    if (baseUrl) sbBaseUrlInput.value = baseUrl;
  } catch {}
}

function sbSetStatus(msg, type) {
  const bar = document.getElementById("sb-statusBar");
  if (!bar) return;
  bar.textContent = msg;
  bar.className = "supabase-status " + (type || "info");
}

function sbGetAnonKey() {
  const key = sbAnonKeyInput ? sbAnonKeyInput.value.trim() : "";
  if (!key) throw new Error("请先填写 Supabase Anon Key");
  try { sessionStorage.setItem(SB_KEY, key); } catch {}
  return key;
}

function sbGetBaseUrl() {
  sbAutoFillBaseUrl();
  const url = sbBaseUrlInput ? sbBaseUrlInput.value.trim() : "";
  if (!url) throw new Error("请先填写 Supabase Base URL（data_source.base_url）");
  return url.replace(/\/+$/, "");
}

/** 将字符串内容通过 Supabase Storage PUT 上传到指定文件名 */
async function sbUploadFile(filename, content, contentType) {
  const key     = sbGetAnonKey();
  const baseUrl = sbGetBaseUrl();

  // 将 public object URL 转为可写 URL
  // base_url 形如 https://xxx.supabase.co/storage/v1/object/public/bucket/dir
  // 写入 URL    形如 https://xxx.supabase.co/storage/v1/object/bucket/dir/filename
  const publicPrefix = "/storage/v1/object/public/";
  const writePrefix  = "/storage/v1/object/";
  let writeUrl;
  if (baseUrl.includes(publicPrefix)) {
    const rest = baseUrl.slice(baseUrl.indexOf(publicPrefix) + publicPrefix.length);
    const origin = baseUrl.slice(0, baseUrl.indexOf(publicPrefix));
    writeUrl = origin + writePrefix + rest + "/" + filename;
  } else {
    throw new Error("base_url 格式不是 Supabase Storage public object URL（应包含 /storage/v1/object/public/）");
  }

  sbSetStatus("正在上传 " + filename + "...", "info");
  const resp = await fetch(writeUrl, {
    method: "PUT",
    headers: {
      "apikey":         key,
      "authorization":  "Bearer " + key,
      "content-type":   contentType || "application/json;charset=utf-8",
      "x-upsert":       "true",
    },
    body: content,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("上传失败 HTTP " + resp.status + ": " + text.slice(0, 200));
  }
  sbSetStatus("✅ 已成功上传 " + filename, "ok");
}

// ─── Standalone HTML 生成 ────────────────────────────────────────────
const STANDALONE_FILES = [
  "index.html",
  "styles.css",
  "lib/query-regex.js",
  "lib/discount-utils.js",
  "lib/result-sort.js",
  "lib/config-core.js",
  "app.js",
];

function getAppsBaseUrl() {
  // 相对于当前页面，找 apps/ 目录
  // http://host/admin/  →  http://host/apps/
  // file:///.../admin/  →  file:///.../apps/
  return new URL("../apps/", window.location.href).href;
}

async function fetchStandaloneSources() {
  const baseUrl = getAppsBaseUrl();
  const keys = ["html","css","js0","js1","js2","js3","js4"];
  const results = await Promise.all(STANDALONE_FILES.map(async (file, i) => {
    const url = baseUrl + file + "?t=" + Date.now();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`加载 ${file} 失败 (HTTP ${resp.status})`);
    return resp.text();
  }));
  const map = {};
  keys.forEach((k, i) => { map[k] = results[i]; });
  return map;
}

function patchCacheApi(appJs) {
  // 将 fetchFileWithCache 中的 Cache API 调用替换为 file:// 兼容版本
  const old = `const cache = await caches.open(cacheName);
  let response = await cache.match(fileUrl);

  if (!response) {
    console.log(\`[\${filename}] 缓存未命中或版本更新，从 Supabase 下载...\`);
    response = await fetch(fileUrl);
    if (response.ok) {
      await cache.put(fileUrl, response.clone());
      // 异步清理旧缓存，不阻塞流程
      cleanOldCache(cache, filename, fileUrl);
    } else {
      throw new Error(\`\${filename} 下载失败\`);
    }
  }`;

  const fixed = `let response = null;
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(cacheName);
      response = await cache.match(fileUrl);
    } catch (e) {
      response = null;
    }
  }

  if (!response) {
    console.log(\`[\${filename}] 缓存未命中或版本更新，从 Supabase 下载...\`);
    response = await fetch(fileUrl);
    if (response.ok) {
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open(cacheName);
          await cache.put(fileUrl, response.clone());
          cleanOldCache(cache, filename, fileUrl);
        } catch (e) {}
      }
    } else {
      throw new Error(\`\${filename} 下载失败\`);
    }
  }`;

  return appJs.replace(old, fixed);
}

function buildStandaloneHtml(sources) {
  const bodyStart = sources.html.indexOf("<body>") + "<body>".length;
  const bodyEnd   = sources.html.indexOf("</body>");
  let bodyContent = sources.html.slice(bodyStart, bodyEnd);

  // 移除外部引用
  bodyContent = bodyContent.replace('<link rel="stylesheet" href="./styles.css">', "");
  bodyContent = bodyContent.replace(/<script\s+src="\.\/lib\/[^"]+\.js(\?v=[\d]+)?"><\/script>/g, "");
  bodyContent = bodyContent.replace(/<script\s+src="\.\/app\.js(\?v=[\d]+)?"><\/script>/g, "");

  const appJsFixed = patchCacheApi(sources.js4);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f7f3ec">
<title>智能询价系统</title>
<style>
${sources.css}
</style>
</head>
<body>
${bodyContent.trim()}
<script>
${sources.js0}
</script>
<script>
${sources.js1}
</script>
<script>
${sources.js2}
</script>
<script>
${sources.js3}
</script>
<script>
${appJsFixed}
</script>
</body>
</html>`;
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function generateStandalone() {
  if (window.location.protocol === "file:") {
    sbSetStatus("❌ 请通过 FastAPI 启动后访问 http://127.0.0.1:8001/admin/ 使用此功能（file:// 下浏览器禁止 fetch）", "error");
    return;
  }
  sbSetStatus("正在加载前端源文件...", "info");
  try {
    const sources = await fetchStandaloneSources();
    sbSetStatus("正在拼接独立 HTML...", "info");
    const html = buildStandaloneHtml(sources);
    downloadBlob(html, "standalone.html");
    sbSetStatus("✅ 已生成 standalone.html，可发给客户直接使用", "ok");
  } catch (err) {
    sbSetStatus("❌ 生成失败: " + (err.message || err), "error");
  }
}

async function deployStandalone() {
  if (window.location.protocol === "file:") {
    sbSetStatus("❌ 请通过 FastAPI 启动后访问 http://127.0.0.1:8001/admin/ 使用此功能", "error");
    return;
  }
  try {
    sbAutoFillBaseUrl();
    const sources = await fetchStandaloneSources();
    const html = buildStandaloneHtml(sources);
    await sbUploadFile("standalone.html", html, "text/html;charset=utf-8");
  } catch (err) {
    sbSetStatus("❌ " + err.message, "error");
  }
}

function defaultConfig() {
  return {
    schema_version: 3,
    revision: new Date().toISOString().slice(0, 10) + ".1",
    version: "",
    data_source: {
      base_url: "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/s-q",
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
      { id: "ex_activity", label: "EX 活动", priority: 10, when: { all: [{ field: "special", op: "contains", value: "EX活动" }] }, actions: [{ type: "set_discount", percent: 32 }] },
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

// ─── Utilities ─────────────────────────────────────────────────────────────

function setStatus(text, isError) {
  $("statusText").textContent = text;
  $("statusText").classList.toggle("danger", Boolean(isError));
}

async function request(path, options) {
  const headers = { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) };
  headers["Authorization"] = "Bearer " + ADMIN_API_KEY;
  const response = await fetch(apiBase + path, {
    headers: headers,
    ...options,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    if (!response.ok) throw new Error(`服务器返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
    throw new Error("服务器返回了非 JSON 格式的响应");
  }
  if (!response.ok) throw new Error(data.detail || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function parseListInput(str) {
  return (str || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Collect ────────────────────────────────────────────────────────────────

function collectConfig() {
  const config = JSON.parse(JSON.stringify(state.config));
  config.revision = $("revision").value.trim() || new Date().toISOString();

  // Fields
  config.fields = Array.from(document.querySelectorAll("[data-field-row]")).map((row) => ({
    key: row.querySelector("[data-key]").value.trim(),
    label: row.querySelector("[data-label]").value.trim(),
    type: row.querySelector("[data-type]").value,
    source: row.querySelector("[data-source]").value,
    excel_aliases: row.querySelector("[data-aliases]").value.split(",").map((item) => item.trim()).filter(Boolean),
    searchable: row.querySelector("[data-searchable]").checked,
    copyable: row.querySelector("[data-copyable]").checked,
    required: row.querySelector("[data-required]").checked,
    result_area: row.querySelector("[data-area]").value,
  })).filter((field) => field.key);

  // field map for later use
  const fieldMap = Object.fromEntries((config.fields || []).map((field) => [field.key, field]));

  // Version
  config.version = $("configVersion").value.trim();

  // Data source
  config.data_source = {
    base_url: $("dsBaseUrl").value.trim(),
    config_file: $("dsConfigFile").value.trim(),
    price_bundle_file: $("dsPriceFile").value.trim(),
    stock_bundle_file: $("dsStockFile").value.trim(),
    version_file: $("dsVersionFile").value.trim(),
    cache_name: $("dsCacheName").value.trim(),
  };

  // Labels — 只发送非空值，避免空字符串覆盖前端默认值
  const rawLabels = {
    app_title: $("uiAppTitle").value.trim(),
    search_button: $("lblSearchBtn").value.trim(),
    stock_search_button: $("lblStockBtn").value.trim(),
    mmc_button: $("lblMmcBtn").value.trim(),
    copy_button: $("lblCopyBtn").value.trim(),
    selected_label: $("lblSelected").value.trim(),
    config_button: $("lblConfig").value.trim(),
    input_title: $("lblInputTitle").value.trim(),
    result_title: $("lblResultTitle").value.trim(),
    query_placeholder: $("lblQueryPlaceholder").value.trim(),
    empty_hint: $("lblEmptyHint").value.trim(),
    stock_prefix: $("lblStockPrefix").value.trim(),
  };
  config.labels = {};
  Object.keys(rawLabels).forEach(function(k) {
    if (rawLabels[k]) config.labels[k] = rawLabels[k];
  });

  // Rules
  config.rules = Array.from(document.querySelectorAll("[data-rule-row]")).map((row) => {
    const isDefault = row.querySelector("[data-rule-default]").value === "true";
    const condition = {
      field: row.querySelector("[data-rule-field]").value.trim(),
      op: row.querySelector("[data-rule-op]").value,
      value: row.querySelector("[data-rule-value]").value.trim(),
    };
    const rule = {
      id: row.querySelector("[data-rule-id]").value.trim(),
      label: row.querySelector("[data-rule-label]").value.trim(),
      priority: Number(row.querySelector("[data-rule-priority]").value || 999),
      default: isDefault,
      actions: [{ type: "set_discount", percent: Number(row.querySelector("[data-rule-percent]").value || 55) }],
    };
    if (!isDefault) rule.when = { all: [condition] };
    return rule;
  }).filter((rule) => rule.id);

  // Copy columns
  config.copy.empty_value = $("copyEmptyValue").value;
  config.copy.price_prefix = $("copyPricePrefix").value.trim();
  config.copy.columns = Array.from(document.querySelectorAll("[data-copy-row]")).map((row) => {
    const fieldKey = row.querySelector("[data-copy-field]").value.trim();
    const field = fieldKey ? fieldMap[fieldKey] : null;
    return {
      field: fieldKey,
      label: (field && field.label) || fieldKey,
      line: row.querySelector("[data-copy-line]").value,
      default: row.querySelector("[data-copy-default]").checked,
      prefix: row.querySelector("[data-copy-prefix]").value,
    };
  }).filter((column) => column.field);

  // UI config — result_layout goes at top level (apps/config-core.js reads raw.result_layout, not raw.ui.result_layout)
  const rowFields = Array.from(document.querySelectorAll("[data-ui-field-row]"));
  const layout = { identity: [], metrics: [], chips: [], details: [] };
  /* fieldMap defined above */
  rowFields.forEach((row) => {
    const key = row.dataset.fieldKey;
    if (!key) return;
    const checked = row.querySelector("[data-ui-field-visible]").checked;
    if (!checked) return;
    // result_area values are singular: identity/metric/chip/detail
    // layout keys are plural for metrics/chips/details to match apps/app.js convention
    const area = (fieldMap[key] && fieldMap[key].result_area) || "detail";
    const layoutKey = area === "identity" ? "identity" : area + "s"; // metric→metrics, chip→chips, detail→details
    if (layout[layoutKey]) {
      layout[layoutKey].push(key);
    } else {
      layout.details.push(key);
    }
  });
  config.ui = {
    app_title: $("uiAppTitle").value.trim() || "智能询价系统",
  };
  config.result_layout = layout;

  // Pricing
  const discountStepVal = Number($("pricingDiscountStep").value ?? 0.1);
  const discountStepMin = Math.max(0.01, discountStepVal);
  const presetsRaw = ($("pricingDiscountStepPresets").value || "").split(/[,，\s]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
  config.pricing = {
    currency: "CNY",
    decimal_places: Number($("pricingDecimals").value ?? 1),
    discount_step: {
      default: Math.max(discountStepMin, discountStepVal),
      min: discountStepMin,
      presets: presetsRaw.length ? presetsRaw : [0.1, 0.5, 1],
    },
    rounding: {
      mode: $("pricingRoundMode").value || "ceil",
      integer_above: Number($("pricingIntegerAbove").value ?? 100),
    },
    default_formula: $("pricingFormula").value.trim() || "face_price * discount_percent / 100",
  };

  state.config = config;
  return config;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function option(value, label, current) {
  return `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
}

const fieldTypeOptions = [
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "computed", label: "计算" },
];
const fieldSourceOptions = [
  { value: "price", label: "价格" },
  { value: "stock", label: "库存" },
  { value: "both", label: "价格+库存" },
  { value: "computed", label: "计算" },
];
const ruleOperators = [
  { value: "contains", label: "包含" },
  { value: "equals", label: "等于" },
  { value: "regex", label: "正则" },
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
];
const copyLineOptions = [
  { value: "main", label: "主行" },
  { value: "detail", label: "详情行" },
];
const copyLineLabels = Object.fromEntries(copyLineOptions.map((item) => [item.value, item.label]));
const resultAreaOptions = [
  { value: "identity", label: "身份区" },
  { value: "metric", label: "指标区" },
  { value: "chip", label: "标签区" },
  { value: "detail", label: "详情区" },
];
const resultAreaLabels = Object.fromEntries(resultAreaOptions.map((item) => [item.value, item.label]));

function getFieldSelectOptions(currentKey, onlyCopyable = false) {
  const fields = (state.config.fields || []).filter((field) => !onlyCopyable || field.copyable || field.key === currentKey);
  const ordered = fields.sort((a, b) => String(a.label || a.key).localeCompare(String(b.label || b.key), "zh-CN"));
  const promptLabel = onlyCopyable ? "请选择可复制字段" : "请选择字段";
  const prompt = `<option value=""${!currentKey ? " selected" : ""}>${promptLabel}</option>`;
  const options = ordered.map((field) => {
    const selected = field.key === currentKey ? " selected" : "";
    const label = `${field.label || field.key}${field.copyable ? "" : " (不可复制)"}`;
    return `<option value="${escapeHtml(field.key)}"${selected}>${escapeHtml(label)} (${escapeHtml(field.key)})</option>`;
  }).join("");
  return prompt + options;
}

function getCopyFieldOptions(currentKey) {
  return getFieldSelectOptions(currentKey, true);
}

function getFieldAreaLabel(area) {
  return resultAreaLabels[area] || "详情区";
}

function renderAll() {
  $("revision").value = state.config.revision || "";
  $("activeRevision").textContent = state.config.revision || "未发布";

  // Version
  const ds = state.config.data_source || {};
  $("configVersion").value = state.config.version || "";

  // Data source
  $("dsBaseUrl").value = ds.base_url || "";
  $("dsConfigFile").value = ds.config_file || "config.json";
  $("dsPriceFile").value = ds.price_bundle_file || "price.bundle.json";
  $("dsStockFile").value = ds.stock_bundle_file || "stock.bundle.json";
  $("dsVersionFile").value = ds.version_file || "version.json";
  $("dsCacheName").value = ds.cache_name || "quotation-cache-v3";

  // Labels
  const labels = state.config.labels || {};
  $("lblSearchBtn").value = labels.search_button || "";
  $("lblStockBtn").value = labels.stock_search_button || "";
  $("lblMmcBtn").value = labels.mmc_button || "";
  $("lblCopyBtn").value = labels.copy_button || "";
  $("lblSelected").value = labels.selected_label || "";
  $("lblConfig").value = labels.config_button || "";
  $("lblInputTitle").value = labels.input_title || "";
  $("lblResultTitle").value = labels.result_title || "";
  $("lblQueryPlaceholder").value = labels.query_placeholder || "";
  $("lblEmptyHint").value = labels.empty_hint || "";
  $("lblStockPrefix").value = labels.stock_prefix || "";

  // Copy
  const copy = state.config.copy || {};
  $("copyEmptyValue").value = copy.empty_value || "";
  $("copyPricePrefix").value = copy.price_prefix || "";

  renderFieldRows();
  renderRuleRows();
  renderCopyRows();
  renderUiConfig();
  renderPricing();
  updateAdvancedJson();
  updatePreview();
}

function renderFieldRows() {
  $("fieldRows").innerHTML = (state.config.fields || []).map((field, index) => `
    <tr data-field-row>
      <td><input data-key value="${escapeHtml(field.key || "")}"></td>
      <td><input data-label value="${escapeHtml(field.label || "")}"></td>
      <td><select data-type>${fieldTypeOptions.map((item) => option(item.value, item.label, field.type || "text")).join("")}</select></td>
      <td><select data-source>${fieldSourceOptions.map((item) => option(item.value, item.label, field.source || "price")).join("")}</select></td>
      <td><input data-aliases value="${escapeHtml((field.excel_aliases || []).join(", "))}"></td>
      <td><input data-searchable type="checkbox"${field.searchable ? " checked" : ""}></td>
      <td><input data-copyable type="checkbox"${field.copyable ? " checked" : ""}></td>
      <td><input data-required type="checkbox"${field.required ? " checked" : ""} title="必填"></td>
      <td><select data-area>${resultAreaOptions.map((item) => option(item.value, item.label, field.result_area || "detail")).join("")}</select></td>
      <td><button type="button" data-remove-field="${index}">×</button></td>
    </tr>
  `).join("");
}

function renderRuleRows() {
  const rules = state.config.rules || [];

  if (!rules.length) {
    $("ruleRows").innerHTML =
      `<p class="hint" style="color:var(--muted);">
        暂无规则，点击"添加规则"开始配置。
      </p>`;
    return;
  }

  const header = `
    <div class="rule-row rule-row--header" aria-hidden="true">
      <span>ID</span>
      <span>名称</span>
      <span>优先级</span>
      <span>默认</span>
      <span>字段</span>
      <span>折扣%</span>
      <span>条件</span>
      <span>匹配值</span>
      <span></span>
    </div>
  `;

  const rows = rules.map((rule, index) => {

    const condition =
      ((rule.when || {}).all || [{}])[0] || {};

    const action =
      (rule.actions || [{}])[0] || {};

    return `
      <div class="rule-row" data-rule-row>

        <input
          data-rule-id
          value="${escapeHtml(rule.id || "")}"
          placeholder="ID">

        <input
          data-rule-label
          value="${escapeHtml(rule.label || "")}"
          placeholder="规则名称">

        <input
          data-rule-priority
          type="number"
          value="${escapeHtml(rule.priority || 999)}">

        <select data-rule-default>
          <option value="false"${rule.default ? "" : " selected"}>否</option>
          <option value="true"${rule.default ? " selected" : ""}>是</option>
        </select>

        <select data-rule-field>
          ${getFieldSelectOptions(condition.field || "")}
        </select>

        <input
          data-rule-percent
          type="number"
          value="${escapeHtml(action.percent || 55)}">

        <select data-rule-op>
          ${ruleOperators.map(item =>
            option(
              item.value,
              item.label,
              condition.op || "contains"
            )
          ).join("")}
        </select>

        <input
          data-rule-value
          value="${escapeHtml(condition.value || "")}"
          placeholder="匹配值">

        <button
          type="button"
          class="small-btn danger-btn"
          data-remove-rule="${index}">
          删除
        </button>

      </div>
    `;
  }).join("");

  $("ruleRows").innerHTML = header + rows;
}

function renderCopyRows() {
  const columns = ((state.config.copy || {}).columns || []);
  if (!columns.length) {
    $("copyRows").innerHTML = `<p class="hint" style="color:var(--muted);">暂无列，点击"添加列"开始配置。</p>`;
    return;
  }
  // 表格布局：只渲染一行标题 + 数据行，避免每行重复标题
  const header = `<div class="copy-row copy-row--header" aria-hidden="true">
    <span>字段</span>
    <span>行类型</span>
    <span style="text-align:center;">默认显示</span>
    <span>前缀</span>
    <span></span>
  </div>`;
  const rows = columns.map((column, index) => `
    <div class="copy-row" data-copy-row>
      <select data-copy-field aria-label="字段">
        ${getCopyFieldOptions(column.field || "")}
      </select>
      <select data-copy-line aria-label="行类型">${copyLineOptions.map((item) => option(item.value, item.label, column.line || "main")).join("")}</select>
      <input data-copy-default type="checkbox" aria-label="默认显示"${column.default ? " checked" : ""} style="justify-self:center;">
      <input data-copy-prefix value="${escapeHtml(column.prefix || "")}" placeholder="例如：含税、含运费" aria-label="前缀">
      <button type="button" data-remove-copy="${index}" class="small-btn danger-btn">移除</button>
    </div>
  `).join("");
  $("copyRows").innerHTML = header + rows;
}

function renderUiConfig() {
  const ui = state.config.ui || {};
  $("uiAppTitle").value = ui.app_title || "智能询价系统";

  // result_layout can be at top level (raw) or nested under ui (legacy/loaded from DB)
  const rawLayout = state.config.result_layout || (state.config.ui || {}).result_layout || {};
  const fields = state.config.fields || [];

  // Derive visible keys from layout
  const visibleKeys = new Set([
    ...(rawLayout.identity || []),
    ...(rawLayout.metrics || []),
    ...(rawLayout.chips || []),
    ...(rawLayout.details || []),
  ]);

  // If layout is empty (new config), default all fields to visible
  if (!visibleKeys.size) {
    fields.forEach((f) => visibleKeys.add(f.key));
  }

  $("uiFieldLayout").innerHTML = fields.map((field) => {
    const visible = visibleKeys.has(field.key);
    return `
      <label class="ui-field-row" data-ui-field-row data-field-key="${escapeHtml(field.key)}">
        <span class="ui-field-name">${escapeHtml(field.label || field.key)}</span>
        <span class="ui-field-area">${escapeHtml(getFieldAreaLabel(field.result_area || "detail"))}</span>
        <input data-ui-field-visible type="checkbox"${visible ? " checked" : ""}>
      </label>
    `;
  }).join("");
}

function renderPricing() {
  const pricing = state.config.pricing || {};
  $("pricingFormula").value = pricing.default_formula || "face_price * discount_percent / 100";
  $("pricingDecimals").value = pricing.decimal_places ?? 1;
  // discount_step can be a flat number (legacy) or object (current)
  const ds = pricing.discount_step || {};
  const stepDefault = typeof ds === "number" ? ds : (ds.default ?? 0.1);
  const stepPresets = Array.isArray(ds.presets) ? ds.presets : [0.1, 0.5, 1];
  $("pricingDiscountStep").value = stepDefault;
  $("pricingDiscountStepPresets").value = stepPresets.join(", ");
  const rounding = pricing.rounding || {};
  $("pricingRoundMode").value = rounding.mode || "ceil";
  $("pricingIntegerAbove").value = rounding.integer_above ?? 100;
}

function updateAdvancedJson() {
  $("advancedJson").value = JSON.stringify(state.config, null, 2);
}


  
function updatePreview() {
  // inspector 已移除，copyPreview DOM 元素已删除
}

// ─── Config API Calls ────────────────────────────────────────────────────────

async function loadConfig() {
  const confirmed = confirm("将从 Supabase 下载 config.json 覆盖当前草稿，未保存的修改会丢失。\n\n是否继续？");
  if (!confirmed) return;

  sbAutoFillBaseUrl();
  const baseUrl = sbGetBaseUrl();
  const configUrl = baseUrl + "/config.json";

  try {
    const resp = await fetch(configUrl + "?t=" + Date.now());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    // 确保 schema_version 存在，标记为草稿
    if (!raw.schema_version) raw.schema_version = 2;
    raw.status = "draft";
    state.config = raw;
    renderAll();
    setStatus("✅ 已从 Supabase 恢复 config.json");
  } catch (err) {
    setStatus("❌ 从 Supabase 恢复失败: " + (err.message || err), true);
  }
}

async function saveConfig(status) {
  const config = collectConfig();
  state.config = await request("/api/config", {
    method: "POST",
    body: JSON.stringify({ config, status }),
  });
  renderAll();

  // 发布时自动部署到 Supabase
  if (status === "published") {
    try {
      // 上传 config.json（剥离 data_source，保留纯 UI 配置）
      const frontendCfg = {};
      for (const [k, v] of Object.entries(state.config)) {
          if (k !== "data_source") {
              frontendCfg[k] = v;
          }
      }
      await sbUploadFile("config.json", JSON.stringify(frontendCfg, null, 2), "application/json;charset=utf-8");

      // 上传 version.json
      const revision = state.config.revision || state.config.version || "";
      const versionPayload = JSON.stringify({
        version: revision,
        updated_at: new Date().toISOString(),
      }, null, 2);
      await sbUploadFile("version.json", versionPayload, "application/json;charset=utf-8");

      setStatus("配置已发布并同步到 Supabase");
    } catch (err) {
      console.error("Supabase 同步失败:", err);
      setStatus("Supabase 同步失败: " + (err.message || err), true);
    }
  } else {
    setStatus("草稿已保存");
  }
  await updatePreview();
}

async function validateConfig() {
  try {
    const result = await request("/api/config/validate");
    if (result.valid) {
      setStatus("服务器端验证通过：配置合法");
    } else {
      setStatus("验证失败：\n" + result.errors.join("\n"), true);
    }
  } catch (err) {
    setStatus("加载失败: " + (err.message || err), true);
  }
}

async function loadHistory() {
  const configs = await request("/api/configs");
  const list = $("historyList");
  if (!configs.length) {
    list.innerHTML = '<p style="color:var(--muted)">暂无配置记录</p>';
  } else {
    list.innerHTML = configs.map((cfg) => {
      const isPublished = cfg.status === "published";
      const isArchived = cfg.status === "archived";
      const badge = isPublished ? '<span class="badge badge-green">已发布</span>'
        : isArchived ? '<span class="badge badge-muted">已归档</span>'
        : '<span class="badge">草稿</span>';
      return `<div class="history-item">
        <div>
          <strong>${escapeHtml(cfg.revision)}</strong> ${badge}
          <small>${cfg.created_at || ""}</small>
        </div>
        <div>
          <button type="button" class="small-btn" onclick="rollbackToRevision('${escapeHtml(cfg.revision)}')">发布此版本</button>
          <button type="button" class="small-btn danger-btn" onclick="deleteConfigRevision('${escapeHtml(cfg.revision)}')">删除</button>
        </div>
      </div>`;
    }).join("");
  }
  setStatus(`共 ${configs.length} 个版本`);
}

async function rollbackToRevision(revision) {
  if (!confirm(`确认将版本 ${revision} 设为当前发布配置？`)) return;
  const config = await request(`/api/config/${encodeURIComponent(revision)}/publish`, { method: "POST" });
  state.config = config;
  renderAll();
  setStatus(`已回滚到版本 ${revision}`);

  // 发布后自动部署到 Supabase
  try {
    const frontendCfg = {};
    for (const [k, v] of Object.entries(config)) {
        if (k !== "data_source") {
            frontendCfg[k] = v;
        }
    }
    await sbUploadFile("config.json", JSON.stringify(frontendCfg, null, 2), "application/json;charset=utf-8");
    const versionPayload = JSON.stringify({
      version: config.revision || "",
      updated_at: new Date().toISOString(),
    }, null, 2);
    await sbUploadFile("version.json", versionPayload, "application/json;charset=utf-8");
    setStatus("已回滚并同步到 Supabase");
  } catch (err) {
    console.error("Supabase 同步失败:", err);
    setStatus("Supabase 同步失败: " + (err.message || err), true);
  }
}

async function deleteConfigRevision(revision) {
  if (!confirm(`确认删除版本 ${revision}？`)) return;
  await request(`/api/config/${encodeURIComponent(revision)}`, { method: "DELETE" });
  setStatus(`已删除版本 ${revision}`);
  await loadHistory();
}

async function loadAudit() {
  const events = await request("/api/audit");
  const list = $("auditList");
  if (!events.length) {
    list.innerHTML = '<p style="color:var(--muted)">暂无审计记录</p>';
  } else {
    list.innerHTML = events.map((e) => {
      return `<div class="audit-item">
        <strong>${escapeHtml(e.action)}</strong>
        <small>${e.created_at || ""}</small>
        <span>${escapeHtml(e.target_type)}/${escapeHtml(e.target_id || "")}</span>
      </div>`;
    }).join("");
  }
}

async function exportConfig() {
  const revision = $("exportRevision").value.trim();
  const fmt = $("exportFormat").value;
  if (!revision) { setStatus("请输入要导出的版本号", true); return; }
  try {
    const response = await fetch(`${apiBase}/api/config/${revision}/export?fmt=${fmt}`);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    const blob = new Blob([text], { type: fmt === "yaml" ? "text/yaml" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `config-${revision}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出版本 ${revision}`);
  } catch (err) {
    setStatus("导出失败: " + (err.message || err), true);
  }
}

async function importJson() {
  const content = $("importContent").value.trim();
  if (!content) { setStatus("请粘贴 JSON/YAML 配置内容", true); return; }
  try {
    state.config = await request("/api/config/import", {
      method: "POST",
      body: JSON.stringify({ content, fmt: "json" }),
    });
    renderAll();
    setStatus("配置已导入为草稿");
  } catch (err) {
    setStatus("导入失败: " + (err.message || err), true);
  }
}

// ─── Event Binding ──────────────────────────────────────────────────────────

function bind() {
  if (g_AdminEventsBound) return;
  g_AdminEventsBound = true;
  document.body.addEventListener("input", (event) => {
    if (!event.target.closest(".workspace")) return;

    const fieldRow = event.target.closest("[data-field-row]");
    const ruleRow = event.target.closest("[data-rule-row]");
    const copyRow = event.target.closest("[data-copy-row]");
    const uiFieldRow = event.target.closest("[data-ui-field-row]");

    if (fieldRow || ruleRow || copyRow || uiFieldRow) {
      try {
        // 实时回填 state.config，确保各区域渲染读到最新数据
        const config = collectConfig();
        state.config = config;
        renderRuleRows();
        renderCopyRows();
        renderUiConfig();
      } catch { /* ignore render errors */ }
    }
  });

  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    // Remove buttons — modify state.config directly
    if (target.dataset.removeField) { state.config.fields.splice(Number(target.dataset.removeField), 1); renderAll(); return; }
    if (target.dataset.removeRule) { state.config.rules.splice(Number(target.dataset.removeRule), 1); renderAll(); return; }
    if (target.dataset.removeCopy) { state.config.copy.columns.splice(Number(target.dataset.removeCopy), 1); renderAll(); return; }

    // Rollback
    if (target.dataset.rollback) { run(() => rollbackToRevision(target.dataset.rollback)); return; }
    // Delete revision
    if (target.dataset.deleteRevision) { run(() => deleteConfigRevision(target.dataset.deleteRevision)); return; }

  });

  // Config
  $("loadConfigBtn").addEventListener("click", () => run(loadConfig));
  $("saveDraftBtn").addEventListener("click", () => run(() => saveConfig("draft")));
  $("publishBtn").addEventListener("click", () => run(() => saveConfig("published")));
  $("validateConfigBtn").addEventListener("click", () => run(validateConfig));

  // Fields / rules / copy add — modify state.config directly, no collectConfig side effect
  $("addFieldBtn").addEventListener("click", () => {
    state.config.fields.push({ key: "", label: "", type: "text", source: "price", excel_aliases: [], searchable: false, copyable: false, required: false, result_area: "detail" });
    renderAll();
  });
  $("addRuleBtn").addEventListener("click", () => {
    state.config.rules.push({ id: "new_rule", label: "新规则", priority: 100, when: { all: [{ field: "spec", op: "contains", value: "" }] }, actions: [{ type: "set_discount", percent: 55 }] });
    renderAll();
  });
  $("addCopyColumnBtn").addEventListener("click", () => {
    state.config.copy.columns.push({ field: "spec", label: "规格", default: true, line: "main" });
    renderAll();
  });

  // Misc
  $("exportJsonBtn").addEventListener("click", () => run(() => exportConfig("json")));
  $("exportYamlBtn").addEventListener("click", () => run(() => exportConfig("yaml")));
  $("importJsonBtn").addEventListener("click", () => run(importJson));
  $("loadHistoryBtn").addEventListener("click", () => run(loadHistory));
  $("loadAuditBtn").addEventListener("click", () => run(loadAudit));

  // ─── Supabase 部署面板 ────────────────────────────────────────────
  sbAnonKeyInput  = $("sb-anonKey");
  sbBaseUrlInput  = $("sb-baseUrl");

  // 恢复 anon key
  try {
    if (sbAnonKeyInput) sbAnonKeyInput.value = sessionStorage.getItem(SB_KEY) || "";
  } catch {}

  // 上传 config.json（使用当前草稿配置）
  const sbUploadConfigBtn = $("sb-uploadConfigBtn");
  if (sbUploadConfigBtn) sbUploadConfigBtn.addEventListener("click", async () => {
    try {
      sbAutoFillBaseUrl();
      const cfg = collectConfig();
      await sbUploadFile("config.json", JSON.stringify(cfg, null, 2), "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传价格包（优先读取拼接区内存数据，回退到文件选择器）
  const sbUploadPriceBtn = $("sb-uploadPriceBtn");
  if (sbUploadPriceBtn) sbUploadPriceBtn.addEventListener("click", async () => {
    try {
      let text = null;
      // 优先使用拼接区已生成的价格包（无需手动下载再上传）
      if (window._mergerBundles && window._mergerBundles.price) {
        text = window._mergerBundles.price;
        sbSetStatus("ℹ️ 使用拼接区刚生成的价格包…", "info");
      } else {
        const fileInput = $("sb-priceFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区导出价格包，或手动选择 price.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text); // 校验合法 JSON
      await sbUploadFile("price.bundle.json", text, "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传库存包（优先读取拼接区内存数据，回退到文件选择器）
    const sbUploadStockBtn = $("sb-uploadStockBtn");
    if (sbUploadStockBtn) sbUploadStockBtn.addEventListener("click", async () => {
      try {
        let text = null;
        if (window._mergerBundles && window._mergerBundles.stock) {
          text = window._mergerBundles.stock;
          sbSetStatus("ℹ️ 使用拼接区刚生成的库存包…", "info");
        } else {
          const fileInput = $("sb-stockFileInput");
          if (!fileInput || !fileInput.files || !fileInput.files[0])
            throw new Error("请先在数据拼接区导出库存包，或手动选择 stock.bundle.json 文件");
          text = await fileInput.files[0].text();
        }
        JSON.parse(text);
        await sbUploadFile("stock.bundle.json", text, "application/json;charset=utf-8");
      } catch (err) {
        sbSetStatus("❌ " + err.message, "error");
      }
    });

    // 生成独立报价单
    const sbGenerateBtn = $("sb-generateStandaloneBtn");
    if (sbGenerateBtn) sbGenerateBtn.addEventListener("click", () => run(generateStandalone));

    // 上传独立报价单到 Supabase
    const sbDeployBtn = $("sb-deployStandaloneBtn");
    if (sbDeployBtn) sbDeployBtn.addEventListener("click", () => run(deployStandalone));

  // 当 base_url input 聚焦时尝试从 config 自动填充
  if (sbBaseUrlInput) sbBaseUrlInput.addEventListener("focus", sbAutoFillBaseUrl);
}

async function run(task) {
  try {
    await task();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setJsStatus(text) {
  const el = $("jsStatus");
  if (el) el.textContent = text;
}

window.addEventListener("DOMContentLoaded", bind);
setJsStatus("已就绪");
renderAll();

// Ctrl+Shift+S 保存快捷键（避免与浏览器 Ctrl+S 冲突）
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "s") {
    e.preventDefault();
    run(() => saveConfig("draft"));
  }
});
