/**
 * companies.js — 公司管理 UI：列表渲染、创建、删除、令牌重置、切换。
 *
 * 依赖：admin-core.js（request、setStatus、escapeHtml、getCurrentCompanyId、setCurrentCompanyId、run）
 */

// ─── 公司管理函数 ─────────────────────────────────────────

async function loadCompanies() {
  try {
    const companies = await request("/api/companies");
    var sel = document.getElementById("companySelect");
    if (sel) {
      sel.innerHTML = "";
      companies.forEach(function (c) {
        var opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.id + (c.name ? "（" + c.name + "）" : "");
        if (c.id === getCurrentCompanyId()) opt.selected = true;
        sel.appendChild(opt);
      });
    }
    var list = document.getElementById("companyList");
    if (list) {
      list.innerHTML = "";
      if (companies.length === 0) {
        list.innerHTML = '<p style="color:#999;font-size:13px;">暂无公司</p>';
      } else {
        companies.forEach(function (c) {
          var meta = c.meta || {};
          var pm = meta.profit_margin !== undefined ? meta.profit_margin + "%" : "-";
          var tokenDisplay = meta.access_token ? meta.access_token.substring(0, 8) + "..." : "未生成";
          var supabaseUrl = (meta.supabase_base_url || "").trim();
          var supabaseDisplay = supabaseUrl ? supabaseUrl.replace(/^https?:\/\//, "").substring(0, 30) + "..." : "默认";
          var safeId = escapeHtml(c.id);
          var safeName = c.name ? escapeHtml(c.name) : "";
          var safeToken = escapeHtml(tokenDisplay);
          var safeSupabase = escapeHtml(supabaseDisplay);
          var isCurrent = c.id === getCurrentCompanyId();

          var card = document.createElement("div");
          card.style.cssText = (
            "display:flex;align-items:center;gap:0;border:1px solid " +
            (isCurrent ? "#2c5282" : "#e8e0d5") + ";border-radius:6px;background:" +
            (isCurrent ? "#eef4fb" : "#fff") + ";overflow:hidden;" +
            "transition:box-shadow .15s,border-color .15s;"
          );

          var clickArea = document.createElement("div");
          clickArea.style.cssText = (
            "flex:1;padding:8px 12px;cursor:" + (isCurrent ? "default" : "pointer") + ";" +
            "border-left:3px solid " + (isCurrent ? "#2c5282" : "transparent") + ";" +
            "min-width:0;"
          );
          if (!isCurrent) {
            clickArea.addEventListener("mouseenter", function () {
              clickArea.style.background = "#f0f7ff";
            });
            clickArea.addEventListener("mouseleave", function () {
              clickArea.style.background = "";
            });
          }
          var nameLine = '<div style="display:flex;align-items:center;gap:6px;">' +
            '<strong style="font-size:13px;">' + safeId + '</strong>' +
            (safeName ? '<span style="color:#666;font-size:12px;">' + safeName + '</span>' : '') +
            (isCurrent
              ? '<span style="margin-left:auto;padding:1px 6px;background:#2c5282;color:#fff;border-radius:3px;font-size:10px;line-height:1.4;">✓ 当前</span>'
              : '<span class="switch-hint" style="margin-left:auto;color:#2c5282;font-size:10px;opacity:0;transition:opacity .15s;">切换 →</span>') +
            '</div>';
          var infoLine = '<div style="font-size:10px;color:#999;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">利润率 ' + escapeHtml(pm) + ' · 令牌 ' + safeToken + ' · 数据源: ' + safeSupabase + '</div>';
          clickArea.innerHTML = nameLine + infoLine;
          if (!isCurrent) {
            clickArea.addEventListener("mouseenter", function () {
              var hint = clickArea.querySelector(".switch-hint");
              if (hint) hint.style.opacity = "1";
            });
            clickArea.addEventListener("mouseleave", function () {
              var hint = clickArea.querySelector(".switch-hint");
              if (hint) hint.style.opacity = "0";
            });
            clickArea.onclick = function () { switchToCompany(c.id); };
          }
          card.appendChild(clickArea);

          var actions = document.createElement("div");
          actions.style.cssText = "display:flex;align-items:center;gap:4px;padding:6px 8px;border-left:1px solid #ece5d8;flex-shrink:0;";
          var btnBase = "padding:3px 8px;border:1px solid #ddd;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;white-space:nowrap;line-height:1.4;";
          if (meta.access_token) {
            var copyLinkBtn = document.createElement("button");
            copyLinkBtn.textContent = "复制";
            copyLinkBtn.style.cssText = btnBase + "color:#2c5282;border-color:#2c5282;";
            copyLinkBtn.title = "复制客户访问链接";
            copyLinkBtn.onclick = function (e) {
              e.stopPropagation();
              var link = buildCustomerLink(c.id, meta.access_token);
              navigator.clipboard.writeText(link).then(function () {
                copyLinkBtn.textContent = "✓";
                setTimeout(function () { copyLinkBtn.textContent = "复制"; }, 1200);
              }).catch(function () {
                prompt("请手动复制客户链接：", link);
              });
            };
            actions.appendChild(copyLinkBtn);
          }
          var regenBtn = document.createElement("button");
          regenBtn.textContent = "令牌";
          regenBtn.style.cssText = btnBase + "color:#f39c12;border-color:#f39c12;";
          regenBtn.title = "重置访问令牌";
          regenBtn.onclick = function (e) { e.stopPropagation(); regenerateToken(c.id); };
          actions.appendChild(regenBtn);
          var editDsBtn = document.createElement("button");
          editDsBtn.textContent = "数据源";
          editDsBtn.style.cssText = btnBase + "color:#6c757d;border-color:#6c757d;";
          editDsBtn.title = "编辑 Supabase 数据源地址";
          editDsBtn.onclick = function (e) { e.stopPropagation(); editCompanyDatasource(c.id, meta); };
          actions.appendChild(editDsBtn);
          if (c.id !== "default" && !isCurrent) {
            var delBtn = document.createElement("button");
            delBtn.textContent = "删除";
            delBtn.style.cssText = btnBase + "color:#e74c3c;border-color:#e74c3c;";
            delBtn.onclick = function (e) { e.stopPropagation(); deleteCompany(c.id); };
            actions.appendChild(delBtn);
          }
          card.appendChild(actions);

          list.appendChild(card);
        });
      }
    }
  } catch (err) {
    setStatus("加载公司列表失败: " + err.message, true);
  }
}

// 构建客户访问链接（统一格式：/apps/index.html#company_id=xxx&token=yyy）
function buildCustomerLink(companyId, token) {
  var base = location.origin + "/apps/index.html";
  var params = "company_id=" + encodeURIComponent(companyId) + "&token=" + encodeURIComponent(token);
  return base + "#" + params;
}

async function editCompanyDatasource(companyId, currentMeta) {
  var currentUrl = (currentMeta.supabase_base_url || "").trim();
  var input = prompt(
    "为「" + companyId + "」设置 Supabase 数据源地址：\n\n" +
    "留空 = 使用全局默认地址（.env 中的 SQ_SUPABASE_BASE_URL）\n" +
    "填写 = 该公司使用独立的远程地址\n\n" +
    "当前值：" + (currentUrl || "（未设置，用全局默认）"),
    currentUrl
  );
  if (input === null) return;
  var newUrl = input.trim();
  var newMeta = Object.assign({}, currentMeta);
  if (newUrl) {
    newMeta.supabase_base_url = newUrl;
  } else {
    delete newMeta.supabase_base_url;
  }
  try {
    await request("/api/companies/" + encodeURIComponent(companyId), {
      method: "PATCH",
      body: JSON.stringify({ meta: newMeta }),
    });
    setStatus("「" + companyId + "」数据源已更新" + (newUrl ? "为独立地址" : "为全局默认"));
    await loadCompanies();
    if (companyId === getCurrentCompanyId()) {
      run(loadConfigFromBackend);
    }
  } catch (err) {
    setStatus("更新数据源失败: " + err.message, true);
  }
}

async function createCompany() {
  var id = document.getElementById("newCompanyId").value.trim();
  var name = document.getElementById("newCompanyName").value.trim();
  var profitMargin = parseFloat(document.getElementById("newCompanyProfitMargin").value) || 0;
  var supabaseUrl = (document.getElementById("newCompanySupabaseUrl").value || "").trim();
  if (!id) { setStatus("请输入公司ID", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) { setStatus("公司ID只能用英文/数字/下划线/连字符", true); return; }
  var meta = { profit_margin: profitMargin };
  if (supabaseUrl) meta.supabase_base_url = supabaseUrl;
  try {
    await request("/api/companies", {
      method: "POST",
      body: JSON.stringify({ id: id, name: name, meta: meta }),
    });
    setStatus("公司 " + id + " 创建成功（利润率 " + profitMargin + "%" + (supabaseUrl ? "，已绑定独立数据源" : "") + "）");
    document.getElementById("newCompanyId").value = "";
    document.getElementById("newCompanyName").value = "";
    document.getElementById("newCompanySupabaseUrl").value = "";
    await loadCompanies();
    setCurrentCompanyId(id);
    document.getElementById("companySelect").value = id;
    run(loadConfigFromBackend);
  } catch (err) {
    setStatus("创建失败: " + err.message, true);
  }
}

async function deleteCompany(id) {
  if (!confirm("确认删除公司 " + id + "？\n该公司的配置和数据都会被删除！")) return;
  try {
    await request("/api/companies/" + encodeURIComponent(id), { method: "DELETE" });
    setStatus("公司 " + id + " 已删除");
    if (getCurrentCompanyId() === id) {
      setCurrentCompanyId("default");
    }
    await loadCompanies();
  } catch (err) {
    setStatus("删除失败: " + err.message, true);
  }
}

async function regenerateToken(id) {
  if (!confirm("确认重新生成公司 " + id + " 的访问令牌？\n\n旧令牌将立即失效，使用旧令牌的客户将无法访问系统。\n新令牌生成后请通过安全渠道分享给客户。")) return;
  try {
    var result = await request("/api/companies/" + encodeURIComponent(id) + "/regenerate-token", { method: "POST" });
    var accessUrl = buildCustomerLink(id, result.access_token);
    var copied = false;
    try {
      await navigator.clipboard.writeText(accessUrl);
      copied = true;
    } catch (e) { }
    var msg = "公司 " + id + " 的访问令牌已重新生成。";
    if (copied) {
      msg += "\n\n客户访问链接已复制到剪贴板，请粘贴到安全渠道发送给客户。";
    } else {
      msg += "\n\n请点击「复制客户链接」按钮获取客户访问链接。";
    }
    alert(msg);
    setStatus("令牌已重新生成" + (copied ? "，客户链接已复制到剪贴板" : ""));
    await loadCompanies();
  } catch (err) {
    setStatus("重置令牌失败: " + err.message, true);
  }
}

function switchCompany() {
  var sel = document.getElementById("companySelect");
  if (sel) {
    setCurrentCompanyId(sel.value);
    setStatus("已切换到公司: " + getCurrentCompanyId());
    run(loadConfigFromBackend);
    run(loadCompanies);
  }
}

function switchToCompany(companyId) {
  if (companyId === getCurrentCompanyId()) return;
  setCurrentCompanyId(companyId);
  var sel = document.getElementById("companySelect");
  if (sel) sel.value = companyId;
  run(loadConfigFromBackend);
  run(loadCompanies);
  var name = "";
  var sel2 = document.getElementById("companySelect");
  if (sel2) {
    var opt = sel2.options[sel2.selectedIndex];
    if (opt) name = opt.textContent;
  }
  setStatus("已切换到「" + (name || companyId) + "」，下方配置将应用到该公司");
  var fieldsSection = document.getElementById("fields");
  if (fieldsSection) {
    setTimeout(function () { fieldsSection.scrollIntoView({ behavior: "smooth", block: "start" }); }, 200);
  }
}
