﻿﻿﻿(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./data-utils"), require("./bundle-utils"));
  } else {
    root.ExportUtils = factory(root.DataUtils, root.BundleUtils);
  }
})(typeof self !== "undefined" ? self : this, function (DataUtils, BundleUtils) {
  if (!DataUtils || !BundleUtils) throw new Error("DataUtils and BundleUtils are required");

  // ─── 脱敏逻辑（与后端 store._desensitize_item_fields 对齐）──────────
  // 安全：部署到 Supabase public bucket 前，必须移除面价并预计算报价。
  // 敏感字段集必须与后端 base.py SENSITIVE_FIELDS 保持一致，否则 admin
  // 若在 config 里定义了 cost/margin 等字段，会泄露到公开 bucket。
  //
  // TODO 产品化建议：当前前端脱敏逻辑是后端 QuotationEngine.quote_row 的重写版，
  // 如果后端引擎新增 action 类型（如 set_field/set_formula）或 condition op，
  // 前端不会自动同步。建议迁移到后端 API 部署（POST /api/merger/bundle/generate
  // with deploy=true），让后端统一脱敏，前端只触发不计算。

  var DEFAULT_SENSITIVE_FIELDS = [
    "face_price", "discount_percent", "discount",
    "cost", "cost_price", "purchase_price", "supplier_price",
    "margin", "margin_percent", "profit_margin", "base_price",
    "进价", "成本", "采购价",
  ];

  function _getSensitiveFields(config) {
    var security = (config && config.security) || {};
    var custom = security.sensitive_fields;
    if (Array.isArray(custom) && custom.length) {
      return custom.map(function (f) { return String(f); });
    }
    return DEFAULT_SENSITIVE_FIELDS;
  }

  function _toNumber(val) {
    var n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }

  function _conditionMatches(condition, fields) {
    var fieldName = condition.field;
    var op = condition.op;
    var expected = condition.value;
    var rawVal = fields[fieldName];
    var text = rawVal === null || rawVal === undefined ? "" : String(rawVal);

    if (op === "equals") return text === String(expected);
    if (op === "contains") return text.replace(/ /g, "").toUpperCase().indexOf(String(expected).replace(/ /g, "").toUpperCase()) >= 0;
    if (op === "regex") {
      try { return new RegExp(String(expected), "i").test(text); }
      catch (e) { return false; }
    }
    if (op === "in") return Array.isArray(expected) && expected.indexOf(rawVal) >= 0;

    var left = _toNumber(rawVal);
    if (op === "gt") return left > _toNumber(expected);
    if (op === "gte") return left >= _toNumber(expected);
    if (op === "lt") return left < _toNumber(expected);
    if (op === "lte") return left <= _toNumber(expected);
    if (op === "between") {
      var arr = Array.isArray(expected) ? expected : [0, 0];
      return _toNumber(arr[0]) <= left && left <= _toNumber(arr[1]);
    }
    return false;
  }

  function _whenMatches(when, fields) {
    if (!when) return false;
    if (when.all) return (when.all || []).every(function (item) { return _whenMatches(item || {}, fields); });
    if (when.any) return (when.any || []).some(function (item) { return _whenMatches(item || {}, fields); });
    if (when.not) return !_whenMatches(when.not, fields);
    return _conditionMatches(when, fields);
  }

  function _calcDiscountPercent(fields, config) {
    var rules = (config && config.rules) || [];
    var defaultDiscount = 55.0;
    var defaultRule = null;
    var sorted = rules.slice().sort(function (a, b) {
      return (parseInt(a.priority || 0, 10) || 0) - (parseInt(b.priority || 0, 10) || 0);
    });
    for (var i = 0; i < sorted.length; i++) {
      var rule = sorted[i];
      if (rule.default) { defaultRule = rule; continue; }
      var when = rule.when || {};
      if (_whenMatches(when, fields)) {
        var actions = rule.actions || [];
        for (var j = 0; j < actions.length; j++) {
          if (actions[j].type === "set_discount") return parseFloat(actions[j].percent || 55);
        }
        break;
      }
    }
    if (defaultRule) {
      var dActions = defaultRule.actions || [];
      for (var k = 0; k < dActions.length; k++) {
        if (dActions[k].type === "set_discount") return parseFloat(dActions[k].percent || 55);
      }
    }
    return defaultDiscount;
  }

  function _roundPrice(value, decimals, mode) {
    var factor = Math.pow(10, decimals);
    if (mode === "floor") return Math.floor(value * factor + 1e-9) / factor;
    if (mode === "round") return Math.round(value * factor) / factor;
    return Math.ceil(value * factor - 1e-9) / factor;
  }

  function _desensitizeFields(fields, config) {
    var safe = {};
    for (var key in fields) {
      if (fields.hasOwnProperty(key)) safe[key] = fields[key];
    }
    var facePrice = parseFloat(safe.face_price || 0) || 0;
    var discount = _calcDiscountPercent(safe, config);
    var basePrice = facePrice * discount / 100;

    var pricing = (config && config.pricing) || {};
    var rounding = pricing.rounding || {};
    var decimals = Math.max(parseInt(pricing.decimal_places || 1, 10), 0);

    var mode = String(rounding.mode || "ceil");
    var roundedPrice = _roundPrice(basePrice, decimals, mode);
    // 兼容嵌套 rounding.integer_above 与旧扁平 pricing.rounding_threshold；
    // 缺失时 fallback 100（与 config-core.js normalizeConfig 一致），
    // 避免阈值被当 0 导致所有报价被取整为整数（如 70.7 误变 71）。
    var integerAbove = Number(rounding.integer_above);
    if (!Number.isFinite(integerAbove)) integerAbove = Number(pricing.rounding_threshold);
    if (!Number.isFinite(integerAbove)) integerAbove = 100;
    if (roundedPrice > integerAbove) {
      safe.quote_price = String(_roundPrice(basePrice, 0, mode));
    } else {
      safe.quote_price = roundedPrice.toFixed(decimals);
    }

    var sensitiveFields = _getSensitiveFields(config);
    for (var i = 0; i < sensitiveFields.length; i++) {
      delete safe[sensitiveFields[i]];
    }
    return safe;
  }

  function desensitizePriceDataset(dataset, config) {
    if (!dataset || !dataset.rows) return dataset;
    var safe = { schema_version: dataset.schema_version, primary_field: dataset.primary_field, rows: [] };
    for (var i = 0; i < dataset.rows.length; i++) {
      var row = dataset.rows[i];
      safe.rows.push({ key: row.key, fields: _desensitizeFields(row.fields || {}, config) });
    }
    return safe;
  }

  function createStockBundleScript(stockRows, config) {
    var rows = Array.isArray(stockRows) ? stockRows : [];
    var stockDataset = DataUtils.buildStockDataset(rows, config);
    var stockBundle = BundleUtils.encodeStockBundle(stockDataset);
    return {
      dataset: stockDataset,
      byCode: DataUtils.buildStockByCode(rows, config),
      bundle: stockBundle,
      script: BundleUtils.toJsonString(stockBundle),
    };
  }

  async function createPriceBundleScript(priceRows, password, config, options) {
    var opts = options || {};
    var rows = Array.isArray(priceRows) ? priceRows : [];
    var dataset = DataUtils.buildPriceDataset(rows, config);
    // 安全：desensitize=true 时脱敏（移除面价，预计算报价），用于部署到公开存储
    if (opts.desensitize) {
      dataset = desensitizePriceDataset(dataset, config);
    }
    var priceBundle = await BundleUtils.encodePriceBundle(dataset, password || "");
    return {
      dataset: dataset,
      rows: dataset.rows || [],
      bundle: priceBundle,
      script: BundleUtils.toJsonString(priceBundle),
    };
  }

  return {
    createStockBundleScript: createStockBundleScript,
    createPriceBundleScript: createPriceBundleScript,
    desensitizePriceDataset: desensitizePriceDataset,
  };
});
