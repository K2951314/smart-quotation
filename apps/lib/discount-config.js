/**
 * discount-config.js — 默认折扣设置弹窗（配置驱动，动态生成品牌输入框）。
 *
 * 依赖：state.js, config-helpers.js
 */

function getSystemDefaultDiscountConfig() {
  var base = DiscountEngine.FALLBACK_DISCOUNT_CONFIG;
  var remote = g_RemoteDefaultDiscountConfig || {};
  var merged = {};
  Object.keys(base).forEach(function(k) { merged[k] = base[k]; });
  Object.keys(remote).forEach(function(k) { merged[k] = remote[k]; });
  return DiscountEngine.sanitizeDiscountConfig(merged, base);
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
  var base = DiscountEngine.FALLBACK_DISCOUNT_CONFIG;
  return DiscountEngine.sanitizeDiscountConfig(g_DefaultDiscountConfig || getSystemDefaultDiscountConfig(), base);
}

function applyRemoteDefaultDiscountConfig(config) {
  g_RemoteDefaultDiscountConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  var remoteRules = (g_AppConfig && g_AppConfig.discount_rules) || [];
  g_RemoteDiscountRules = remoteRules;
  g_DefaultDiscountConfig = getSystemDefaultDiscountConfig();
  syncDefaultDiscountButtonSummary();
  buildDefaultDiscountForm(g_DefaultDiscountConfig, remoteRules);
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  refreshRowsWithDefaultDiscounts();
}

function getDefaultDiscountConfigSummary(config) {
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  var rules = (g_AppConfig && g_AppConfig.discount_rules) || [];
  if (rules.length) {
    return rules.map(function(rule) {
      var id = String(rule.id || "").toLowerCase();
      var percent = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
        ? Number(safeConfig[id])
        : (Number.isFinite(Number(rule.percent)) ? Number(rule.percent) : 55);
      return (rule.label || rule.id) + " " + formatCompactNumber(percent) + "%";
    }).join(" / ");
  }
  return ["其他 " + formatCompactNumber(safeConfig.other || 55) + "%"].join(" / ");
}

/** 动态构建折扣弹窗输入框（根据 discount_rules 生成） */
function buildDefaultDiscountForm(config, rules) {
  var grid = document.querySelector("#defaultDiscountModal .discount-config-grid");
  if (!grid) return;
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  grid.innerHTML = "";
  var displayRules = (Array.isArray(rules) && rules.length) ? rules : [
    { id: "other", label: "其他", percent: safeConfig.other || 55, default: true }
  ];
  displayRules.forEach(function(rule) {
    var id = String(rule.id || "").toLowerCase();
    var label = rule.label || rule.id || "规则";
    var percent = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
      ? Number(safeConfig[id])
      : (Number.isFinite(Number(rule.percent)) ? Number(rule.percent) : 55);
    var inputId = "defaultDiscount-" + id;
    var html = '<label class="discount-config-field" for="' + inputId + '">'
      + '<span>' + label + '</span>'
      + '<div class="field-shell">'
      + '<input type="number" id="' + inputId + '" min="0" max="100" step="0.1" inputmode="decimal" data-discount-id="' + id + '">'
      + '<span class="field-unit">%</span>'
      + '</div>'
      + '</label>';
    grid.insertAdjacentHTML("beforeend", html);
  });
}

function syncDefaultDiscountForm(config) {
  var safeConfig = DiscountEngine.sanitizeDiscountConfig(config, config);
  var inputs = document.querySelectorAll("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
  inputs.forEach(function(input) {
    var id = input.getAttribute("data-discount-id") || "";
    var value = (safeConfig[id] !== undefined && Number.isFinite(Number(safeConfig[id])))
      ? Number(safeConfig[id])
      : 55;
    input.value = formatCompactNumber(value);
  });
  var legacyMapping = { defaultDiscountEx: safeConfig.ex, defaultDiscountOsg: safeConfig.osg, defaultDiscountMitsubishi: safeConfig.mitsubishi, defaultDiscountOther: safeConfig.other };
  Object.keys(legacyMapping).forEach(function(elId) {
    var input = document.getElementById(elId);
    if (input) input.value = formatCompactNumber(legacyMapping[elId]);
  });
}

function readDefaultDiscountForm() {
  var out = {};
  var inputs = document.querySelectorAll("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
  inputs.forEach(function(input) {
    var id = input.getAttribute("data-discount-id") || "";
    if (id) out[id] = Number(input.value) || 55;
  });
  if (Object.keys(out).length === 0) {
    out = {
      ex: document.getElementById("defaultDiscountEx") ? document.getElementById("defaultDiscountEx").value : 32,
      osg: document.getElementById("defaultDiscountOsg") ? document.getElementById("defaultDiscountOsg").value : 36,
      mitsubishi: document.getElementById("defaultDiscountMitsubishi") ? document.getElementById("defaultDiscountMitsubishi").value : 55,
      other: document.getElementById("defaultDiscountOther") ? document.getElementById("defaultDiscountOther").value : 50
    };
  }
  return DiscountEngine.sanitizeDiscountConfig(out, out);
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
  var rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  buildDefaultDiscountForm(g_DefaultDiscountConfig, rules);
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  setDefaultDiscountModalState(true);
  window.requestAnimationFrame(function() {
    var firstInput = document.querySelector("#defaultDiscountModal .discount-config-grid input[data-discount-id]");
    if (firstInput) firstInput.focus();
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
  const rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset(toCoreRow(row), getRuntimeAppConfig())
    : DiscountEngine.getDefaultDiscountPreset({ spec: row.spec, special: row.special, brand: row.brand, name: row.name }, getDefaultDiscountConfig(), rules);
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
