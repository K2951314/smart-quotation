/**
 * standalone-html.js — 独立报价单 HTML 生成（离线版）。
 *
 * 将 apps/ 下的所有前端源文件内联到单个 HTML 文件中，
 * 并对 Cache API 调用做 file:// 兼容性修补。
 *
 * 依赖：supabase-deploy.js（sbSetStatus、sbAutoFillBaseUrl、sbUploadFile）
 */

// ─── apps/ 前端文件清单（与 apps/index.html 的 <script> 顺序一致）───
const STANDALONE_FILES = [
  "index.html",
  "styles.css",
  "lib/query-regex.js",
  "lib/discount-utils.js",
  "lib/result-sort.js",
  "lib/config-core.js",
  "lib/state.js",
  "lib/ui-helpers.js",
  "lib/config-helpers.js",
  "lib/search-render.js",
  "lib/copy-clipboard.js",
  "lib/discount-config.js",
  "lib/stock-query.js",
  "lib/auth.js",
  "lib/data-load.js",
  "app.js",
];

function getAppsBaseUrl() {
  return new URL("../apps/", window.location.href).href;
}

async function fetchStandaloneSources() {
  const baseUrl = getAppsBaseUrl();
  const htmlResp = await fetch(baseUrl + "index.html?t=" + Date.now());
  if (!htmlResp.ok) throw new Error("加载 index.html 失败 (HTTP " + htmlResp.status + ")");
  const html = await htmlResp.text();

  const cssResp = await fetch(baseUrl + "styles.css?t=" + Date.now());
  if (!cssResp.ok) throw new Error("加载 styles.css 失败 (HTTP " + cssResp.status + ")");
  const css = await cssResp.text();

  const jsNames = STANDALONE_FILES.filter(function (f) { return f.endsWith(".js"); });
  const jsSources = await Promise.all(jsNames.map(async function (file) {
    const url = baseUrl + file + "?t=" + Date.now();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("加载 " + file + " 失败 (HTTP " + resp.status + ")");
    return resp.text();
  }));

  return { html: html, css: css, jsNames: jsNames, jsSources: jsSources };
}

/** 修补 Cache API 调用，使其在 file:// 协议下不崩溃 */
function patchCacheApi(jsContent) {
  return jsContent
    .replace(
      /const cache = await caches\.open\(cacheName\);\s*\n\s*let response = await cache\.match\(fileUrl\);/,
      "let response = null;\n  if (typeof caches !== 'undefined') {\n    try {\n      const cache = await caches.open(cacheName);\n      response = await cache.match(fileUrl);\n    } catch (e) { response = null; }\n  }"
    )
    .replace(
      /await cache\.put\(fileUrl, response\.clone\(\)\);\s*\n\s*cleanOldCache\(cache, filename, fileUrl\);/,
      "if (typeof caches !== 'undefined') {\n        try {\n          const cache = await caches.open(cacheName);\n          await cache.put(fileUrl, response.clone());\n          cleanOldCache(cache, filename, fileUrl);\n        } catch (e) {}\n      }"
    );
}

function buildStandaloneHtml(sources) {
  const bodyStart = sources.html.indexOf("<body>") + "<body>".length;
  const bodyEnd = sources.html.indexOf("</body>");
  let bodyContent = sources.html.slice(bodyStart, bodyEnd);

  // 移除外部引用
  bodyContent = bodyContent.replace(/<link\s+rel="stylesheet"\s+href="\.\/styles\.css(\?v=[\d]+)?">/g, "");
  bodyContent = bodyContent.replace(/<script\s+src="\.\/lib\/[^"]+\.js(\?v=[\d]+)?"><\/script>/g, "");
  bodyContent = bodyContent.replace(/<script\s+src="\.\/app\.js(\?v=[\d]+)?"><\/script>/g, "");

  // 内联所有 JS 文件（对 data-load.js 做 Cache API 修补）
  const inlineScripts = sources.jsSources.map(function (src, i) {
    var content = src;
    if (sources.jsNames[i] === "lib/data-load.js") {
      content = patchCacheApi(content);
    }
    return "<script>\n" + content + "\n</script>";
  }).join("\n");

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<meta name="theme-color" content="#f7f3ec">\n<title>智能询价系统</title>\n<style>\n' + sources.css + '\n</style>\n</head>\n<body>\n' + bodyContent.trim() + '\n' + inlineScripts + '\n</body>\n</html>';
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
