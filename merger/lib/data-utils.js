(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../../apps/lib/config-core"));
  } else {
    root.DataUtils = factory(root.ConfigCore);
  }
})(typeof self !== "undefined" ? self : this, function (ConfigCore) {
  var STANDARD_PRICE_COLS = [
    "代码",
    "规格型号",
    "销售单价",
    "名称",
    "助记码",
    "补充说明",
    "别名",
    "特价",
  ];

  function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function parseMoney(value) {
    var cleaned = toStringSafe(value).replace(/,/g, "");
    var num = Number(cleaned);
    return Number.isFinite(num) ? num : 0;
  }

  function isGenericColumns(columns) {
    if (!columns || !columns.length) return false;
    return columns.every(function (col) {
      return /^列\d+$/.test(String(col));
    });
  }

  function sortGenericColumns(columns) {
    return columns.slice().sort(function (a, b) {
      var na = Number(String(a).replace("列", ""));
      var nb = Number(String(b).replace("列", ""));
      return na - nb;
    });
  }

  function normalizePriceRows(rows, config) {
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];

    var columns = Object.keys(list[0]);
    var generic = isGenericColumns(columns);
    var genericCols = generic ? sortGenericColumns(columns) : [];
    var cfg = ConfigCore ? ConfigCore.normalizeConfig(config || {}) : null;
    var configuredPriceFields = cfg ? cfg.fields.filter(function (field) {
      return field.source === "price" && field.type !== "computed";
    }) : [];
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var row = list[i] || {};
      var normalized = {};

      if (cfg) {
        var sourceRow = row;
        if (generic) {
          sourceRow = {};
          for (var g = 0; g < configuredPriceFields.length; g++) {
            var genericKey = genericCols[g];
            var targetField = configuredPriceFields[g];
            if (genericKey && targetField) sourceRow[targetField.key] = row[genericKey];
          }
        }
        var fields = ConfigCore.mapExcelRowToFields(sourceRow, cfg, "price");
        configuredPriceFields.forEach(function (field) {
          if (fields[field.key] !== undefined) normalized[field.label] = fields[field.key];
        });
        if (Object.prototype.hasOwnProperty.call(sourceRow, "brand")) {
          normalized.brand = toStringSafe(sourceRow.brand);
        } else if (fields.brand) {
          normalized.brand = toStringSafe(fields.brand);
        }
      } else if (generic) {
        for (var j = 0; j < STANDARD_PRICE_COLS.length; j++) {
          var key = genericCols[j];
          normalized[STANDARD_PRICE_COLS[j]] = toStringSafe(key ? row[key] : "");
        }
      } else {
        for (var k = 0; k < STANDARD_PRICE_COLS.length; k++) {
          var col = STANDARD_PRICE_COLS[k];
          normalized[col] = toStringSafe(row[col]);
        }
      }

      if (Object.prototype.hasOwnProperty.call(row, "brand")) {
        normalized.brand = toStringSafe(row.brand);
      }

      if (Object.prototype.hasOwnProperty.call(normalized, "销售单价")) {
        normalized["销售单价"] = parseMoney(normalized["销售单价"]);
      }
      out.push(normalized);
    }

    return out;
  }

  function getBaseName(filename) {
    var name = toStringSafe(filename);
    var p = name.split(/[\\/]/).pop() || name;
    return p.replace(/\.[^.]+$/, "");
  }

  function detectBrandByFilename(filename, config) {
    var cfg = config || {};
    var brands = Array.isArray(cfg.brands) ? cfg.brands : [];
    var defaultBrand = toStringSafe(cfg.defaultBrand) || "UNMAPPED";
    var base = getBaseName(filename).toUpperCase();

    for (var i = 0; i < brands.length; i++) {
      var brand = brands[i] || {};
      var brandId = toStringSafe(brand.id);
      var prefixes = Array.isArray(brand.prefixes) ? brand.prefixes : [];
      for (var j = 0; j < prefixes.length; j++) {
        var prefix = toStringSafe(prefixes[j]).toUpperCase();
        if (!prefix) continue;
        if (base.indexOf(prefix) === 0) {
          return brandId || defaultBrand;
        }
      }
    }

    return defaultBrand;
  }

  function getBrandConfig(config) {
    var cfg = config || {};
    if (cfg.merger && cfg.merger.brand_rules) return cfg.merger.brand_rules;
    return cfg;
  }

  function splitPriceFilesByBrand(files, config, overrides) {
    var list = Array.isArray(files) ? files : [];
    var overrideMap = overrides || {};
    var brandConfig = getBrandConfig(config);
    var grouped = {};
    var fileBrands = [];

    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var filename = toStringSafe(item.filename);
      var normalizedRows = normalizePriceRows(item.rows || [], config);
      var detected = detectBrandByFilename(filename, brandConfig);
      var selected = toStringSafe(overrideMap[filename]) || detected;

      if (!grouped[selected]) grouped[selected] = [];
      for (var j = 0; j < normalizedRows.length; j++) {
        var row = normalizedRows[j];
        row.brand = selected;
        grouped[selected].push(row);
      }

      fileBrands.push({
        filename: filename,
        detectedBrand: detected,
        selectedBrand: selected,
        rowCount: normalizedRows.length,
      });
    }

    return { grouped: grouped, fileBrands: fileBrands };
  }

  function mergePriceTables(tables, config) {
    var list = Array.isArray(tables) ? tables : [];
    var merged = [];
    for (var i = 0; i < list.length; i++) {
      var rows = normalizePriceRows(list[i] || [], config);
      for (var j = 0; j < rows.length; j++) merged.push(rows[j]);
    }
    return merged;
  }

  function buildPriceDataset(rows, config) {
    if (ConfigCore) {
      var cfg = ConfigCore.normalizeConfig(config || {});
      var primary = ConfigCore.getPrimaryField(cfg);
      var sourceRows = Array.isArray(rows) ? rows : [];
      var normalizedRows = [];
      for (var x = 0; x < sourceRows.length; x++) {
        var sourceRow = sourceRows[x] || {};
        var fields = ConfigCore.mapExcelRowToFields(sourceRow, cfg, "price");
        if (sourceRow.brand && !fields.brand) fields.brand = toStringSafe(sourceRow.brand);
        var key = toStringSafe(fields[primary]);
        if (!key) continue;
        normalizedRows.push({ key: key, fields: fields });
      }
      return { schema_version: 2, primary_field: primary, rows: normalizedRows };
    }

    var normalized = normalizePriceRows(rows);
    var bySpec = {};
    for (var i = 0; i < normalized.length; i++) {
      var row = normalized[i];
      var spec = toStringSafe(row["规格型号"]);
      if (!spec) continue;
      bySpec[spec] = {
        c: toStringSafe(row["代码"]),
        p: parseMoney(row["销售单价"]),
        s: toStringSafe(row["特价"]),
        r: toStringSafe(row["补充说明"]),
        b: toStringSafe(row.brand),
        n: toStringSafe(row["名称"]),
        m: toStringSafe(row["助记码"]),
        a: toStringSafe(row["别名"]),
      };
    }
    return { bySpec: bySpec };
  }

  function resolveColumn(columns, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var alias = aliases[i];
      if (columns.indexOf(alias) >= 0) return alias;
    }
    return "";
  }

  function getConfiguredStockColumns(config, columns, genericCols) {
    var cfg = ConfigCore ? ConfigCore.normalizeConfig(config || {}) : null;
    var stockCfg = cfg && cfg.merger && cfg.merger.stock_columns ? cfg.merger.stock_columns : {};
    return {
      code: resolveColumn(columns, stockCfg.code || ["物料长代码", "代码", "物料编码", "编码"]) || genericCols[0] || "",
      warehouse: resolveColumn(columns, stockCfg.warehouse || ["发料仓库", "仓库", "仓位", "仓"]) || genericCols[1] || "",
      quantity: resolveColumn(columns, stockCfg.quantity || ["库存数量", "数量", "可用数量", "库存"]) || genericCols[2] || "",
      status: resolveColumn(columns, stockCfg.status || ["参考状态", "状态", "备注"]) || genericCols[3] || "",
    };
  }

  function buildStockByCode(stockRows, config) {
    var rows = Array.isArray(stockRows) ? stockRows : [];
    if (!rows.length) return {};

    var columns = Object.keys(rows[0]);
    var generic = isGenericColumns(columns);
    var genericCols = generic ? sortGenericColumns(columns) : [];

    var mapped = getConfiguredStockColumns(config, columns, genericCols);
    var codeCol = mapped.code;
    var whCol = mapped.warehouse;
    var qtyCol = mapped.quantity;
    var statusCol = mapped.status;

    var bucket = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var code = toStringSafe(row[codeCol]);
      if (!code) continue;

      var wh = toStringSafe(row[whCol]);
      var status = toStringSafe(row[statusCol]);
      var qtyRaw = toStringSafe(row[qtyCol]).replace(/,/g, "");
      var qtyNum = Number(qtyRaw);
      var qtyText = Number.isFinite(qtyNum) ? String(qtyNum) : qtyRaw;
      var hasValue = (qtyText && qtyText !== "0") || status;
      if (!hasValue) continue;

      var item = (wh || "仓库") + ":" + (qtyText || "0");
      if (status) item += "(" + status + ")";

      if (!bucket[code]) bucket[code] = [];
      bucket[code].push(item);
    }

    var byCode = {};
    var codes = Object.keys(bucket);
    for (var j = 0; j < codes.length; j++) {
      var c = codes[j];
      byCode[c] = bucket[c].join(" | ");
    }
    return byCode;
  }

  function buildStockDataset(stockRows, config) {
    var cfg = ConfigCore ? ConfigCore.normalizeConfig(config || {}) : null;
    var byCode = buildStockByCode(stockRows, cfg);
    var keyField = cfg ? ConfigCore.getStockKeyField(cfg) : "code";
    return {
      schema_version: 2,
      key_field: keyField,
      rows: Object.keys(byCode).map(function (code) {
        var fields = {};
        fields[keyField] = code;
        fields.stock = byCode[code];
        return { key: code, fields: fields };
      }),
    };
  }

  function bytesToBase64(bytes) {
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }

    if (typeof btoa === "function") return btoa(binary);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(binary, "binary").toString("base64");
    }
    throw new Error("Base64 encoder is not available");
  }

  function utf8ToBase64(text) {
    if (typeof TextEncoder !== "undefined") {
      return bytesToBase64(new TextEncoder().encode(text));
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(String(text), "utf8").toString("base64");
    }
    return btoa(unescape(encodeURIComponent(String(text))));
  }

  return {
    STANDARD_PRICE_COLS: STANDARD_PRICE_COLS,
    normalizePriceRows: normalizePriceRows,
    detectBrandByFilename: detectBrandByFilename,
    splitPriceFilesByBrand: splitPriceFilesByBrand,
    mergePriceTables: mergePriceTables,
    buildPriceDataset: buildPriceDataset,
    buildStockByCode: buildStockByCode,
    buildStockDataset: buildStockDataset,
    bytesToBase64: bytesToBase64,
    utf8ToBase64: utf8ToBase64,
  };
});
