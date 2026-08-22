/**
 * config-collect.js — 从表单收集配置对象（collectConfig）。
 *
 * 依赖：admin-core.js（$、state）
 */

function collectConfig() {
  const config = JSON.parse(JSON.stringify(state.config));
  config.revision = $("revision").value.trim() || new Date().toISOString();

  // Fields
  config.fields = Array.from(document.querySelectorAll("[data-field-row]")).map((row) => ({
    key: row.querySelector("[data-key]").value.trim(),
    label: row.querySelector("[data-label]").value.trim(),
    type: row.querySelector("[data-type]").value,
    source: row.querySelector("[data-source]").value,
    // 别名分隔符兼容：逗号(,)、中文逗号(，)、顿号(、)、分号(;；)、竖线(|｜)、制表符、换行。
    // 注意：不按普通空格拆分——英文别名可能含空格（如 "List Price"）。
    // 修复背景：此前只认 [,，]，用户用顿号/分号输入时整串不拆分，
    // 导致 Excel 列名匹配失败 → face_price 缺失 → 报价静默变 0。
    excel_aliases: row.querySelector("[data-aliases]").value.split(/[,，、;；|｜\t\n\r]+/).map((item) => item.trim()).filter(Boolean),
    searchable: row.querySelector("[data-searchable]").checked,
    copyable: row.querySelector("[data-copyable]").checked,
    required: row.querySelector("[data-required]").checked,
    result_area: row.querySelector("[data-area]").value,
  })).filter((field) => field.key);

  const fieldMap = Object.fromEntries((config.fields || []).map((field) => [field.key, field]));

  // Version
  config.version = $("configVersion").value.trim();

  // Data source — DOM 元素已移除（base_url 在公司管理配置），此处保留默认文件名供 bundle 引用
  config.data_source = {
    base_url: "",
    config_file: "config.json",
    price_bundle_file: "price.bundle.json",
    stock_bundle_file: "stock.bundle.json",
    version_file: "version.json",
    cache_name: "quotation-cache-v3",
  };

  // Labels — 只发送非空值
  const rawLabels = {
    app_title: $("uiAppTitle").value.trim(),
    search_button: $("lblSearchBtn").value.trim(),
    stock_search_button: $("lblStockBtn").value.trim(),
    mmc_button: $("lblMmcBtn").value.trim(),
    copy_button: $("lblCopyBtn").value.trim(),
    selected_label: $("lblSelected").value.trim(),
    config_button: $("lblConfig").value.trim(),
    input_title: $("lblInputTitle").value.trim(),
    result_title: $("lblResultTitle").value.trim(),
    query_placeholder: $("lblQueryPlaceholder").value.trim(),
    empty_hint: $("lblEmptyHint").value.trim(),
    stock_prefix: $("lblStockPrefix").value.trim(),
  };
  config.labels = {};
  Object.keys(rawLabels).forEach(function (k) {
    if (rawLabels[k]) config.labels[k] = rawLabels[k];
  });

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
  if (!config.copy || typeof config.copy !== "object") config.copy = {};
  config.copy.empty_value = $("copyEmptyValue").value;
  config.copy.price_prefix = $("copyPricePrefix").value.trim();
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

  // UI config — result_layout goes at top level
  const rowFields = Array.from(document.querySelectorAll("[data-ui-field-row]"));
  const layout = { identity: [], metrics: [], chips: [], details: [] };
  rowFields.forEach((row) => {
    const key = row.dataset.fieldKey;
    if (!key) return;
    const checked = row.querySelector("[data-ui-field-visible]").checked;
    if (!checked) return;
    const area = (fieldMap[key] && fieldMap[key].result_area) || "detail";
    const layoutKey = area === "identity" ? "identity" : area + "s";
    if (layout[layoutKey]) {
      layout[layoutKey].push(key);
    } else {
      layout.details.push(key);
    }
  });
  config.ui = {
    app_title: $("uiAppTitle").value.trim() || "智能询价系统",
  };
  config.result_layout = layout;

  // Pricing
  const discountStepVal = Number($("pricingDiscountStep").value ?? 0.1);
  const discountStepMin = Math.max(0.01, discountStepVal);
  const presetsRaw = ($("pricingDiscountStepPresets").value || "").split(/[,，\s]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
  // 数值输入兜底：Number("" ?? 100) 会得 0（空字符串 ?? 不替换，Number("")=0），
  // 导致取整阈值变 0 → 所有报价被取整为整数。改用 Number.isFinite 判定，
  // 空/非法值回退默认值（与 export-utils / config-core.js 一致）。
  const _num = (id, def) => { var v = Number($(id).value); return Number.isFinite(v) ? v : def; };
  config.pricing = {
    currency: "CNY",
    decimal_places: _num("pricingDecimals", 1),
    discount_step: {
      default: Math.max(discountStepMin, discountStepVal),
      min: discountStepMin,
      presets: presetsRaw.length ? presetsRaw : [0.1, 0.5, 1],
    },
    rounding: {
      mode: $("pricingRoundMode").value || "ceil",
      integer_above: _num("pricingIntegerAbove", 100),
    },
    default_formula: $("pricingFormula").value.trim() || "face_price * discount_percent / 100",
    tax_rate: _num("pricingTaxRate", 13),
    face_price_tax_inclusive: $("pricingFacePriceTaxInclusive").value !== "false",
  };

  state.config = config;
  return config;
}
