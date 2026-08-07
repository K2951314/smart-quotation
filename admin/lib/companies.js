/**
 * companies.js — 公司管理 UI：树形列表渲染、创建管理员/成员、删除、令牌重置。
 *
 * 树形结构设计（从第一性原理出发）：
 * - 数据源管理员（is_admin=true, 无 parent）→ 拥有独立 config/data/折扣/tiers
 * - 成员公司（有 parent_company_id）→ 继承管理员配置，通过 tier 获取利润率
 * - 独立公司（default 等，无 parent 非 admin）→ 向后兼容
 *
 * 依赖：admin-core.js（request、setStatus、escapeHtml、getCurrentCompanyId、setCurrentCompanyId、run）
 *       tiers.js（renderTierManagerForAdmin、getTierBadgeHTML、getTierProfitMargin、companyDragStart 等）
 */

// ─── 全局缓存 ─────────────────────────────────────────────

var g_Companies = [];        // 所有公司列表
var g_TiersCache = {};       // { adminId: [tier, ...] }  各管理员的 tier 定义
var g_ExpandedAdmins = {};   // { adminId: true/false }  管理员卡片展开状态

// ─── 加载公司列表 + 预加载 tiers ─────────────────────────

async function loadCompanies() {
  if (!isAdminAuthenticated()) return;
  try {
    g_Companies = await request("/api/companies");
    await preloadTiers();
    renderCompanyTree();
    // 同步顶部公司选择下拉框
    syncCompanySelect();
  } catch (err) {
    setStatus("加载公司列表失败: " + err.message, true);
  }
}

async function preloadTiers() {
  g_TiersCache = {};
  var admins = g_Companies.filter(function (c) {
    var meta = c.meta || {};
    return meta.is_admin && !meta.parent_company_id;
  });
  var promises = admins.map(function (admin) {
    return request("/api/tiers?company_id=" + encodeURIComponent(admin.id))
      .then(function (data) { g_TiersCache[admin.id] = data.tiers || []; })
      .catch(function () { g_TiersCache[admin.id] = []; });
  });
  await Promise.all(promises);
}

function syncCompanySelect() {
  var sel = document.getElementById("companySelect");
  if (!sel) return;
  var currentId = getCurrentCompanyId();
  sel.innerHTML = "";
  g_Companies.forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c.id;
    var meta = c.meta || {};
    var prefix = "";
    if (meta.is_admin) prefix = "[管理员] ";
    else if (meta.parent_company_id) prefix = "  └ ";
    opt.textContent = prefix + c.id + (c.name ? "（" + c.name + "）" : "");
    if (c.id === currentId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── 渲染树形公司列表 ───────────────────────────────────

function renderCompanyTree() {
  var list = document.getElementById("companyList");
  if (!list) return;
  list.innerHTML = "";

  if (g_Companies.length === 0) {
    list.innerHTML = '<p style="color:#999;font-size:13px;">暂无公司。请在左侧创建第一个数据源管理员。</p>';
    return;
  }

  // 分类：管理员 / 成员 / 独立公司
  var admins = [];
  var members = [];
  var standalone = [];

  g_Companies.forEach(function (c) {
    var meta = c.meta || {};
    if (meta.parent_company_id) {
      members.push(c);
    } else if (meta.is_admin) {
      admins.push(c);
    } else {
      standalone.push(c);
    }
  });

  if (admins.length === 0 && standalone.length <= 1) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:#999;font-size:12px;border:1px dashed #ddd;border-radius:6px;">' +
      '暂无数据源管理员。<br>请在左侧创建第一个管理员，然后在其卡片上添加成员公司。</div>';
    // 仍然渲染独立公司
    standalone.forEach(function (c) { list.appendChild(renderStandaloneCard(c)); });
    return;
  }

  // 渲染管理员卡片
  admins.forEach(function (admin) {
    var adminMembers = members.filter(function (m) {
      return (m.meta || {}).parent_company_id === admin.id;
    });
    list.appendChild(renderAdminCard(admin, adminMembers));
  });

  // 渲染独立公司区块
  if (standalone.length > 0) {
    var divider = document.createElement("div");
    divider.style.cssText = "margin:16px 0 8px;padding:6px 10px;border-top:1px solid #e8e0d5;font-size:11px;color:#999;";
    divider.textContent = "独立公司（无管理员，向后兼容）";
    list.appendChild(divider);
    standalone.forEach(function (c) {
      list.appendChild(renderStandaloneCard(c));
    });
  }
}

// ─── 渲染管理员卡片 ─────────────────────────────────────

function renderAdminCard(admin, members) {
  var meta = admin.meta || {};
  var tiers = g_TiersCache[admin.id] || [];
  var isExpanded = g_ExpandedAdmins[admin.id] !== false; // 默认展开
  var isCurrent = admin.id === getCurrentCompanyId();
  var safeId = escapeHtml(admin.id);
  var safeName = admin.name ? escapeHtml(admin.name) : "";
  var tokenDisplay = meta.access_token ? meta.access_token.substring(0, 8) + "..." : "未生成";
  var safeToken = escapeHtml(tokenDisplay);
  var memberCount = members.length;

  var wrapper = document.createElement("div");
  wrapper.style.cssText = (
    "border:1px solid " + (isCurrent ? "#2c5282" : "#d4c5a9") + ";" +
    "border-radius:8px;background:#fff;overflow:hidden;margin-bottom:12px;" +
    "box-shadow:0 1px 3px rgba(0,0,0,0.04);"
  );

  // ── 管理员头部 ──
  var header = document.createElement("div");
  header.style.cssText = (
    "display:flex;align-items:center;gap:0;background:" + (isCurrent ? "#eef4fb" : "#fdfbf7") + ";" +
    "border-bottom:1px solid #ece5d8;"
  );

  // 展开按钮
  var toggleBtn = document.createElement("div");
  toggleBtn.style.cssText = "padding:10px 8px;cursor:pointer;font-size:14px;color:#666;flex-shrink:0;";
  toggleBtn.textContent = isExpanded ? "▼" : "▶";
  toggleBtn.onclick = function () {
    g_ExpandedAdmins[admin.id] = !isExpanded;
    renderCompanyTree();
  };
  header.appendChild(toggleBtn);

  // 主信息区（可点击切换）
  var infoArea = document.createElement("div");
  infoArea.style.cssText = (
    "flex:1;padding:10px 4px;cursor:" + (isCurrent ? "default" : "pointer") + ";min-width:0;"
  );
  if (!isCurrent) {
    infoArea.onmouseenter = function () { infoArea.style.background = "rgba(44,82,130,0.05)"; };
    infoArea.onmouseleave = function () { infoArea.style.background = ""; };
  }
  infoArea.onclick = function () { if (!isCurrent) switchToCompany(admin.id); };

  var nameLine = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
    '<span style="font-size:14px;">🏢</span>' +
    '<strong style="font-size:14px;color:#2c5282;">' + safeId + '</strong>' +
    (safeName ? '<span style="color:#666;font-size:12px;">' + safeName + '</span>' : '') +
    '<span style="padding:2px 8px;background:#8e44ad;color:#fff;border-radius:3px;font-size:10px;">数据源管理员</span>' +
    (isCurrent ? '<span style="padding:2px 6px;background:#2c5282;color:#fff;border-radius:3px;font-size:10px;">✓ 当前</span>' : '') +
    '</div>';
  var infoLine = '<div style="font-size:10px;color:#999;margin-top:3px;">' +
    '成员: ' + memberCount + ' 家 · 利润率分组: ' + tiers.length + ' 个 · 令牌: ' + safeToken +
    '</div>';
  infoArea.innerHTML = nameLine + infoLine;
  header.appendChild(infoArea);

  // 操作按钮区
  var actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:4px;padding:6px 8px;flex-shrink:0;flex-wrap:wrap;";
  // 功能门控：成员公司创建是 admin_member_inheritance 功能（pro/team）
  if (window.hasFeature && window.hasFeature("admin_member_inheritance")) {
    actions.appendChild(makeActionBtn("添加成员", "#38a169", "在该管理员下创建成员公司（继承配置/数据）", function (e) {
      e.stopPropagation();
      showAddMemberForm(admin.id);
    }));
  }
  if (meta.access_token) {
    actions.appendChild(makeActionBtn("复制", "#2c5282", "复制客户访问链接", function (e) {
      e.stopPropagation();
      copyCustomerLink(admin.id, meta.access_token);
    }));
  }
  actions.appendChild(makeActionBtn("令牌", "#f39c12", "重置访问令牌", function (e) {
    e.stopPropagation();
    regenerateToken(admin.id);
  }));
  actions.appendChild(makeActionBtn("数据源", "#6c757d", "编辑 Supabase 数据源地址", function (e) {
    e.stopPropagation();
    editCompanyDatasource(admin.id, meta);
  }));
  if (admin.id !== "default") {
    actions.appendChild(makeActionBtn("删除", "#e74c3c", "删除管理员及其所有成员", function (e) {
      e.stopPropagation();
      deleteAdminCompany(admin.id);
    }));
  }
  header.appendChild(actions);
  wrapper.appendChild(header);

  // ── 展开内容：Tier 管理 + 成员列表 ──
  if (isExpanded) {
    // Tier 管理面板
    var tierSection = document.createElement("div");
    tierSection.style.cssText = "padding:10px 12px;border-bottom:1px solid #ece5d8;background:#faf8f3;";
    var tierContainer = document.createElement("div");
    tierSection.appendChild(tierContainer);
    wrapper.appendChild(tierSection);
    // 延迟渲染 tier 管理器（确保 DOM 已挂载）
    setTimeout(function () {
      if (typeof renderTierManagerForAdmin === "function") {
        renderTierManagerForAdmin(tierContainer, admin.id);
      }
    }, 0);

    // 成员列表
    var memberSection = document.createElement("div");
    memberSection.style.cssText = "padding:8px 12px;";
    var memberTitle = document.createElement("div");
    memberTitle.style.cssText = "font-size:12px;font-weight:600;color:#666;margin-bottom:6px;";
    memberTitle.textContent = "成员公司（" + memberCount + " 家）";
    memberSection.appendChild(memberTitle);

    if (members.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "padding:12px;text-align:center;color:#bbb;font-size:11px;border:1px dashed #eee;border-radius:4px;";
      empty.textContent = "暂无成员公司。点击上方「添加成员」创建。";
      memberSection.appendChild(empty);
    } else {
      members.forEach(function (m) {
        memberSection.appendChild(renderMemberRow(m, admin.id));
      });
    }
    wrapper.appendChild(memberSection);
  }

  return wrapper;
}

// ─── 渲染成员公司行 ─────────────────────────────────────

function renderMemberRow(member, adminId) {
  var meta = member.meta || {};
  var tiers = g_TiersCache[adminId] || [];
  var isCurrent = member.id === getCurrentCompanyId();
  var safeId = escapeHtml(member.id);
  var safeName = member.name ? escapeHtml(member.name) : "";

  // 获取 tier 徽标
  var tierBadge = "";
  var tierMargin = null;
  if (meta.tier) {
    var tier = tiers.find(function (t) { return t.name === meta.tier; });
    if (tier) {
      var color = tier.color || "#2c5282";
      tierBadge = '<span style="padding:1px 6px;background:' + escapeHtml(color) + ';color:#fff;border-radius:3px;font-size:10px;">' +
        escapeHtml(meta.tier) + " " + tier.profit_margin + "%</span>";
      tierMargin = tier.profit_margin;
    } else {
      tierBadge = '<span style="padding:1px 6px;background:#ccc;color:#fff;border-radius:3px;font-size:10px;">' +
        escapeHtml(meta.tier) + " (未定义)</span>";
    }
  }
  var pmDisplay = tierMargin !== null ? tierMargin + "%" : (meta.profit_margin !== undefined ? meta.profit_margin + "%" : "继承默认");
  var tokenDisplay = meta.access_token ? meta.access_token.substring(0, 8) + "..." : "未生成";

  var row = document.createElement("div");
  row.style.cssText = (
    "display:flex;align-items:center;gap:0;margin:4px 0;border:1px solid " +
    (isCurrent ? "#2c5282" : "#e8e0d5") + ";border-radius:5px;background:" +
    (isCurrent ? "#eef4fb" : "#fff") + ";overflow:hidden;"
  );

  // 拖拽手柄 + 缩进
  var dragHandle = document.createElement("div");
  dragHandle.style.cssText = "padding:6px 8px;cursor:grab;color:#bbb;font-size:12px;flex-shrink:0;";
  dragHandle.textContent = "⠿";
  dragHandle.title = "拖到上方利润率分组上可切换级别";
  if (typeof companyDragStart === "function") {
    row.draggable = true;
    row.ondragstart = function (e) { companyDragStart(e, member.id); };
    row.ondragend = function (e) { companyDragEnd(e); };
  }
  row.appendChild(dragHandle);

  // 主信息（可点击切换）
  var infoArea = document.createElement("div");
  infoArea.style.cssText = (
    "flex:1;padding:6px 10px;cursor:" + (isCurrent ? "default" : "pointer") + ";min-width:0;" +
    "border-left:3px solid " + (isCurrent ? "#2c5282" : "transparent") + ";"
  );
  if (!isCurrent) {
    infoArea.onmouseenter = function () { infoArea.style.background = "#f0f7ff"; };
    infoArea.onmouseleave = function () { infoArea.style.background = ""; };
  }
  infoArea.onclick = function () { if (!isCurrent) switchToCompany(member.id); };

  var nameLine = '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">' +
    '<span style="font-size:10px;color:#bbb;">└</span>' +
    '<strong style="font-size:12px;">' + safeId + '</strong>' +
    (safeName ? '<span style="color:#999;font-size:11px;">' + safeName + '</span>' : '') +
    tierBadge +
    (isCurrent ? '<span style="padding:1px 5px;background:#2c5282;color:#fff;border-radius:2px;font-size:9px;">✓ 当前</span>' : '') +
    '</div>';
  var infoLine = '<div style="font-size:10px;color:#aaa;margin-top:2px;">' +
    '利润率: ' + escapeHtml(pmDisplay) + ' · 令牌: ' + escapeHtml(tokenDisplay) +
    '</div>';
  infoArea.innerHTML = nameLine + infoLine;
  row.appendChild(infoArea);

  // 操作按钮
  var actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:3px;padding:4px 6px;flex-shrink:0;";
  if (meta.access_token) {
    actions.appendChild(makeActionBtn("复制", "#2c5282", "复制客户访问链接", function (e) {
      e.stopPropagation();
      copyCustomerLink(member.id, meta.access_token);
    }));
  }
  actions.appendChild(makeActionBtn("令牌", "#f39c12", "重置访问令牌", function (e) {
    e.stopPropagation();
    regenerateToken(member.id);
  }));
  actions.appendChild(makeActionBtn("删除", "#e74c3c", "删除成员公司", function (e) {
    e.stopPropagation();
    deleteCompany(member.id);
  }));
  row.appendChild(actions);

  return row;
}

// ─── 渲染独立公司卡片 ───────────────────────────────────

function renderStandaloneCard(company) {
  var meta = company.meta || {};
  var isCurrent = company.id === getCurrentCompanyId();
  var safeId = escapeHtml(company.id);
  var safeName = company.name ? escapeHtml(company.name) : "";
  var tokenDisplay = meta.access_token ? meta.access_token.substring(0, 8) + "..." : "未生成";

  var card = document.createElement("div");
  card.style.cssText = (
    "display:flex;align-items:center;gap:0;border:1px solid " +
    (isCurrent ? "#2c5282" : "#e8e0d5") + ";border-radius:6px;background:" +
    (isCurrent ? "#eef4fb" : "#fff") + ";overflow:hidden;margin-bottom:6px;"
  );

  var infoArea = document.createElement("div");
  infoArea.style.cssText = (
    "flex:1;padding:8px 12px;cursor:" + (isCurrent ? "default" : "pointer") + ";min-width:0;" +
    "border-left:3px solid " + (isCurrent ? "#2c5282" : "transparent") + ";"
  );
  if (!isCurrent) {
    infoArea.onmouseenter = function () { infoArea.style.background = "#f0f7ff"; };
    infoArea.onmouseleave = function () { infoArea.style.background = ""; };
  }
  infoArea.onclick = function () { if (!isCurrent) switchToCompany(company.id); };

  var nameLine = '<div style="display:flex;align-items:center;gap:6px;">' +
    '<strong style="font-size:13px;">' + safeId + '</strong>' +
    (safeName ? '<span style="color:#666;font-size:12px;">' + safeName + '</span>' : '') +
    '<span style="padding:1px 5px;background:#aaa;color:#fff;border-radius:2px;font-size:10px;">独立</span>' +
    (isCurrent ? '<span style="padding:1px 5px;background:#2c5282;color:#fff;border-radius:2px;font-size:10px;">✓ 当前</span>' : '') +
    '</div>';
  var infoLine = '<div style="font-size:10px;color:#999;margin-top:2px;">令牌: ' + escapeHtml(tokenDisplay) + '</div>';
  infoArea.innerHTML = nameLine + infoLine;
  card.appendChild(infoArea);

  var actions = document.createElement("div");
  actions.style.cssText = "display:flex;align-items:center;gap:4px;padding:6px 8px;flex-shrink:0;";
  if (meta.access_token) {
    actions.appendChild(makeActionBtn("复制", "#2c5282", "复制客户访问链接", function (e) {
      e.stopPropagation();
      copyCustomerLink(company.id, meta.access_token);
    }));
  }
  actions.appendChild(makeActionBtn("令牌", "#f39c12", "重置访问令牌", function (e) {
    e.stopPropagation();
    regenerateToken(company.id);
  }));
  if (company.id !== "default") {
    // 允许将独立公司升级为管理员
    actions.appendChild(makeActionBtn("升级为管理员", "#8e44ad", "将此独立公司升级为数据源管理员", function (e) {
      e.stopPropagation();
      upgradeToAdmin(company.id, meta);
    }));
    actions.appendChild(makeActionBtn("删除", "#e74c3c", "删除公司", function (e) {
      e.stopPropagation();
      deleteCompany(company.id);
    }));
  }
  card.appendChild(actions);

  return card;
}

// ─── 辅助：创建操作按钮 ─────────────────────────────────

function makeActionBtn(text, color, title, onclick) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = text;
  btn.title = title;
  btn.style.cssText = (
    "padding:3px 8px;border:1px solid " + color + ";border-radius:3px;" +
    "background:#fff;color:" + color + ";cursor:pointer;font-size:11px;" +
    "white-space:nowrap;line-height:1.4;"
  );
  btn.onmouseenter = function () { btn.style.background = color; btn.style.color = "#fff"; };
  btn.onmouseleave = function () { btn.style.background = "#fff"; btn.style.color = color; };
  btn.onclick = onclick;
  return btn;
}

// ─── 添加成员公司表单 ───────────────────────────────────

function showAddMemberForm(adminId) {
  var member = prompt(
    "在管理员「" + adminId + "」下创建成员公司\n\n" +
    "请输入成员公司 ID（英文/数字，如 client01）：\n" +
    "（成员公司将自动继承管理员的配置/数据/折扣）"
  );
  if (member === null) return;
  var memberId = member.trim();
  if (!memberId) { setStatus("成员公司ID不能为空", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(memberId)) { setStatus("公司ID只能用英文/数字/下划线/连字符", true); return; }
  if (memberId === "default") { setStatus("default 是系统保留ID", true); return; }
  if (g_Companies.some(function (c) { return c.id === memberId; })) {
    setStatus("公司ID「" + memberId + "」已存在", true);
    return;
  }

  var memberName = prompt("成员公司名称（可选，如 客户A）：", "");
  if (memberName === null) return;

  // 选择初始 Tier（可选）
  var tiers = g_TiersCache[adminId] || [];
  var tierPrompt = "选择初始利润率分组（可选，留空=不分配）\n\n可用分组：\n";
  if (tiers.length === 0) {
    tierPrompt += "（暂无分组，创建后可在管理员卡片中定义）";
  } else {
    tiers.forEach(function (t, i) {
      tierPrompt += "  " + (i + 1) + ". " + t.name + "（利润率 " + t.profit_margin + "%）\n";
    });
    tierPrompt += "\n输入分组名称（如 " + tiers[0].name + "），或留空跳过：";
  }
  var tierName = prompt(tierPrompt, "");
  if (tierName === null) return;
  tierName = tierName.trim();
  if (tierName && tiers.length > 0 && !tiers.some(function (t) { return t.name === tierName; })) {
    if (!confirm("分组「" + tierName + "」不存在，是否创建为不分组状态？\n（可稍后拖拽分配）")) return;
    tierName = "";
  }

  var meta = {};
  if (tierName) meta.tier = tierName;

  createMemberCompany(adminId, memberId, memberName, meta);
}

async function createMemberCompany(adminId, memberId, memberName, meta) {
  try {
    await request("/api/companies/" + encodeURIComponent(adminId) + "/members", {
      method: "POST",
      body: JSON.stringify({ id: memberId, name: memberName, meta: meta }),
    });
    setStatus("成员公司「" + memberId + "」已在管理员「" + adminId + "」下创建成功");
    g_ExpandedAdmins[adminId] = true; // 展开该管理员
    await loadCompanies();
    // 不自动切换到成员公司——成员公司继承管理员配置，切换到管理员编辑配置更有意义
  } catch (err) {
    setStatus("创建成员公司失败: " + err.message, true);
  }
}

// ─── 创建数据源管理员 ───────────────────────────────────

async function createCompany() {
  var id = document.getElementById("newCompanyId").value.trim();
  var name = document.getElementById("newCompanyName").value.trim();
  if (!id) { setStatus("请输入公司ID", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) { setStatus("公司ID只能用英文/数字/下划线/连字符", true); return; }
  if (id === "default") { setStatus("default 是系统保留ID，请换一个", true); return; }
  if (g_Companies.some(function (c) { return c.id === id; })) {
    setStatus("公司ID「" + id + "」已存在", true);
    return;
  }
  try {
    await request("/api/companies", {
      method: "POST",
      body: JSON.stringify({ id: id, name: name, meta: {} }),
    });
    setStatus("数据源管理员「" + id + "」创建成功。可在其卡片上添加成员公司。");
    document.getElementById("newCompanyId").value = "";
    document.getElementById("newCompanyName").value = "";
    g_ExpandedAdmins[id] = true;
    await loadCompanies();
    setCurrentCompanyId(id);
    document.getElementById("companySelect").value = id;
    run(loadConfigFromBackend);
  } catch (err) {
    setStatus("创建失败: " + err.message, true);
  }
}

// ─── 升级独立公司为管理员 ───────────────────────────────

async function upgradeToAdmin(companyId, currentMeta) {
  if (!confirm("确认将「" + companyId + "」升级为数据源管理员？\n\n" +
    "升级后该公司将拥有独立的配置/数据/折扣规则，并可在其下添加成员公司。")) return;
  var newMeta = Object.assign({}, currentMeta);
  newMeta.is_admin = true;
  try {
    await request("/api/companies/" + encodeURIComponent(companyId), {
      method: "PATCH",
      body: JSON.stringify({ meta: newMeta }),
    });
    setStatus("「" + companyId + "」已升级为数据源管理员");
    await loadCompanies();
  } catch (err) {
    setStatus("升级失败: " + err.message, true);
  }
}

// ─── 删除管理员公司（级联删除成员） ─────────────────────

async function deleteAdminCompany(adminId) {
  var admin = g_Companies.find(function (c) { return c.id === adminId; });
  if (!admin) return;
  var members = g_Companies.filter(function (c) {
    return (c.meta || {}).parent_company_id === adminId;
  });
  var msg = "确认删除数据源管理员「" + adminId + "」？\n\n";
  if (members.length > 0) {
    msg += "⚠️ 该管理员下有 " + members.length + " 家成员公司，将一并删除：\n";
    members.forEach(function (m) { msg += "  - " + m.id + "\n"; });
    msg += "\n所有成员公司的配置和数据都会丢失！\n\n";
  }
  msg += "该管理员的配置、数据、折扣规则将全部删除。";
  if (!confirm(msg)) return;
  // 先删除所有成员
  try {
    for (var i = 0; i < members.length; i++) {
      await request("/api/companies/" + encodeURIComponent(members[i].id), { method: "DELETE" });
    }
    // 再删除管理员本身
    await request("/api/companies/" + encodeURIComponent(adminId), { method: "DELETE" });
    setStatus("数据源管理员「" + adminId + "」及其 " + members.length + " 家成员公司已删除");
    if (getCurrentCompanyId() === adminId || members.some(function (m) { return m.id === getCurrentCompanyId(); })) {
      setCurrentCompanyId("default");
    }
    await loadCompanies();
  } catch (err) {
    setStatus("删除失败: " + err.message, true);
    await loadCompanies();
  }
}

// ─── 通用操作 ───────────────────────────────────────────

function buildCustomerLink(companyId, token) {
  var base = location.origin + "/apps/index.html";
  var params = "company_id=" + encodeURIComponent(companyId) + "&token=" + encodeURIComponent(token);
  return base + "#" + params;
}

function copyCustomerLink(companyId, token) {
  var link = buildCustomerLink(companyId, token);
  navigator.clipboard.writeText(link).then(function () {
    setStatus("客户访问链接已复制到剪贴板");
  }).catch(function () {
    prompt("请手动复制客户访问链接：", link);
  });
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
      msg += "\n\n请点击「复制」按钮获取客户访问链接。";
    }
    alert(msg);
    setStatus("令牌已重新生成" + (copied ? "，客户链接已复制到剪贴板" : ""));
    await loadCompanies();
  } catch (err) {
    setStatus("重置令牌失败: " + err.message, true);
  }
}

// ─── 公司切换 ───────────────────────────────────────────

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
