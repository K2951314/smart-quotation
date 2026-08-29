/**
 * event-bindings.js — 所有 UI 事件绑定（bind 函数）。
 *
 * 依赖：admin-core.js（$、g_AdminEventsBound、SB_KEY、sbAnonKeyInput、sbBaseUrlInput、run、collectConfig）
 *       config-render.js（renderAll、renderRuleRows、renderCopyRows、renderUiConfig）
 *       config-api.js（loadConfig、saveConfig、exportConfig、loadHistory、loadAudit、rollbackToRevision、deleteConfigRevision）
 *       companies.js（switchCompany、createCompany、loadCompanies）
 *       supabase-deploy.js（sbAutoFillBaseUrl、sbSetStatus、sbUploadFile、sbUpdateVersionJson）
 *       standalone-html.js（generateStandalone、deployStandalone）
 */

/**
 * 上传管理员加密价格包（price.admin.bundle.json）。
 *
 * 背景：公开桶的 price.bundle.json 是强制脱敏版（无 face_price），
 * apps 端 admin 角色（供应商自己）需要面价做折扣调整，曾因此显示价格 0。
 *
 * 方案：完整数据（含面价）用「当前公司 access_token」AES-GCM 加密后
 * 上传到公开桶。apps 端 admin 角色用本地登录令牌自动解密。
 * 安全性：token 是 43 字符随机串 + PBKDF2 10 万轮派生密钥，公开下载无法破解；
 * 令牌泄露的攻击者本来就能登录管理员账号看面价，不扩大攻击面。
 *
 * 失败不阻断主流程（客户公司通道优先），仅提示。
 */
async function uploadAdminPriceBundle(priceRows, cfg) {
  // 返回 {ok, error}：让调用方决定最终状态展示，避免失败被后续 sbSetStatus 覆盖
  // （曾导致用户只看到「已同步全部」却不知 admin 包失败 → admin 端看不到面价）。
  const cid = getCurrentCompanyId();
  if (!cid || cid === "default") {
    return { ok: false, error: "未选中主公司（当前为 default）。请在配置中心顶部选择你的主公司后再同步，否则 price.admin.bundle.json 不会上传，admin 端看不到面价" };
  }
  try {
    const company = await request("/api/companies/" + encodeURIComponent(cid));
    const token = ((company && company.meta) || {}).access_token || "";
    if (!token) {
      return { ok: false, error: "公司 " + cid + " 无 access_token（meta 未生成令牌）" };
    }
    sbSetStatus("正在生成管理员加密价格包…", "info");
    const result = await ExportUtils.createPriceBundleScript(priceRows, token, cfg, { desensitize: false });
    JSON.parse(result.script);
    await sbUploadFile("price.admin.bundle.json", result.script, "application/json;charset=utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

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

    if (target.dataset.removeField) { state.config.fields.splice(Number(target.dataset.removeField), 1); renderAll(); if (window.refreshQuotaIndicators) window.refreshQuotaIndicators(); return; }
    if (target.dataset.removeRule) { state.config.rules.splice(Number(target.dataset.removeRule), 1); renderAll(); if (window.refreshQuotaIndicators) window.refreshQuotaIndicators(); return; }
    if (target.dataset.removeCopy) { state.config.copy.columns.splice(Number(target.dataset.removeCopy), 1); renderAll(); return; }

    if (target.dataset.rollback) { run(() => rollbackToRevision(target.dataset.rollback)); return; }
    if (target.dataset.deleteRevision) { run(() => deleteConfigRevision(target.dataset.deleteRevision)); return; }

    if (target.dataset.tierEditAdmin !== undefined) { editTier(target.dataset.tierEditAdmin, Number(target.dataset.tierEditIdx)); return; }
    if (target.dataset.tierDeleteAdmin !== undefined) { deleteTier(target.dataset.tierDeleteAdmin, Number(target.dataset.tierDeleteIdx)); return; }
  });

  // ── 配置操作 ──
  $("loadConfigBtn").addEventListener("click", () => run(loadConfig));
  $("saveDraftBtn").addEventListener("click", () => run(() => saveConfig("draft")));
  $("publishBtn").addEventListener("click", () => run(() => saveConfig("published")));

  // ── 字段/规则/复制列 添加（含配额前置阻断）──
  $("addFieldBtn").addEventListener("click", () => {
    if (!Array.isArray(state.config.fields)) state.config.fields = [];
    state.config.fields.push({ key: "", label: "", type: "text", source: "price", excel_aliases: [], searchable: false, copyable: false, required: false, result_area: "detail" });
    renderAll();
    if (window.refreshQuotaIndicators) window.refreshQuotaIndicators();
  });
  $("addRuleBtn").addEventListener("click", () => {
    if (!Array.isArray(state.config.rules)) state.config.rules = [];
    // 配额前置阻断：免费版只能加 max_brands 条规则（默认 2）
    // 不让用户超限添加，而非保存时才报错（体验更好）
    var quota = window.SQ_QUOTA;
    if (quota && quota.max_brands >= 0 && state.config.rules.length >= quota.max_brands) {
      setStatus(
        "报价规则已达当前订阅上限（" + quota.max_brands + " 条），请升级订阅或删除多余规则",
        true,
      );
      return;
    }
    state.config.rules.push({ id: "new_rule", label: "新规则", priority: 100, when: { all: [{ field: "spec", op: "contains", value: "" }] }, actions: [{ type: "set_discount", percent: 55 }] });
    renderAll();
    if (window.refreshQuotaIndicators) window.refreshQuotaIndicators();
  });
  $("addCopyColumnBtn").addEventListener("click", () => {
    if (!state.config.copy || typeof state.config.copy !== "object") state.config.copy = {};
    if (!Array.isArray(state.config.copy.columns)) state.config.copy.columns = [];
    state.config.copy.columns.push({ field: "spec", label: "规格", default: true, line: "main" });
    renderAll();
  });

  // ── 导入导出/历史/审计 ──
  $("exportJsonBtn").addEventListener("click", () => run(() => exportConfig("json")));
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
      const safeCfg = desensitizeConfigForPublic(cfg);
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
      if (window._mergerState && window._mergerState.priceRows && window._mergerState.priceRows.length > 0) {
        // 优先从拼接数据重新生成脱敏价格包（安全：移除面价、预计算报价）
        sbSetStatus("正在从拼接数据生成脱敏价格包…", "info");
        var password = $("merger-pricePassword")?.value.trim() || "";
        var cfg = collectConfig();
        var result = await ExportUtils.createPriceBundleScript(window._mergerState.priceRows, password, cfg, { desensitize: true });
        text = result.script;
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.price = text;
      } else if (window._mergerBundles && window._mergerBundles.price) {
        // 无拼接数据时回退到已生成价格包（merger 导出已脱敏）
        text = window._mergerBundles.price;
        sbSetStatus("使用拼接区已生成的价格包…", "info");
      } else {
        const fileInput = $("sb-priceFileInput");
        if (!fileInput || !fileInput.files || !fileInput.files[0])
          throw new Error("请先在数据拼接区加载报价文件，或手动选择 price.bundle.json 文件");
        text = await fileInput.files[0].text();
      }
      JSON.parse(text);
      await sbUploadFile("price.bundle.json", text, "application/json;charset=utf-8");
      // 管理员通道：有拼接原始数据时额外生成 token 加密的完整价格包（含面价）
      let adminResult = null;
      if (window._mergerState && window._mergerState.priceRows && window._mergerState.priceRows.length > 0) {
        adminResult = await uploadAdminPriceBundle(window._mergerState.priceRows, collectConfig());
        if (!adminResult.ok) {
          sbSetStatus("⚠️ 价格包已上传，但管理员数据包失败：" + adminResult.error + "（admin 端将看不到面价）", "error");
          return;
        }
      } else {
        sbSetStatus("⚠️ 无拼接原始数据，管理员数据包未生成（管理员端将看不到面价）", "info");
      }
      // 版本号 = 本次上传内容的指纹（内容变 → version 变 → 门户拉新）
      await sbUpdateVersionJson(await computeBundleContentHash([text]));
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
      await sbUpdateVersionJson(await computeBundleContentHash([text]));
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

  // 上传数据到服务器（后端托管，所有档位可用——免费版主发布路径）
  const ubPriceBtn = $("merger-uploadBackendPriceBtn");
  if (ubPriceBtn) ubPriceBtn.addEventListener("click", async () => {
    const ms = window._mergerState || {};
    const statusEl = $("backendUploadPriceStatus");
    if (!ms.priceRows || !ms.priceRows.length) {
      if (statusEl) statusEl.textContent = "请先点击「加载并合并」，再上传";
      return;
    }
    ubPriceBtn.disabled = true;
    if (statusEl) statusEl.textContent = "正在上传价格数据...";
    try {
      const resp = await request("/api/items/upload-json", {
        method: "POST",
        body: JSON.stringify({ rows: ms.priceRows, filename: "price.xlsx", write: true }),
      });
      if (statusEl) statusEl.textContent = "✅ 价格数据已上传（" + resp.count + " 行，数据版本 " + resp.data_revision + "）。客户门户将自动加载最新数据。";
    } catch (err) {
      if (statusEl) statusEl.textContent = "❌ 上传失败：" + err.message;
    } finally {
      ubPriceBtn.disabled = false;
    }
  });
  const ubStockBtn = $("merger-uploadBackendStockBtn");
  if (ubStockBtn) ubStockBtn.addEventListener("click", async () => {
    const ms = window._mergerState || {};
    const statusEl = $("backendUploadStockStatus");
    if (!ms.stockRows || !ms.stockRows.length) {
      if (statusEl) statusEl.textContent = "请先点击「加载库存」，再上传";
      return;
    }
    ubStockBtn.disabled = true;
    if (statusEl) statusEl.textContent = "正在上传库存数据...";
    try {
      const resp = await request("/api/items/upload-json", {
        method: "POST",
        body: JSON.stringify({ rows: ms.stockRows, filename: "stock.xlsx", write: true }),
      });
      if (statusEl) statusEl.textContent = "✅ 库存数据已上传（" + resp.count + " 行，数据版本 " + resp.data_revision + "）。客户门户将自动加载最新数据。";
    } catch (err) {
      if (statusEl) statusEl.textContent = "❌ 上传失败：" + err.message;
    } finally {
      ubStockBtn.disabled = false;
    }
  });

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
      let adminBundleResult = { ok: true };

      // 密码警告：加密包会导致客户端 prompt 密码，客户不知道密码无法查看价格
      if (password) {
        const ok = confirm("⚠️ 您填写了价格包密码，上传后价格包将被加密。\n\n" +
          "客户端遇到加密包会弹出密码输入框，客户通常不知道密码。\n\n" +
          "如需让客户直接查看价格，请清空密码框。\n\n是否继续？");
        if (!ok) return;
      }

      // 上传 config.json（脱敏版）——修复：原来一键同步不上传 config.json，
      // 导致 Supabase 上的 config.json 可能是旧的，客户端用旧配置 + 新 bundle 会字段不匹配
      sbSetStatus("正在上传 config.json...", "info");
      const safeCfg = desensitizeConfigForPublic(cfg);
      await sbUploadFile("config.json", JSON.stringify(safeCfg, null, 2), "application/json;charset=utf-8");

      let priceResult = null;
      let stockResult = null;
      if (hasPrice) {
        sbSetStatus("正在生成并上传脱敏价格包...", "info");
        priceResult = await ExportUtils.createPriceBundleScript(ms.priceRows, password, cfg, { desensitize: true });
        JSON.parse(priceResult.script);
        await sbUploadFile("price.bundle.json", priceResult.script, "application/json;charset=utf-8");
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.price = priceResult.script;
        // 管理员通道：token 加密的完整价格包（含面价），apps 端 admin 角色自动解密
        adminBundleResult = await uploadAdminPriceBundle(ms.priceRows, cfg);
      }
      if (hasStock) {
        sbSetStatus("正在生成并上传库存包...", "info");
        stockResult = ExportUtils.createStockBundleScript(ms.stockRows, cfg);
        JSON.parse(stockResult.script);
        await sbUploadFile("stock.bundle.json", stockResult.script, "application/json;charset=utf-8");
        window._mergerBundles = window._mergerBundles || {};
        window._mergerBundles.stock = stockResult.script;
      }
      // 版本号 = 本次全部上传内容的指纹（数据没变则 version 不变，门户缓存继续有效）
      await sbUpdateVersionJson(await computeBundleContentHash(
        [JSON.stringify(safeCfg), priceResult && priceResult.script, stockResult && stockResult.script]
      ));
      if (hasPrice && adminBundleResult && !adminBundleResult.ok) {
        sbSetStatus("⚠️ 价格/库存已同步，但管理员数据包失败：" + adminBundleResult.error + "（admin 端将看不到面价）", "error");
      } else {
        sbSetStatus("⚡ 已同步全部数据到 Supabase（含 config + price + stock + version）", "ok");
      }
    } catch (err) {
      sbSetStatus("❌ " + err.message, "error");
    }
  });
}
