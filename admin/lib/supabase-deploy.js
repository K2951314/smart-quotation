/**
 * supabase-deploy.js — Supabase Storage 上传工具。
 *
 * 依赖：admin-core.js（sbAnonKeyInput、sbBaseUrlInput、collectConfig、request、state）
 */

const SB_KEY = "quotation-admin-sb-anon-key";

/**
 * 统一脱敏函数：用于上传 config.json 到 Supabase 公开桶。
 *
 * 与后端 store/configs.py desensitize_config() 对齐：
 * - 移除 rules（折扣条件，可反推面价）
 * - 移除 discount_rules（折扣规则，可反推面价）
 * - 移除 pricing.default_formula（可能含面价引用）
 * - 设置 _desensitized = true 标记（供客户端识别）
 * - 保留 data_source（客户端需要 base_url 拉取 bundle）
 *
 * 安全：三处调用（saveConfig / sbUploadConfigBtn / rollbackToRevision）共用此函数，
 * 避免遗漏导致 rules/discount_rules 泄露到公开桶。
 */
function desensitizeConfigForPublic(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  var safe = {};
  for (var k in cfg) {
    if (!cfg.hasOwnProperty(k)) continue;
    // 移除敏感字段：rules、discount_rules
    if (k === "rules" || k === "discount_rules") continue;
    safe[k] = cfg[k];
  }
  // 移除 pricing.default_formula
  if (safe.pricing && typeof safe.pricing === "object") {
    safe.pricing = {};
    for (var pk in cfg.pricing) {
      if (!cfg.pricing.hasOwnProperty(pk)) continue;
      if (pk === "default_formula") continue;
      safe.pricing[pk] = cfg.pricing[pk];
    }
  }
  // 设置脱敏标记（与后端 desensitize_config 对齐）
  safe._desensitized = true;
  return safe;
}

function sbAutoFillBaseUrl() {
  // Base URL 输入框已移除（type=hidden），改为在 sbGetBaseUrl 中直接从后端拉取
  // 保留此函数以兼容 event-bindings.js 的 focus 监听（若 DOM 已无则直接 return）
  if (!sbBaseUrlInput) return;
  try {
    const cfg = collectConfig();
    const baseUrl = (cfg.data_source && cfg.data_source.base_url) ? cfg.data_source.base_url : "";
    if (baseUrl) sbBaseUrlInput.value = baseUrl;
  } catch { }
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
  try { sessionStorage.setItem(SB_KEY, key); } catch { }
  return key;
}

/**
 * 从后端 /api/settings/datasource 获取有效 Supabase Base URL。
 * request() 会自动追加当前选中公司的 company_id（withCompany 正则含 settings）。
 * 优先级：当前公司 meta.supabase_base_url → 环境变量 SQ_SUPABASE_BASE_URL。
 */
async function sbFetchBaseUrl() {
  try {
    const settings = await request("/api/settings/datasource");
    const url = (settings.supabase_base_url || "").trim();
    if (url && sbBaseUrlInput) sbBaseUrlInput.value = url;
    return url;
  } catch (err) {
    throw new Error("获取数据源地址失败: " + (err.message || err));
  }
}

async function sbGetBaseUrl() {
  let url = sbBaseUrlInput ? sbBaseUrlInput.value.trim() : "";
  if (!url) {
    url = await sbFetchBaseUrl();
  }
  if (!url) {
    throw new Error("未配置 Supabase Base URL——请到「公司管理」点击「数据源」按钮设置，或在后端 .env 设置 SQ_SUPABASE_BASE_URL");
  }
  return url.replace(/\/+$/, "");
}

/** 将字符串内容通过 Supabase Storage PUT 上传到指定文件名 */
async function sbUploadFile(filename, content, contentType) {
  const key = sbGetAnonKey();
  const baseUrl = await sbGetBaseUrl();

  const publicPrefix = "/storage/v1/object/public/";
  const writePrefix = "/storage/v1/object/";
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
      "apikey": key,
      "authorization": "Bearer " + key,
      "content-type": contentType || "application/json;charset=utf-8",
      "x-upsert": "true",
    },
    body: content,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("上传失败 HTTP " + resp.status + ": " + text.slice(0, 200));
  }
  sbSetStatus("✅ 已成功上传 " + filename, "ok");
}

/** 上传 bundle 后自动更新 version.json，让前端发现版本变了重新下载 bundle */
async function sbUpdateVersionJson() {
  let dataRev = "";
  try {
    const stats = await request("/api/items/stats");
    dataRev = (stats && stats.data_revision) || "";
  } catch (e) {
    // fallback：使用当前配置的 revision，与 saveConfig 对齐
    dataRev = (state.config && state.config.revision) || "";
  }
  if (!dataRev) dataRev = new Date().toISOString();
  const versionPayload = JSON.stringify({
    version: dataRev,
    updated_at: new Date().toISOString(),
  }, null, 2);
  await sbUploadFile("version.json", versionPayload, "application/json;charset=utf-8");
}

// 加载配置后预填充 Supabase Base URL（异步，不阻塞 UI）
// 从后端 /api/settings/datasource 获取有效地址（环境变量 → 公司 meta）
function autoFillSupabaseUrl() {
  if (!sbBaseUrlInput || sbBaseUrlInput.value.trim()) return;
  sbFetchBaseUrl().catch(function () { /* 静默失败，上传时会再报错 */ });
}
