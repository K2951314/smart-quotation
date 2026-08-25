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

  // data_source DOM 元素已移除（base_url 在公司管理配置），无需渲染

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
  // 同步配置到 merger-app.js 的隐藏 textarea，使数据拼接区加载文件时
  // 使用配置中心编辑的最新 fields/rules/pricing（而非 ConfigCore fallback 默认）
  var appConfigEl = $("merger-appConfig");
  if (appConfigEl && window.ConfigCore) {
    try {
      var normalized = ConfigCore.normalizeConfig(state.config);
      appConfigEl.value = JSON.stringify(normalized, null, 2);
      if (typeof renderConfigPreview === "function") renderConfigPreview(normalized);
    } catch (e) { /* 配置非合法 JSON 时静默，不影响其他渲染 */ }
  }
}

function renderFieldRows() {
  $("fieldRows").innerHTML = (state.config.fields || []).map((field, index) => `
    <tr data-field-row>
      <td><input data-key value="${escapeHtml(field.key || "")}"></td>
      <td><input data-label value="${escapeHtml(field.label || "")}"></td>
      <td><select data-type>${fieldTypeOptions.map((item) => option(item.value, item.label, field.type || "text")).join("")}</select></td>
      <td><select data-source>${fieldSourceOptions.map((item) => option(item.value, item.label, field.source || "price")).join("")}</select></td>
      <td><input data-aliases value="${escapeHtml((field.excel_aliases || []).join(", "))}" placeholder="如: 销售单价、面价、目录价（逗号/顿号/分号分隔）"></td>
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

  const thead = `
    <thead>
      <tr>
        <th>ID</th>
        <th>名称</th>
        <th>优先级</th>
        <th>默认</th>
        <th>字段</th>
        <th>折扣%</th>
        <th>条件</th>
        <th>匹配值</th>
        <th></th>
      </tr>
    </thead>
  `;

  const tbody = rules.map((rule, index) => {
    const condition = ((rule.when || {}).all || [{}])[0] || {};
    const action = (rule.actions || [{}])[0] || {};

    return `
      <tr data-rule-row>
        <td><input data-rule-id value="${escapeHtml(rule.id || "")}" placeholder="ID"></td>
        <td><input data-rule-label value="${escapeHtml(rule.label || "")}" placeholder="规则名称"></td>
        <td><input data-rule-priority type="number" value="${escapeHtml(rule.priority || 999)}"></td>
        <td><select data-rule-default>
          <option value="false"${rule.default ? "" : " selected"}>否</option>
          <option value="true"${rule.default ? " selected" : ""}>是</option>
        </select></td>
        <td><select data-rule-field>
          ${getFieldSelectOptions(condition.field || "")}
        </select></td>
        <td><input data-rule-percent type="number" value="${escapeHtml(action.percent || 55)}"></td>
        <td><select data-rule-op>
          ${ruleOperators.map(item => option(item.value, item.label, condition.op || "contains")).join("")}
        </select></td>
        <td><input data-rule-value value="${escapeHtml(condition.value || "")}" placeholder="匹配值"></td>
        <td><button type="button" class="small-btn danger-btn" data-remove-rule="${index}">删除</button></td>
      </tr>
    `;
  }).join("");

  $("ruleRows").innerHTML = `<div class="table-wrap"><table class="rule-table">${thead}<tbody>${tbody}</tbody></table></div>`;
}

function renderCopyRows() {
  const columns = ((state.config.copy || {}).columns || []);
  if (!columns.length) {
    $("copyRows").innerHTML = `<p class="hint" style="color:var(--muted);">暂无列，点击"添加列"开始配置。</p>`;
    return;
  }
  const thead = `<thead><tr>
    <th>字段</th>
    <th>行类型</th>
    <th style="text-align:center;" title="默认显示">默认</th>
    <th>前缀</th>
    <th></th>
  </tr></thead>`;
  const tbody = columns.map((column, index) => `
    <tr data-copy-row>
      <td><select data-copy-field aria-label="字段">
        ${getCopyFieldOptions(column.field || "")}
      </select></td>
      <td><select data-copy-line aria-label="行类型">${copyLineOptions.map((item) => option(item.value, item.label, column.line || "main")).join("")}</select></td>
      <td style="text-align:center;"><input data-copy-default type="checkbox" aria-label="默认显示"${column.default ? " checked" : ""}></td>
      <td><input data-copy-prefix value="${escapeHtml(column.prefix || "")}" placeholder="例如：含税、含运费" aria-label="前缀"></td>
      <td><button type="button" data-remove-copy="${index}" class="small-btn danger-btn">移除</button></td>
    </tr>
  `).join("");
  $("copyRows").innerHTML = `<div class="table-wrap"><table class="copy-table">${thead}<tbody>${tbody}</tbody></table></div>`;
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
