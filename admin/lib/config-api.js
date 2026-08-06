/**
 * config-api.js — 配置 API 调用：加载、保存、校验、版本历史、审计日志、导入导出。
 *
 * 依赖：admin-core.js（$、state、request、setStatus、run、defaultConfig）
 *       config-collect.js（collectConfig）
 *       config-render.js（renderAll）
 *       supabase-deploy.js（desensitizeConfigForPublic、sbUploadFile、sbUpdateVersionJson、autoFillSupabaseUrl、sbAutoFillBaseUrl、sbGetBaseUrl）
 *       companies.js（getCurrentCompanyId）
 */

// 从后端 API 加载当前公司的配置
async function loadConfigFromBackend() {
  var cid = getCurrentCompanyId();
  try {
    var config = await request("/api/config");
    if (!config.schema_version) config.schema_version = 3;
    config.status = "draft";
    state.config = normalizeAdminConfig(config);
    renderAll();
    setStatus("已加载「" + cid + "」的配置");
    autoFillSupabaseUrl();
    return true;
  } catch (err) {
    if (err.status === 404) {
      state.config = defaultConfig();
      try {
        var settings = await request("/api/settings/datasource");
        if (settings.supabase_base_url) {
          state.config.data_source = state.config.data_source || {};
          state.config.data_source.base_url = settings.supabase_base_url;
        }
      } catch { }
      renderAll();
      setStatus("「" + cid + "」尚未发布配置，当前显示默认模板。填写配置后点击「保存」即可创建。", "warn");
      autoFillSupabaseUrl();
      return false;
    }
    setStatus("加载配置失败: " + err.message, true);
    return false;
  }
}

// 初始化应用（登录后自动调用）
async function initApp() {
  await loadCompanies();
  await loadConfigFromBackend();
}

async function loadConfig() {
  // 安全修复：从后端 SQLite 恢复完整配置（含 rules/discount_rules），
  // 不再从 Supabase 恢复（Supabase 上是脱敏版，无 rules，恢复后再保存会丢 rules）。
  const confirmed = confirm("将从后端数据库加载已发布的配置覆盖当前草稿，未保存的修改会丢失。\n\n是否继续？");
  if (!confirmed) return;

  try {
    const config = await request("/api/config");
    if (!config.schema_version) config.schema_version = 3;
    config.status = "draft";
    state.config = normalizeAdminConfig(config);
    renderAll();
    autoFillSupabaseUrl();
    setStatus("已从后端恢复「" + getCurrentCompanyId() + "」的配置");
  } catch (err) {
    if (err.status === 404) {
      setStatus("「" + getCurrentCompanyId() + "」尚未发布配置", "warn");
    } else {
      setStatus("加载失败: " + (err.message || err), true);
    }
  }
}

async function saveConfig(status) {
  const config = collectConfig();
  const saved = await request("/api/config", {
    method: "POST",
    body: JSON.stringify({ config, status }),
  });
  state.config = normalizeAdminConfig(saved);
  renderAll();

  // 发布时自动部署到 Supabase
  if (status === "published") {
    try {
      // 上传 config.json — 使用统一脱敏函数（移除 rules/discount_rules/default_formula）
      const safeCfg = desensitizeConfigForPublic(state.config);
      await sbUploadFile("config.json", JSON.stringify(safeCfg, null, 2), "application/json;charset=utf-8");
      await sbUpdateVersionJson();
      setStatus("配置已发布并同步到 Supabase");
    } catch (err) {
      console.error("Supabase 同步失败:", err);
      setStatus("Supabase 同步失败: " + (err.message || err), true);
    }
  } else {
    setStatus("草稿已保存");
  }
  await updatePreview();
}

async function validateConfig() {
  try {
    const result = await request("/api/config/validate");
    if (result.valid) {
      setStatus("服务器端验证通过：配置合法");
    } else {
      setStatus("验证失败：\n" + result.errors.join("\n"), true);
    }
  } catch (err) {
    setStatus("加载失败: " + (err.message || err), true);
  }
}

async function loadHistory() {
  const configs = await request("/api/configs");
  const tbody = $("historyRows");
  if (!tbody) return;
  if (!configs.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;">暂无配置记录</td></tr>';
  } else {
    tbody.innerHTML = configs.map((cfg) => {
      const isPublished = cfg.status === "published";
      const isArchived = cfg.status === "archived";
      const badge = isPublished ? '<span class="badge badge-green">已发布</span>'
        : isArchived ? '<span class="badge badge-muted">已归档</span>'
          : '<span class="badge">草稿</span>';
      const safeRev = escapeHtml(cfg.revision || "");
      return `<tr>
        <td><strong>${safeRev}</strong></td>
        <td>${badge}</td>
        <td>${escapeHtml(cfg.published_at || "—")}</td>
        <td>${escapeHtml(cfg.created_at || "")}</td>
        <td>
          <button type="button" class="small-btn" onclick="rollbackToRevision('${safeRev}')">发布此版本</button>
          <button type="button" class="small-btn danger-btn" onclick="deleteConfigRevision('${safeRev}')">删除</button>
        </td>
      </tr>`;
    }).join("");
  }
  setStatus(`共 ${configs.length} 个版本`);
}

async function rollbackToRevision(revision) {
  if (!confirm(`确认将版本 ${revision} 设为当前发布配置？`)) return;
  const config = await request(`/api/config/${encodeURIComponent(revision)}/publish`, { method: "POST" });
  state.config = normalizeAdminConfig(config);
  renderAll();
  setStatus(`已回滚到版本 ${revision}`);

  try {
    // 安全修复：使用统一脱敏函数（原代码只移除 data_source，漏了 rules/discount_rules，
    // 导致折扣规则泄露到 Supabase 公开桶）
    const safeCfg = desensitizeConfigForPublic(config);
    await sbUploadFile("config.json", JSON.stringify(safeCfg, null, 2), "application/json;charset=utf-8");
    await sbUpdateVersionJson();
    setStatus("已回滚并同步到 Supabase");
  } catch (err) {
    console.error("Supabase 同步失败:", err);
    setStatus("Supabase 同步失败: " + (err.message || err), true);
  }
}

async function deleteConfigRevision(revision) {
  if (!confirm(`确认删除版本 ${revision}？`)) return;
  await request(`/api/config/${encodeURIComponent(revision)}`, { method: "DELETE" });
  setStatus(`已删除版本 ${revision}`);
  await loadHistory();
}

async function loadAudit() {
  const events = await request("/api/audit");
  const tbody = $("auditRows");
  if (!tbody) return;
  if (!events.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;">暂无审计记录</td></tr>';
  } else {
    tbody.innerHTML = events.map((e) => {
      return `<tr>
        <td>${escapeHtml(e.created_at || "")}</td>
        <td><strong>${escapeHtml(e.action || "")}</strong></td>
        <td>${escapeHtml(e.target_type || "")}</td>
        <td>${escapeHtml(e.target_id || "")}</td>
        <td>${escapeHtml(e.actor_id || "")}</td>
      </tr>`;
    }).join("");
  }
  setStatus(`共 ${events.length} 条审计记录`);
}

async function exportConfig(fmt) {
  const revision = $("revision").value.trim();
  if (!revision) { setStatus("请先在顶部填写版本号", true); return; }
  try {
    const response = await fetch(withCompany(`${apiBase}/api/config/${encodeURIComponent(revision)}/export?fmt=${fmt}`), {
      headers: { "Authorization": "Bearer " + getAuthToken() }
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    const blob = new Blob([text], { type: fmt === "yaml" ? "text/yaml" : "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `config-${revision}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出版本 ${revision}（${fmt.toUpperCase()}）`);
  } catch (err) {
    setStatus("导出失败: " + (err.message || err), true);
  }
}

async function importJson() {
  const content = $("advancedJson").value.trim();
  if (!content) { setStatus("请在高级 JSON 文本框中粘贴配置内容", true); return; }
  try {
    state.config = normalizeAdminConfig(await request("/api/config/import", {
      method: "POST",
      body: JSON.stringify({ content, fmt: "json" }),
    }));
    renderAll();
    setStatus("配置已导入为草稿");
  } catch (err) {
    setStatus("导入失败: " + (err.message || err), true);
  }
}
