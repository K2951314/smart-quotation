(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.QueryRegex = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function escapeRegexLiteral(text) {
    return toStringSafe(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function convertPlainLineToRegex(line) {
    var normalized = toStringSafe(line).trim();
    if (!normalized) return null;
    var parts = normalized.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    var pattern = parts.map(escapeRegexLiteral).join(".*");
    return new RegExp(pattern, "i");
  }

  function testRegex(re, value) {
    var flags = toStringSafe(re.flags).replace(/g/g, "");
    var safe = new RegExp(re.source, flags);
    return safe.test(toStringSafe(value));
  }

  function collectMatchFields(args) {
    if (!args.length) return [];

    var first = args[0];
    if (Array.isArray(first)) return first;
    if (first && typeof first === "object") {
      return [
        first.spec,
        first.code,
        first.name,
        first.mnemonic,
        first.remark,
        first.alias,
        first.special,
      ];
    }
    if (args.length === 1) return [args[0]];

    return args;
  }

  function matchRegexTarget() {
    var args = Array.prototype.slice.call(arguments);
    var re = args.pop();
    if (!(re instanceof RegExp)) throw new Error("re must be RegExp");
    var fields = collectMatchFields(args);
    var combined = fields.map(toStringSafe).join(" ");
    return (
      testRegex(re, combined) ||
      fields.some(function (field) {
        return testRegex(re, field);
      })
    );
  }

  function hasStockValue(stockText) {
    return !!toStringSafe(stockText).trim();
  }

  return {
    escapeRegexLiteral: escapeRegexLiteral,
    convertPlainLineToRegex: convertPlainLineToRegex,
    matchRegexTarget: matchRegexTarget,
    hasStockValue: hasStockValue,
  };
});
