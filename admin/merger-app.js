(function () {
  var state = {
    appConfig: null,
    stage1Files: [],
    stage1Overrides: {},
    stage2Rows: [],
    stockRows: [],
  };

  // SUPABASE_KEY_STORAGE — 与 admin/app.js 共用同一个 key

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, type) {
    var box = $("merger-statusBox");
    if (!box) return;
    box.textContent = msg;
    box.className = "merger-status" + (type ? " " + type : "");
  }

  function updateCounters() {
    $("merger-stage1Count").textContent = String(state.stage1Files.length);
    $("merger-stage2Count").textContent = String(state.stage2Rows.length);
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

  function normalizeBaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function getDataSourceConfig(cfg) {
    var config = ConfigCore.normalizeConfig(cfg || state.appConfig || {});
    return {
      base_url: normalizeBaseUrl(config.data_source && config.data_source.base_url),
      config_file: (config.data_source && config.data_source.config_file) || "config.json",
    };
  }

  function buildRemoteFileUrl(source, filename, query) {
    var name = String(filename || "");
    var separator = name.indexOf("?") >= 0 ? "&" : "?";
    if (/^https?:\/\//i.test(name)) return query ? name + separator + query : name;
    return source.base_url + "/" + name.replace(/^\/+/, "") + (query ? "?" + query : "");
  }

  function getSupabaseObjectWriteUrl(cfg) {
    var source = getDataSourceConfig(cfg);
    var file = source.config_file || "config.json";
    var publicUrl = /^https?:\/\//i.test(file)
      ? file
      : source.base_url + "/" + file.replace(/^\/+/, "");
    var writeUrl = publicUrl.replace("/storage/v1/object/public/", "/storage/v1/object/");
    if (writeUrl === publicUrl) throw new Error("data_source.base_url 必须是 Supabase Storage public object URL");
    return writeUrl;
  }

  function loadStoredSupabaseAnonKey() {
    try {
      return window.sessionStorage.getItem("quotation-admin-sb-anon-key") || "";
    } catch (err) {
      return "";
    }
  }

function getConfigFromEditor() {
    try {
      var raw = $("merger-appConfig").value;
      var cfg = JSON.parse(raw);
      var normalized = ConfigCore.normalizeConfig(cfg && cfg.brands ? { merger: { brand_rules: cfg } } : cfg);
      var validation = ConfigCore.validateConfig(normalized);
      if (!validation.ok) throw new Error(validation.errors.join("; "));
      return normalized;
    } catch (err) {
      throw new Error("配置不是合法 JSON: " + err.message);
    }
  }

  function getBrandOptions(cfg) {
    var list = [];
    var brandCfg = cfg && cfg.merger ? cfg.merger.brand_rules : cfg;
    var brands = Array.isArray(brandCfg.brands) ? brandCfg.brands : [];
    for (var i = 0; i < brands.length; i++) {
      var id = String(brands[i].id || "").trim();
      if (id) list.push(id);
    }
    var fallback = String(brandCfg.defaultBrand || "UNMAPPED").trim() || "UNMAPPED";
    if (list.indexOf(fallback) < 0) list.push(fallback);
    return list;
  }

  function renderStage1Mappings(splitResult, cfg) {
    var body = $("merger-mappingBody");
    if (!body) return;
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
    $("merger-stage1Summary").textContent = summary || "无";

    // 显示映射表
    var tableWrap = $("merger-stage1TableWrap");
    if (tableWrap) tableWrap.style.display = splitResult.fileBrands.length > 0 ? "" : "none";
  }

  function renderConfigPreview(cfg) {
    var config = cfg || getConfigFromEditor();
    var fields = config.fields || [];
    var searchable = fields.filter(function (field) { return field.searchable; }).map(function (field) { return field.label; }).join(" / ");
    var copy = (config.copy.columns || []).filter(function (column) { return column.default; }).map(function (column) { return column.label; }).join(" / ");
    var priceAliases = fields.filter(function (field) { return field.source === "price"; }).map(function (field) {
      return field.label + ": " + field.excel_aliases.join("|");
    }).join("\n");
    var source = getDataSourceConfig(config);
    var preview = [
      "版本: " + (ConfigCore.getConfigVersion(config) || "未设置"),
      "远端目录: " + (source.base_url || "未设置"),
      "字段数: " + fields.length,
      "搜索字段: " + (searchable || "无"),
      "默认复制: " + (copy || "无"),
      "",
      "价格列别名:",
      priceAliases || "无"
    ].join("\n");
    var previewEl = $("merger-configPreview");
    if (previewEl) previewEl.textContent = preview;
  }

function exportConfigJson() {
    var cfg = validateConfigEditor();
    triggerDownload("config.json", JSON.stringify(cfg, null, 2), "application/json;charset=utf-8");
    setStatus("已导出 config.json", "ok");
  }

  async function analyzeStage1() {
    var input = $("merger-stage1Files");
    if (!input || !input.files.length) {
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
    var brandCfg = cfg.merger ? cfg.merger.brand_rules : cfg;
    var defaultBrand = String(brandCfg.defaultBrand || "UNMAPPED").trim() || "UNMAPPED";
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
    var input = $("merger-stage2Files");
    if (!input || !input.files.length) {
      setStatus("请先选择处理后的品牌文件", "warn");
      return;
    }

    var files = await readExcelFiles(input.files);
    var cfg = getConfigFromEditor();
    state.stage2Rows = DataUtils.mergePriceTables(files.map(function (f) { return f.rows; }), cfg);
    updateCounters();
    setStatus("阶段2文件已加载", "ok");
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
    if (!state.stage2Rows.length) {
      setStatus("请先加载阶段2品牌文件后再导出价格包", "warn");
      return;
    }

    var password = $("merger-pricePassword").value.trim();
    var cfg = getConfigFromEditor();
    var result = await ExportUtils.createPriceBundleScript(state.stage2Rows, password, cfg);
    // 同时挂到全局，让发布配置区可直接读取（无需手动下载再上传）
    window._mergerBundles = window._mergerBundles || {};
    window._mergerBundles.price = result.script;
    triggerDownload("price.bundle.json", result.script, "application/json;charset=utf-8");
    setStatus("已导出 price.bundle.json（发布区可直接一键上传）", "ok");
  }

  function exportStockBundleOnly() {
    if (!state.stockRows.length) {
      setStatus("请先加载库存文件后再导出库存包", "warn");
      return;
    }

    var cfg = getConfigFromEditor();
    var result = ExportUtils.createStockBundleScript(state.stockRows, cfg);
    // 同时挂到全局
    window._mergerBundles = window._mergerBundles || {};
    window._mergerBundles.stock = result.script;
    triggerDownload("stock.bundle.json", result.script, "application/json;charset=utf-8");
    setStatus("已导出 stock.bundle.json（发布区可直接一键上传）", "ok");
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

    var password = $("merger-pricePassword").value.trim();
    var cfg = getConfigFromEditor();
    var price = await ExportUtils.createPriceBundleScript(state.stage2Rows, password, cfg);
    var stock = ExportUtils.createStockBundleScript(state.stockRows, cfg);

    // 挂到全局供发布区直接读取
    window._mergerBundles = { price: price.script, stock: stock.script };

    downloadRowsAsWorkbook(state.stage2Rows, "price_all_merged.xlsx");
    triggerDownload("price.bundle.json", price.script, "application/json;charset=utf-8");
    triggerDownload("stock.bundle.json", stock.script, "application/json;charset=utf-8");

    setStatus("已导出: price_all_merged.xlsx + price.bundle.json + stock.bundle.json（发布区可直接一键上传）", "ok");
  }

  async function loadDefaultConfig() {
    var fallback = ConfigCore.normalizeConfig({});

    // 优先使用主程序的全局配置，不发起无意义的网络请求
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
    $("merger-analyzeStage1Btn").onclick = function () {
      analyzeStage1().catch(function (err) { setStatus("阶段1分析失败: " + err.message, "error"); });
    };
    $("merger-exportStage1Btn").onclick = function () {
      try { exportStage1ByBrand(); } catch (err) { setStatus("阶段1导出失败: " + err.message, "error"); }
    };
    $("merger-loadStage2Btn").onclick = function () {
      loadStage2Files().catch(function (err) { setStatus("加载阶段2文件失败: " + err.message, "error"); });
    };
    $("merger-loadStockBtn").onclick = function () {
      loadStockFiles().catch(function (err) { setStatus("加载库存文件失败: " + err.message, "error"); });
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
    var anonField = $("merger-supabaseAnonKey");
    if (anonField) anonField.value = loadStoredSupabaseAnonKey();
    bindEvents();
    updateCounters();
    setStatus("就绪：先执行阶段1分析", "info");
  }

  bootstrap().catch(function (err) {
    setStatus("初始化失败: " + err.message, "error");
  });
})();
