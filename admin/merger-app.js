(function () {
  var state = {
    appConfig: null,
    priceRows: [],
    stockRows: [],
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, type) {
    var box = $("merger-statusBox");
    if (!box) return;
    box.textContent = msg;
    box.className = "merger-status" + (type ? " " + type : "");
  }

  function updateCounters() {
    $("merger-fileCount").textContent = String(state.priceRows.length > 0 ? 1 : 0);
    $("merger-rowCount").textContent = String(state.priceRows.length);
    $("merger-stockCount").textContent = String(state.stockRows.length);
  }

  function triggerDownload(filename, content, mime) {
    var blob = new Blob([content], { type: mime || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function downloadRowsAsWorkbook(rows, filename) {
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    triggerDownload(filename, out, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  function readExcelFile(file) {
    return file.arrayBuffer().then(function (ab) {
      var wb = XLSX.read(ab, { type: "array" });
      var first = wb.SheetNames[0];
      var ws = wb.Sheets[first];
      var rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      return { filename: file.name, rows: rows };
    });
  }

  function readExcelFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(readExcelFile));
  }

  function getConfigFromEditor() {
    try {
      var raw = $("merger-appConfig").value;
      var cfg = JSON.parse(raw);
      return ConfigCore.normalizeConfig(cfg);
    } catch (err) {
      throw new Error("配置不是合法 JSON: " + err.message);
    }
  }

  function renderConfigPreview(cfg) {
    var config = cfg || getConfigFromEditor();
    var fields = config.fields || [];
    var searchable = fields.filter(function (f) { return f.searchable; }).map(function (f) { return f.label; }).join(" / ");
    var source = config.data_source || {};
    var preview = [
      "版本: " + (ConfigCore.getConfigVersion(config) || "未设置"),
      "字段数: " + fields.length,
      "搜索字段: " + (searchable || "无"),
    ].join("\n");
    var el = $("merger-configPreview");
    if (el) el.textContent = preview;
  }

  async function loadPriceFiles() {
    var input = $("merger-priceFiles");
    if (!input || !input.files.length) {
      setStatus("请先选择报价 Excel 文件", "warn");
      return;
    }

    var cfg = getConfigFromEditor();
    var files = await readExcelFiles(input.files);
    var allTables = files.map(function (f) { return f.rows; });
    state.priceRows = DataUtils.mergePriceTables(allTables, cfg);
    updateCounters();
    setStatus("已加载并合并 " + state.priceRows.length + " 行", "ok");
  }

  async function loadStockFiles() {
    var input = $("merger-stockFiles");
    if (!input || !input.files.length) {
      setStatus("请先选择库存 Excel 文件", "warn");
      return;
    }

    var files = await readExcelFiles(input.files);
    var merged = [];
    for (var i = 0; i < files.length; i++) {
      for (var j = 0; j < files[i].rows.length; j++) merged.push(files[i].rows[j]);
    }
    state.stockRows = merged;
    updateCounters();
    setStatus("库存文件已加载", "ok");
  }

  async function exportPriceBundleOnly() {
    if (!state.priceRows.length) {
      setStatus("请先加载报价文件后再导出价格包", "warn");
      return;
    }

    var password = $("merger-pricePassword").value.trim();
    var cfg = getConfigFromEditor();
    var result = await ExportUtils.createPriceBundleScript(state.priceRows, password, cfg);
    window._mergerBundles = window._mergerBundles || {};
    window._mergerBundles.price = result.script;
    triggerDownload("price.bundle.json", result.script, "application/json;charset=utf-8");
    setStatus("已导出 price.bundle.json", "ok");
  }

  function exportStockBundleOnly() {
    if (!state.stockRows.length) {
      setStatus("请先加载库存文件后再导出库存包", "warn");
      return;
    }

    var cfg = getConfigFromEditor();
    var result = ExportUtils.createStockBundleScript(state.stockRows, cfg);
    window._mergerBundles = window._mergerBundles || {};
    window._mergerBundles.stock = result.script;
    triggerDownload("stock.bundle.json", result.script, "application/json;charset=utf-8");
    setStatus("已导出 stock.bundle.json", "ok");
  }

  async function exportAllBundles() {
    if (!state.priceRows.length) {
      setStatus("请先加载报价文件", "warn");
      return;
    }
    if (!state.stockRows.length) {
      setStatus("请先加载库存文件", "warn");
      return;
    }

    var password = $("merger-pricePassword").value.trim();
    var cfg = getConfigFromEditor();
    var price = await ExportUtils.createPriceBundleScript(state.priceRows, password, cfg);
    var stock = ExportUtils.createStockBundleScript(state.stockRows, cfg);

    window._mergerBundles = { price: price.script, stock: stock.script };

    downloadRowsAsWorkbook(state.priceRows, "price_all_merged.xlsx");
    triggerDownload("price.bundle.json", price.script, "application/json;charset=utf-8");
    triggerDownload("stock.bundle.json", stock.script, "application/json;charset=utf-8");

    setStatus("已导出: price_all_merged.xlsx + price.bundle.json + stock.bundle.json", "ok");
  }

  async function loadDefaultConfig() {
    var fallback = ConfigCore.normalizeConfig({});
    if (window.state && window.state.config) {
      state.appConfig = ConfigCore.normalizeConfig(window.state.config);
    } else {
      state.appConfig = fallback;
    }
    if ($("merger-appConfig")) {
      $("merger-appConfig").value = JSON.stringify(state.appConfig, null, 2);
    }
    renderConfigPreview(state.appConfig);
  }

  function bindEvents() {
    $("merger-loadPriceBtn").onclick = function () {
      loadPriceFiles().catch(function (err) { setStatus("加载失败: " + err.message, "error"); });
    };
    $("merger-loadStockBtn").onclick = function () {
      loadStockFiles().catch(function (err) { setStatus("库存加载失败: " + err.message, "error"); });
    };
    $("merger-exportPriceBtn").onclick = function () {
      exportPriceBundleOnly().catch(function (err) { setStatus("导出价格包失败: " + err.message, "error"); });
    };
    $("merger-exportStockBtn").onclick = function () {
      try { exportStockBundleOnly(); } catch (err) { setStatus("导出库存包失败: " + err.message, "error"); }
    };
    $("merger-exportAllBtn").onclick = function () {
      exportAllBundles().catch(function (err) { setStatus("全部导出失败: " + err.message, "error"); });
    };
  }

  async function bootstrap() {
    await loadDefaultConfig();
    bindEvents();
    updateCounters();
    setStatus("就绪：上传报价文件后点击「加载并合并」", "info");
  }

  bootstrap().catch(function (err) {
    setStatus("初始化失败: " + err.message, "error");
  });
})();