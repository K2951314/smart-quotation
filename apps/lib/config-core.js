(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ConfigCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var DEFAULT_CONFIG = Object.freeze({
    schema_version: 2,
    version: "",
    data_source: {
      base_url: "https://xnnolklpjentxhosetcd.supabase.co/storage/v1/object/public/s-q",
      version_file: "version.json",
      config_file: "config.json",
      price_bundle_file: "price.bundle.json",
      stock_bundle_file: "stock.bundle.json",
      cache_name: "quotation-cache-v3",
    },
    pricing: {
      decimal_places: 1,
      rounding_threshold: 100,
      discount_step: {
        default: 0.1,
        min: 0.1,
        presets: [0.1, 0.5, 1],
      },
    },
    fields: [
      { key: "code", label: "代码", type: "text", source: "price", excel_aliases: ["代码", "货号", "物料编码", "编码"], searchable: true, copyable: true, result_area: "identity", required: false },
      { key: "spec", label: "规格型号", type: "text", source: "price", excel_aliases: ["规格型号", "规格", "型号", "产品型号"], searchable: true, copyable: true, result_area: "identity", required: true },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价", "面价", "目录价", "含税单价", "单价"], searchable: false, copyable: false, result_area: "metric", required: false },
      { key: "quote_price", label: "报价", type: "computed", source: "computed", excel_aliases: [], searchable: false, copyable: true, result_area: "metric", required: false },
      { key: "special", label: "特价", type: "text", source: "price", excel_aliases: ["特价", "活动", "促销"], searchable: true, copyable: true, result_area: "chip", required: false },
      { key: "stock", label: "库存", type: "text", source: "stock", excel_aliases: ["库存", "库存数量", "可用数量", "数量"], searchable: false, copyable: true, result_area: "chip", required: false },
      { key: "remark", label: "备注", type: "text", source: "price", excel_aliases: ["补充说明", "备注", "说明"], searchable: true, copyable: true, result_area: "detail", required: false },
      { key: "brand", label: "品牌", type: "text", source: "price", excel_aliases: ["品牌", "厂家"], searchable: true, copyable: false, result_area: "detail", required: false },
      { key: "name", label: "名称", type: "text", source: "price", excel_aliases: ["名称", "品名", "类别"], searchable: true, copyable: false, result_area: "detail", required: false },
      { key: "mnemonic", label: "助记码", type: "text", source: "price", excel_aliases: ["助记码", "简码"], searchable: true, copyable: false, result_area: "detail", required: false },
      { key: "alias", label: "别名", type: "text", source: "price", excel_aliases: ["别名", "旧型号"], searchable: true, copyable: false, result_area: "detail", required: false },
    ],
    copy: {
      empty_value: "",
      price_prefix: "含税",
      columns: [
        { field: "code", label: "代码", default: true, line: "main" },
        { field: "spec", label: "规格", default: true, line: "main" },
        { field: "quote_price", label: "报价", default: true, line: "main", prefix: "含税" },
        { field: "special", label: "特价", default: false, line: "main" },
        { field: "stock", label: "库存", default: false, line: "main" },
        { field: "remark", label: "备注", default: false, line: "detail" },
      ],
    },
    result_layout: {
      identity: ["code", "spec"],
      chips: ["stock", "special"],
      metrics: ["face_price", "quote_price"],
      details: ["remark"],
    },
    discount_rules: [
      { id: "ex", label: "EX活动", percent: 32, conditions: [{ field: "special", contains: "EX活动" }] },
      { id: "osg", label: "OSG", percent: 36, conditions: [{ field: "brand", regex: "OSG" }] },
      { id: "mitsubishi", label: "三菱", percent: 55, conditions: [{ field: "name", equals: "刀具" }] },
      { id: "other", label: "其他", percent: 55, default: true, conditions: [] },
    ],
    merger: {
      primary_field: "spec",
      stock_key_field: "code",
      brand_rules: {
        defaultBrand: "UNMAPPED",
        brands: [
          { id: "MITSUBISHI", prefixes: ["三菱", "MITSU"] },
          { id: "OSG", prefixes: ["OSG"] },
        ],
      },
      passthrough_fields: [],
      stock_format: "{warehouse}:{quantity}{status}",
      stock_joiner: " | ",
      stock_columns: {
        code: ["物料长代码", "代码", "物料编码", "编码"],
        warehouse: ["发料仓库", "仓库", "仓位", "仓"],
        quantity: ["库存数量", "数量", "可用数量", "库存"],
        status: ["参考状态", "状态", "备注"],
      },
    },
    labels: {
      app_title: "智能询价系统",
      search_button: "智能查询",
      stock_search_button: "库存查询",
      mmc_button: "三菱库存",
      copy_button: "复制勾选",
      selected_label: "勾选",
      config_button: "配置",
      input_title: "输入",
      result_title: "结果",
      query_placeholder: "请输入规格型号...\n支持多关键词，例如：\nWNMG080408 UC5115",
      empty_hint: "支持规格、代码、助记码、别名、备注和特价关键词。",
      stock_prefix: "库存 ",
    },
  });

  var LEGACY_FIELD_MAP = {
    c: "code",
    p: "face_price",
    s: "special",
    r: "remark",
    b: "brand",
    n: "name",
    m: "mnemonic",
    a: "alias",
    i: "stock",
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function compactNumber(value, fallback) {
    var num = Number(value);
    if (!Number.isFinite(num)) num = Number(fallback);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
  }

  function parseNumber(value) {
    var num = Number(toStringSafe(value).replace(/,/g, ""));
    return Number.isFinite(num) ? num : 0;
  }

  function normalizeArray(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function mergePlain(target, source) {
    var out = clone(target || {});
    var incoming = source || {};
    Object.keys(incoming).forEach(function (key) {
      var value = incoming[key];
      if (Array.isArray(value)) {
        out[key] = clone(value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = mergePlain(out[key] || {}, value);
      } else if (value !== undefined && value !== "") {
        out[key] = value;
      }
    });
    return out;
  }

  function normalizeField(field) {
    var item = field || {};
    var source = toStringSafe(item.source || "price");
    if (source === "data" || source === "key") source = "price";
    return {
      key: toStringSafe(item.key),
      label: toStringSafe(item.label || item.key),
      type: toStringSafe(item.type || "text"),
      source: source,
      excel_aliases: normalizeArray(item.excel_aliases).map(toStringSafe).filter(Boolean),
      searchable: item.searchable === true,
      copyable: item.copyable === true,
      result_area: toStringSafe(item.result_area || "detail"),
      required: item.required === true,
    };
  }

  function mergeFields(rawFields) {
    var defaults = DEFAULT_CONFIG.fields.map(normalizeField);
    if (rawFields && !Array.isArray(rawFields) && typeof rawFields === "object") {
      rawFields = Object.keys(rawFields).map(function (key) {
        var normalizedKey = LEGACY_FIELD_MAP[key] || (key === "price" ? "quote_price" : key);
        return mergePlain({ key: normalizedKey }, rawFields[key] || {});
      });
    }
    if (!Array.isArray(rawFields) || !rawFields.length) return defaults;

    var byKey = {};
    defaults.forEach(function (field) {
      byKey[field.key] = field;
    });

    rawFields.map(normalizeField).forEach(function (field) {
      if (!field.key) return;
      byKey[field.key] = mergePlain(byKey[field.key] || {}, field);
    });

    var ordered = [];
    rawFields.forEach(function (field) {
      var key = toStringSafe(field && field.key);
      if (key && byKey[key] && ordered.indexOf(key) < 0) ordered.push(key);
    });
    defaults.forEach(function (field) {
      if (ordered.indexOf(field.key) < 0) ordered.push(field.key);
    });

    return ordered.map(function (key) {
      return normalizeField(byKey[key]);
    });
  }

  function normalizeCopy(config) {
    var source = (config && config.copy) || {};
    var fallback = DEFAULT_CONFIG.copy;
    var legacyColumns = config && Array.isArray(config.copy_columns) ? config.copy_columns.map(function (column) {
      return { field: column.field, label: column.label, default: column.default, line: column.field === "remark" || column.field === "r" ? "detail" : "main" };
    }) : null;
    var columns = Array.isArray(source.columns) && source.columns.length ? source.columns : (legacyColumns || fallback.columns);
    return {
      empty_value: source.empty_value !== undefined ? String(source.empty_value) : fallback.empty_value,
      price_prefix: source.price_prefix !== undefined ? String(source.price_prefix) : fallback.price_prefix,
      line_template: source.line_template ? String(source.line_template) : "",
      columns: columns.map(function (column) {
        var item = column || {};
        return {
          field: LEGACY_FIELD_MAP[toStringSafe(item.field)] || (toStringSafe(item.field) === "price" ? "quote_price" : toStringSafe(item.field)),
          label: toStringSafe(item.label || item.field),
          default: item.default === true,
          line: toStringSafe(item.line || "main"),
          prefix: item.prefix !== undefined ? String(item.prefix) : "",
          suffix: item.suffix !== undefined ? String(item.suffix) : "",
        };
      }).filter(function (column) {
        return column.field;
      }),
    };
  }

  function normalizeDiscountRules(rawConfig) {
    // ── v3 format: rawConfig.rules ────────────────────────────────────────
    if (rawConfig && Array.isArray(rawConfig.rules) && rawConfig.rules.length) {
      return rawConfig.rules.map(function (rule) {
        var source = rule || {};
        var action = (source.actions || [])[0] || {};
        var conditions = [];

        // Default rule has no conditions
        if (!source.default && source.when && Array.isArray(source.when.all)) {
          source.when.all.forEach(function (c) {
            var cond = { field: toStringSafe(c.field) };
            var op = String(c.op || "contains").toLowerCase();
            var val = toStringSafe(c.value);
            if (op === "contains") cond.contains = val;
            else if (op === "equals") cond.equals = val;
            else if (op === "regex") cond.regex = val;
            else if (op === "gt") cond.gt = Number(val) || 0;
            else if (op === "gte") cond.gte = Number(val) || 0;
            else if (op === "lt") cond.lt = Number(val) || 0;
            else if (op === "lte") cond.lte = Number(val) || 0;
            else cond.contains = val; // fallback
            conditions.push(cond);
          });
        }

        return {
          id: toStringSafe(source.id || source.label || "rule"),
          label: toStringSafe(source.label || source.id || "规则"),
          percent: compactNumber(action.percent, 55),
          category: toStringSafe(source.id || source.label || "rule"),
          source: toStringSafe(source.id || source.label || "rule"),
          default: source.default === true,
          conditions: conditions,
        };
      });
    }

    // ── v1 format: rawConfig.discounts (legacy flat object) ───────────────
    if (rawConfig && rawConfig.discounts && !Array.isArray(rawConfig.discount_rules)) {
      return [
        { id: "ex", label: "EX活动", percent: rawConfig.discounts.EX, conditions: [{ field: "special", contains: "EX活动" }] },
        { id: "osg", label: "OSG", percent: rawConfig.discounts.OSG, conditions: [{ field: "brand", regex: "OSG" }] },
        { id: "mitsubishi", label: "三菱", percent: rawConfig.discounts["三菱"], conditions: [{ field: "name", equals: "刀具" }] },
        { id: "other", label: "其他", percent: rawConfig.discounts["其他"], default: true, conditions: [] },
      ];
    }

    // ── v2 format: rawConfig.discount_rules ───────────────────────────────
    var rules = rawConfig && Array.isArray(rawConfig.discount_rules) && rawConfig.discount_rules.length
      ? rawConfig.discount_rules
      : DEFAULT_CONFIG.discount_rules;

    return rules.map(function (rule) {
      var source = rule || {};
      return {
        id: toStringSafe(source.id || source.label || "rule"),
        label: toStringSafe(source.label || source.id || "规则"),
        percent: compactNumber(source.percent, 55),
        category: toStringSafe(source.category || source.id || source.label || "rule"),
        source: toStringSafe(source.source || source.id || source.label || "rule"),
        default: source.default === true,
        conditions: Array.isArray(source.conditions) ? source.conditions.map(function (condition) {
          var item = condition || {};
          return {
            field: toStringSafe(item.field),
            contains: item.contains !== undefined ? String(item.contains) : undefined,
            equals: item.equals !== undefined ? String(item.equals) : undefined,
            regex: item.regex !== undefined ? String(item.regex) : undefined,
          };
        }) : [],
      };
    });
  }

  function normalizePricing(rawPricing) {
    var pricing = mergePlain(DEFAULT_CONFIG.pricing, rawPricing || {});
    pricing.decimal_places = Math.max(0, Math.round(Number(pricing.decimal_places) || 0));
    pricing.rounding_threshold = Number.isFinite(Number(pricing.rounding_threshold)) ? Number(pricing.rounding_threshold) : 100;
    pricing.discount_step = mergePlain(DEFAULT_CONFIG.pricing.discount_step, pricing.discount_step || {});
    pricing.discount_step.default = Math.max(Number(pricing.discount_step.min) || 0.1, compactNumber(pricing.discount_step.default, 0.1));
    pricing.discount_step.min = Math.max(0.01, compactNumber(pricing.discount_step.min, 0.1));
    pricing.discount_step.presets = normalizeArray(pricing.discount_step.presets)
      .map(function (value) { return compactNumber(value, NaN); })
      .filter(function (value) { return Number.isFinite(value) && value > 0; });
    if (!pricing.discount_step.presets.length) pricing.discount_step.presets = DEFAULT_CONFIG.pricing.discount_step.presets.slice();
    return pricing;
  }

  var _normalizeCache = new Map();
  var _normalizeCacheMax = 8;

  function normalizeConfig(rawConfig) {
    var raw = rawConfig || {};
    if (raw._normalized) return raw;
    var cacheKey = "";
    try { cacheKey = JSON.stringify(raw); } catch (e) { cacheKey = ""; }
    if (cacheKey && _normalizeCache.has(cacheKey)) return _normalizeCache.get(cacheKey);

    var merged = mergePlain(DEFAULT_CONFIG, raw);
    merged.schema_version = 2;
    merged.version = getConfigVersion(raw);
    merged.data_source = mergePlain(DEFAULT_CONFIG.data_source, raw.data_source || {});
    merged.pricing = normalizePricing(raw.pricing || {
      decimal_places: raw.decimal_places,
      rounding_threshold: raw.rounding_threshold,
    });
    merged.fields = mergeFields(raw.fields);
    merged.copy = normalizeCopy(raw);
    merged.result_layout = mergePlain(DEFAULT_CONFIG.result_layout, raw.result_layout || {});
    merged.discount_rules = normalizeDiscountRules(raw);
    merged.merger = mergePlain(DEFAULT_CONFIG.merger, raw.merger || {});
    merged.labels = mergePlain(DEFAULT_CONFIG.labels, raw.labels || {});
    merged._normalized = true;

    if (cacheKey) {
      if (_normalizeCache.size >= _normalizeCacheMax) _normalizeCache.clear();
      _normalizeCache.set(cacheKey, merged);
    }
    return merged;
  }

  function getConfigVersion(config) {
    var raw = config || {};
    return toStringSafe(
      raw.version ||
      raw.data_version ||
      (raw.data_source && (raw.data_source.cache_version || raw.data_source.version)) ||
      ""
    );
  }

  function getField(config, key) {
    var cfg = normalizeConfig(config);
    var name = toStringSafe(key);
    for (var i = 0; i < cfg.fields.length; i++) {
      if (cfg.fields[i].key === name) return cfg.fields[i];
    }
    return { key: name, label: name, type: "text", excel_aliases: [], searchable: false, copyable: false, result_area: "detail", required: false };
  }

  function getFieldsByArea(config, area) {
    var cfg = normalizeConfig(config);
    var name = toStringSafe(area);
    return cfg.fields.filter(function (field) {
      return field.result_area === name;
    });
  }

  function readByAliases(row, aliases) {
    var source = row || {};
    var keys = normalizeArray(aliases);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
    }
    return undefined;
  }

  function normalizeFieldValue(value, field) {
    if ((field && field.type) === "number") return parseNumber(value);
    return toStringSafe(value);
  }

  function mapExcelRowToFields(row, config, sourceName) {
    var cfg = normalizeConfig(config);
    var source = toStringSafe(sourceName);
    var out = {};
    cfg.fields.forEach(function (field) {
      if (field.source === "computed") return;
      if (source && field.source !== source && field.source !== "both") return;
      var aliases = field.excel_aliases.concat([field.label, field.key]);
      var value = readByAliases(row, aliases);
      if (value === undefined || value === null || String(value).trim() === "") return;
      out[field.key] = normalizeFieldValue(value, field);
    });
    return out;
  }

  function getPrimaryField(config) {
    var cfg = normalizeConfig(config);
    return toStringSafe(cfg.merger.primary_field || "spec");
  }

  function getStockKeyField(config) {
    var cfg = normalizeConfig(config);
    return toStringSafe(cfg.merger.stock_key_field || "code");
  }

  function adaptLegacyPriceRow(spec, item) {
    var source = item || {};
    var fields = { spec: toStringSafe(spec) };
    Object.keys(LEGACY_FIELD_MAP).forEach(function (legacyKey) {
      var fieldKey = LEGACY_FIELD_MAP[legacyKey];
      if (source[legacyKey] === undefined) return;
      fields[fieldKey] = fieldKey === "face_price" ? parseNumber(source[legacyKey]) : toStringSafe(source[legacyKey]);
    });
    return { key: toStringSafe(spec), fields: fields };
  }

  function adaptPricePayload(payload, config) {
    var data = payload || {};
    if (data.schema_version === 2 && Array.isArray(data.rows)) {
      var primary = toStringSafe(data.primary_field || getPrimaryField(config));
      return data.rows.map(function (row) {
        var fields = mergePlain({}, (row && row.fields) || {});
        var key = toStringSafe((row && row.key) || fields[primary]);
        if (primary && key && !fields[primary]) fields[primary] = key;
        return { key: key, fields: fields };
      }).filter(function (row) { return row.key; });
    }

    var bySpec = data.bySpec || {};
    return Object.keys(bySpec).map(function (spec) {
      return adaptLegacyPriceRow(spec, bySpec[spec]);
    });
  }

  function adaptStockPayload(payload, config) {
    var data = payload || {};
    if (data.schema_version === 2 && Array.isArray(data.rows)) {
      var keyField = toStringSafe(data.key_field || getStockKeyField(config));
      return data.rows.map(function (row) {
        var fields = mergePlain({}, (row && row.fields) || {});
        var key = toStringSafe((row && row.key) || fields[keyField]);
        if (keyField && key && !fields[keyField]) fields[keyField] = key;
        return { key: key, fields: fields };
      }).filter(function (row) { return row.key; });
    }

    var byCode = data.byCode || {};
    return Object.keys(byCode).map(function (code) {
      return { key: toStringSafe(code), fields: { code: toStringSafe(code), stock: toStringSafe(byCode[code]) } };
    });
  }

  function mergePriceAndStockRows(priceRows, stockRows, config) {
    var cfg = normalizeConfig(config);
    var stockKey = getStockKeyField(cfg);
    var stockMap = {};
    (Array.isArray(stockRows) ? stockRows : []).forEach(function (row) {
      if (!row || !row.key) return;
      stockMap[toStringSafe(row.key)] = row.fields || {};
    });

    return (Array.isArray(priceRows) ? priceRows : []).map(function (row) {
      var fields = mergePlain({}, row.fields || {});
      var key = toStringSafe(row.key || fields[getPrimaryField(cfg)]);
      var stockLookup = toStringSafe(fields[stockKey]);
      var stockFields = stockMap[stockLookup] || stockMap[key] || null;
      if (stockFields) fields = mergePlain(fields, stockFields);
      if (!fields[getPrimaryField(cfg)]) fields[getPrimaryField(cfg)] = key;
      return { key: key, fields: fields };
    });
  }

  function getFieldValue(row, key, emptyValue) {
    var fields = (row && row.fields) || {};
    var value = fields[toStringSafe(key)];
    if (value === null || value === undefined || String(value) === "") return emptyValue !== undefined ? emptyValue : "";
    return value;
  }

  var _searchableFieldsCache = null;
  var _searchableFieldsCacheKey = null;

  function rowMatchesText(row, text, config) {
    var query = toStringSafe(text).toUpperCase();
    if (!query) return false;
    var cfg = config && config._normalized ? config : normalizeConfig(config);
    var tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    var fieldKeys;
    var cacheKey = cfg.schema_version + "|" + cfg.fields.length;
    if (_searchableFieldsCacheKey === cacheKey && _searchableFieldsCache) {
      fieldKeys = _searchableFieldsCache;
    } else {
      fieldKeys = cfg.fields.filter(function (field) { return field.searchable; }).map(function (field) { return field.key; });
      _searchableFieldsCache = fieldKeys;
      _searchableFieldsCacheKey = cacheKey;
    }
    var fields = (row && row.fields) || {};
    var values = [];
    for (var i = 0; i < fieldKeys.length; i++) {
      var v = toStringSafe(fields[fieldKeys[i]]).toUpperCase();
      if (v) values.push(v);
    }
    var combined = values.join(" ");
    for (var t = 0; t < tokens.length; t++) {
      var token = tokens[t];
      var found = combined.indexOf(token) >= 0;
      if (!found) {
        for (var j = 0; j < values.length; j++) {
          if (values[j].indexOf(token) >= 0) { found = true; break; }
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function conditionMatches(row, condition) {
    var item = condition || {};
    var rawValue = getFieldValue(row, item.field);
    var value = toStringSafe(rawValue);

    if (item.equals !== undefined && value !== String(item.equals)) return false;
    if (item.contains !== undefined && value.replace(/\s+/g, "").toUpperCase().indexOf(String(item.contains).replace(/\s+/g, "").toUpperCase()) < 0) return false;
    if (item.regex !== undefined) {
      try {
        if (!new RegExp(String(item.regex), "i").test(value)) return false;
      } catch (error) { return false; }
    }
    // Numeric comparison operators (from v3 rules format)
    if (item.gt !== undefined) { if (Number(rawValue) <= Number(item.gt)) return false; }
    if (item.gte !== undefined) { if (Number(rawValue) < Number(item.gte)) return false; }
    if (item.lt !== undefined) { if (Number(rawValue) >= Number(item.lt)) return false; }
    if (item.lte !== undefined) { if (Number(rawValue) > Number(item.lte)) return false; }
    return true;
  }

  function formatPercent(value) {
    return compactNumber(value, 55).toFixed(2).replace(/\.?0+$/, "") + "%";
  }

  function getDiscountPreset(row, config) {
    var cfg = normalizeConfig(config);
    var defaultRule = null;
    for (var i = 0; i < cfg.discount_rules.length; i++) {
      var rule = cfg.discount_rules[i];
      if (rule.default) defaultRule = rule;
      if (!rule.default && rule.conditions.every(function (condition) { return conditionMatches(row, condition); })) {
        return { percent: rule.percent, label: rule.label + " " + formatPercent(rule.percent), source: rule.source || rule.id, category: rule.category || rule.id };
      }
    }
    var fallback = defaultRule || { id: "other", label: "其他", percent: 55, source: "fallback", category: "other" };
    return { percent: fallback.percent, label: fallback.label + " " + formatPercent(fallback.percent), source: fallback.source || fallback.id || "fallback", category: fallback.category || fallback.id || "other" };
  }

  function renderColumnValue(row, config, column) {
    var cfg = normalizeConfig(config);
    var value = getFieldValue(row, column.field, cfg.copy.empty_value);
    if (value === "") return "";
    return String(column.prefix || "") + String(value) + String(column.suffix || "");
  }

  function renderCopyText(rows, config, selectedFields) {
    var cfg = normalizeConfig(config);
    var selected = Array.isArray(selectedFields) ? selectedFields : cfg.copy.columns.filter(function (column) { return column.default; }).map(function (column) { return column.field; });
    var lines = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var main = [];
      var detail = [];
      cfg.copy.columns.forEach(function (column) {
        if (selected.indexOf(column.field) < 0) return;
        var value = renderColumnValue(row, cfg, column);
        if (!value) return;
        if (column.line === "detail") detail.push(value);
        else main.push(value);
      });
      if (main.length) lines.push(main.join(" "));
      detail.forEach(function (value) { lines.push(value); });
    });
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  function validateConfig(rawConfig) {
    var errors = [];
    var raw = rawConfig || {};
    if (raw.fields !== undefined && !Array.isArray(raw.fields)) errors.push("fields must be an array");
    if (Array.isArray(raw.fields)) {
      raw.fields.forEach(function (field, index) {
        if (!toStringSafe(field && field.key)) errors.push("fields[" + index + "].key is required");
      });
    }
    var presets = raw.pricing && raw.pricing.discount_step && raw.pricing.discount_step.presets;
    if (presets !== undefined) {
      if (!Array.isArray(presets) || presets.some(function (value) { return !Number.isFinite(Number(value)) || Number(value) <= 0; })) {
        errors.push("pricing.discount_step.presets must contain positive numbers");
      }
    }
    var cfg = normalizeConfig(raw);
    if (!getField(cfg, getPrimaryField(cfg)).key) errors.push("merger.primary_field must reference a field");
    if (!getField(cfg, getStockKeyField(cfg)).key) errors.push("merger.stock_key_field must reference a field");
    return { ok: errors.length === 0, errors: errors, config: cfg };
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    LEGACY_FIELD_MAP: LEGACY_FIELD_MAP,
    normalizeConfig: normalizeConfig,
    validateConfig: validateConfig,
    getConfigVersion: getConfigVersion,
    getField: getField,
    getFieldsByArea: getFieldsByArea,
    getPrimaryField: getPrimaryField,
    getStockKeyField: getStockKeyField,
    getFieldValue: getFieldValue,
    mapExcelRowToFields: mapExcelRowToFields,
    adaptPricePayload: adaptPricePayload,
    adaptStockPayload: adaptStockPayload,
    mergePriceAndStockRows: mergePriceAndStockRows,
    rowMatchesText: rowMatchesText,
    getDiscountPreset: getDiscountPreset,
    renderCopyText: renderCopyText,
    formatPercent: formatPercent,
  };
});
