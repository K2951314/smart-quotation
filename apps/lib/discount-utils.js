(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DiscountUtils = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // 全部折扣参数从 config.json 的 rules 驱动，此处仅保留中立 fallback
  var FALLBACK_DISCOUNT_PERCENT = 55;
  var MIN_DISCOUNT_PERCENT = 0;
  var MAX_DISCOUNT_PERCENT = 100;
  var DEFAULT_STEP_PERCENT = 0.1;
  // 兜底默认折扣：仅含 “other”，不再硬编码任何品牌名/折扣率。
  // 品牌识别与对应折扣完全由 config.rules 驱动。
  var FALLBACK_DISCOUNT_CONFIG = Object.freeze({ other: FALLBACK_DISCOUNT_PERCENT });

  function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundToTwo(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function normalizePercent(value, fallback) {
    var num = Number(value);
    if (!Number.isFinite(num)) num = Number(fallback);
    if (!Number.isFinite(num)) num = FALLBACK_DISCOUNT_PERCENT;
    return clamp(roundToTwo(num), MIN_DISCOUNT_PERCENT, MAX_DISCOUNT_PERCENT);
  }

  function sanitizeStepPercent(value) {
    var num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_STEP_PERCENT;
    return Math.max(DEFAULT_STEP_PERCENT, roundToTwo(num));
  }

  function compactText(value) {
    return toStringSafe(value).replace(/\s+/g, "");
  }

  function includesNormalized(haystack, needle) {
    return compactText(haystack).toUpperCase().indexOf(compactText(needle).toUpperCase()) >= 0;
  }

  /**
   * 从 discount_rules 数组构建扁平折扣配置对象 { ruleId: percent, ... }
   * 这是动态品牌键的核心函数，替代硬编码的 {ex, osg, mitsubishi, other}
   */
  function buildDiscountConfigFromRules(rules, fallbackConfig) {
    var out = {};
    var fb = fallbackConfig || FALLBACK_DISCOUNT_CONFIG;

    // 从 rules 中提取每个规则的 percent
    (Array.isArray(rules) ? rules : []).forEach(function (rule) {
      var id = String(rule.id || "").toLowerCase();
      if (id && Number.isFinite(Number(rule.percent))) {
        out[id] = Number(rule.percent);
      }
    });

    // 兜底：如果没有 rules，使用 fallback config
    if (Object.keys(out).length === 0) {
      Object.keys(fb).forEach(function (key) {
        out[key] = fb[key];
      });
    }

    return out;
  }

  /**
   * 动态版 sanitizeDiscountConfig：规范化任意键的折扣对象
   * 对 config 中的每个键规范化其 percent 值，缺失的键从 fallbackConfig 补充
   */
  function sanitizeDiscountConfig(config, fallbackConfig) {
    var source = config || {};
    var fb = fallbackConfig || FALLBACK_DISCOUNT_CONFIG;

    // 收集所有已知的键
    var allKeys = {};
    Object.keys(fb).forEach(function (k) { allKeys[k] = true; });
    Object.keys(source).forEach(function (k) { allKeys[k] = true; });

    var out = {};
    Object.keys(allKeys).forEach(function (key) {
      var fallback = (fb[key] !== undefined) ? fb[key] : FALLBACK_DISCOUNT_PERCENT;
      out[key] = normalizePercent(source[key], fallback);
    });

    return out;
  }

  /**
   * 从 discount_rules 中匹配物品的折扣类别（动态版）。
   * 品牌识别完全由 rules.conditions 驱动，不再硬编码任何品牌名。
   */
  function getDiscountCategoryFromRules(item, rules) {
    if (!rules || !Array.isArray(rules) || !rules.length) {
      // 无 rules 时所有商品统一归到 “other”
      return "other";
    }

    var source = item || {};
    // 构造一个用于条件匹配的 row 对象
    var special = toStringSafe(source.special);
    var spec = toStringSafe(source.spec);
    var brand = toStringSafe(source.brand || source.b);
    var name = toStringSafe(source.name || source.n);
    var code = toStringSafe(source.code || source.c);

    var row = {
      code: code, spec: spec, brand: brand, name: name, special: special,
      // 支持 conditionMatches 中使用的字段
      fields: {
        code: code, spec: spec, brand: brand, name: name, special: special,
        b: brand, n: name, c: code,
      }
    };

    // 遍历 rules（按优先级），第一个匹配的非默认规则即为分类
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.default) continue; // 跳过默认规则
      var conditions = rule.conditions || [];
      if (conditions.length === 0) continue;

      var allMatch = conditions.every(function (cond) {
        return _conditionMatches(row, cond);
      });
      if (allMatch) {
        return String(rule.id || rule.category || "").toLowerCase();
      }
    }

    // 未匹配任何特定规则 → fallback
    // 找到 default 规则
    for (var j = 0; j < rules.length; j++) {
      if (rules[j].default) return String(rules[j].id || "other").toLowerCase();
    }
    return "other";
  }

  // 轻量条件匹配（不依赖 config-core.js）
  function _conditionMatches(row, condition) {
    var item = condition || {};
    var rawValue = (row.fields && row.fields[item.field] !== undefined)
      ? row.fields[item.field]
      : (row[item.field] !== undefined ? row[item.field] : "");
    var value = toStringSafe(rawValue);

    if (item.equals !== undefined && value !== String(item.equals)) return false;
    if (item.contains !== undefined && compactText(value).toUpperCase().indexOf(compactText(String(item.contains)).toUpperCase()) < 0) return false;
    if (item.regex !== undefined) {
      try {
        if (!new RegExp(String(item.regex), "i").test(value)) return false;
      } catch (e) { return false; }
    }
    if (item.gt !== undefined) { if (Number(rawValue) <= Number(item.gt)) return false; }
    if (item.gte !== undefined) { if (Number(rawValue) < Number(item.gte)) return false; }
    if (item.lt !== undefined) { if (Number(rawValue) >= Number(item.lt)) return false; }
    if (item.lte !== undefined) { if (Number(rawValue) > Number(item.lte)) return false; }
    return true;
  }

  /**
   * 公开的 getDiscountCategory（配置驱动）。
   * 当提供 rules 时按 conditions 动态匹配，否则所有商品归到 “other”。
   * 不再硬编码任何品牌名。
   */
  function getDiscountCategory(item, rules) {
    if (rules && Array.isArray(rules) && rules.length) {
      return getDiscountCategoryFromRules(item, rules);
    }
    return "other";
  }

  function getDiscountLabel(category, percent, rules) {
    // 尝试从 rules 中查找类别标签
    if (rules && Array.isArray(rules)) {
      for (var i = 0; i < rules.length; i++) {
        if (String(rules[i].id || "").toLowerCase() === String(category).toLowerCase()) {
          return (rules[i].label || category) + " " + formatDiscountPercent(percent);
        }
      }
    }
    // 无配置时仅显示类别名 + 百分比，不猜测品牌
    return String(category || "other") + " " + formatDiscountPercent(percent);
  }

  function getDefaultDiscountPreset(item, config, rules) {
    var category = getDiscountCategory(item, rules);
    var normalizedConfig = sanitizeDiscountConfig(config);

    var percent = normalizedConfig[category];
    var source = category;

    if (percent === undefined || !Number.isFinite(percent)) {
      percent = normalizedConfig.other || FALLBACK_DISCOUNT_PERCENT;
      source = "fallback";
      category = "other";
    }

    return {
      percent: percent,
      source: source,
      category: category,
      label: getDiscountLabel(category, percent, rules),
    };
  }

  function getDefaultDiscountPercent(item, config, rules) {
    return getDefaultDiscountPreset(item, config, rules).percent;
  }

  function shiftDiscountPercent(currentPercent, stepPercent, direction) {
    var current = normalizePercent(currentPercent, FALLBACK_DISCOUNT_PERCENT);
    var step = sanitizeStepPercent(stepPercent);
    var dir = Number(direction) < 0 ? -1 : 1;
    return normalizePercent(current + step * dir, current);
  }

  function formatDiscountPercent(value) {
    return normalizePercent(value, FALLBACK_DISCOUNT_PERCENT)
      .toFixed(2)
      .replace(/\.?0+$/, "") + "%";
  }

  return {
    FALLBACK_DISCOUNT_PERCENT: FALLBACK_DISCOUNT_PERCENT,
    DEFAULT_STEP_PERCENT: DEFAULT_STEP_PERCENT,
    DEFAULT_DISCOUNT_CONFIG: FALLBACK_DISCOUNT_CONFIG,
    FALLBACK_DISCOUNT_CONFIG: FALLBACK_DISCOUNT_CONFIG,
    normalizePercent: normalizePercent,
    sanitizeStepPercent: sanitizeStepPercent,
    sanitizeDiscountConfig: sanitizeDiscountConfig,
    buildDiscountConfigFromRules: buildDiscountConfigFromRules,
    getDiscountCategory: getDiscountCategory,
    getDiscountCategoryFromRules: getDiscountCategoryFromRules,
    getDefaultDiscountPreset: getDefaultDiscountPreset,
    getDefaultDiscountPercent: getDefaultDiscountPercent,
    shiftDiscountPercent: shiftDiscountPercent,
    formatDiscountPercent: formatDiscountPercent,
  };
});
