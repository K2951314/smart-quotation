/**
 * event-bindings.js — 所有 UI 事件绑定（bind 函数）。
 *
 * 依赖：admin-core.js（$、g_AdminEventsBound、SB_KEY、sbAnonKeyInput、sbBaseUrlInput、run、collectConfig）
 *       config-render.js（renderAll、renderRuleRows、renderCopyRows、renderUiConfig）
 *       config-api.js（loadConfig、saveConfig、validateConfig、exportConfig、importJson、loadHistory、loadAudit、rollbackToRevision、deleteConfigRevision）
 *       companies.js（switchCompany、createCompany、loadCompanies）
 *       supabase-deploy.js（sbAutoFillBaseUrl、sbSetStatus、sbUploadFile、sbUpdateVersionJson）
 *       standalone-html.js（generateStandalone、deployStandalone）
 */

function bind() {
  if (g_AdminEventsBound) return;
  g_AdminEventsBound = true;

  // ── 公司选择器事件 ──
  var companySelect = $("companySelect");
  if (companySelect) companySelect.addEventListener("change", switchCompany);
  var manageCompaniesBtn = $("manageCompaniesBtn");
  if (manageCompaniesBtn) manageCompaniesBtn.addEventListener("click", function () {
    run(loadCompanies);
    document.getElementById("companies").scrollIntoView({ behavior: "smooth" });
  });
  var createCompanyBtn = $("createCompanyBtn");
  if (createCompanyBtn) createCompanyBtn.addEventListener("click", function () { run(createCompany); });

  // ── 实时回填 state.config ──
  // 重要：input 事件只同步数据到 state.config，绝不重建 DOM。
  // 重建 DOM（innerHTML）会打断 IME 输入法组合，导致中文无法输入。
  // 联动更新（如字段名改动后刷新规则行下拉框）改到 change 事件，
  // change 事件在失焦时触发，不会打断输入。
  document.body.addEventListener("input", (event) => {
    if (!event.target.closest(".workspace")) return;
    try {
      // 仅同步数据，不触发任何 render* 函数
      state.config = collectConfig();
    } catch { /* ignore */ }
  });

  // ── 失焦时联动更新（重建 DOM 刷新下拉框等）──
  document.body.addEventListener("change", (event) => {
    if (!event.target.closest(".workspace")) return;
    try {
      state.config = collectConfig();
      renderRuleRows();
      renderCopyRows();
      renderUiConfig();
    } catch { /* ignore */ }
  });

  // ── 删除/回滚/删除版本 按钮委托 ──
  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.removeField) { state.config.fields.splice(Number(target.dataset.removeField), 1); renderAll(); return; }
    if (target.dataset.removeRule) { state.config.rules.splice(Number(target.dataset.removeRule), 1); renderAll(); return; }
    if (target.dataset.removeCopy) { state.config.copy.columns.splice(Number(target.dataset.removeCopy), 1); renderAll(); return; }

    if (target.dataset.rollback) { run(() => rollbackToRevision(target.dataset.rollback)); return; }
    if (target.dataset.deleteRevision) { run(() => deleteConfigRevision(target.dataset.deleteRevision)); return; }
  });

  // ── 配置操作 ──
  $("loadConfigBtn").addEventListener("click", () => run(loadConfig));
  $("saveDraftBtn").addEventListener("click", () => run(() => saveConfig("draft")));
  $("publishBtn").addEventListener("click", () => run(() => saveConfig("published")));
  $("validateConfigBtn").addEventListener("click", () => run(validateConfig));

  // ── 字段/规则/复制列 添加 ──
  $("addFieldBtn").addEventListener("click", () => {
    if (!Array.isArray(state.config.fields)) state.config.fields = [];
    state.config.fields.push({ key: "", label: "", type: "text", source: "price", excel_aliases: [], searchable: false, copyable: false, required: false, result_area: "detail" });
    renderAll();
  });
  $("addRuleBtn").addEventListener("click", () => {
    if (!Array.isArray(state.config.rules)) state.config.rules = [];
    state.config.rules.push({ id: "new_rule", label: "新规则", priority: 100, when: { all: [{ field: "spec", op: "contains", value: "" }] }, actions: [{ type: "set_discount", percent: 55 }] });
    renderAll();
  });
  $("addCopyColumnBtn").addEventListener("click", () => {
    if (!state.config.copy || typeof state.config.copy !== "object") state.config.copy = {};
    if (!Array.isArray(state.config.copy.columns)) state.config.copy.columns = [];
    state.config.copy.columns.push({ field: "spec", label: "规格", default: true, line: "main" });
    renderAll();
  });

  // ── 导入导出/历史/审计 ──
  $("exportJsonBtn").addEventListener("click", () => run(() => exportConfig("json")));
  $("exportYamlBtn").addEventListener("click", () => run(() => exportConfig("yaml")));
  $("importJsonBtn").addEventListener("click", () => run(importJson));
  $("loadHistoryBtn").addEventListener("click", () => run(loadHistory));
  $("loadAuditBtn").addEventListener("click", () => run(loadAudit));

  // ─── Supabase 部署面板 ────────────────────────────────────────────
  sbAnonKeyInput = $("sb-anonKey");
  sbBaseUrlInput = $("sb-baseUrl");

  // 恢复 anon key
  try {
    if (sbAnonKeyInput) sbAnonKeyInput.value = sessionStorage.getItem(SB_KEY) || "";
  } catch { }

  // 上传 config.json
  const sbUploadConfigBtn = $("sb-uploadConfigBtn");
  if (sbUploadConfigBtn) sbUploadConfigBtn.addEventListener("click", async () => {
    try {
      sbAutoFillBaseUrl();
      const cfg = collectConfig();
      const safeCfg = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (k !== "data_source" && k !== "rules" && k !== "discount_rules") {
          safeCfg[k] = v;
        }
      }
      if (safeCfg.pricing) {
        safeCfg.pricing = { ...safeCfg.pricing };
        delete safeCfg.pricing.default_formula;
      }
      await sbUploadFile("config.json", JSON.stringify(safeCfg, null, 2), "application/json;charset=utf-8");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传价格包
  const sbUploadPriceBtn = $("sb-uploadPriceBtn");
  if (sbUploadPriceBtn) sbUploadPriceBtn.addEventListener("click", async () => {
    try {
      let text = null;
      if (window._mergerBundles && window._mergerBundles.price) {
        text = window._mergerBundles.price;
        sbSetStatus("使用拼接区已生成的价格包…", "info");
      } else if (window._mergerState && window._mergerState.priceRows && window._mergerState.priceRows.length > 0) {
        sbSetStatus("正在从拼接数据生成脱敏价格包…", "info");
        var password = $("merger-pricePassword")?.value.trim() || "";
        var cfg = collectConfig();
        var result = await ExportUtils.createPriceBundleScript(window._mergerState.priceRows, password, cfg, { desensitize: true });
        text = result.script;
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.price = text;
      } else {
        const fileInput = $("sb-priceFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区加载报价文件，或手动选择 price.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text);
      await sbUploadFile("price.bundle.json", text, "application/json;charset=utf-8");
      await sbUpdateVersionJson();
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 上传库存包
  const sbUploadStockBtn = $("sb-uploadStockBtn");
  if (sbUploadStockBtn) sbUploadStockBtn.addEventListener("click", async () => {
    try {
      let text = null;
      if (window._mergerBundles && window._mergerBundles.stock) {
        text = window._mergerBundles.stock;
        sbSetStatus("使用拼接区已生成的库存包…", "info");
      } else if (window._mergerState && window._mergerState.stockRows && window._mergerState.stockRows.length > 0) {
        sbSetStatus("正在从拼接数据生成库存包…", "info");
        var cfg = collectConfig();
        var result = ExportUtils.createStockBundleScript(window._mergerState.stockRows, cfg);
        text = result.script;
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.stock = text;
      } else {
        const fileInput = $("sb-stockFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区加载库存文件，或手动选择 stock.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text);
      await sbUploadFile("stock.bundle.json", text, "application/json;charset=utf-8");
      await sbUpdateVersionJson();
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });

  // 生成独立报价单
  const sbGenerateBtn = $("sb-generateStandaloneBtn");
  if (sbGenerateBtn) sbGenerateBtn.addEventListener("click", () => run(generateStandalone));

  // 上传独立报价单到 Supabase
  const sbDeployBtn = $("sb-deployStandaloneBtn");
  if (sbDeployBtn) sbDeployBtn.addEventListener("click", () => run(deployStandalone));

  // base_url input 聚焦时自动填充
  if (sbBaseUrlInput) sbBaseUrlInput.addEventListener("focus", sbAutoFillBaseUrl);

  // 一键同步全部
  const sbSyncAllBtn = $("sb-syncAllBtn");
  if (sbSyncAllBtn) sbSyncAllBtn.addEventListener("click", async () => {
    try {
      const ms = window._mergerState || {};
      const hasPrice = ms.priceRows && ms.priceRows.length > 0;
      const hasStock = ms.stockRows && ms.stockRows.length > 0;
      if (!hasPrice && !hasStock) {
        throw new Error("请先在数据拼接区加载报价文件或库存文件");
      }
      const cfg = collectConfig();
      const password = $("merger-pricePassword")?.value.trim() || "";
      if (hasPrice) {
        sbSetStatus("正在生成并上传脱敏价格包...", "info");
        const priceResult = await ExportUtils.createPriceBundleScript(ms.priceRows, password, cfg, { desensitize: true });
        JSON.parse(priceResult.script);
        await sbUploadFile("price.bundle.json", priceResult.script, "application/json;charset=utf-8");
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.price = priceResult.script;
      }
      if (hasStock) {
        sbSetStatus("正在生成并上传库存包...", "info");
        const stockResult = ExportUtils.createStockBundleScript(ms.stockRows, cfg);
        JSON.parse(stockResult.script);
        await sbUploadFile("stock.bundle.json", stockResult.script, "application/json;charset=utf-8");
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.stock = stockResult.script;
      }
      await sbUpdateVersionJson();
      sbSetStatus("⚡ 已同步全部数据到 Supabase", "ok");
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });
}
