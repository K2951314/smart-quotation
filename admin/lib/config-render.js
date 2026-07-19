/**
 * config-render.js — 配置渲染：将 state.config 渲染到表单控件。
 *
 * 依赖：admin-core.js（$、state、escapeHtml）
 */

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

  const ds = state.config.data_source || {};
  $("configVersion").value = state.config.version || "";

  $("dsBaseUrl").value = ds.base_url || "";
  $("dsConfigFile").value = ds.config_file || "config.json";
  $("dsPriceFile").value = ds.price_bundle_file || "price.bundle.json";
  $("dsStockFile").value = ds.stock_bundle_file || "stock.bundle.json";
  $("dsVersionFile").value = ds.version_file || "version.json";
  $("dsCacheName").value = ds.cache_name || "quotation-cache-v3";

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
    const condition = ((rule.when || {}).all || [{}])[0] || {};
    const action = (rule.actions || [{}])[0] || {};

    return `
      <div class="rule-row" data-rule-row>
        <input data-rule-id value="${escapeHtml(rule.id || "")}" placeholder="ID">
        <input data-rule-label value="${escapeHtml(rule.label || "")}" placeholder="规则名称">
        <input data-rule-priority type="number" value="${escapeHtml(rule.priority || 999)}">
        <select data-rule-default>
          <option value="false"${rule.default ? "" : " selected"}>否</option>
          <option value="true"${rule.default ? " selected" : ""}>是</option>
        </select>
        <select data-rule-field>
          ${getFieldSelectOptions(condition.field || "")}
        </select>
        <input data-rule-percent type="number" value="${escapeHtml(action.percent || 55)}">
        <select data-rule-op>
          ${ruleOperators.map(item => option(item.value, item.label, condition.op || "contains")).join("")}
        </select>
        <input data-rule-value value="${escapeHtml(condition.value || "")}" placeholder="匹配值">
        <button type="button" class="small-btn danger-btn" data-remove-rule="${index}">删除</button>
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

  const rawLayout = state.config.result_layout || (state.config.ui || {}).result_layout || {};
  const fields = state.config.fields || [];

  const visibleKeys = new Set([
    ...(rawLayout.identity || []),
    ...(rawLayout.metrics || []),
    ...(rawLayout.chips || []),
    ...(rawLayout.details || []),
  ]);

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
  const ds = pricing.discount_step || {};
  const stepDefault = typeof ds === "number" ? ds : (ds.default ?? 0.1);
  const stepPresets = Array.isArray(ds.presets) ? ds.presets : [0.1, 0.5, 1];
  $("pricingDiscountStep").value = stepDefault;
  $("pricingDiscountStepPresets").value = stepPresets.join(", ");
  const rounding = pricing.rounding || {};
  $("pricingRoundMode").value = rounding.mode || "ceil";
  $("pricingIntegerAbove").value = rounding.integer_above ?? 100;
  $("pricingTaxRate").value = pricing.tax_rate ?? 13;
  $("pricingFacePriceTaxInclusive").value = pricing.face_price_tax_inclusive === false ? "false" : "true";
}

function updateAdvancedJson() {
  $("advancedJson").value = JSON.stringify(state.config, null, 2);
}

function updatePreview() {
  // inspector 已移除，copyPreview DOM 元素已删除
}
