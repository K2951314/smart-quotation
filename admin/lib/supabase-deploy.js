/**
 * supabase-deploy.js — Supabase Storage 上传工具。
 *
 * 依赖：admin-core.js（sbAnonKeyInput、sbBaseUrlInput、collectConfig、request）
 */

const SB_KEY = "quotation-admin-sb-anon-key";

function sbAutoFillBaseUrl() {
  if (!sbBaseUrlInput || sbBaseUrlInput.value.trim()) return;
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

function sbGetBaseUrl() {
  sbAutoFillBaseUrl();
  const url = sbBaseUrlInput ? sbBaseUrlInput.value.trim() : "";
  if (!url) throw new Error("请先填写 Supabase Base URL（data_source.base_url）");
  return url.replace(/\/+$/, "");
}

/** 将字符串内容通过 Supabase Storage PUT 上传到指定文件名 */
async function sbUploadFile(filename, content, contentType) {
  const key = sbGetAnonKey();
  const baseUrl = sbGetBaseUrl();

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
    dataRev = new Date().toISOString();
  }
  if (!dataRev) dataRev = new Date().toISOString();
  const versionPayload = JSON.stringify({
    version: dataRev,
    updated_at: new Date().toISOString(),
  }, null, 2);
  await sbUploadFile("version.json", versionPayload, "application/json;charset=utf-8");
}

// 自动填充 Supabase Base URL 字段（dsBaseUrl + sb-baseUrl）
function autoFillSupabaseUrl() {
  try {
    var cfg = collectConfig();
    var baseUrl = (cfg.data_source && cfg.data_source.base_url) || "";
    if (baseUrl) {
      if (sbBaseUrlInput && !sbBaseUrlInput.value.trim()) {
        sbBaseUrlInput.value = baseUrl;
      }
    }
  } catch { }
}
