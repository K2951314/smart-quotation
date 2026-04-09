(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DiscountUtils = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  var FALLBACK_DISCOUNT_PERCENT = 55;
  var OSG_DISCOUNT_PERCENT = 36;
  var EX_ACTIVITY_DISCOUNT_PERCENT = 32;
  var MITSUBISHI_DISCOUNT_PERCENT = 55;
  var MIN_DISCOUNT_PERCENT = 0;
  var MAX_DISCOUNT_PERCENT = 100;
  var DEFAULT_STEP_PERCENT = 0.1;
  var DEFAULT_DISCOUNT_CONFIG = Object.freeze({
    ex: EX_ACTIVITY_DISCOUNT_PERCENT,
    osg: OSG_DISCOUNT_PERCENT,
    mitsubishi: MITSUBISHI_DISCOUNT_PERCENT,
    other: FALLBACK_DISCOUNT_PERCENT,
  });

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

  function sanitizeDiscountConfig(config) {
    var source = config || {};
    return {
      ex: normalizePercent(source.ex, DEFAULT_DISCOUNT_CONFIG.ex),
      osg: normalizePercent(source.osg, DEFAULT_DISCOUNT_CONFIG.osg),
      mitsubishi: normalizePercent(source.mitsubishi, DEFAULT_DISCOUNT_CONFIG.mitsubishi),
      other: normalizePercent(source.other, DEFAULT_DISCOUNT_CONFIG.other),
    };
  }

  function getDiscountCategory(item) {
    var source = item || {};
    var special = toStringSafe(source.special);
    var spec = toStringSafe(source.spec);
    var brand = toStringSafe(source.brand || source.b);
    var name = toStringSafe(source.name || source.n);
    var brandAndSpec = brand + " " + spec;

    if (includesNormalized(special, "\u0045\u0058\u6d3b\u52a8")) {
      return "ex";
    }

    if (/OSG/i.test(brandAndSpec)) {
      return "osg";
    }

    if (name === "\u5200\u5177") {
      return "mitsubishi";
    }

    return "other";
  }

  function getDiscountLabel(category, percent) {
    if (category === "ex") return "\u0045\u0058\u6d3b\u52a8 " + formatDiscountPercent(percent);
    if (category === "osg") return "OSG " + formatDiscountPercent(percent);
    if (category === "mitsubishi") return "\u4e09\u83f1 " + formatDiscountPercent(percent);
    return "\u5176\u4ed6 " + formatDiscountPercent(percent);
  }

  function getDefaultDiscountPreset(item, config) {
    var normalizedConfig = sanitizeDiscountConfig(config);
    var category = getDiscountCategory(item);
    var percent = normalizedConfig.other;
    var source = "fallback";

    if (category === "ex") {
      percent = normalizedConfig.ex;
      source = "ex-activity";
    } else if (category === "osg") {
      percent = normalizedConfig.osg;
      source = "osg";
    } else if (category === "mitsubishi") {
      percent = normalizedConfig.mitsubishi;
      source = "mitsubishi";
    }

    return {
      percent: percent,
      source: source,
      category: category,
      label: getDiscountLabel(category, percent),
    };
  }

  function getDefaultDiscountPercent(item, config) {
    return getDefaultDiscountPreset(item, config).percent;
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
    OSG_DISCOUNT_PERCENT: OSG_DISCOUNT_PERCENT,
    EX_ACTIVITY_DISCOUNT_PERCENT: EX_ACTIVITY_DISCOUNT_PERCENT,
    MITSUBISHI_DISCOUNT_PERCENT: MITSUBISHI_DISCOUNT_PERCENT,
    DEFAULT_STEP_PERCENT: DEFAULT_STEP_PERCENT,
    DEFAULT_DISCOUNT_CONFIG: DEFAULT_DISCOUNT_CONFIG,
    normalizePercent: normalizePercent,
    sanitizeStepPercent: sanitizeStepPercent,
    sanitizeDiscountConfig: sanitizeDiscountConfig,
    getDiscountCategory: getDiscountCategory,
    getDefaultDiscountPreset: getDefaultDiscountPreset,
    getDefaultDiscountPercent: getDefaultDiscountPercent,
    shiftDiscountPercent: shiftDiscountPercent,
    formatDiscountPercent: formatDiscountPercent,
  };
});
