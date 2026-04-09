(function () {
  var state = {
    brandConfig: null,
    stage1Files: [],
    stage1Overrides: {},
    stage2Rows: [],
    stockRows: [],
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, type) {
    var box = $("statusBox");
    box.textContent = msg;
    box.className = "status " + (type || "info");
  }

  function updateCounters() {
    $("stage1Count").textContent = String(state.stage1Files.length);
    $("stage2Count").textContent = String(state.stage2Rows.length);
    $("stockCount").textContent = String(state.stockRows.length);
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
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
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
      var raw = $("brandConfig").value;
      var cfg = JSON.parse(raw);
      if (!cfg || !Array.isArray(cfg.brands)) throw new Error("brands must be an array");
      return cfg;
    } catch (err) {
      throw new Error("品牌配置不是合法 JSON: " + err.message);
    }
  }

  function getBrandOptions(cfg) {
    var list = [];
    var brands = Array.isArray(cfg.brands) ? cfg.brands : [];
    for (var i = 0; i < brands.length; i++) {
      var id = String(brands[i].id || "").trim();
      if (id) list.push(id);
    }
    var fallback = String(cfg.defaultBrand || "UNMAPPED").trim() || "UNMAPPED";
    if (list.indexOf(fallback) < 0) list.push(fallback);
    return list;
  }

  function renderStage1Mappings(splitResult, cfg) {
    var body = $("mappingBody");
    body.innerHTML = "";
    var brands = getBrandOptions(cfg);

    for (var i = 0; i < splitResult.fileBrands.length; i++) {
      var row = splitResult.fileBrands[i];
      var tr = document.createElement("tr");

      var fileTd = document.createElement("td");
      fileTd.textContent = row.filename;
      tr.appendChild(fileTd);

      var detectedTd = document.createElement("td");
      detectedTd.textContent = row.detectedBrand;
      tr.appendChild(detectedTd);

      var selectedTd = document.createElement("td");
      var select = document.createElement("select");
      select.setAttribute("data-file", row.filename);
      for (var b = 0; b < brands.length; b++) {
        var opt = document.createElement("option");
        opt.value = brands[b];
        opt.textContent = brands[b];
        if (brands[b] === row.selectedBrand) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = function (evt) {
        var file = evt.target.getAttribute("data-file");
        state.stage1Overrides[file] = evt.target.value;
        var recomputed = DataUtils.splitPriceFilesByBrand(state.stage1Files, cfg, state.stage1Overrides);
        renderStage1Mappings(recomputed, cfg);
      };
      selectedTd.appendChild(select);
      tr.appendChild(selectedTd);

      var countTd = document.createElement("td");
      countTd.textContent = String(row.rowCount);
      tr.appendChild(countTd);

      body.appendChild(tr);
    }

    var summary = Object.keys(splitResult.grouped).map(function (k) {
      return k + ": " + splitResult.grouped[k].length;
    }).join(" | ");
    $("stage1Summary").textContent = summary || "无";
  }

  async function analyzeStage1() {
    var input = $("stage1Files");
    if (!input.files.length) {
      setStatus("请先选择品牌原始 Excel 文件", "warn");
      return;
    }

    var cfg = getConfigFromEditor();
    var files = await readExcelFiles(input.files);
    state.stage1Files = files;

    var splitResult = DataUtils.splitPriceFilesByBrand(files, cfg, state.stage1Overrides);
    renderStage1Mappings(splitResult, cfg);
    updateCounters();
    setStatus("阶段1分析完成，可手动修正品牌后导出", "ok");
  }

  function exportStage1ByBrand() {
    if (!state.stage1Files.length) {
      setStatus("请先执行阶段1分析", "warn");
      return;
    }

    var cfg = getConfigFromEditor();
    var splitResult = DataUtils.splitPriceFilesByBrand(state.stage1Files, cfg, state.stage1Overrides);
    var defaultBrand = String(cfg.defaultBrand || "UNMAPPED").trim() || "UNMAPPED";
    var hasUnmapped = Object.prototype.hasOwnProperty.call(splitResult.grouped, defaultBrand);
    if (hasUnmapped) {
      setStatus("仍存在 UNMAPPED 文件，请先手动改判再导出", "warn");
      return;
    }

    var brands = Object.keys(splitResult.grouped);
    for (var i = 0; i < brands.length; i++) {
      var brand = brands[i];
      downloadRowsAsWorkbook(splitResult.grouped[brand], "brand_" + brand + "_stage1.xlsx");
    }

    setStatus("阶段1导出完成：按品牌生成分包文件", "ok");
  }

  async function loadStage2Files() {
    var input = $("stage2Files");
    if (!input.files.length) {
      setStatus("请先选择处理后的品牌文件", "warn");
      return;
    }

    var files = await readExcelFiles(input.files);
    state.stage2Rows = DataUtils.mergePriceTables(files.map(function (f) { return f.rows; }));
    updateCounters();
    setStatus("阶段2文件已加载", "ok");
  }

  async function loadStockFiles() {
    var input = $("stockFiles");
    if (!input.files.length) {
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
    if (!state.stage2Rows.length) {
      setStatus("请先加载阶段2品牌文件后再导出价格包", "warn");
      return;
    }

    var password = $("pricePassword").value.trim();
    var result = await ExportUtils.createPriceBundleScript(state.stage2Rows, password);
    triggerDownload("price.bundle.js", result.script, "text/javascript;charset=utf-8");
    setStatus("已导出 price.bundle.js", "ok");
  }

  function exportStockBundleOnly() {
    if (!state.stockRows.length) {
      setStatus("请先加载库存文件后再导出库存包", "warn");
      return;
    }

    var result = ExportUtils.createStockBundleScript(state.stockRows);
    triggerDownload("stock.bundle.js", result.script, "text/javascript;charset=utf-8");
    setStatus("已导出 stock.bundle.js", "ok");
  }

  async function exportAllBundles() {
    if (!state.stage2Rows.length) {
      setStatus("请先加载阶段2品牌文件", "warn");
      return;
    }
    if (!state.stockRows.length) {
      setStatus("请先加载库存文件", "warn");
      return;
    }

    var password = $("pricePassword").value.trim();
    var price = await ExportUtils.createPriceBundleScript(state.stage2Rows, password);
    var stock = ExportUtils.createStockBundleScript(state.stockRows);

    downloadRowsAsWorkbook(state.stage2Rows, "price_all_merged.xlsx");
    triggerDownload("price.bundle.js", price.script, "text/javascript;charset=utf-8");
    triggerDownload("stock.bundle.js", stock.script, "text/javascript;charset=utf-8");

    setStatus("已导出: price_all_merged.xlsx + price.bundle.js + stock.bundle.js", "ok");
  }

  async function loadDefaultConfig() {
    var fallback = {
      defaultBrand: "UNMAPPED",
      brands: [
        { id: "MITSUBISHI", prefixes: ["三菱", "MITSU"] },
        { id: "OSG", prefixes: ["OSG"] },
      ],
    };

    try {
      var resp = await fetch("./brand-config.json", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      state.brandConfig = await resp.json();
    } catch (err) {
      state.brandConfig = fallback;
    }

    $("brandConfig").value = JSON.stringify(state.brandConfig, null, 2);
  }

  function bindEvents() {
    $("analyzeStage1Btn").onclick = function () {
      analyzeStage1().catch(function (err) { setStatus("阶段1分析失败: " + err.message, "error"); });
    };

    $("exportStage1Btn").onclick = function () {
      try { exportStage1ByBrand(); } catch (err) { setStatus("阶段1导出失败: " + err.message, "error"); }
    };

    $("loadStage2Btn").onclick = function () {
      loadStage2Files().catch(function (err) { setStatus("加载阶段2文件失败: " + err.message, "error"); });
    };

    $("loadStockBtn").onclick = function () {
      loadStockFiles().catch(function (err) { setStatus("加载库存文件失败: " + err.message, "error"); });
    };

    $("exportPriceBtn").onclick = function () {
      exportPriceBundleOnly().catch(function (err) { setStatus("导出价格包失败: " + err.message, "error"); });
    };

    $("exportStockBtn").onclick = function () {
      try { exportStockBundleOnly(); } catch (err) { setStatus("导出库存包失败: " + err.message, "error"); }
    };

    $("exportAllBtn").onclick = function () {
      exportAllBundles().catch(function (err) { setStatus("全部导出失败: " + err.message, "error"); });
    };
  }

  async function bootstrap() {
    await loadDefaultConfig();
    bindEvents();
    updateCounters();
    setStatus("就绪：先执行阶段1分析", "info");
  }

  bootstrap().catch(function (err) {
    setStatus("初始化失败: " + err.message, "error");
  });
})();
