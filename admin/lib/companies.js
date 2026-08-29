/**
 * companies.js — 公司管理 UI：树形列表渲染、创建主公司/客户、删除、令牌重置。
 *
 * 树形结构设计（从第一性原理出发）：
 * - 主公司（is_admin=true, 无 parent）→ 拥有独立 config/data/折扣/tiers
 * - 客户公司（有 parent_company_id）→ 继承管理员配置，通过 tier 获取利润率
 * - 独立公司（default 等，无 parent 非 admin）→ 向后兼容
 *
 * 依赖：admin-core.js（request、setStatus、escapeHtml、getCurrentCompanyId、setCurrentCompanyId、run）
 *       tiers.js（renderTierManagerForAdmin、getTierBadgeHTML、getTierProfitMargin、companyDragStart 等）
 */

// ─── 全局缓存 ─────────────────────────────────────────────

var g_Companies = [];        // 所有公司列表
var g_TiersCache = {};       // { adminId: [tier, ...] }  各管理员的 tier 定义
var g_ExpandedAdmins = {};   // { adminId: true/false }  管理员卡片展开状态
var g_GroupExpanded = {};    // { groupKey: true/false } 超管视图按账号分组的折叠状态

// ─── 加载公司列表 + 预加载 tiers ─────────────────────────

async function loadCompanies() {
  if (!isAdminAuthenticated()) return;
  try {
    g_Companies = await request("/api/companies");
    await preloadTiers();
    fixTenantCurrentCompany();
    renderCompanyTree();
    updateCompanyQuotaHint();
    // 同步顶部公司选择下拉框
    syncCompanySelect();
  } catch (err) {
    setStatus("加载公司列表失败: " + err.message, true);
  }
}

/**
 * 创建面板配额提示：租户显示「已用 / 上限」（max_companies = 可拥有的
 * 主公司公司数）；超管不显示（不受账号配额限制）。
 */
function updateCompanyQuotaHint() {
  var el = document.getElementById("companyQuotaHint");
  if (!el) return;
  var session = window.SQ_SESSION;
  if (!session || session.role !== "tenant") { el.textContent = ""; return; }
  var quota = window.SQ_QUOTA || {};
  var max = quota.max_companies;
  if (max == null) { el.textContent = ""; return; }
  var owned = g_Companies.filter(function (c) {
    var meta = c.meta || {};
    return !meta.parent_company_id;
  }).length;
  el.textContent = "已用 " + owned + " / " + (max < 0 ? "不限" : max) +
    " 家主公司" + (max >= 0 && owned >= max ? "（已达上限，升级订阅可扩容）" : "");
}

/**
 * 租户当前公司兜底：注册/登录虽已写入自己的 company_id，但 localStorage
 * 可能残留其他值（如曾以超管身份操作过、多账号共用浏览器），导致租户
 * 一直操作无权访问的公司而到处报错。这里在列表加载后自动纠正为自己的公司。
 */
function fixTenantCurrentCompany() {
  var session = window.SQ_SESSION;
  var ownCompanyId = session && session.role === "tenant" ? session.company_id : null;
  if (!ownCompanyId) return;
  var stillVisible = g_Companies.some(function (c) { return c.id === getCurrentCompanyId(); });
  if (getCurrentCompanyId() !== ownCompanyId || !stillVisible) {
    setCurrentCompanyId(ownCompanyId);
    // 同步下拉框选中项（syncCompanySelect 在调用方随后执行）
    var sel = document.getElementById("companySelect");
    if (sel) sel.value = ownCompanyId;
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
    if (meta.is_admin) prefix = "[主] ";
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
    list.innerHTML = '<p style="color:#999;font-size:13px;">暂无公司。请在左侧创建第一个主公司。</p>';
    return;
  }

  // 分类：主公司 / 客户公司。无 is_admin 的「独立公司」已废弃（注册即数据源
  // 管理员），不再渲染——历史残留数据仍存在于列表/下拉中，可由超管删除。
  var admins = [];
  var members = [];

  g_Companies.forEach(function (c) {
    var meta = c.meta || {};
    if (meta.parent_company_id) {
      members.push(c);
    } else if (meta.is_admin) {
      admins.push(c);
    }
  });

  if (admins.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:#999;font-size:12px;border:1px dashed #ddd;border-radius:6px;">' +
      "暂无主公司。<br>注册账号会自动创建主公司；超管可在左侧手动创建。</div>";
    return;
  }

  // ── 超管视图：按归属账号分组（平台公司置顶，账号组默认折叠省空间）──
  if (!isTenantUser()) {
    var groups = {};
    var order = [];
    admins.forEach(function (admin) {
      var meta = admin.meta || {};
      var key = meta.owner_user_id || "__platform__";
      if (!groups[key]) {
        // owner_email 在公司对象顶层（API 附带），不在 meta 里
        groups[key] = {
          key: key,
          label: admin.owner_email || (meta.owner_user_id ? meta.owner_user_id : "平台公司（未归属账号）"),
          admins: [],
          platform: !meta.owner_user_id,
        };
        order.push(key);
      }
      groups[key].admins.push(admin);
    });
    // 平台组置顶，其余按邮箱排序
    order.sort(function (a, b) {
      if (groups[a].platform !== groups[b].platform) return groups[a].platform ? -1 : 1;
      return groups[a].label.localeCompare(groups[b].label);
    });
    order.forEach(function (key) {
      var g = groups[key];
      // 默认：平台组展开，账号组折叠（避免多账号公司占满整屏）
      var expanded = g_GroupExpanded[g.key] !== undefined ? g_GroupExpanded[g.key] : g.platform;
      list.appendChild(renderOwnerGroupHeader(g, expanded));
      if (expanded) {
        appendGroupAdmins(list, g, members);
      }
    });
    return;
  }

  // ── 租户视图：平铺自己的主公司（通常 1~5 家）──
  admins.forEach(function (admin) {
    var adminMembers = members.filter(function (m) {
      return (m.meta || {}).parent_company_id === admin.id;
    });
    list.appendChild(renderAdminCard(admin, adminMembers));
  });
}

/** 超管分组折叠头：账号邮箱 + 主公司数，点击展开/收起。 */
function renderOwnerGroupHeader(g, expanded) {
  var header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:8px 10px;margin-top:10px;" +
    "background:#f4f1ea;border:1px solid #e8e0d5;border-radius:6px;cursor:pointer;" +
    "user-select:none;";
  header.innerHTML =
    '<span style="font-size:11px;color:#8a7a5c;">' + (expanded ? "▼" : "▶") + "</span>" +
    '<strong style="font-size:12px;color:#4a4a4a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
    escapeHtml(g.label) + "</strong>" +
    '<span style="font-size:11px;color:#999;margin-left:auto;flex-shrink:0;">' +
    g.admins.length + " 家主公司</span>";
  header.title = expanded ? "点击收起" : "点击展开该账号名下的公司";
  header.onclick = function () {
    g_GroupExpanded[g.key] = !expanded;
    renderCompanyTree();
  };
  return header;
}

/** 渲染一组主公司卡片（含各自客户公司）。 */
function appendGroupAdmins(list, g, members) {
  g.admins.forEach(function (admin) {
    var adminMembers = members.filter(function (m) {
      return (m.meta || {}).parent_company_id === admin.id;
    });
    list.appendChild(renderAdminCard(admin, adminMembers));
  });
}

// ─── 订阅档位（plan）管理 ───────────────────────────────
// 主公司（含注册用户自己的公司，注册即主公司）独立订阅档位
// （free/pro/team），决定功能开关 + 配额 + 水印；客户公司（客户的客户）
// 继承其主公司的订阅，不自订阅。无 is_admin 的独立公司仅向后兼容。
// 与利润率分组（tier）是两套独立体系。

var PLAN_LABELS = { free: "免费版", pro: "个人版", team: "专业版" };

/**
 * 当前登录用户是否为 JWT 租户（非超管/开发模式）。
 * 用于隐藏平台级按钮（删除公司、分配档位等超管专属操作），避免点击后 403。
 * session 已加载时用权威角色；未加载时按实际发送的凭证类型判断
 * （API Key 优先于 JWT，与 admin-core.js getAuthToken 一致）。
 */
function isTenantUser() {
  if (window.SQ_SESSION && window.SQ_SESSION.role) {
    return window.SQ_SESSION.role === "tenant";
  }
  try {
    var apiKey = sessionStorage.getItem("sq_admin_api_key") || "";
    var jwt = sessionStorage.getItem("sq_jwt_token") || localStorage.getItem("sq_jwt_token") || "";
    return !apiKey && !!jwt;
  } catch (e) { return false; }
}

function makePlanSelect(company, meta) {
  // 生效档位（显式覆盖 > 账号档位 > free）——展示一律用它，而非 meta.plan 快照
  var resolved = company.resolved_plan || "";
  // 租户不能分配订阅档位（后端会剥离 meta.plan）——渲染生效档位静态标签
  if (isTenantUser()) {
    var label = document.createElement("span");
    label.style.cssText = "padding:2px 6px;font-size:11px;color:#666;flex-shrink:0;";
    label.textContent = PLAN_LABELS[resolved] || "继承账号";
    label.title = "当前生效订阅档位（跟随账号订阅）";
    return label;
  }
  var sel = document.createElement("select");
  sel.setAttribute("data-plan-company", company.id);
  sel.style.cssText = "padding:2px 6px;font-size:11px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#333;cursor:pointer;flex-shrink:0;box-sizing:border-box;";
  var current = (meta || {}).plan || "";
  if (!current) {
    var emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "继承账号";
    emptyOpt.selected = true;
    sel.appendChild(emptyOpt);
  }
  ["free", "pro", "team"].forEach(function (p) {
    var opt = document.createElement("option");
    opt.value = p;
    opt.textContent = PLAN_LABELS[p];
    if (p === current) opt.selected = true;
    sel.appendChild(opt);
  });
  // 阻止事件冒泡（避免触发卡片切换公司）
  sel.onclick = function (e) { e.stopPropagation(); };
  sel.onchange = function () { setCompanyPlan(company.id, sel.value); };
  // 宽度按选中项字数 + 0.5 字余量自适应（3字→3.5字宽，2字→2.5字宽）
  function fitWidth() {
    var len = sel.options[sel.selectedIndex].textContent.length;
    sel.style.width = "calc(" + (len + 0.5) + "em + 29px)";
  }
  fitWidth();
  // 生效档位标注：显式覆盖与实际生效可能不同（继承账号时跟随账号订阅）
  var wrap = document.createElement("span");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex-shrink:0;";
  wrap.appendChild(sel);
  var effective = document.createElement("span");
  effective.style.cssText = "font-size:10px;color:#999;white-space:nowrap;";
  var explicitLabel = current ? (PLAN_LABELS[current] || current) : "继承账号";
  if ((PLAN_LABELS[resolved] || resolved) !== explicitLabel) {
    effective.textContent = "生效:" + (PLAN_LABELS[resolved] || resolved);
    effective.title = "无显式分配时跟随账号订阅档位";
  } else {
    effective.textContent = "生效:" + (PLAN_LABELS[resolved] || resolved);
  }
  wrap.appendChild(effective);
  return wrap;
}

async function setCompanyPlan(companyId, plan) {
  var company = g_Companies.find(function (c) { return c.id === companyId; });
  if (!company) return;
  var newMeta = Object.assign({}, company.meta || {});
  if (plan) {
    newMeta.plan = plan;
  } else {
    delete newMeta.plan;
  }
  try {
    await request("/api/companies/" + encodeURIComponent(companyId), {
      method: "PATCH",
      body: JSON.stringify({ meta: newMeta }),
    });
    setStatus("「" + companyId + "」订阅档位已更新" + (plan ? "为 " + PLAN_LABELS[plan] : "为继承全局"));
    await loadCompanies();
  } catch (err) {
    setStatus("更新订阅档位失败: " + err.message, true);
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
  var memberCount = members.length;

  var wrapper = document.createElement("div");
  wrapper.style.cssText = (
    "border:1px solid " + (isCurrent ? "#2c5282" : "#d4c5a9") + ";" +
    "border-radius:8px;background:#fff;overflow:hidden;margin-bottom:12px;" +
    "box-shadow:0 1px 3px rgba(0,0,0,0.04);"
  );

  // ── 管理员头部 ──
  var header = document.createElement("div");
  header.className = "cc-header";
  header.style.cssText = (
    "display:flex;align-items:center;gap:0;background:" + (isCurrent ? "#eef4fb" : "#fdfbf7") + ";" +
    "border-bottom:1px solid #ece5d8;"
  );

  // 主信息区（可点击切换）
  var infoArea = document.createElement("div");
  infoArea.className = "cc-info";
  infoArea.style.cssText = (
    "flex:1;padding:10px 8px;cursor:" + (isCurrent ? "default" : "pointer") + ";min-width:0;"
  );
  if (!isCurrent) {
    infoArea.onmouseenter = function () { infoArea.style.background = "rgba(44,82,130,0.05)"; };
    infoArea.onmouseleave = function () { infoArea.style.background = ""; };
  }
  infoArea.onclick = function () { if (!isCurrent) switchToCompany(admin.id); };

  // 第一行：展开按钮 + 图标 + 公司名 + 主公司 + 当前
  var toggleBtn = document.createElement("div");
  toggleBtn.style.cssText = "padding:0 4px 0 0;cursor:pointer;font-size:14px;color:#666;flex-shrink:0;";
  toggleBtn.textContent = isExpanded ? "▼" : "▶";
  toggleBtn.onclick = function () {
    g_ExpandedAdmins[admin.id] = !isExpanded;
    renderCompanyTree();
  };
  var nameRow = document.createElement("div");
  nameRow.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
  nameRow.innerHTML = '<span style="font-size:14px;">🏢</span>' +
    '<strong style="font-size:14px;color:#2c5282;">' + safeId + '</strong>' +
    (safeName ? '<span style="color:#666;font-size:12px;">' + safeName + '</span>' : '') +
    '<span style="padding:2px 8px;background:#8e44ad;color:#fff;border-radius:3px;font-size:10px;">主公司</span>' +
    (isCurrent ? '<span style="padding:2px 6px;background:#2c5282;color:#fff;border-radius:3px;font-size:10px;">✓ 当前</span>' : '');
  nameRow.insertBefore(toggleBtn, nameRow.firstChild);
  // 第二行：客户/分组/令牌 + 订阅档位下拉同一行（手机版下拉靠右、介绍超长省略）
  var metaLine = document.createElement("div");
  metaLine.className = "cc-meta";
  metaLine.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10px;color:#999;margin-top:3px;";
  var infoText = document.createElement("span");
  infoText.className = "cc-meta-info";
  infoText.textContent = "客户: " + memberCount + " 家 · 利润率分组: " + tiers.length + " 个 · 令牌: " + tokenDisplay;
  metaLine.appendChild(infoText);
  var planLabel = document.createElement("span");
  planLabel.textContent = "订阅档位:";
  metaLine.appendChild(planLabel);
  metaLine.appendChild(makePlanSelect(admin, meta));
  infoArea.appendChild(nameRow);
  infoArea.appendChild(metaLine);
  header.appendChild(infoArea);

  // 操作按钮区
  var actions = document.createElement("div");
  actions.className = "cc-actions";
  actions.style.cssText = "display:flex;align-items:center;gap:4px;padding:6px 8px;flex-shrink:0;flex-wrap:wrap;";
  // 功能门控：客户公司创建是 admin_member_inheritance 功能（pro/team）
  if (window.hasFeature && window.hasFeature("admin_member_inheritance")) {
    actions.appendChild(makeActionBtn("添加客户", "#38a169", "在该管理员下创建客户公司（继承配置/数据）", function (e) {
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
  // 改名/改 ID（各公司仅限一次，超管专属）
  if (!isTenantUser()) {
    actions.appendChild(makeActionBtn("改名", "#16a085", "修改公司显示名（仅一次机会）", function (e) {
      e.stopPropagation();
      renameCompanyName(admin.id, admin.name);
    }));
    actions.appendChild(makeActionBtn("改ID", "#7f8c8d", "修改公司 ID（仅一次机会，用户/配置/数据引用一并迁移）", function (e) {
      e.stopPropagation();
      renameCompanyId(admin.id);
    }));
  }
  if (admin.id !== "default" && !isTenantUser()) {
    actions.appendChild(makeActionBtn("删除", "#e74c3c", "删除主公司及其所有客户公司", function (e) {
      e.stopPropagation();
      deleteAdminCompany(admin.id);
    }));
  }
  header.appendChild(actions);
  wrapper.appendChild(header);

  // ── 展开内容：Tier 管理 + 客户列表 ──
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

    // 客户列表
    var memberSection = document.createElement("div");
    memberSection.style.cssText = "padding:8px 12px;";
    var memberTitle = document.createElement("div");
    memberTitle.style.cssText = "font-size:12px;font-weight:600;color:#666;margin-bottom:6px;";
    memberTitle.textContent = "客户公司（" + memberCount + " 家）";
    memberSection.appendChild(memberTitle);

    if (members.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "padding:12px;text-align:center;color:#bbb;font-size:11px;border:1px dashed #eee;border-radius:4px;";
      empty.textContent = "暂无客户公司。点击上方「添加客户」创建。";
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

// ─── 渲染客户公司行 ─────────────────────────────────────

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
        escapeHtml(meta.tier) + " " + escapeHtml(tier.profit_margin) + "%</span>";
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
  // 第二行：利润率/令牌 + 继承订阅同一行（手机版右侧不换行）
  var parentId = meta.parent_company_id || "";
  var parentCompany = g_Companies.find(function (c) { return c.id === parentId; });
  var parentLabel = parentCompany ? (parentCompany.name || parentId) : parentId;
  var metaLine = document.createElement("div");
  metaLine.className = "cc-meta";
  metaLine.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10px;color:#aaa;margin-top:2px;";
  var infoText = document.createElement("span");
  infoText.className = "cc-meta-info";
  infoText.textContent = "利润率: " + pmDisplay + " · 令牌: " + tokenDisplay;
  metaLine.appendChild(infoText);
  var planText = document.createElement("span");
  planText.textContent = "订阅: 继承「" + parentLabel + "」";
  metaLine.appendChild(planText);
  infoArea.innerHTML = nameLine;
  infoArea.appendChild(metaLine);
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
  if (!isTenantUser()) {
    actions.appendChild(makeActionBtn("删除", "#e74c3c", "删除客户公司", function (e) {
      e.stopPropagation();
      deleteCompany(member.id);
    }));
  }
  row.appendChild(actions);

  return row;
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

// ─── 添加客户公司表单 ───────────────────────────────────

function showAddMemberForm(adminId) {
  var member = prompt(
    "在管理员「" + adminId + "」下创建客户公司\n\n" +
    "请输入客户公司 ID（英文/数字，如 client01）：\n" +
    "（客户公司将自动继承管理员的配置/数据/折扣）"
  );
  if (member === null) return;
  var memberId = member.trim();
  if (!memberId) { setStatus("客户公司ID不能为空", true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(memberId)) { setStatus("公司ID只能用英文/数字/下划线/连字符", true); return; }
  if (memberId === "default") { setStatus("default 是系统保留ID", true); return; }
  if (g_Companies.some(function (c) { return c.id === memberId; })) {
    setStatus("公司ID「" + memberId + "」已存在", true);
    return;
  }

  var memberName = prompt("客户公司名称（可选，如 客户A）：", "");
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
    setStatus("客户公司「" + memberId + "」已在管理员「" + adminId + "」下创建成功");
    g_ExpandedAdmins[adminId] = true; // 展开该管理员
    await loadCompanies();
    // 不自动切换到客户公司——客户公司继承管理员配置，切换到管理员编辑配置更有意义
  } catch (err) {
    setStatus("创建客户公司失败: " + err.message, true);
  }
}

// ─── 创建主公司 ───────────────────────────────────

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
  // 公司名去重预检（后端兜底 409）
  if (name && g_Companies.some(function (c) { return (c.name || "").trim() === name; })) {
    setStatus("公司名「" + name + "」已被占用", true);
    return;
  }
  try {
    await request("/api/companies", {
      method: "POST",
      body: JSON.stringify({ id: id, name: name, meta: {} }),
    });
    setStatus("主公司「" + id + "」创建成功。可在其卡片上添加客户公司。");
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

// ─── 公司改名 / 改 ID（各仅限一次） ─────────────────────

async function renameCompanyName(companyId, currentName) {
  var newName = prompt("修改公司显示名（仅此一次机会）：", currentName || companyId);
  if (newName === null) return;
  newName = newName.trim();
  if (!newName) { setStatus("公司名称不能为空", true); return; }
  if (newName === (currentName || "")) return;
  try {
    await request("/api/companies/" + encodeURIComponent(companyId), {
      method: "PATCH",
      body: JSON.stringify({ name: newName }),
    });
    setStatus("公司名已改为「" + newName + "」（改名机会已用）");
    await loadCompanies();
  } catch (err) {
    setStatus("改名失败: " + err.message, true);
  }
}

async function renameCompanyId(companyId) {
  var newId = prompt(
    "修改公司 ID（仅此一次机会）。\n\n" +
    "⚠️ 该公司下的用户/配置/数据/审计引用会一并迁移，客户访问令牌不变。\n" +
    "当前 ID：" + companyId + "\n新 ID（中文/英文/数字/下划线/连字符）："
  );
  if (newId === null) return;
  newId = newId.trim();
  if (!newId) { setStatus("公司 ID 不能为空", true); return; }
  if (newId === companyId) return;
  try {
    await request("/api/companies/" + encodeURIComponent(companyId) + "/rename-id", {
      method: "POST",
      body: JSON.stringify({ new_id: newId }),
    });
    setStatus("公司 ID 已改为「" + newId + "」（改 ID 机会已用）");
    if (getCurrentCompanyId() === companyId) setCurrentCompanyId(newId);
    await loadCompanies();
  } catch (err) {
    setStatus("改 ID 失败: " + err.message, true);
  }
}

// ─── 删除主公司（级联删除客户公司） ─────────────────────

async function deleteAdminCompany(adminId) {
  var admin = g_Companies.find(function (c) { return c.id === adminId; });
  if (!admin) return;
  var members = g_Companies.filter(function (c) {
    return (c.meta || {}).parent_company_id === adminId;
  });
  var msg = "确认删除主公司「" + adminId + "」？\n\n";
  if (members.length > 0) {
    msg += "⚠️ 该管理员下有 " + members.length + " 家客户公司，将一并删除：\n";
    members.forEach(function (m) { msg += "  - " + m.id + "\n"; });
    msg += "\n所有客户公司的配置和数据都会丢失！\n\n";
  }
  msg += "该管理员的配置、数据、折扣规则将全部删除。";
  if (!confirm(msg)) return;
  // 先删除所有客户公司
  try {
    for (var i = 0; i < members.length; i++) {
      await request("/api/companies/" + encodeURIComponent(members[i].id), { method: "DELETE" });
    }
    // 再删除管理员本身
    await request("/api/companies/" + encodeURIComponent(adminId), { method: "DELETE" });
    setStatus("主公司「" + adminId + "」及其 " + members.length + " 家客户公司已删除");
    if (getCurrentCompanyId() === adminId || members.some(function (m) { return m.id === getCurrentCompanyId(); })) {
      setCurrentCompanyId("default");
    }
    await loadCompanies();
  } catch (err) {
    // 409 = 公司下仍有注册用户（租户无法自行重建公司）——需显式强制
    if (/注册用户/.test(err.message) && confirm(err.message + "\n\n确定强制删除？其下用户将被停用。")) {
      try {
        await request("/api/companies/" + encodeURIComponent(adminId) + "?force=true", { method: "DELETE" });
        setStatus("主公司「" + adminId + "」已强制删除（用户已停用，可在用户管理清理）");
        if (getCurrentCompanyId() === adminId) setCurrentCompanyId("default");
        await loadCompanies();
        return;
      } catch (err2) {
        setStatus("强制删除失败: " + err2.message, true);
      }
    } else {
      setStatus("删除失败: " + err.message, true);
    }
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
    if (/注册用户/.test(err.message) && confirm(err.message + "\n\n确定强制删除？其下用户将被停用。")) {
      try {
        await request("/api/companies/" + encodeURIComponent(id) + "?force=true", { method: "DELETE" });
        setStatus("公司 " + id + " 已强制删除（用户已停用）");
        if (getCurrentCompanyId() === id) setCurrentCompanyId("default");
        await loadCompanies();
        return;
      } catch (err2) {
        setStatus("强制删除失败: " + err2.message, true);
      }
    } else {
      setStatus("删除失败: " + err.message, true);
    }
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
