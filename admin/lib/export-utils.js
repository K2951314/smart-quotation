(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./data-utils"), require("./bundle-utils"));
  } else {
    root.ExportUtils = factory(root.DataUtils, root.BundleUtils);
  }
})(typeof self !== "undefined" ? self : this, function (DataUtils, BundleUtils) {
  if (!DataUtils || !BundleUtils) throw new Error("DataUtils and BundleUtils are required");

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

  async function createPriceBundleScript(priceRows, password, config) {
    var rows = Array.isArray(priceRows) ? priceRows : [];
    var dataset = DataUtils.buildPriceDataset(rows, config);
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
  };
});
