/**
 * copy-clipboard.js — 复制功能、剪贴板辅助、Toast 提示。
 *
 * 依赖：state.js, config-helpers.js, search-render.js
 */

/** 将列字段 ID 映射为行对象的属性名。 */
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

  const useUntaxed = (document.getElementById("chkUntaxedQuote")?.checked) ?? false;
  const settings = getCurrentPriceSettings();
  const decimals = settings.decimals;
  const factor = Math.pow(10, decimals);

  const columns = getCopyColumns();
  const enabled = {};
  columns.forEach(function (col) {
    var cbId = makeCopyCheckboxId(col.field);
    var cb = document.getElementById(cbId);
    enabled[col.field] = cb ? cb.checked : !!col.default;
  });

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
      var lineGroup = col.line || "main";

      if (prop === "price") {
        var rawPrice = parseFloat(row.price) || 0;
        var formatted = (decimals === 0 && rawPrice > settings.threshold)
          ? rawPrice.toFixed(0)
          : rawPrice.toFixed(decimals);
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

// ─── 剪贴板辅助 ──────────────────────────────────────────────

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
