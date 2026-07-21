/**
 * search-render.js — 搜索逻辑、结果渲染、定价计算、折扣步进器。
 *
 * 依赖：state.js, config-helpers.js, discount-config.js
 * 被 auth.js 依赖：appendResultRow 和 calcDiscountedPrice 会被 auth.js 打补丁。
 */

// ─── UI 辅助 ──────────────────────────────────────────────

function setStatus(msg, type) {
  const el = document.getElementById("status");
  el.innerText = msg;
  el.className = "status-badge " + (type || "info");
}

function setSearchLoading(loading) {
  const searchBtn = document.getElementById("btnSearch");
  const stockBtn = document.getElementById("btnRegexConvert");
  if (!searchBtn || !stockBtn) return;
  if (loading) {
    if (!searchBtn.dataset.defaultText) searchBtn.dataset.defaultText = searchBtn.textContent;
    if (!stockBtn.dataset.defaultText) stockBtn.dataset.defaultText = stockBtn.textContent;
    searchBtn.textContent = "加速加载中...";
    stockBtn.textContent = "同步中...";
    searchBtn.disabled = true;
    stockBtn.disabled = true;
    return;
  }
  searchBtn.textContent = searchBtn.dataset.defaultText || "智能查询";
  stockBtn.textContent = stockBtn.dataset.defaultText || "库存查询";
  searchBtn.disabled = false;
  stockBtn.disabled = false;
  requestLayoutMetricsSync();
}

// ─── 通用辅助 ──────────────────────────────────────────────

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return num.toFixed(2).replace(/\.?0+$/, "");
}

// ─── 查询解析 ──────────────────────────────────────────────

function getQueryLines() {
  return document.getElementById("queryInput").value.split(/\r?\n/).filter((line) => line.trim());
}

function hasStockValue(text) {
  if (!window.QueryRegex || typeof window.QueryRegex.hasStockValue !== "function") return !!String(text || "").trim();
  return window.QueryRegex.hasStockValue(text);
}

function convertPlainLineToRegex(line) {
  if (!window.QueryRegex || typeof window.QueryRegex.convertPlainLineToRegex !== "function") throw new Error("正则模块未加载");
  return window.QueryRegex.convertPlainLineToRegex(line);
}

function matchRegexTarget(target, re) {
  if (!window.QueryRegex || typeof window.QueryRegex.matchRegexTarget !== "function") throw new Error("正则模块未加载");
  return window.QueryRegex.matchRegexTarget(target, re);
}

function toCoreRow(rowOrKey, item) {
  if (rowOrKey && rowOrKey.fields) return { key: rowOrKey.key || rowOrKey.spec || "", fields: rowOrKey.fields };
  if (item && item.fields) return { key: rowOrKey || item.key || "", fields: item.fields };
  const source = item || {};
  return {
    key: rowOrKey || source.spec || "",
    fields: {
      code: source.c || source.code || "",
      spec: rowOrKey || source.spec || "",
      face_price: Number(source.p || source.facePrice) || 0,
      quote_price: source.price || "",
      special: source.s || source.special || "",
      stock: source.i || source.stock || "",
      remark: source.r || source.remark || "",
      brand: source.b || source.brand || "",
      name: source.n || source.name || "",
      mnemonic: source.m || source.mnemonic || "",
      alias: source.a || source.alias || ""
    }
  };
}

function getConfiguredValue(row, fieldKey) {
  const key = normalizeFieldKey(fieldKey);
  if (row && row.fields && row.fields[key] !== undefined) return row.fields[key];
  if (row && row[key] !== undefined) return row[key];
  return "";
}

// ─── 结果统计 ──────────────────────────────────────────────

function updateResultCount() {
  document.getElementById("resultCount").textContent = String(g_Results.length);
}

function getSelectedCount() {
  return g_Results.filter((row) => row.checked).length;
}

function syncToggleAllState() {
  const master = document.getElementById("toggleAllResults");
  if (!master) return;
  const checkboxes = Array.from(document.querySelectorAll('#resultBody input[type="checkbox"][data-id]'));
  if (!checkboxes.length) { master.checked = false; master.indeterminate = false; return; }
  const checkedCount = checkboxes.filter((cb) => cb.checked).length;
  master.checked = checkedCount === checkboxes.length;
  master.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

function updateSelectionUi() {
  const selectedCount = getSelectedCount();
  const selectedCountEl = document.getElementById("selectedCount");
  if (selectedCountEl) selectedCountEl.textContent = String(selectedCount);
  const copyBtn = document.getElementById("btnCopy");
  if (copyBtn) {
    if (!copyBtn.dataset.baseText) copyBtn.dataset.baseText = copyBtn.textContent || "复制勾选";
    copyBtn.textContent = selectedCount > 0 ? copyBtn.dataset.baseText + " (" + selectedCount + ")" : copyBtn.dataset.baseText;
  }
  syncToggleAllState();
  requestLayoutMetricsSync();
}

// ─── 状态卡片 ──────────────────────────────────────────────

function renderStateCard(kind, title, message, hint) {
  const body = document.getElementById("resultBody");
  const skeleton = kind === "loading" ? '<div class="state-skeleton"><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line"></span><span class="skeleton-line skeleton-line-short"></span></div>' : "";
  body.innerHTML = [
    '<section class="state-card state-card--', kind, '">',
    '<span class="state-kicker">', escapeHtml(title), "</span>",
    "<h3>", escapeHtml(message), "</h3>",
    hint ? "<p>" + escapeHtml(hint) + "</p>" : "", skeleton,
    "</section>"
  ].join("");
  updateSelectionUi();
}

function renderLoadingState(message) { renderStateCard("loading", "数据同步", message, "仅在初次进入时拉取，后续皆为0延迟的极速缓存。"); }
function renderEmptyState(message) { renderStateCard("empty", "等待查询", message, getAppConfig().labels?.empty_hint || "支持规格、代码、助记码、别名、备注和特价关键词。"); }
function renderErrorState(message) { renderStateCard("error", "加载失败", message, "网络或节点连接失败，请稍后重试。"); }

// ─── 定价计算 ──────────────────────────────────────────────

function getCurrentPriceSettings() {
  const decimals = parseInt(document.getElementById("decimals").value, 10);
  const threshold = parseFloat(document.getElementById("threshold").value);
  return { decimals: Number.isFinite(decimals) ? decimals : 0, threshold: Number.isFinite(threshold) ? threshold : 100 };
}

function getCurrentDiscountStep() { return DiscountEngine.sanitizeStepPercent(document.getElementById("discountStep").value); }

function updateStepPresetState(stepValue) {
  const normalized = DiscountEngine.sanitizeStepPercent(stepValue);
  document.querySelectorAll(".step-preset").forEach((button) => {
    if (!button.dataset.step) { button.classList.remove("is-active"); return; }
    button.classList.toggle("is-active", DiscountEngine.sanitizeStepPercent(button.dataset.step) === normalized);
  });
}

function syncDiscountStepInput(value) {
  const normalized = DiscountEngine.sanitizeStepPercent(value);
  document.getElementById("discountStep").value = formatCompactNumber(normalized);
  updateStepPresetState(normalized);
}

function setDiscountStepPreset(button) {
  if (!button) return;
  syncDiscountStepInput(button.dataset.step || DiscountEngine.DEFAULT_STEP_PERCENT);
}

// ─── 取整（auth.js 会补丁 getRoundingMethod / applyRounding 的调用者）───

function getRoundingMethod() {
  var sel = document.getElementById("roundingMethod");
  return sel ? sel.value : 'ceil';
}

function applyRounding(value, factor, method) {
  var eps = 1e-9;
  if (method === 'ceil') return Math.ceil(value * factor - eps) / factor;
  if (method === 'floor') return Math.floor(value * factor + eps) / factor;
  return Math.round(value * factor) / factor;
}

// ─── 搜索匹配 ──────────────────────────────────────────────

function normalizeExactText(value) { return String(value || "").trim().toUpperCase(); }
function isExactSpecMatch(inputLine, spec) {
  return normalizeExactText(inputLine) !== "" && normalizeExactText(inputLine) === normalizeExactText(spec);
}

function getSearchTarget(spec, item) {
  return { spec: spec || "", code: item.c || "", mnemonic: item.m || "", remark: item.r || "", alias: item.a || "", special: item.s || "" };
}

function findMatchesByRegex(line, allKeys, onlyInStock) {
  const re = convertPlainLineToRegex(line);
  if (!re) return [];
  const runtimeConfig = getRuntimeAppConfig();
  const tokens = line.toUpperCase().split(/\s+/).filter(Boolean);
  const useSearchIndex = window.ConfigCore && g_SearchIndex && tokens.length > 0;
  return allKeys.filter((key) => {
    const item = DB[key] || {};
    if (onlyInStock) {
      const stockVal = window.ConfigCore ? ((item.fields && item.fields.stock) || item.i) : item.i;
      if (!hasStockValue(stockVal)) return false;
    }
    if (useSearchIndex) {
      const combined = g_SearchIndex[key] || "";
      for (let t = 0; t < tokens.length; t++) {
        if (combined.indexOf(tokens[t]) < 0) return false;
      }
      return true;
    }
    if (window.ConfigCore) return window.ConfigCore.rowMatchesText(toCoreRow(key, item), line, runtimeConfig);
    return matchRegexTarget(getSearchTarget(key, item), re);
  });
}

// ─── 行操作 ──────────────────────────────────────────────

function getRowById(id) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId)) return null;
  return g_Results.find((row) => row && row.id === rowId) || null;
}

function calculateBaseDiscountedPrice(facePrice, discount, decimals, threshold) {
  const rawCalc = facePrice * discount;
  const factor = Math.pow(10, decimals);
  const method = getRoundingMethod();
  let finalPrice = applyRounding(rawCalc * factor, 1, method) / factor;
  if (finalPrice > threshold && decimals > 0) {
    finalPrice = applyRounding(rawCalc, 1, method);
  }
  const display = (finalPrice % 1 === 0 && finalPrice > threshold) ? finalPrice.toFixed(0) : finalPrice.toFixed(decimals);
  return { value: finalPrice, display: display };
}

function calculateDisplayedPrice(baseValue, settings, useUntaxed, taxRate) {
  const decimals = settings.decimals;
  const threshold = settings.threshold;
  let finalValue = Number(baseValue) || 0;
  if (useUntaxed) {
    const rate = Number(taxRate);
    const divisor = 1 + (Number.isFinite(rate) && rate >= 0 ? rate : 13) / 100;
    finalValue = applyRounding(finalValue / divisor, Math.pow(10, decimals), getRoundingMethod());
  }
  const display = (finalValue % 1 === 0 && finalValue > threshold)
    ? finalValue.toFixed(0)
    : finalValue.toFixed(decimals);
  return { value: finalValue, display: display };
}

function calcDiscountedPrice(facePrice, discount, decimals, threshold) {
  const base = calculateBaseDiscountedPrice(facePrice, discount, decimals, threshold);
  const useUntaxed = document.getElementById("chkUntaxedQuote")?.checked ?? false;
  return calculateDisplayedPrice(base.value, { decimals: decimals, threshold: threshold }, useUntaxed, getTaxRate());
}

function normalizeDiscountPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number.isFinite(Number(fallback)) ? Number(fallback) : 53;
  return Math.min(100, Math.max(0, Math.round(num * 100) / 100));
}

function flashPriceCell(priceCell) {
  if (!priceCell) return;
  if (priceCell._flashFrame) window.cancelAnimationFrame(priceCell._flashFrame);
  priceCell.classList.remove("is-flashing");
  priceCell._flashFrame = window.requestAnimationFrame(() => {
    priceCell.classList.add("is-flashing");
    priceCell._flashFrame = null;
  });
}

function refreshRowPrice(row, flash) {
  if (!row) return;
  const settings = getCurrentPriceSettings();
  var baseResult = calculateBaseDiscountedPrice(row.facePrice, row.discountPercent / 100, settings.decimals, settings.threshold);
  var priceInfo;
  if (isCompanyMode()) {
    var profit = getCompanyProfitMargin(row);
    var tax = getTaxRate();
    var useUntaxed = document.getElementById("chkUntaxedQuote")?.checked ?? false;
    var factor = Math.pow(10, settings.decimals);
    var method = getRoundingMethod();
    var withProfit = applyRounding(baseResult.value * (1 + profit / 100), factor, method);
    priceInfo = calculateDisplayedPrice(withProfit, settings, useUntaxed, tax);
  } else {
    var useUntaxed = document.getElementById("chkUntaxedQuote")?.checked ?? false;
    priceInfo = calculateDisplayedPrice(baseResult.value, settings, useUntaxed, getTaxRate());
  }
  row.price = priceInfo.display;
  if (!row.fields) row.fields = {};
  row.fields.quote_price = priceInfo.display;
  row.fields.price = priceInfo.display;

  const resultCard = row.cardEl || document.querySelector('.result-card[data-row-id="' + row.id + '"]');
  if (!resultCard) return;
  row.cardEl = resultCard;

  const priceCell = row.priceEl || resultCard.querySelector(".price");
  var discountInput = row.discountInputEl || resultCard.querySelector(".discount-manual");
  if (priceCell) row.priceEl = priceCell;
  if (discountInput) row.discountInputEl = discountInput;
  if (discountInput) {
    discountInput.value = isCompanyMode() ? formatCompactNumber(row.profitMargin !== undefined ? row.profitMargin : getCompanyProfitMargin()) : formatCompactNumber(row.discountPercent);
  }
  if (priceCell) {
    priceCell.textContent = priceInfo.display;
    if (flash) flashPriceCell(priceCell);
  }
}

function refreshRenderedPrices() { g_Results.forEach((row) => refreshRowPrice(row, false)); }

function syncRowSelectionState(row) {
  if (!row) return;
  const resultCard = row.cardEl || document.querySelector('.result-card[data-row-id="' + row.id + '"]');
  if (!resultCard) return;
  row.cardEl = resultCard;
  resultCard.classList.toggle("is-selected", !!row.checked);
  resultCard.setAttribute("data-checked", row.checked ? "true" : "false");
}

function syncResultOrder() {
  const resultList = document.getElementById("resultBody");
  if (!resultList || !g_Results.length) return;
  g_Results = ResultSortEngine.sortResultsBySelection(g_Results);
  const fragment = document.createDocumentFragment();
  g_Results.forEach((row) => {
    syncRowSelectionState(row);
    if (row && row.cardEl) fragment.appendChild(row.cardEl);
  });
  resultList.appendChild(fragment);
}

function applyManualDiscount(id, rawValue) {
  const row = getRowById(id);
  if (!row) return;
  if (isCompanyMode()) {
    row.hasCustomDiscount = true;
    var num = parseFloat(rawValue);
    row.profitMargin = Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
    refreshRowPrice(row, true);
    return;
  }
  row.hasCustomDiscount = true;
  row.discountPercent = normalizeDiscountPercent(rawValue, row.discountPercent);
  refreshRowPrice(row, true);
}

function getDiscountButtonMarkup(rowId, direction) {
  const symbol = direction < 0 ? "-" : "+";
  const label = direction < 0 ? "降低折扣" : "提高折扣";
  return [
    '<button type="button" class="discount-stepper-btn"',
    ' data-row-id="', rowId, '" data-direction="', direction, '"',
    ' aria-label="', label, '">', symbol, "</button>"
  ].join("");
}

// ─── 结果渲染 ──────────────────────────────────────────────

function appendResultRow(resultList, matchKey, item, shouldCheck, isExact, runtimeConfig) {
  const coreRow = toCoreRow(matchKey, item);
  const fields = { ...(coreRow.fields || {}) };
  if (!runtimeConfig) runtimeConfig = getRuntimeAppConfig();
  const rules = (g_AppConfig && g_AppConfig.discount_rules) || g_RemoteDiscountRules || [];
  const preset = window.ConfigCore
    ? window.ConfigCore.getDiscountPreset({ key: coreRow.key, fields }, runtimeConfig)
    : DiscountEngine.getDefaultDiscountPreset({ spec: matchKey, special: item.s || "", brand: item.b || "", name: item.n || "" }, getDefaultDiscountConfig(), rules);
  const settings = getCurrentPriceSettings();
  // 安全修复：company 模式下 face_price 已被服务端脱敏移除，
  // 前端必须使用服务端预计算的 quote_price 作为基础价
  var facePrice, effectiveDiscountPercent;
  if (isCompanyMode() && fields.quote_price !== undefined && fields.face_price === undefined) {
    facePrice = Number(fields.quote_price) || 0;
    effectiveDiscountPercent = 100;
  } else {
    facePrice = Number(fields.face_price !== undefined ? fields.face_price : item.p) || 0;
    effectiveDiscountPercent = preset.percent;
  }
  const priceInfo = calcDiscountedPrice(facePrice, effectiveDiscountPercent / 100, settings.decimals, settings.threshold);
  fields.quote_price = priceInfo.display;
  fields.price = priceInfo.display;
  const rowData = {
    id: g_Results.length, orderIndex: g_Results.length, key: coreRow.key || matchKey, fields,
    code: fields.code || "", spec: fields.spec || matchKey,
    brand: fields.brand || "", name: fields.name || "", mnemonic: fields.mnemonic || "", alias: fields.alias || "",
    price: priceInfo.display, facePrice: facePrice, remark: fields.remark || "",
    special: fields.special || "", stock: fields.stock || "", discountPercent: effectiveDiscountPercent,
    discountLabel: preset.label, discountCategory: preset.category || "", hasCustomDiscount: false, checked: shouldCheck
  };
  g_Results.push(rowData);

  const layout = runtimeConfig.result_layout || {};
  const identityFields = (layout.identity || ["code", "spec"]).filter(Boolean);
  const primaryIdentity = identityFields[0] || "code";
  const titleIdentity = identityFields[1] || "spec";
  const chipFields = (layout.chips || ["stock", "special"]).filter(Boolean);
  var rawMetricFields = (layout.metrics || ["face_price", "quote_price"]).filter(Boolean);
  var metricFields = rawMetricFields;
  if (isStockOnlyMode()) {
    metricFields = metricFields.filter(function(f) {
      return f !== "face_price" && f !== "quote_price" && f !== "price";
    });
  } else if (isCompanyMode()) {
    metricFields = metricFields.filter(function(f) { return f !== "face_price"; });
  }
  if (isCompanyMode() && !isStockOnlyMode() && metricFields.length === 0) metricFields.push("quote_price");
  const detailFields = (layout.details || ["remark"]).filter(Boolean);

  const identityLead = getConfiguredValue(rowData, primaryIdentity) || ("未设置" + getFieldLabel(primaryIdentity));
  const identityTitle = getConfiguredValue(rowData, titleIdentity) || rowData.key;
  const extraIdentityMarkup = identityFields.slice(2).map((field) => {
    const value = getConfiguredValue(rowData, field);
    return value ? '<span class="identity-code">' + escapeHtml(value) + "</span>" : "";
  }).join("");
  const chipMarkup = chipFields.map((field) => {
    const value = getConfiguredValue(rowData, field);
    if (!value) return "";
    const label = field === "stock" ? getFieldConfig().stockPrefix : "";
    const cls = field === "stock" ? "stock-chip" : "special-chip";
    return '<span class="' + cls + '">' + escapeHtml(label + value) + "</span>";
  }).join("");
  const detailMarkup = detailFields.map((field) => {
    const value = getConfiguredValue(rowData, field);
    return value ? '<span class="info-note info-note-inline">' + escapeHtml(value) + "</span>" : "";
  }).join("");
  const metaLineMarkup = (chipMarkup || detailMarkup) ? '<div class="meta-line">' + chipMarkup + detailMarkup + "</div>" : "";
  const metricMarkup = (function () {
    return metricFields.map((field) => {
      const value = field === "quote_price" ? priceInfo.display : getConfiguredValue(rowData, field);
      const display = field === "face_price" ? formatCompactNumber(value || 0) : value;
      const priceClass = field === "quote_price" ? " price" : "";
      const accentClass = field === "quote_price" ? " metric-inline-accent" : "";
      return '<div class="metric-inline' + accentClass + '"><span class="metric-label">' + escapeHtml(getFieldLabel(field)) + '</span><strong class="' + priceClass.trim() + '">' + escapeHtml(display) + '</strong></div>';
    }).join("");
  })();

  const resultCard = document.createElement("article");
  resultCard.className = "result-card" + (isExact ? " match-exact" : "");
  resultCard.setAttribute("data-row-id", String(rowData.id));
  const discountPanelMarkup = [
    '<div class="discount-panel"><div class="discount-stepper" data-id="', rowData.id, '">',
    getDiscountButtonMarkup(rowData.id, -1),
    '<label class="discount-input-shell"><input type="number" class="discount-manual" data-id="', rowData.id, '" min="0" max="100" step="0.1" inputmode="decimal" value="', escapeHtml(formatCompactNumber(rowData.discountPercent)), '"><span class="discount-unit">%</span></label>',
    getDiscountButtonMarkup(rowData.id, 1),
    "</div></div>"
  ].join("");
  resultCard.innerHTML = [
    '<div class="result-row">',
    '<label class="select-chip discount-select-chip"><input type="checkbox" data-id="', rowData.id, '" ', rowData.checked ? "checked" : "", '><span>', escapeHtml(runtimeConfig.labels?.selected_label || "勾选"), '</span></label>',
    '<div class="result-summary">',
    '<div class="identity-line"><div class="identity-code">', escapeHtml(identityLead), "</div>",
    '<h3 class="identity-spec">', escapeHtml(identityTitle), "</h3>", extraIdentityMarkup,
    '<div class="stock-live-placeholder" data-stock-id="', rowData.id, '" style="display:none"></div>',
    "</div>", metaLineMarkup,
    "</div>",
    '<div class="result-side"><div class="result-metrics">',
    metricMarkup,
    "</div>",
    discountPanelMarkup,
    "</div></div>"
  ].join("");

  rowData.cardEl = resultCard;
  rowData.priceEl = resultCard.querySelector(".price");
  rowData.discountInputEl = resultCard.querySelector(".discount-manual");
  syncRowSelectionState(rowData);
  resultList.appendChild(resultCard);
}

function renderSearchResults(lines, onlyInStock) {
  const resultList = document.getElementById("resultBody");
  resultList.innerHTML = "";
  g_Results = [];
  if (!lines.length) {
    renderEmptyState("请输入规格型号或关键字后再查询。");
    updateResultCount();
    return;
  }
  const allKeys = Object.keys(DB);
  const runtimeConfig = getRuntimeAppConfig();
  lines.forEach((line) => {
    const matches = findMatchesByRegex(line, allKeys, onlyInStock);
    const defaultChecked = matches.length === 1;
    matches.forEach((matchKey) => {
      const item = DB[matchKey];
      if (!item) return;
      const isExact = isExactSpecMatch(line, matchKey);
      appendResultRow(resultList, matchKey, item, isExact || defaultChecked, isExact, runtimeConfig);
    });
  });
  if (g_Results.length === 0) renderEmptyState("没有找到匹配项，请调整关键词或切换查询方式。");
  syncResultOrder();
  updateResultCount();
  updateSelectionUi();
}

async function doSearch() {
  const ready = await ensureDataLoaded();
  if (!ready) { renderErrorState("数据加载失败，请稍后重试。"); return; }
  console.log("[doSearch] DB size:", Object.keys(DB).length, "query:", getQueryLines());
  renderSearchResults(getQueryLines(), false);
}

async function doRegexSearchConverted() {
  const ready = await ensureDataLoaded();
  if (!ready) { renderErrorState("数据加载失败，请稍后重试。"); return; }
  renderSearchResults(getQueryLines(), true);
  showToast("已按库存查询并过滤无库存项");
}

// ─── 折扣步进器（长按重复）──────────────────────────────

function adjustRowDiscount(id, direction, flash) {
  const row = getRowById(id);
  if (!row) return;
  if (isCompanyMode()) {
    row.hasCustomDiscount = true;
    var step = getCurrentDiscountStep();
    if (direction < 0) row.profitMargin = (row.profitMargin !== undefined ? row.profitMargin : 0) - step;
    else row.profitMargin = (row.profitMargin !== undefined ? row.profitMargin : 0) + step;
    row.profitMargin = Math.round(row.profitMargin * 100) / 100;
    var input = document.querySelector('.discount-manual[data-profit-id="' + id + '"]');
    if (input) input.value = formatCompactNumber(row.profitMargin);
    refreshRowPrice(row, flash !== false);
    return;
  }
  row.hasCustomDiscount = true;
  row.discountPercent = DiscountEngine.shiftDiscountPercent(row.discountPercent, getCurrentDiscountStep(), direction);
  refreshRowPrice(row, flash !== false);
}

function clearDiscountPressTimers(state) {
  if (!state) return;
  if (state.timeoutId) window.clearTimeout(state.timeoutId);
  if (state.intervalId) window.clearInterval(state.intervalId);
  state.timeoutId = null;
  state.intervalId = null;
}

function releasePressedButton(state) {
  if (!state || !state.button) return;
  state.button.classList.remove("is-pressing");
  if (typeof state.button.releasePointerCapture === "function" && state.pointerId !== null && state.pointerId !== undefined) {
    try { state.button.releasePointerCapture(state.pointerId); } catch (err) {}
  }
}

function stopDiscountPress(applySingleStep) {
  const state = g_DiscountPressState;
  if (!state) return;
  g_DiscountPressState = null;
  clearDiscountPressTimers(state);
  releasePressedButton(state);
  if (applySingleStep && !state.repeatStarted) adjustRowDiscount(state.id, state.direction);
}

function startDiscountPress(event, id, direction) {
  if (event && typeof event.button === "number" && event.button !== 0) return;
  stopDiscountPress(false);
  const state = {
    id: Number(id), direction: Number(direction) < 0 ? -1 : 1,
    button: event && event.currentTarget ? event.currentTarget : null,
    pointerId: event && event.pointerId !== undefined ? event.pointerId : null,
    repeatStarted: false, timeoutId: null, intervalId: null
  };
  if (state.button) {
    state.button.classList.add("is-pressing");
    if (typeof state.button.setPointerCapture === "function" && state.pointerId !== null) {
      try { state.button.setPointerCapture(state.pointerId); } catch (err) {}
    }
  }
  state.timeoutId = window.setTimeout(() => {
    if (g_DiscountPressState !== state) return;
    state.repeatStarted = true;
    adjustRowDiscount(state.id, state.direction, false);
    state.intervalId = window.setInterval(() => { adjustRowDiscount(state.id, state.direction, false); }, HOLD_REPEAT_INTERVAL_MS);
  }, HOLD_START_DELAY_MS);
  g_DiscountPressState = state;
  if (event) event.preventDefault();
}

function handleDiscountButtonClick(event, id, direction) {
  if (event && event.detail !== 0) return;
  adjustRowDiscount(id, direction);
}

function handleGlobalPointerUp(event) {
  if (!g_DiscountPressState) return;
  if (g_DiscountPressState.pointerId !== null && event && event.pointerId !== undefined && g_DiscountPressState.pointerId !== event.pointerId) return;
  stopDiscountPress(true);
}

function handleGlobalPointerCancel(event) {
  if (!g_DiscountPressState) return;
  if (g_DiscountPressState.pointerId !== null && event && event.pointerId !== undefined && g_DiscountPressState.pointerId !== event.pointerId) return;
  stopDiscountPress(false);
}
