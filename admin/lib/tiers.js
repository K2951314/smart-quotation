/**
 * tiers.js — 利润率分组（Tier）管理 + 拖拽分配公司到分组。
 *
 * 设计（配合树形公司结构）：
 * - 每个主公司拥有独立的 tier 定义（存储在 admin meta.tiers 中）
 * - 客户公司通过 meta.tier + meta.parent_company_id 继承 parent 的配置/数据
 * - 利润率解析链：tier → meta.profit_margin → 默认 10
 * - 拖拽：客户公司卡片可拖到任意 Tier 卡片上完成分配
 *
 * 依赖：admin-core.js（request、setStatus、escapeHtml、getCurrentCompanyId、run）
 *       companies.js（loadCompanies，拖拽后刷新公司列表）
 */

// ─── Tier 渲染：为指定管理员渲染 tier 管理面板 ───────────

/**
 * 在指定容器内为管理员渲染 Tier 管理面板。
 * @param {HTMLElement} container - 容器 DOM 节点
 * @param {string} adminId - 主公司 ID
 */
function renderTierManagerForAdmin(container, adminId) {
  if (!container) return;

  // 功能门控：tier_profit_grouping 是 team 档位功能，低档位显示升级提示
  if (window.hasFeature && !window.hasFeature("tier_profit_grouping")) {
    container.innerHTML = '<div style="padding:10px;border:1px dashed #ddd;border-radius:5px;text-align:center;color:#bbb;font-size:11px;background:#fff;">' +
      '🔒 利润率分组是专业版功能。<br>升级后可创建分组并为客户公司分配不同利润率。</div>';
    return;
  }

  var tiers = (g_TiersCache && g_TiersCache[adminId]) || [];

  var header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
    '<strong style="font-size:12px;color:#666;">利润率分组（Tier）</strong>' +
    '<button type="button" data-admin-id="' + escapeHtml(adminId) + '" class="tier-add-btn" ' +
    'style="padding:2px 8px;font-size:11px;border:1px solid #38a169;background:#fff;color:#38a169;border-radius:3px;cursor:pointer;">＋ 添加分组</button>' +
    '</div>';

  var hint = '<p style="font-size:10px;color:#999;margin-bottom:6px;">' +
    '将客户公司拖到下方分组上即可分配利润率级别。无分组的客户公司使用默认利润率。</p>';

  if (tiers.length === 0) {
    container.innerHTML = header + hint +
      '<div style="padding:10px;border:1px dashed #ddd;border-radius:5px;text-align:center;color:#bbb;font-size:11px;background:#fff;">' +
      '暂无利润率分组。客户公司使用默认利润率（10%）。<br>点击「添加分组」创建级别（如 A级 5%、B级 10%）。</div>';
  } else {
    var cards = tiers.map(function (tier, idx) {
      var name = escapeHtml(tier.name || "");
      var margin = Number(tier.profit_margin || 0);
      var color = tier.color || _tierDefaultColor(idx);
      var safeColor = escapeHtml(color);
      return '<div class="tier-card" data-tier-name="' + name + '" data-tier-color="' + safeColor + '" data-admin-id="' + escapeHtml(adminId) + '" style="' +
        'border:2px dashed ' + safeColor + ';' +
        'border-radius:5px;padding:6px 10px;margin-bottom:5px;' +
        'background:' + safeColor + '15;' +
        'transition:background .15s,border-color .15s;"' +
        ' ondragover="tierDragOver(event, this)"' +
        ' ondragleave="tierDragLeave(event, this)"' +
        ' ondrop="tierDrop(event, this)">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + safeColor + ';flex-shrink:0;"></span>' +
        '<strong style="font-size:11px;">' + name + '</strong>' +
        '<span style="font-size:10px;color:#666;">利润率 ' + margin + '%</span>' +
        '<button type="button" data-tier-edit-admin="' + escapeHtml(adminId) + '" data-tier-edit-idx="' + idx + '" style="margin-left:auto;padding:1px 5px;font-size:10px;border:1px solid #ddd;background:#fff;border-radius:2px;cursor:pointer;">改</button>' +
        '<button type="button" data-tier-delete-admin="' + escapeHtml(adminId) + '" data-tier-delete-idx="' + idx + '" style="padding:1px 5px;font-size:10px;border:1px solid #e74c3c;color:#e74c3c;background:#fff;border-radius:2px;cursor:pointer;">删</button>' +
        '</div>' +
        '<div class="tier-drop-hint" style="font-size:10px;color:#aaa;margin-top:3px;display:none;">← 拖客户公司到此处分配</div>' +
        '</div>';
    }).join("");

    // 未分组区域
    var ungrouped = '<div class="tier-card" data-tier-name="" data-tier-color="#ccc" data-admin-id="' + escapeHtml(adminId) + '" style="' +
      'border:2px dashed #ccc;border-radius:5px;padding:6px 10px;background:#fafafa;' +
      'transition:background .15s,border-color .15s;"' +
      ' ondragover="tierDragOver(event, this)"' +
      ' ondragleave="tierDragLeave(event, this)"' +
      ' ondrop="tierDrop(event, this)">' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
      '<strong style="font-size:11px;color:#999;">未分组</strong>' +
      '<span style="font-size:10px;color:#bbb;">使用默认利润率</span>' +
      '</div>' +
      '<div class="tier-drop-hint" style="font-size:10px;color:#aaa;margin-top:3px;display:none;">← 拖到此处移除分组</div>' +
      '</div>';

    container.innerHTML = header + hint + cards + ungrouped;
  }

  // 绑定「添加分组」按钮
  var addBtn = container.querySelector(".tier-add-btn");
  if (addBtn) {
    addBtn.onclick = function () { addTier(adminId); };
  }
}

// ─── 兼容旧接口：全局 tier 管理器渲染 ───────────────────
// 如果页面有全局 #tierManager 容器，渲染当前公司的 tier 管理
function loadTiers() {
  // 预加载已在 loadCompanies 中完成，此处仅触发渲染（如果存在全局容器）
  var globalContainer = document.getElementById("tierManager");
  if (globalContainer) {
    var cid = getCurrentCompanyId();
    // 解析当前公司所属的管理员
    var adminId = cid;
    var current = g_Companies.find(function (c) { return c.id === cid; });
    if (current) {
      var meta = current.meta || {};
      if (meta.parent_company_id) {
        adminId = meta.parent_company_id;
      }
    }
    renderTierManagerForAdmin(globalContainer, adminId);
  }
}

// ─── Tier CRUD（按管理员 ID 操作）────────────────────────

function addTier(adminId) {
  var name = prompt("分组名称（如：A级、VIP、零售）");
  if (!name || !name.trim()) return;
  name = name.trim();
  var tiers = (g_TiersCache[adminId] || []).slice();
  if (tiers.some(function (t) { return t.name === name; })) {
    setStatus("分组「" + name + "」已存在", true);
    return;
  }
  var marginStr = prompt("利润率（%，0-100）", "10");
  if (marginStr === null) return;
  var margin = parseFloat(marginStr);
  if (isNaN(margin) || margin < 0 || margin > 100) {
    setStatus("利润率必须在 0-100 之间", true);
    return;
  }
  tiers.push({ name: name, profit_margin: margin, color: _tierDefaultColor(tiers.length) });
  saveTiersForAdmin(adminId, tiers);
}

function editTier(adminId, idx) {
  var tiers = (g_TiersCache[adminId] || []).slice();
  if (idx < 0 || idx >= tiers.length) return;
  var tier = tiers[idx];
  var marginStr = prompt("修改「" + tier.name + "」的利润率（%）", String(tier.profit_margin));
  if (marginStr === null) return;
  var margin = parseFloat(marginStr);
  if (isNaN(margin) || margin < 0 || margin > 100) {
    setStatus("利润率必须在 0-100 之间", true);
    return;
  }
  tiers[idx].profit_margin = margin;
  saveTiersForAdmin(adminId, tiers);
}

function deleteTier(adminId, idx) {
  var tiers = (g_TiersCache[adminId] || []).slice();
  if (idx < 0 || idx >= tiers.length) return;
  var tier = tiers[idx];
  if (!confirm("确认删除分组「" + tier.name + "」？\n该分组下的客户公司将回退到默认利润率。")) return;
  tiers.splice(idx, 1);
  saveTiersForAdmin(adminId, tiers);
}

async function saveTiersForAdmin(adminId, tiers) {
  try {
    var data = await request("/api/tiers?company_id=" + encodeURIComponent(adminId), {
      method: "PUT",
      body: JSON.stringify({ tiers: tiers }),
    });
    g_TiersCache[adminId] = data.tiers || tiers;
    setStatus("利润率分组已保存（管理员: " + adminId + "）");
    if (typeof loadCompanies === "function") loadCompanies();
  } catch (err) {
    setStatus("保存利润率分组失败: " + err.message, true);
    if (typeof loadCompanies === "function") loadCompanies();
  }
}

// ─── 拖拽：客户公司 → Tier ──────────────────────────────

function companyDragStart(event, companyId) {
  event.dataTransfer.setData("text/plain", companyId);
  event.dataTransfer.effectAllowed = "move";
  var card = event.currentTarget;
  card.style.opacity = "0.5";
}

function companyDragEnd(event) {
  var card = event.currentTarget;
  if (card) card.style.opacity = "";
}

function tierDragOver(event, tierCard) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  var color = tierCard.getAttribute("data-tier-color") || "#2c5282";
  var hasTier = Boolean(tierCard.getAttribute("data-tier-name"));
  tierCard.style.background = hasTier ? color + "30" : "#eef4fb";
  tierCard.style.borderColor = color;
  var hint = tierCard.querySelector(".tier-drop-hint");
  if (hint) hint.style.display = "block";
}

function tierDragLeave(event, tierCard) {
  var color = tierCard.getAttribute("data-tier-color") || "#ccc";
  var hasTier = Boolean(tierCard.getAttribute("data-tier-name"));
  tierCard.style.background = hasTier ? color + "15" : "#fafafa";
  tierCard.style.borderColor = color;
  var hint = tierCard.querySelector(".tier-drop-hint");
  if (hint) hint.style.display = "none";
}

async function tierDrop(event, tierCard) {
  event.preventDefault();
  var companyId = event.dataTransfer.getData("text/plain");
  var tierName = tierCard.getAttribute("data-tier-name") || "";
  var adminId = tierCard.getAttribute("data-admin-id") || "";
  if (!companyId || companyId === "default") return;
  tierDragLeave(event, tierCard);
  await assignTier(companyId, tierName, adminId);
}

async function assignTier(companyId, tierName, adminId) {
  // 如果未传 adminId，尝试从公司信息推断
  if (!adminId) {
    var company = g_Companies.find(function (c) { return c.id === companyId; });
    if (company && (company.meta || {}).parent_company_id) {
      adminId = company.meta.parent_company_id;
    }
  }
  try {
    await request("/api/companies/" + encodeURIComponent(companyId) + "/assign-tier", {
      method: "POST",
      body: JSON.stringify({
        tier: tierName || null,
        parent_company_id: adminId || null,
      }),
    });
    setStatus("「" + companyId + "」" + (tierName ? "已分配到「" + tierName + "」" : "已移除分组"));
    if (typeof loadCompanies === "function") loadCompanies();
  } catch (err) {
    setStatus("分配失败: " + err.message, true);
  }
}

// ─── 辅助：获取公司 tier 徽标 HTML（供 companies.js 调用）──

function getTierBadgeHTML(companyMeta) {
  if (!companyMeta) return "";
  var tierName = companyMeta.tier;
  if (!tierName) return "";
  // 查找 parent 的 tiers
  var parentId = companyMeta.parent_company_id || "";
  var tiers = (g_TiersCache && g_TiersCache[parentId]) || [];
  var tier = tiers.find(function (t) { return t.name === tierName; });
  var color = tier ? (tier.color || "#2c5282") : "#2c5282";
  var margin = tier ? tier.profit_margin : "?";
  return '<span style="padding:1px 6px;background:' + escapeHtml(color) + ';color:#fff;border-radius:3px;font-size:10px;line-height:1.4;">' +
    escapeHtml(tierName) + " " + margin + "%</span>";
}

function getTierProfitMargin(companyMeta) {
  if (!companyMeta) return null;
  var tierName = companyMeta.tier;
  if (!tierName) return null;
  var parentId = companyMeta.parent_company_id || "";
  var tiers = (g_TiersCache && g_TiersCache[parentId]) || [];
  var tier = tiers.find(function (t) { return t.name === tierName; });
  return tier ? tier.profit_margin : null;
}

// ─── 默认颜色调色板 ─────────────────────────────────────

function _tierDefaultColor(idx) {
  var palette = ["#2c5282", "#38a169", "#d69e2e", "#9b59b6", "#e74c3c", "#1abc9c"];
  return palette[idx % palette.length];
}
