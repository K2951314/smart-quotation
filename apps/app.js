/**
 * app.js — 应用启动入口（bootstrap）。
 *
 * 此文件是 apps 前端的编排层，仅包含：
 *   - startApp(): 启动流程
 *   - bindUiEvents(): 绑定所有 UI 事件
 *   - window.onload: 入口
 *
 * 所有业务逻辑已拆分到 lib/ 目录下的模块中：
 *   state.js          — 全局状态、常量、Sentry
 *   config-helpers.js — 配置访问、字段映射、控件渲染
 *   discount-config.js— 默认折扣弹窗
 *   search-render.js  — 搜索、渲染、定价、折扣步进
 *   auth.js           — 认证网关、公司模式补丁
 *   data-load.js      — 远程数据加载、缓存
 *   copy-clipboard.js — 复制、剪贴板、Toast
 *   stock-query.js    — 三菱库存、令牌管理
 *   ui-helpers.js     — 布局度量、移动端状态
 */

async function startApp() {
  // authGate 检查
  if (!initAuthGate()) {
    return;
  }
  var companyId = getCompanyId();
  var forceAuth = new URLSearchParams(location.search).get("test_auth") === "1";
  var isLocalDev = !forceAuth && (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  if (companyId && companyId !== "default") {
    await loadCompanyProfile(companyId);
  } else if (!getAuthProfile()) {
    // 安全：生产环境下不允许无 company_id 时自动降级为 admin 角色
    if (isLocalDev) {
      saveAuthProfile({ role: "admin" });
    } else {
      var stockKey = getStockQueryKey();
      if (stockKey) {
        saveAuthProfile({ role: "stock_only" });
      } else {
        saveAuthProfile({ role: "stock_only" });
      }
    }
  }
  var currentProfile = getAuthProfile();
  if (currentProfile && currentProfile.role === "stock_only") {
    applyCompanyMode(currentProfile);
  }
  g_DefaultDiscountConfig = loadLocalDefaultDiscountConfig() || getSystemDefaultDiscountConfig();
  applyAppConfig(window.APP_CONFIG || {});
  bindUiEvents();
  syncDefaultDiscountButtonSummary();
  syncDefaultDiscountForm(g_DefaultDiscountConfig);
  syncDiscountStepInput(document.getElementById("discountStep").value);
  requestLayoutMetricsSync();
  renderLoadingState("正在极速同步远程数据");
  updateResultCount();
  if (isCompanyMode()) {
    var stepLabel = document.querySelector("label[for=\"discountStep\"]");
    if (stepLabel) stepLabel.textContent = "步进";
    var stepUnit = document.querySelector(".field-group-large .field-unit");
    if (stepUnit) stepUnit.textContent = "点";
    var stepInput = document.getElementById("discountStep");
    if (stepInput) {
      stepInput.value = "1";
      stepInput.step = "0.1";
      stepInput.min = "0.1";
      stepInput.max = "10";
    }
    var configBtn = document.getElementById("btnDefaultDiscounts");
    if (configBtn) configBtn.style.display = "none";
  }
  ensureDataLoaded().then(function (ready) {
    if (ready) {
      renderEmptyState("输入规格后开始查询。");
      if (isCompanyMode()) {
        refreshAllCompanyPrices();
      } else {
        refreshRenderedPrices();
      }
    } else {
      renderErrorState("远程数据未就绪，请重试。");
    }
  });
}

function bindUiEvents() {
  const searchBtn = document.getElementById("btnSearch");
  const stockBtn = document.getElementById("btnRegexConvert");
  const mmcBtn = document.getElementById("btnMmc");
  const copyBtn = document.getElementById("btnCopy");
  const backTopBtn = document.getElementById("btnBackToTop");
  const stepWrap = document.getElementById("stepPresetControls");
  const toggleAllInput = document.getElementById("toggleAllResults");
  if (searchBtn) searchBtn.addEventListener("click", doSearch);
  if (stockBtn) stockBtn.addEventListener("click", doRegexSearchConverted);
  if (mmcBtn) mmcBtn.addEventListener("click", doMitsubishiStockQuery);
  if (copyBtn) copyBtn.addEventListener("click", doCopy);
  if (backTopBtn) backTopBtn.addEventListener("click", scrollToTop);
  if (toggleAllInput) toggleAllInput.addEventListener("change", function () { toggleAll(this); });
  if (stepWrap) {
    stepWrap.addEventListener("click", function (event) {
      const button = event.target && event.target.closest ? event.target.closest("button") : null;
      if (!button || !stepWrap.contains(button)) return;
      if (button.id === "btnDefaultDiscounts") { openDefaultDiscountConfig(); return; }
      if (button.classList.contains("step-preset")) setDiscountStepPreset(button);
    });
  }
  const closeDefaultBtn = document.getElementById("btnCloseDefaultDiscounts");
  const resetDefaultBtn = document.getElementById("btnResetDefaultDiscounts");
  const cancelDefaultBtn = document.getElementById("btnCancelDefaultDiscounts");
  const saveDefaultBtn = document.getElementById("btnSaveDefaultDiscounts");
  const defaultBackdrop = document.getElementById("defaultDiscountBackdrop");
  if (closeDefaultBtn) closeDefaultBtn.addEventListener("click", closeDefaultDiscountConfig);
  if (resetDefaultBtn) resetDefaultBtn.addEventListener("click", resetDefaultDiscountConfig);
  if (cancelDefaultBtn) cancelDefaultBtn.addEventListener("click", closeDefaultDiscountConfig);
  if (saveDefaultBtn) saveDefaultBtn.addEventListener("click", saveDefaultDiscountConfig);
  if (defaultBackdrop) defaultBackdrop.addEventListener("click", closeDefaultDiscountConfig);

  ["defaultDiscountEx", "defaultDiscountOsg", "defaultDiscountMitsubishi", "defaultDiscountOther"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("blur", function () {
      const key = id.replace("defaultDiscount", "").toLowerCase();
      const normalized = DiscountEngine.sanitizeDiscountConfig({ [key]: this.value });
      this.value = formatCompactNumber(normalized[key]);
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); saveDefaultDiscountConfig(); } });
  });
  const discountStep = document.getElementById("discountStep");
  if (discountStep) {
    discountStep.addEventListener("input", function () { updateStepPresetState(this.value); });
    discountStep.addEventListener("change", function () { syncDiscountStepInput(this.value); });
    discountStep.addEventListener("blur", function () { syncDiscountStepInput(this.value); });
  }
  const decimalsInput = document.getElementById("decimals");
  const thresholdInput = document.getElementById("threshold");
  if (decimalsInput) decimalsInput.addEventListener("change", refreshRenderedPrices);
  if (thresholdInput) thresholdInput.addEventListener("change", refreshRenderedPrices);
  const resultBody = document.getElementById("resultBody");
  resultBody.addEventListener("pointerdown", function (event) {
    const target = event.target && event.target.closest ? event.target.closest(".discount-stepper-btn") : null;
    if (!target) return;
    startDiscountPress(event, target.dataset.rowId, target.dataset.direction);
  });
  resultBody.addEventListener("click", function (event) {
    const target = event.target && event.target.closest ? event.target.closest(".discount-stepper-btn") : null;
    if (!target) return;
    handleDiscountButtonClick(event, target.dataset.rowId, target.dataset.direction);
  });
  resultBody.addEventListener("change", function (event) {
    const target = event.target;
    if (!target || typeof target.matches !== "function") return;
    if (target.matches('input[type="checkbox"][data-id]')) {
      const row = getRowById(target.getAttribute("data-id"));
      if (row) { row.checked = target.checked; syncRowSelectionState(row); }
      syncResultOrder(); updateSelectionUi(); return;
    }
    if (target.matches(".discount-manual")) applyManualDiscount(target.getAttribute("data-id"), target.value);
  });
  resultBody.addEventListener("keydown", function (event) {
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

window.onload = async function () {
  bindAuthEvents();
  await startApp();
};
