﻿(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./data-utils"), require("./bundle-utils"));
  } else {
    root.ExportUtils = factory(root.DataUtils, root.BundleUtils);
  }
})(typeof self !== "undefined" ? self : this, function (DataUtils, BundleUtils) {
  if (!DataUtils || !BundleUtils) throw new Error("DataUtils and BundleUtils are required");

  // ─── 脱敏逻辑（与后端 store._desensitize_item_fields 对齐）──────────
  // 安全：部署到 Supabase public bucket 前，必须移除面价并预计算报价。

  var SENSITIVE_FIELDS = ["face_price", "discount_percent"];

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
    if (op === "contains") return String(expected).replace(/ /g, "").toUpperCase().indexOf(text.replace(/ /g, "").toUpperCase()) >= 0;
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
    var decimals = parseInt(pricing.decimal_places || 1, 10);
    if (rounding.mode === "ceil") {
      var factor = Math.pow(10, Math.max(decimals, 0));
      basePrice = Math.ceil(basePrice * factor) / factor;
      var integerAbove = parseFloat(rounding.integer_above || 0) || 0;
      if (facePrice > integerAbove) {
        basePrice = Math.ceil(basePrice);
      }
    } else {
      basePrice = parseFloat(basePrice.toFixed(Math.max(decimals, 0)));
    }

    safe.quote_price = String(basePrice);
    for (var i = 0; i < SENSITIVE_FIELDS.length; i++) {
      delete safe[SENSITIVE_FIELDS[i]];
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
