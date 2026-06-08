const apiBase = "";
let g_AdminEventsBound = false;

window.addEventListener("error", (event) => {
  const msg = event?.message || "未知错误";
  setStatus(`JS 错误：${msg}`, true);
  setJsStatus("异常");
});

const state = {
  config: defaultConfig(),
  uploadedRows: null,
  uploadFilename: "",
  selectedUploadFile: null,
};

function $(id) {
  return document.getElementById(id);
}

function defaultConfig() {
  return {
    schema_version: 3,
    company_id: "demo-company",
    revision: new Date().toISOString().slice(0, 10) + ".1",
    pricing: {
      currency: "CNY",
      decimal_places: 1,
      discount_step: { default: 0.1, min: 0.1, presets: [0.1, 0.5, 1] },
      rounding: { mode: "ceil", integer_above: 100 },
      default_formula: "face_price * discount_percent / 100",
    },
    fields: [
      { key: "code", label: "代码", type: "text", source: "price", excel_aliases: ["代码", "物料编码"], searchable: true, copyable: true, required: false, result_area: "identity" },
      { key: "spec", label: "规格型号", type: "text", source: "price", excel_aliases: ["规格型号", "规格", "型号"], searchable: true, copyable: true, required: true, result_area: "identity" },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价", "面价"], searchable: false, copyable: false, required: false, result_area: "metric" },
      { key: "quote_price", label: "报价", type: "computed", source: "computed", excel_aliases: [], searchable: false, copyable: true, required: false, result_area: "metric" },
      { key: "special", label: "特价", type: "text", source: "price", excel_aliases: ["特价", "活动"], searchable: true, copyable: true, required: false, result_area: "chip" },
    ],
    rules: [
      { id: "ex_activity", label: "EX 活动", priority: 10, when: { all: [{ field: "special", op: "contains", value: "EX活动" }] }, actions: [{ type: "set_discount", percent: 32 }] },
      { id: "default", label: "默认折扣", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 55 }] },
    ],
    copy: {
      columns: [
        { field: "spec", label: "规格", default: true, line: "main" },
        { field: "quote_price", label: "报价", default: true, line: "main", prefix: "含税" },
      ],
    },
    ui: {
      app_title: "智能询价系统",
      result_layout: {
        identity: ["code", "spec"],
        metrics: ["face_price", "quote_price"],
        chips: ["special"],
        details: [],
      },
    },
    integrations: {
      erpnext: { enabled: false, base_url: "", item_code_field: "code", price_list: "Standard Selling", warehouse_map: {} },
    },
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function setStatus(text, isError) {
  $("statusText").textContent = text;
  $("statusText").classList.toggle("danger", Boolean(isError));
}

async function request(path, options) {
  const response = await fetch(apiBase + path, {
    headers: { "Content-Type": "application/json", ...(options && options.headers ? options.headers : {}) },
    ...options,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    if (!response.ok) throw new Error(`服务器返回非 JSON 响应 (HTTP ${response.status}): ${text.slice(0, 200)}`);
    throw new Error("服务器返回了非 JSON 格式的响应");
  }
  if (!response.ok) throw new Error(data.detail || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function parseListInput(str) {
  return (str || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Collect ────────────────────────────────────────────────────────────────

function collectConfig() {
  const config = JSON.parse(JSON.stringify(state.config));
  config.company_id = $("companyId").value.trim();
  config.revision = $("revision").value.trim() || new Date().toISOString();

  // Fields
  config.fields = Array.from(document.querySelectorAll("[data-field-row]")).map((row) => ({
    key: row.querySelector("[data-key]").value.trim(),
    label: row.querySelector("[data-label]").value.trim(),
    type: row.querySelector("[data-type]").value,
    source: row.querySelector("[data-source]").value,
    excel_aliases: row.querySelector("[data-aliases]").value.split(",").map((item) => item.trim()).filter(Boolean),
    searchable: row.querySelector("[data-searchable]").checked,
    copyable: row.querySelector("[data-copyable]").checked,
    required: false,
    result_area: row.querySelector("[data-area]").value,
  })).filter((field) => field.key);

  // field map for later use
  const fieldMap = Object.fromEntries((config.fields || []).map((field) => [field.key, field]));

  // Rules
  config.rules = Array.from(document.querySelectorAll("[data-rule-row]")).map((row) => {
    const isDefault = row.querySelector("[data-rule-default]").value === "true";
    const condition = {
      field: row.querySelector("[data-rule-field]").value.trim(),
      op: row.querySelector("[data-rule-op]").value,
      value: row.querySelector("[data-rule-value]").value.trim(),
    };
    const rule = {
      id: row.querySelector("[data-rule-id]").value.trim(),
      label: row.querySelector("[data-rule-label]").value.trim(),
      priority: Number(row.querySelector("[data-rule-priority]").value || 999),
      default: isDefault,
      actions: [{ type: "set_discount", percent: Number(row.querySelector("[data-rule-percent]").value || 55) }],
    };
    if (!isDefault) rule.when = { all: [condition] };
    return rule;
  }).filter((rule) => rule.id);

  // Copy columns
  config.copy.columns = Array.from(document.querySelectorAll("[data-copy-row]")).map((row) => {
    const fieldKey = row.querySelector("[data-copy-field]").value.trim();
    const field = fieldKey ? fieldMap[fieldKey] : null;
    return {
      field: fieldKey,
      label: (field && field.label) || fieldKey,
      line: row.querySelector("[data-copy-line]").value,
      default: row.querySelector("[data-copy-default]").checked,
      prefix: row.querySelector("[data-copy-prefix]").value,
    };
  }).filter((column) => column.field);

  // UI config
  const rowFields = Array.from(document.querySelectorAll("[data-ui-field-row]"));
  const layout = { identity: [], metrics: [], chips: [], details: [] };
  /* fieldMap defined above */
  rowFields.forEach((row) => {
    const key = row.dataset.fieldKey;
    if (!key) return;
    const checked = row.querySelector("[data-ui-field-visible]").checked;
    if (!checked) return;
    const area = (fieldMap[key] && fieldMap[key].result_area) || "details";
    if (layout[area]) {
      layout[area].push(key);
    } else {
      layout.details.push(key);
    }
  });
  config.ui = {
    app_title: $("uiAppTitle").value.trim() || "智能询价系统",
    result_layout: layout,
  };

  // Pricing
  const discountStepVal = Number($("pricingDiscountStep").value ?? 0.1);
  const discountStepMin = Math.max(0.01, discountStepVal);
  const presetsRaw = ($("pricingDiscountStepPresets").value || "").split(/[,，\s]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
  config.pricing = {
    currency: "CNY",
    decimal_places: Number($("pricingDecimals").value ?? 1),
    discount_step: {
      default: Math.max(discountStepMin, discountStepVal),
      min: discountStepMin,
      presets: presetsRaw.length ? presetsRaw : [0.1, 0.5, 1],
    },
    rounding: {
      mode: $("pricingRoundMode").value || "ceil",
      integer_above: Number($("pricingIntegerAbove").value ?? 100),
    },
    default_formula: $("pricingFormula").value.trim() || "face_price * discount_percent / 100",
  };

  // ERPNext
  config.integrations.erpnext = {
    enabled: $("erpEnabled").value === "true",
    base_url: $("erpBaseUrl").value.trim(),
    item_code_field: $("erpItemCodeField").value.trim() || "code",
    price_list: $("erpPriceList").value.trim() || "Standard Selling",
    warehouse_map: {},
  };

  state.config = config;
  return config;
}

// ─── Render ─────────────────────────────────────────────────────────────────

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
  $("companyId").value = state.config.company_id || "demo-company";
  $("revision").value = state.config.revision || "";
  $("activeRevision").textContent = state.config.revision || "未发布";
  renderFieldRows();
  renderRuleRows();
  renderCopyRows();
  renderUiConfig();
  renderPricing();
  renderErp();
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

    const condition =
      ((rule.when || {}).all || [{}])[0] || {};

    const action =
      (rule.actions || [{}])[0] || {};

    return `
      <div class="rule-row" data-rule-row>

        <input
          data-rule-id
          value="${escapeHtml(rule.id || "")}"
          placeholder="ID">

        <input
          data-rule-label
          value="${escapeHtml(rule.label || "")}"
          placeholder="规则名称">

        <input
          data-rule-priority
          type="number"
          value="${escapeHtml(rule.priority || 999)}">

        <select data-rule-default>
          <option value="false"${rule.default ? "" : " selected"}>否</option>
          <option value="true"${rule.default ? " selected" : ""}>是</option>
        </select>

        <select data-rule-field>
          ${getFieldSelectOptions(condition.field || "")}
        </select>

        <input
          data-rule-percent
          type="number"
          value="${escapeHtml(action.percent || 55)}">

        <select data-rule-op>
          ${ruleOperators.map(item =>
            option(
              item.value,
              item.label,
              condition.op || "contains"
            )
          ).join("")}
        </select>

        <input
          data-rule-value
          value="${escapeHtml(condition.value || "")}"
          placeholder="匹配值">

        <button
          type="button"
          class="small-btn danger-btn"
          data-remove-rule="${index}">
          删除
        </button>

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
  // 表格布局：只渲染一行标题 + 数据行，避免每行重复标题
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
  const layout = ui.result_layout || {};
  const fields = state.config.fields || [];
  const visibleKeys = new Set([...(layout.identity || []), ...(layout.metrics || []), ...(layout.chips || []), ...(layout.details || [])]);

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
  // discount_step can be a flat number (legacy) or object (current)
  const ds = pricing.discount_step || {};
  const stepDefault = typeof ds === "number" ? ds : (ds.default ?? 0.1);
  const stepPresets = Array.isArray(ds.presets) ? ds.presets : [0.1, 0.5, 1];
  $("pricingDiscountStep").value = stepDefault;
  $("pricingDiscountStepPresets").value = stepPresets.join(", ");
  const rounding = pricing.rounding || {};
  $("pricingRoundMode").value = rounding.mode || "ceil";
  $("pricingIntegerAbove").value = rounding.integer_above ?? 100;
}

function renderErp() {
  const erp = ((state.config.integrations || {}).erpnext || {});
  $("erpEnabled").value = erp.enabled ? "true" : "false";
  $("erpBaseUrl").value = erp.base_url || "";
  $("erpItemCodeField").value = erp.item_code_field || "code";
  $("erpPriceList").value = erp.price_list || "Standard Selling";
}

function updateAdvancedJson() {
  $("advancedJson").value = JSON.stringify(state.config, null, 2);
}


  
function updatePreview() {
  // inspector 已移除，仅更新 copyPreview
  const config = collectConfig();
  const preview = $("copyPreview");
  if (preview) preview.innerHTML = getCopyPreviewMarkup(config);
}

// ─── Company API Calls ───────────────────────────────────────────────────────

async function listCompanies() {
  const companies = await request("/api/companies");
  const list = $("companyList");
  if (!companies.length) {
    list.innerHTML = '<p style="color:var(--muted)">暂无公司记录</p>';
  } else {
    list.innerHTML = `<div class="company-chips">${companies.map((c) => {
      const statusBadge = c.status === "active"
        ? '<span class="badge badge-green">活跃</span>'
        : '<span class="badge badge-muted">已停用</span>';
      const isActive = c.status === "active";
      return `
        <div class="company-chip-card">
          <button type="button" class="chip-btn chip-select" data-company-id="${escapeHtml(c.id)}" data-company-name="${escapeHtml(c.name)}">
            ${escapeHtml(c.name)} <small>${escapeHtml(c.code)}</small>
          </button>
          ${statusBadge}
          <button type="button" class="small-btn" data-rename-company="${escapeHtml(c.id)}" title="重命名">✏</button>
          ${isActive
            ? `<button type="button" class="small-btn warn-btn" data-deactivate-company="${escapeHtml(c.id)}" title="停用公司">停用</button>`
            : `<button type="button" class="small-btn success-btn" data-activate-company="${escapeHtml(c.id)}" title="激活公司">激活</button>`
          }
          <button type="button" class="small-btn danger-btn" data-hard-delete-company="${escapeHtml(c.id)}" title="彻底删除公司（不可恢复）">删除</button>
        </div>
      `;
    }).join("")}</div>`;
  }
  list.style.display = "block";
  setStatus(`共 ${companies.length} 个公司`);
}

async function createCompany() {
  const name = $("companyName").value.trim();
  if (!name) { setStatus("错误：公司名称不能为空"); return; }
  const code = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/(^-|-$)/g, "");
  const payload = { name, code };
  const data = await request("/api/companies", { method: "POST", body: JSON.stringify(payload) });
  $("companyId").value = data.company_id;
  state.config.company_id = data.company_id;
  setStatus("公司已创建");
  updatePreview();
  await listCompanies();
}

async function deleteCompany(companyId, hard = false) {
  if (!hard) {
    // Soft delete = 停用
    if (!confirm(`确认停用公司 ${companyId}？停用后配置和数据仍保留，可重新激活恢复。`)) return;
  } else {
    // Hard delete = 彻底删除
    if (!confirm(`⚠️ 确认彻底删除公司 ${companyId}？\n\n此操作将删除该公司所有配置、料号和审计记录，且不可恢复！\n\n点击"确定"继续，点击"取消"中止。`)) return;
  }
  const url = `/api/companies/${encodeURIComponent(companyId)}${hard ? "?hard=true" : ""}`;
  await request(url, { method: "DELETE" });
  setStatus(hard ? `公司 ${companyId} 已彻底删除` : `公司 ${companyId} 已停用`);
  await listCompanies();
}

async function deactivateCompany(companyId) {
  if (!confirm(`确认停用公司 ${companyId}？停用后配置和数据仍保留，可重新激活恢复。`)) return;
  await request(`/api/companies/${encodeURIComponent(companyId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "inactive" }),
  });
  setStatus(`公司 ${companyId} 已停用`);
  await listCompanies();
}

async function activateCompany(companyId) {
  await request(`/api/companies/${encodeURIComponent(companyId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "active" }),
  });
  setStatus(`公司 ${companyId} 已激活`);
  await listCompanies();
}

function openRenamePanel(companyId) {
  $("renameTarget").value = companyId;
  $("renameNewName").value = "";
  $("renameNewId").value = "";
  $("renamePanel").style.display = "flex";
  $("renameNewName").focus();
}

async function confirmRename() {
  const companyId = $("renameTarget").value;
  const newName = $("renameNewName").value.trim();
  const newId = $("renameNewId").value.trim();
  if (!newName && !newId) { setStatus("请输入新名称或新 company_id", true); return; }
  const payload = {};
  if (newName) payload.name = newName;
  if (newId) payload.new_id = newId;
  const result = await request(`/api/companies/${encodeURIComponent(companyId)}/rename`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  $("renamePanel").style.display = "none";
  setStatus(`公司已更新：${result.new_id || companyId}`);
  // If id changed, switch to new id
  if (result.new_id) {
    $("companyId").value = result.new_id;
    state.config.company_id = result.new_id;
  }
  if (result.name) $("companyName").value = result.name;
  await listCompanies();
}

// ─── Config API Calls ────────────────────────────────────────────────────────

async function loadConfig() {
  const companyId = $("companyId").value.trim();
  state.config = await request(`/api/companies/${encodeURIComponent(companyId)}/config`);
  renderAll();
  setStatus("配置已读取");
}

async function saveConfig(status) {
  const companyId = $("companyId").value.trim();
  const config = collectConfig();
  state.config = await request(`/api/companies/${encodeURIComponent(companyId)}/config`, {
    method: "POST",
    body: JSON.stringify({ config, status }),
  });
  renderAll();
  setStatus(status === "published" ? "配置已发布" : "草稿已保存");
}

async function validateConfig() {
  const companyId = $("companyId").value.trim();
  let result;
  try {
    result = await request(`/api/companies/${encodeURIComponent(companyId)}/config/validate`);
  } catch {
    // 如果没有发布版本，先用当前草稿在前端做基础校验
    const config = collectConfig();
    const rules = config.rules || [];
    const hasDefault = rules.some((r) => r.default);
    result = {
      valid: hasDefault,
      errors: hasDefault ? [] : ["缺少默认规则（default=true），报价时无兜底折扣"],
    };
  }
  const panel = $("validateResult");
  if (result.valid) {
    panel.innerHTML = '<div class="validate-pass">✅ 配置校验通过，可以发布</div>';
  } else {
    panel.innerHTML = `<div class="validate-fail">
      <strong>❌ 校验发现 ${result.errors.length} 个问题，请修复后再发布：</strong>
      <ul>${(result.errors || []).map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
    </div>`;
  }
  panel.style.display = "block";
  setStatus(result.valid ? "校验通过" : `校验失败，${result.errors.length} 个问题`);
}

// ─── History & Audit ─────────────────────────────────────────────────────────

async function loadHistory() {
  const companyId = $("companyId").value.trim();
  const configs = await request(`/api/companies/${encodeURIComponent(companyId)}/configs`);
  const tbody = $("historyRows");
  if (!configs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center">暂无历史记录</td></tr>';
    return;
  }
  tbody.innerHTML = configs.map((c) => {
    const statusBadge = c.status === "published"
      ? '<span class="badge badge-green">已发布</span>'
      : c.status === "archived"
        ? '<span class="badge badge-muted">已归档</span>'
        : '<span class="badge badge-amber">草稿</span>';
    const rollbackBtn = c.status !== "published"
      ? `<button type="button" class="small-btn" data-rollback="${escapeHtml(c.revision)}">回滚至此版本</button>`
      : '<span style="color:var(--muted);font-size:12px">当前版本</span>';
    const deleteBtn = `<button type="button" class="small-btn danger-btn" data-delete-revision="${escapeHtml(c.revision)}" title="删除此版本">删除</button>`;
    return `
      <tr>
        <td><code>${escapeHtml(c.revision)}</code></td>
        <td>${statusBadge}</td>
        <td>${escapeHtml(c.published_at ? c.published_at.slice(0, 19).replace("T", " ") : "—")}</td>
        <td>${escapeHtml(c.created_at ? c.created_at.slice(0, 19).replace("T", " ") : "—")}</td>
        <td>${rollbackBtn}</td>
        <td>${deleteBtn}</td>
      </tr>
    `;
  }).join("");
  setStatus(`共 ${configs.length} 个版本`);
}

async function rollbackToRevision(revision) {
  const companyId = $("companyId").value.trim();
  if (!confirm(`确认将 ${revision} 回滚为当前发布版本？`)) return;
  state.config = await request(
    `/api/companies/${encodeURIComponent(companyId)}/config/${encodeURIComponent(revision)}/publish`,
    { method: "POST" }
  );
  renderAll();
  setStatus(`已回滚至版本 ${revision}`);
  await loadHistory();
}

async function deleteConfigRevision(revision) {
  const companyId = $("companyId").value.trim();
  if (!confirm(`确认删除版本 ${revision}？此操作不可恢复！`)) return;
  await request(
    `/api/companies/${encodeURIComponent(companyId)}/config/${encodeURIComponent(revision)}`,
    { method: "DELETE" }
  );
  setStatus(`版本 ${revision} 已删除`);
  await loadHistory();
}

async function loadAudit() {
  const companyId = $("companyId").value.trim();
  const events = await request(`/api/companies/${encodeURIComponent(companyId)}/audit`);
  const tbody = $("auditRows");
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center">暂无审计记录</td></tr>';
    return;
  }
  tbody.innerHTML = events.map((e) => `
    <tr>
      <td>${escapeHtml(e.created_at ? e.created_at.slice(0, 19).replace("T", " ") : "—")}</td>
      <td><code>${escapeHtml(e.action || "")}</code></td>
      <td>${escapeHtml(e.target_type || "")}</td>
      <td>${escapeHtml(e.target_id || "—")}</td>
      <td>${escapeHtml(e.actor_id || "—")}</td>
    </tr>
  `).join("");
  setStatus(`共 ${events.length} 条审计记录`);
}

// ─── Misc ────────────────────────────────────────────────────────────────────

async function exportConfig(fmt) {
  const companyId = $("companyId").value.trim();
  const revision = encodeURIComponent($("revision").value.trim());
  const response = await fetch(`${apiBase}/api/companies/${encodeURIComponent(companyId)}/config/${revision}/export?fmt=${fmt}`);
  $("advancedJson").value = await response.text();
  setStatus(fmt.toUpperCase() + " 已导出到高级区域");
}

async function importJson() {
  const companyId = $("companyId").value.trim();
  try {
    const exampleConfig = await request(`/api/config/example`);
    const payload = JSON.stringify({ content: JSON.stringify(exampleConfig, null, 2), fmt: "json", status: "draft" });
    state.config = await request(`/api/companies/${encodeURIComponent(companyId)}/config/import`, {
      method: "POST",
      body: payload,
    });
    $("advancedJson").value = JSON.stringify(exampleConfig, null, 2);
    renderAll();
    setStatus("示例配置已导入为草稿");
  } catch (err) {
    setStatus(`示例导入失败：${err.message}`, true);
    throw err;
  }
}

async function testErp() {
  const companyId = $("companyId").value.trim();
  await request(`/api/companies/${encodeURIComponent(companyId)}/integrations/erpnext/test`, { method: "POST" });
  setStatus("ERPNext 已配置");
}

// ─── Merger / Bundle ────────────────────────────────────────────────────────

const SUPABASE_KEY_STORAGE = "quotation-admin-supabase-anon-key";

async function detectBrands() {
  const input = $("mergerFiles");
  if (!input.files.length) {
    setStatus("请先选择品牌原始文件", true);
    return;
  }

  const companyId = $("companyId").value.trim();
  const formData = new FormData();
  for (let i = 0; i < input.files.length; i++) {
    formData.append("files", input.files[i]);
  }

  setStatus(`正在识别 ${input.files.length} 个文件的品牌…`);
  const response = await fetch(`${apiBase}/api/companies/${encodeURIComponent(companyId)}/merger/detect-brands`, {
    method: "POST",
    body: formData,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || response.statusText);

  // 渲染品牌检测结果
  const files = data.files || [];
  // 从配置中获取品牌列表
  const brands = getBrandOptions();

  $("brandDetectionBody").innerHTML = files.map((f, idx) => {
    const detected = f.detected_brand || "UNMAPPED";
    const optionsHtml = brands.map((b) =>
      `<option value="${escapeHtml(b)}"${b === detected ? " selected" : ""}>${escapeHtml(b)}</option>`
    ).join("");
    return `
      <tr>
        <td>${escapeHtml(f.filename)}</td>
        <td><code>${escapeHtml(detected)}</code></td>
        <td><select data-brand-override="${idx}">${optionsHtml}</select></td>
        <td>${f.row_count}</td>
        <td data-merge-status="${idx}">未处理</td>
        <td><button type="button" class="small-btn" data-import-single="${idx}" data-filename="${escapeHtml(f.filename)}">导入此文件</button></td>
      </tr>
    `;
  }).join("");

  // 存储检测结果供后续导入使用
  state._mergerFiles = files;
  state._mergerInput = input;

  $("brandDetectionResult").style.display = "block";
  if (files.some((f) => f.row_count === 0)) {
    setStatus("部分文件检测到 0 条有效数据，可能是当前公司配置未保存或字段别名不匹配。请先保存配置或优先使用 merger/index.html。", true);
  } else {
    setStatus(`识别完成：${files.length} 个文件，请检查品牌归属`);
  }
}

function getBrandOptions() {
  const rules = (state.config.merger || {}).brand_rules || {};
  const brands = (rules.brands || []).map((b) => b.id);
  const fallback = rules.defaultBrand || "UNMAPPED";
  if (!brands.includes(fallback)) brands.push(fallback);
  return brands;
}

async function importByBrand() {
  const companyId = $("companyId").value.trim();
  if (!state._mergerFiles || !state._mergerInput) {
    setStatus("请先识别品牌", true);
    return;
  }

  // 读取品牌修正
  const overrides = {};
  document.querySelectorAll("[data-brand-override]").forEach((sel) => {
    const idx = sel.dataset.brandOverride;
    overrides[idx] = sel.value;
  });

  // 逐个导入（按修正后的品牌标记）
  let total = 0;
  // 记录此次导入的元信息，供前端撤销使用
  state._lastImport = { files: [], timestamp: new Date().toISOString() };
  for (let i = 0; i < state._mergerInput.files.length; i++) {
    const file = state._mergerInput.files[i];
    const brand = overrides[String(i)] || state._mergerFiles[i]?.detected_brand || "UNMAPPED";
    const formData = new FormData();
    formData.append("file", file);

    const rev = `${brand}_${new Date().toISOString().slice(0, 10)}`;
    let url = `/api/companies/${encodeURIComponent(companyId)}/items/upload?write=true&data_revision=${encodeURIComponent(rev)}`;
    const response = await fetch(apiBase + url, { method: "POST", body: formData });
    let data;
    try {
      data = await response.json();
      if (!response.ok) throw new Error(data.detail || response.statusText);
    } catch (err) {
      const statusEl = document.querySelector(`[data-merge-status="${i}"]`);
      if (statusEl) statusEl.textContent = `失败`;
      setStatus(`导入 ${file.name} 失败：${err.message}`, true);
      continue;
    }
    total += data.count;
    // 更新表格中对应文件的处理状态
    try {
      const statusEl = document.querySelector(`[data-merge-status="${i}"]`);
      if (statusEl) {
        statusEl.textContent = data.count ? `已导入 ${data.count} 条` : `未导入：无有效行`;
      }
      if (state._mergerFiles && state._mergerFiles[i]) state._mergerFiles[i].importedCount = data.count;
      // 记录成功导入文件信息
      if (data.count) {
        state._lastImport.files.push({ index: i, filename: file.name, count: data.count, revision: rev });
      }
    } catch (e) { /* ignore DOM update errors */ }
  }

  let failCount = state._mergerInput.files.length - state._lastImport.files.length;
  if (failCount > 0) {
    setStatus(`⚠️ 已导入 ${total} 条数据（${state._lastImport.files.length}/${state._mergerInput.files.length} 个文件成功，${failCount} 个失败）`, true);
  } else {
    setStatus(`✅ 已导入 ${total} 条数据（${state._mergerInput.files.length} 个文件）`);
  }
  await loadStats();
}

// 前端撤销上次导入：将表格回滚为未处理（仅前端展示）。真正回滚需后端支持。
async function undoLastImport() {
  if (!state._lastImport || !state._lastImport.files || !state._lastImport.files.length) {
    setStatus('没有可撤销的最近导入', true);
    return;
  }

  const companyId = $("companyId").value.trim();
  const results = [];
  for (const info of state._lastImport.files) {
    if (!info.revision) continue;
    try {
      const url = `/api/companies/${encodeURIComponent(companyId)}/items/rollback?data_revision=${encodeURIComponent(info.revision)}`;
      const response = await fetch(apiBase + url, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || response.statusText);
      results.push(`已撤销 ${info.revision}(${data.deleted} 条)`);
      const el = document.querySelector(`[data-merge-status="${info.index}"]`);
      if (el) el.textContent = '已撤销';
      if (state._mergerFiles && state._mergerFiles[info.index]) state._mergerFiles[info.index].importedCount = 0;
    } catch (err) {
      results.push(`撤销 ${info.revision} 失败：${err.message}`);
    }
  }

  setStatus(results.join('；'));
  state._lastImport = null;
}

async function importSingleMergerFile(idx) {
  if (!state._mergerInput || !state._mergerFiles) {
    setStatus("请先识别品牌", true);
    return;
  }

  const companyId = $("companyId").value.trim();
  const file = state._mergerInput.files[idx];
  const sel = document.querySelector(`[data-brand-override="${idx}"]`);
  const brand = sel ? sel.value : state._mergerFiles[idx]?.detected_brand || "UNMAPPED";

  const formData = new FormData();
  formData.append("file", file);

  const rev = `${brand}_${new Date().toISOString().slice(0, 10)}`;
  let url = `/api/companies/${encodeURIComponent(companyId)}/items/upload?write=true&data_revision=${encodeURIComponent(rev)}`;
  const response = await fetch(apiBase + url, { method: "POST", body: formData });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || response.statusText);

  setStatus(`✅ ${file.name}（${brand}）已导入 ${data.count} 条`);
  try {
    const statusEl = document.querySelector(`[data-merge-status="${idx}"]`);
    if (statusEl) {
      statusEl.textContent = data.count ? `已导入 ${data.count} 条` : `未导入：无有效行`;
    }
    if (state._mergerFiles && state._mergerFiles[idx]) state._mergerFiles[idx].importedCount = data.count;
  } catch (e) { }
  await loadStats();
}

async function generateBundle(deploy = false) {
  const companyId = $("companyId").value.trim();
  const password = $("bundlePassword").value;
  const anonKey = $("supabaseAnonKey").value.trim();

  if (deploy && !anonKey) {
    setStatus("部署到 Supabase 需要填写 Anon Key", true);
    return;
  }

  // 持久化 anon key（仅 sessionStorage，避免长期保留在 localStorage）
  if (anonKey) {
    try { sessionStorage.setItem(SUPABASE_KEY_STORAGE, anonKey); } catch {}
  }

  setStatus(deploy ? "正在生成 Bundle 并部署…" : "正在生成 Bundle…");

  const payload = {
    password: password,
    deploy: deploy,
    anon_key: deploy ? anonKey : "",
  };

  const data = await request(`/api/companies/${encodeURIComponent(companyId)}/merger/bundle/generate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const priceRows = data.price_bundle?.meta?.rowCount ?? "?";
  const stockRows = data.stock_bundle?.meta?.rowCount ?? "?";
  const encrypted = data.price_bundle?.secured ? "🔒 已加密" : "📖 明文";

  let html = `
    <div class="mapping-report">
      <div class="mapping-item matched-fields">
        <strong>📦 价格包</strong>
        <span>${encrypted} · ${priceRows} 条</span>
      </div>
      <div class="mapping-item matched-fields">
        <strong>📦 库存包</strong>
        <span>📖 明文 · ${stockRows} 条</span>
      </div>
    </div>
  `;

  if (data.deploy) {
    const deployInfo = data.deploy || {};
    html += `
      <div class="validate-pass" style="margin-top:8px;">
        ✅ 已部署到 Supabase<br>
        价格包：${escapeHtml(deployInfo.price || "—")}<br>
        库存包：${escapeHtml(deployInfo.stock || "—")}
      </div>
    `;
  }

  $("bundleResult").innerHTML = html;
  $("bundleResult").style.display = "block";

  setStatus(deploy
    ? `✅ Bundle 已生成并部署（价格 ${priceRows} 条，库存 ${stockRows} 条）`
    : `✅ Bundle 已生成（价格 ${priceRows} 条，库存 ${stockRows} 条）`
  );
}

// ─── Event Binding ──────────────────────────────────────────────────────────

function bind() {
  if (g_AdminEventsBound) return;
  g_AdminEventsBound = true;
  document.body.addEventListener("input", (event) => {
    if (event.target.closest(".workspace")) {
      const fieldRow = event.target.closest("[data-field-row]");
      if (fieldRow) {
        try { renderRuleRows(); renderCopyRows(); renderUiConfig(); } catch { /* ignore render errors */ }
      }
    }
  });

  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    // Remove buttons — collectConfig only when modifying config structure
    if (target.dataset.removeField) { const c = collectConfig(); c.fields.splice(Number(target.dataset.removeField), 1); renderAll(); return; }
    if (target.dataset.removeRule) { const c = collectConfig(); c.rules.splice(Number(target.dataset.removeRule), 1); renderAll(); return; }
    if (target.dataset.removeCopy) { const c = collectConfig(); c.copy.columns.splice(Number(target.dataset.removeCopy), 1); renderAll(); return; }

    // Company chip selection
    if (target.dataset.companyId) {
      const newId = target.dataset.companyId;
      const newName = target.dataset.companyName || "";
      // Update form
      $("companyId").value = newId;
      if (newName) $("companyName").value = newName;
      state.config.company_id = newId;
      // Highlight active chip
      document.querySelectorAll(".chip-select").forEach(el => el.classList.remove("active"));
      target.classList.add("active");
      setStatus(`已切换到 ${newName || newId}`);
      // Auto-load config
      run(loadConfig);
      return;
    }

    // Company management
    if (target.dataset.deactivateCompany) { run(() => deactivateCompany(target.dataset.deactivateCompany)); return; }
    if (target.dataset.activateCompany) { run(() => activateCompany(target.dataset.activateCompany)); return; }
    if (target.dataset.hardDeleteCompany) { run(() => deleteCompany(target.dataset.hardDeleteCompany, true)); return; }
    if (target.dataset.renameCompany) { openRenamePanel(target.dataset.renameCompany); return; }

    // Merger single file import
    if (target.dataset.importSingle) { run(() => importSingleMergerFile(Number(target.dataset.importSingle))); return; }

    // Rollback
    if (target.dataset.rollback) { run(() => rollbackToRevision(target.dataset.rollback)); return; }
    // Delete revision
    if (target.dataset.deleteRevision) { run(() => deleteConfigRevision(target.dataset.deleteRevision)); return; }

    // Tab buttons
    if (target.dataset.tab) { return; } // tabs removed
  });

  // Company management
  $("listCompaniesBtn").addEventListener("click", () => run(listCompanies));
  $("createCompanyBtn").addEventListener("click", () => run(createCompany));
  $("confirmRenameBtn").addEventListener("click", () => run(confirmRename));
  $("cancelRenameBtn").addEventListener("click", () => { $("renamePanel").style.display = "none"; });

  // Config
  $("loadConfigBtn").addEventListener("click", () => run(loadConfig));
  $("saveDraftBtn").addEventListener("click", () => run(() => saveConfig("draft")));
  $("publishBtn").addEventListener("click", () => run(() => saveConfig("published")));
  $("validateConfigBtn").addEventListener("click", () => run(validateConfig));

  // Fields / rules / copy add
  $("addFieldBtn").addEventListener("click", () => {
    collectConfig().fields.push({ key: "", label: "", type: "text", source: "price", excel_aliases: [], searchable: false, copyable: false, result_area: "detail" });
    renderAll();
  });
  $("addRuleBtn").addEventListener("click", () => {
    collectConfig().rules.push({ id: "new_rule", label: "新规则", priority: 100, when: { all: [{ field: "spec", op: "contains", value: "" }] }, actions: [{ type: "set_discount", percent: 55 }] });
    renderAll();
  });
  $("addCopyColumnBtn").addEventListener("click", () => {
    collectConfig().copy.columns.push({ field: "spec", label: "规格", default: true, line: "main" });
    renderAll();
  });

  // Misc
  $("exportJsonBtn").addEventListener("click", () => run(() => exportConfig("json")));
  $("exportYamlBtn").addEventListener("click", () => run(() => exportConfig("yaml")));
  $("importJsonBtn").addEventListener("click", () => run(importJson));
  $("testErpBtn").addEventListener("click", () => run(testErp));
  $("loadHistoryBtn").addEventListener("click", () => run(loadHistory));
  $("loadAuditBtn").addEventListener("click", () => run(loadAudit));

  // Merger / Bundle
  const detectBrandsBtn = $("detectBrandsBtn");
  if (detectBrandsBtn) detectBrandsBtn.addEventListener("click", () => run(detectBrands));
  const importByBrandBtn = $("importByBrandBtn");
  if (importByBrandBtn) importByBrandBtn.addEventListener("click", () => run(importByBrand));
  const undoLastImportBtn = $("undoLastImportBtn");
  if (undoLastImportBtn) undoLastImportBtn.addEventListener("click", () => run(undoLastImport));
  const generateBundleBtn = $("generateBundleBtn");
  if (generateBundleBtn) generateBundleBtn.addEventListener("click", () => run(() => generateBundle(false)));
  const deployBundleBtn = $("deployBundleBtn");
  if (deployBundleBtn) deployBundleBtn.addEventListener("click", () => run(() => generateBundle(true)));

  // Restore Supabase anon key（仅从 sessionStorage 恢复）
  try {
    const anonInput = $("supabaseAnonKey");
    if (anonInput) anonInput.value = sessionStorage.getItem(SUPABASE_KEY_STORAGE) || "";
  } catch {}

  // ─── Supabase 部署面板 ────────────────────────────────────────────
  const SB_KEY = "quotation-admin-sb-anon-key";
  const sbAnonKeyInput  = $("sb-anonKey");
  const sbBaseUrlInput  = $("sb-baseUrl");

  // 恢复 anon key
  try {
    if (sbAnonKeyInput) sbAnonKeyInput.value = sessionStorage.getItem(SB_KEY) || "";
  } catch {}

  // 从当前配置自动填充 base_url（如果 input 为空）
  function sbAutoFillBaseUrl() {
    if (!sbBaseUrlInput || sbBaseUrlInput.value.trim()) return;
    try {
      const cfg = collectConfig();
      const baseUrl = (cfg.data_source && cfg.data_source.base_url) ? cfg.data_source.base_url : "";
      if (baseUrl) sbBaseUrlInput.value = baseUrl;
    } catch {}
  }

  function sbSetStatus(msg, type) {
    const bar = $("sb-statusBar");
    if (!bar) return;
    bar.textContent = msg;
    bar.className = "supabase-status " + (type || "info");
  }

  function sbGetAnonKey() {
    const key = sbAnonKeyInput ? sbAnonKeyInput.value.trim() : "";
    if (!key) throw new Error("请先填写 Supabase Anon Key");
    try { sessionStorage.setItem(SB_KEY, key); } catch {}
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
    const key     = sbGetAnonKey();
    const baseUrl = sbGetBaseUrl();

    // 将 public object URL 转为可写 URL
    // base_url 形如 https://xxx.supabase.co/storage/v1/object/public/bucket/dir
    // 写入 URL    形如 https://xxx.supabase.co/storage/v1/object/bucket/dir/filename
    const publicPrefix = "/storage/v1/object/public/";
    const writePrefix  = "/storage/v1/object/";
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
        "apikey":         key,
        "authorization":  "Bearer " + key,
        "content-type":   contentType || "application/json;charset=utf-8",
        "x-upsert":       "true",
      },
      body: content,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error("上传失败 HTTP " + resp.status + ": " + text.slice(0, 200));
    }
    sbSetStatus("✅ 已成功上传 " + filename, "ok");
  }

  // 上传 config.json（使用当前草稿配置）
  const sbUploadConfigBtn = $("sb-uploadConfigBtn");
  if (sbUploadConfigBtn) sbUploadConfigBtn.addEventListener("click", async () => {
    try {
      sbAutoFillBaseUrl();
      const cfg = collectConfig();
      await sbUploadFile("config.json", JSON.stringify(cfg, null, 2), "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传价格包（优先读取拼接区内存数据，回退到文件选择器）
  const sbUploadPriceBtn = $("sb-uploadPriceBtn");
  if (sbUploadPriceBtn) sbUploadPriceBtn.addEventListener("click", async () => {
    try {
      let text = null;
      // 优先使用拼接区已生成的价格包（无需手动下载再上传）
      if (window._mergerBundles && window._mergerBundles.price) {
        text = window._mergerBundles.price;
        sbSetStatus("ℹ️ 使用拼接区刚生成的价格包…", "info");
      } else {
        const fileInput = $("sb-priceFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区导出价格包，或手动选择 price.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text); // 校验合法 JSON
      await sbUploadFile("price.bundle.json", text, "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传库存包（优先读取拼接区内存数据，回退到文件选择器）
  const sbUploadStockBtn = $("sb-uploadStockBtn");
  if (sbUploadStockBtn) sbUploadStockBtn.addEventListener("click", async () => {
    try {
      let text = null;
      if (window._mergerBundles && window._mergerBundles.stock) {
        text = window._mergerBundles.stock;
        sbSetStatus("ℹ️ 使用拼接区刚生成的库存包…", "info");
      } else {
        const fileInput = $("sb-stockFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区导出库存包，或手动选择 stock.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text);
      await sbUploadFile("stock.bundle.json", text, "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 当 base_url input 聚焦时尝试从 config 自动填充
  if (sbBaseUrlInput) sbBaseUrlInput.addEventListener("focus", sbAutoFillBaseUrl);
}

async function run(task) {
  try {
    await task();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setJsStatus(text) {
  const el = $("jsStatus");
  if (el) el.textContent = text;
}

function seedDemoRows() {
  const el = $("itemRows");
  if (el) {
    el.value = JSON.stringify([
      { item_key: "WNMG080408", fields: { code: "C001", spec: "WNMG080408", face_price: 101, special: "EX活动" } },
      { item_key: "TNMG160408", fields: { code: "C002", spec: "TNMG160408", face_price: 88, special: "" } },
    ], null, 2);
  }
}

window.addEventListener("DOMContentLoaded", bind);
setJsStatus("已就绪");
seedDemoRows();
renderAll();
// 自动加载公司列表，让用户直接看到管理操作按钮
run(listCompanies);
