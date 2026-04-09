(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./data-utils"), require("./bundle-utils"));
  } else {
    root.ExportUtils = factory(root.DataUtils, root.BundleUtils);
  }
})(typeof self !== "undefined" ? self : this, function (DataUtils, BundleUtils) {
  if (!DataUtils || !BundleUtils) throw new Error("DataUtils and BundleUtils are required");

  function createStockBundleScript(stockRows) {
    var rows = Array.isArray(stockRows) ? stockRows : [];
    var stockByCode = DataUtils.buildStockByCode(rows);
    var stockBundle = BundleUtils.encodeStockBundle(stockByCode);
    return {
      byCode: stockByCode,
      bundle: stockBundle,
      script: BundleUtils.toWindowScript("STOCK_BUNDLE", stockBundle),
    };
  }

  async function createPriceBundleScript(priceRows, password) {
    var rows = Array.isArray(priceRows) ? priceRows : [];
    var dataset = DataUtils.buildPriceDataset(rows);
    var priceBundle = await BundleUtils.encodePriceBundle(dataset, password || "");
    return {
      bySpec: dataset.bySpec,
      bundle: priceBundle,
      script: BundleUtils.toWindowScript("PRICE_BUNDLE", priceBundle),
    };
  }

  return {
    createStockBundleScript: createStockBundleScript,
    createPriceBundleScript: createPriceBundleScript,
  };
});
