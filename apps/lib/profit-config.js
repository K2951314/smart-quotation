/**
 * profit-config.js — 客户版整体利润设置弹窗。
 *
 * 参考管理员版 discount-config.js 的 UI 模式（按钮 + 模态框 + 输入框 + 保存/重置/取消）。
 * 保存后更新 auth profile 的 profitMargin，并刷新所有未手动改过利润率的行。
 *
 * 依赖：state.js, auth.js (getAuthProfile, saveAuthProfile, getCompanyProfitMargin, refreshAllCompanyPrices, isCompanyMode)
 */

const DEFAULT_PROFIT_STORAGE_KEY = "sq-default-profit-margin";

var g_DefaultProfitMargin = null;
var g_HasLocalProfitMargin = false;

function getSystemDefaultProfitMargin() {
  var profile = getAuthProfile();
  return (profile && profile.profitMargin !== undefined) ? profile.profitMargin : 10;
}

function loadLocalProfitMargin() {
  try {
    var raw = window.localStorage.getItem(DEFAULT_PROFIT_STORAGE_KEY);
    if (!raw) {
      g_HasLocalProfitMargin = false;
      return null;
    }
    g_HasLocalProfitMargin = true;
    var num = Number(raw);
    return Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : null;
  } catch (e) {
    g_HasLocalProfitMargin = false;
    return null;
  }
}

function persistProfitMargin(value) {
  try {
    var num = Number(value);
    if (!Number.isFinite(num)) return;
    num = Math.min(100, Math.max(0, num));
    window.localStorage.setItem(DEFAULT_PROFIT_STORAGE_KEY, String(num));
    g_HasLocalProfitMargin = true;
  } catch (e) {}
}

function getDefaultProfitMargin() {
  if (g_DefaultProfitMargin !== null) return g_DefaultProfitMargin;
  return getSystemDefaultProfitMargin();
}

function syncProfitConfigForm(value) {
  var input = document.getElementById("defaultProfitMargin");
  if (input) input.value = formatCompactNumber(value);
}

function setProfitConfigModalState(open) {
  var modal = document.getElementById("profitConfigModal");
  if (!modal) return;
  modal.hidden = !open;
  document.body.classList.toggle("has-overlay", open);
}

function openProfitConfig() {
  syncProfitConfigForm(getDefaultProfitMargin());
  setProfitConfigModalState(true);
  window.requestAnimationFrame(function () {
    var input = document.getElementById("defaultProfitMargin");
    if (input) input.focus();
  });
}

function closeProfitConfig() {
  setProfitConfigModalState(false);
}

function resetProfitConfig() {
  syncProfitConfigForm(getSystemDefaultProfitMargin());
}

function saveProfitConfig() {
  var input = document.getElementById("defaultProfitMargin");
  if (!input) return;
  var num = Number(input.value);
  if (!Number.isFinite(num)) num = getSystemDefaultProfitMargin();
  num = Math.min(100, Math.max(0, Math.round(num * 100) / 100));
  g_DefaultProfitMargin = num;
  persistProfitMargin(num);
  // 更新 auth profile 中的 profitMargin，让 getCompanyProfitMargin 返回新值
  var profile = getAuthProfile();
  if (profile) {
    profile.profitMargin = num;
    saveAuthProfile(profile);
    // 更新页头徽标显示
    var text = document.getElementById("userBadgeText");
    if (text && profile.role !== "stock_only") {
      text.textContent = "\uD83C\uDFE1 " + (profile.companyName || "公司账号") + " | 利润率 " + num + "% 税率 " + (profile.taxRate !== undefined ? profile.taxRate : 13) + "%";
    }
  }
  // 刷新所有未手动改过利润率的行
  refreshAllCompanyPrices();
  closeProfitConfig();
  showToast("整体利润率已更新");
}
