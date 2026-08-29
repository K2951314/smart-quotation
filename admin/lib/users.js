// 用户管理（超管专属）：列表 / 改档位 / 停用 / 重置密码 / 迁移公司
// 直接从 storage 读 token（含 localStorage 兜底），不依赖 admin-core.js 全局变量，
// 避免 target=_blank 新标签页 sessionStorage 快照缺失导致"闪退退出账号"。
(function () {
  "use strict";

  var PAGE = 1;
  var PAGE_SIZE = 50;
  var TOTAL = 0;
  // 用户对象缓存（id → user），迁移公司弹窗需要 email/company_id 等字段
  var USERS_BY_ID = {};

  function readToken() {
    // 与 billing.html 一致：JWT 优先 localStorage 兜底，API Key 仅 sessionStorage
    try {
      return sessionStorage.getItem("sq_jwt_token") ||
             localStorage.getItem("sq_jwt_token") ||
             sessionStorage.getItem("sq_admin_api_key") || "";
    } catch (e) { return ""; }
  }

  function authHeaders() {
    var token = readToken();
    return token ? { Authorization: "Bearer " + token } : {};
  }

  function checkAccess() {
    var token = readToken();
    if (!token) {
      // 无凭证——显示提示而非强制跳转（避免闪退感）
      document.getElementById("usersBody").innerHTML =
        '<tr><td colspan="4" class="empty">未检测到登录凭证。请先在 <a href="index.html">配置中心</a> 登录后重试。</td></tr>';
      document.getElementById("statusBar").textContent = "";
      return false;
    }
    return true;
  }

  var TENANT_MODE = false;

  /**
   * 加载会话并切换页面模式：
   * - 超管：完整用户管理（档位/订阅/迁移/删除）
   * - 租户：子账号管理模式——只能查看/添加/删除自己公司的登录席位
   *   （席位上限 = 账号档位的 max_users；档位/迁移/重置密码为超管专属）
   */
  function loadRoleContext() {
    var token = readToken();
    if (!token) return Promise.resolve();
    return fetch(resolveApiBase() + "/api/auth/session", { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (session) {
        if (!session) return;
        window.SQ_SESSION = session;
        if (session.role === "tenant") {
          TENANT_MODE = true;
          applyTenantMode();
        }
      })
      .catch(function () { /* session 加载失败不阻断，后端仍会兜底 403 */ });
  }

  function applyTenantMode() {
    document.title = "子账号管理 — 智能询价";
    var h1 = document.getElementById("pageTitle");
    if (h1) h1.textContent = "👥 子账号管理";
    var head = document.getElementById("tableHead");
    if (head) {
      head.innerHTML = "<th>账号</th><th>状态</th><th>最后登录</th><th>操作</th>";
    }
    // 档位/状态筛选与子账号无关，隐藏
    var pf = document.getElementById("planFilter");
    var sf = document.getElementById("statusFilter");
    if (pf) pf.style.display = "none";
    if (sf) sf.style.display = "none";
    var form = document.getElementById("subAccountForm");
    if (form) {
      form.style.display = "flex";
      document.getElementById("subAccountSubmit").onclick = submitSubAccount;
    }
  }

  function submitSubAccount() {
    var email = document.getElementById("subEmail").value.trim();
    var pw = document.getElementById("subPassword").value;
    setStatus("");
    if (!email) { setStatus("请输入子账号邮箱", true); return; }
    if (pw.length < 8) { setStatus("密码至少 8 位", true); return; }
    fetch(resolveApiBase() + "/api/users/sub", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ email: email, password: pw }),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
          return d;
        });
      })
      .then(function () {
        document.getElementById("subEmail").value = "";
        document.getElementById("subPassword").value = "";
        setStatus("子账号已创建");
        loadUsers();
      })
      .catch(function (err) { setStatus("创建失败：" + err.message, true); });
  }

  function loadMySubAccounts() {
    setStatus("加载中...");
    fetch(resolveApiBase() + "/api/users/mine", { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) {
          alert("登录已失效，请重新登录");
          window.location.href = "index.html";
          return null;
        }
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.detail || "HTTP " + r.status); });
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        TOTAL = data.total;
        USERS_BY_ID = {};
        data.users.forEach(function (u) { USERS_BY_ID[u.id] = u; });
        var body = document.getElementById("usersBody");
        if (!data.users.length) {
          body.innerHTML = '<tr><td colspan="4" class="empty">暂无子账号。在上方添加即可共享使用。</td></tr>';
        } else {
          body.innerHTML = data.users.map(renderRow).join("");
        }
        var seats = document.getElementById("seatsHint");
        if (seats) {
          seats.textContent = "席位：已用 " + data.seats_used + " / " +
            (data.seats_max < 0 ? "不限" : data.seats_max) +
            (data.seats_max >= 0 && data.seats_used >= data.seats_max ? "（已达上限，升级订阅可扩容）" : "");
        }
        renderPagination();
        setStatus("");
      })
      .catch(function (err) {
        setStatus("");
        document.getElementById("usersBody").innerHTML =
          '<tr><td colspan="4" class="empty">加载失败：' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  function fmtDate(s) {
    if (!s) return "—";
    try {
      var d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
             String(d.getDate()).padStart(2, "0") + " " +
             String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    } catch (e) { return s; }
  }

  /** 到期日期的展示值（YYYY-MM-DD）+ 是否已过期 + 剩余天数。无到期返回 null。
   * 后端把纯日期归一化到 UTC 当日末（23:59:59Z），这里用 UTC 日期显示，
   * 与超管输入一致（用本地时区会跨到第二天）。 */
  function parseExpiry(s) {
    if (!s) return null;
    try {
      var d = new Date(s);
      if (isNaN(d.getTime())) return null;
      return {
        date: d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
              String(d.getUTCDate()).padStart(2, "0"),
        expired: d.getTime() < Date.now(),
        daysLeft: Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000)),
      };
    } catch (e) { return null; }
  }

  var PLAN_LABELS_U = { free: "免费版", pro: "个人版", team: "专业版" };
  // 快捷时长（与后端 _DURATIONS 对齐：月/年按日历计，7 天按天计）
  var PLAN_DURATIONS = [
    { key: "7d", label: "7天试用", days: 7 },
    { key: "1m", label: "1个月", months: 1 },
    { key: "3m", label: "3个月", months: 3 },
    { key: "1y", label: "1年", months: 12 },
    { key: "forever", label: "永久", days: 0 },
    { key: "custom", label: "自定义", days: 0 },
  ];

  /** 日历月加法（月末截断：1-31 + 1 月 → 2-28）。与后端 _add_calendar_months 一致。 */
  function addCalendarMonths(d, months) {
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth() + months; // 0-based，可为负/超 12
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    var daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), daysInMonth),
      d.getUTCHours(), d.getUTCMinutes()));
  }

  // 当前弹窗对应用户（预览计算用）
  var currentModalUser = null;

  /** 订阅预览：返回"至 yyyy-mm-dd"的到期日。
   * 规则与后端一致：到期日 =（基准日 + N 单位）的前一天；
   * 续期基准 = 原到期日次日；换档/新订阅基准 = 现在。 */
  function previewExpiry(plan, durationKey) {
    var user = USERS_BY_ID[currentModalUser] || {};
    var base = new Date();
    if (plan === user.plan) {
      var cur = parseExpiry(user.plan_expires_at);
      if (cur && !cur.expired) {
        base = new Date(cur.date + "T23:59:59.000Z");
        base = new Date(base.getTime() + 86400000); // 原到期日次日
      }
    }
    var def = PLAN_DURATIONS.filter(function (x) { return x.key === durationKey; })[0];
    var end;
    if (def.days) {
      end = new Date(base.getTime() + def.days * 86400000);
    } else {
      end = addCalendarMonths(base, def.months);
    }
    var expiry = new Date(end.getTime() - 86400000); // 到期日 = end 前一天
    return expiry.getUTCFullYear() + "-" +
      String(expiry.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(expiry.getUTCDate()).padStart(2, "0");
  }

  // 自带 getApiBase 兜底（admin-core.js 未加载或未提供时），与 billing.html 一致
  function resolveApiBase() {
    if (typeof getApiBase === "function") return getApiBase();
    if (window.SQ_PROD_API_BASE) return String(window.SQ_PROD_API_BASE).replace(/\/+$/, "");
    var isDev = location.protocol === "file:" || location.hostname === "127.0.0.1" || location.hostname === "localhost";
    if (isDev) {
      var p = new URLSearchParams(location.search).get("api");
      if (p) return p.replace(/\/+$/, "");
    }
    try {
      var stored = localStorage.getItem("sq_admin_api_base");
      if (stored) return stored.replace(/\/+$/, "");
    } catch (e) { }
    if (location.protocol === "file:") return "http://127.0.0.1:8001";
    return location.origin;
  }

  function planBadge(plan) {
    if (!plan) return '<span class="badge badge-inherit">继承公司</span>';
    var cls = { free: "badge-free", pro: "badge-pro", team: "badge-team" }[plan] || "badge-inherit";
    var label = { free: "免费版", pro: "个人版", team: "专业版" }[plan] || plan;
    return '<span class="badge ' + cls + '">' + label + '</span>';
  }

  function statusBadge(isActive) {
    return isActive
      ? '<span class="badge badge-active">启用</span>'
      : '<span class="badge badge-inactive">停用</span>';
  }

  function planSelect(user) {
    var cur = user.plan || "inherit";
    var opts = [
      { v: "inherit", l: "继承公司" },
      { v: "free", l: "免费版" },
      { v: "pro", l: "个人版" },
      { v: "team", l: "专业版" },
    ];
    var html = '<select class="plan-select" data-user="' + user.id + '">';
    opts.forEach(function (o) {
      html += '<option value="' + o.v + '"' + (o.v === cur ? " selected" : "") + ">" + o.l + "</option>";
    });
    html += "</select>";
    return html;
  }

  function actionBtns(user) {
    var toggle = user.is_active
      ? '<button class="action-btn danger" data-act="deactivate" data-user="' + user.id + '">停用</button>'
      : '<button class="action-btn" data-act="activate" data-user="' + user.id + '">启用</button>';
    return toggle +
      '<button class="action-btn" data-act="subscribe" data-user="' + user.id + '">订阅</button>' +
      '<button class="action-btn" data-act="reset" data-user="' + user.id + '">重置密码</button>' +
      '<button class="action-btn" data-act="migrate" data-user="' + user.id + '" data-cid="' + (user.company_id || "") + '">迁移公司</button>' +
      '<button class="action-btn danger" data-act="delete" data-user="' + user.id + '">删除</button>';
  }

  function renderRow(user) {
    // 租户（子账号模式）：只展示账号/状态/最后登录/删除
    if (TENANT_MODE) {
      var me = (window.SQ_SESSION || {}).user_id;
      var isSelf = user.id === me;
      var delBtn = isSelf
        ? '<span style="font-size:11px;color:#bbb;">当前登录账号</span>'
        : '<button class="action-btn danger" data-act="delete" data-user="' + user.id + '">删除</button>';
      return "<tr>" +
        "<td><div class=\"u-email\">" + escapeHtml(user.email) +
        (isSelf ? ' <span style="color:#2563eb;font-size:11px;">（主账号）</span>' : "") + "</div>" +
        '<div class="u-sub">注册 ' + fmtDate(user.created_at).slice(0, 10) + "</div></td>" +
        "<td>" + statusBadge(user.is_active) + "</td>" +
        "<td>" + fmtDate(user.last_login_at) + "</td>" +
        '<td><div class="u-actions">' + delBtn + "</div></td>" +
        "</tr>";
    }
    // 4 列布局：用户（邮箱+公司/注册）· 订阅（档位+状态）· 状态 · 操作
    // 桌面一行放下；手机（媒体查询）允许操作列换行到第二行
    var expiry = parseExpiry(user.plan_expires_at);
    var subInfo;
    if (user.plan && expiry) {
      subInfo = expiry.expired
        ? '<span style="color:#e74c3c">已过期 ' + expiry.date + "</span>"
        : "至 " + expiry.date + (expiry.daysLeft <= 7
          ? ' <span style="color:#e67e22">（剩 ' + expiry.daysLeft + " 天）</span>"
          : "（剩 " + expiry.daysLeft + " 天）");
    } else if (user.plan) {
      subInfo = "永久有效";
    } else {
      subInfo = "继承公司档位";
    }
    return "<tr>" +
      "<td>" +
        '<div class="u-email">' + escapeHtml(user.email) + "</div>" +
        '<div class="u-sub">' + escapeHtml(user.company_name || user.company_id || "—") +
        " · 注册 " + fmtDate(user.created_at).slice(0, 10) + "</div>" +
      "</td>" +
      "<td>" +
        '<div class="u-plan-line">' + planSelect(user) + "</div>" +
        '<div class="u-sub">' + subInfo + "</div>" +
      "</td>" +
      "<td>" +
        statusBadge(user.is_active) +
        '<div class="u-sub">活跃 ' + fmtDate(user.last_login_at).slice(0, 10) + "</div>" +
      "</td>" +
      "<td>" + actionBtns(user) + "</td>" +
      "</tr>";
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function setStatus(msg) {
    document.getElementById("statusBar").textContent = msg || "";
  }

  function loadUsers() {
    if (TENANT_MODE) { loadMySubAccounts(); return; }
    if (!checkAccess()) return;
    setStatus("加载中...");
    var search = document.getElementById("searchInput").value.trim();
    var planFilter = document.getElementById("planFilter").value;
    var statusFilter = document.getElementById("statusFilter").value;

    var params = "page=" + PAGE + "&page_size=" + PAGE_SIZE;
    if (search) params += "&search=" + encodeURIComponent(search);
    if (planFilter) {
      // "inherit" 映射为后端 u.plan IS NULL（继承公司档位），分页/计数一致
      params += "&plan=" + encodeURIComponent(planFilter);
    }
    if (statusFilter) params += "&is_active=" + encodeURIComponent(statusFilter);

    fetch(resolveApiBase() + "/api/users?" + params, { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) {
          if (r.status === 403) throw new Error("需要超管权限");
          if (r.status === 401) {
            alert("登录已失效，请重新登录");
            window.location.href = "index.html";
            return null;
          }
          return r.json().then(function (d) { throw new Error(d.detail || "HTTP " + r.status); });
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        var body = document.getElementById("usersBody");
        TOTAL = data.total;
        USERS_BY_ID = {};
        data.users.forEach(function (u) { USERS_BY_ID[u.id] = u; });
        if (!data.users.length) {
          body.innerHTML = '<tr><td colspan="4" class="empty">暂无用户</td></tr>';
        } else {
          body.innerHTML = data.users.map(renderRow).join("");
        }
        renderPagination();
        setStatus("共 " + TOTAL + " 个用户");
      })
      .catch(function (err) {
        setStatus("");
        document.getElementById("usersBody").innerHTML =
          '<tr><td colspan="4" class="empty">加载失败：' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  function renderPagination() {
    var pages = Math.ceil(TOTAL / PAGE_SIZE);
    var el = document.getElementById("pagination");
    if (pages <= 1) { el.innerHTML = ""; return; }
    var html = '<button ' + (PAGE <= 1 ? "disabled" : "") + ' data-page="' + (PAGE - 1) + '">上一页</button>';
    html += '<span>第 ' + PAGE + " / " + pages + " 页</span>";
    html += '<button ' + (PAGE >= pages ? "disabled" : "") + ' data-page="' + (PAGE + 1) + '">下一页</button>';
    el.innerHTML = html;
  }

  function patchUser(userId, body) {
    return fetch(resolveApiBase() + "/api/users/" + userId, {
      method: "PATCH",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
        return d;
      });
    });
  }

  function onTableClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var userId = btn.getAttribute("data-user");
    var act = btn.getAttribute("data-act");

    if (act === "deactivate") {
      if (!confirm("确认停用该账号？停用后该用户将立即无法登录。")) return;
      patchUser(userId, { is_active: false }).then(function () { loadUsers(); }).catch(function (err) { alert("失败：" + err.message); });
    } else if (act === "activate") {
      patchUser(userId, { is_active: true }).then(function () { loadUsers(); }).catch(function (err) { alert("失败：" + err.message); });
    } else if (act === "subscribe") {
      // 订阅入口：不依赖下拉——同档位续期、查看当前订阅都在这里
      var u = USERS_BY_ID[userId];
      if (u) showSubscriptionModal(u, u.plan || "free");
    } else if (act === "delete") {
      var ud = USERS_BY_ID[userId];
      if (ud) showDeleteUserModal(ud);
    } else if (act === "reset") {
      if (!confirm("确认重置该用户密码？将生成临时密码，请通过安全渠道告知用户。")) return;
      fetch(resolveApiBase() + "/api/users/" + userId + "/reset-password", {
        method: "POST",
        headers: authHeaders(),
      })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || "HTTP " + r.status); return d; }); })
        .then(function (d) { showTempPasswordModal(d.temp_password); })
        .catch(function (err) { alert("失败：" + err.message); });
    } else if (act === "migrate") {
      var user = USERS_BY_ID[userId];
      if (user) showMigrateModal(user);
    }
  }

  /**
   * 迁移公司弹窗：拉取公司列表渲染下拉框（替代手输 company_id，防拼错）。
   * 列表加载失败时回退为手输框。
   */
  function showMigrateModal(user) {
    var root = document.getElementById("modalRoot");
    root.innerHTML = '<div class="modal-overlay"><div class="modal">' +
      "<h3>迁移公司</h3>" +
      "<p>将 <b>" + escapeHtml(user.email) + "</b> 迁移到：<br>" +
      '<span style="font-size:12px;color:#999">当前：' + escapeHtml(user.company_name || user.company_id || "—") + "</span></p>" +
      '<div id="migrateBody"><p style="margin:0">加载公司列表中...</p></div>' +
      '<div class="actions">' +
      '<button class="btn-secondary" id="migrateCancel">取消</button>' +
      '<button class="btn-primary" id="migrateOk" disabled>确认迁移</button>' +
      "</div></div></div>";

    document.getElementById("migrateCancel").onclick = function () { root.innerHTML = ""; };

    fetch(resolveApiBase() + "/api/companies", { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (companies) {
        var body = document.getElementById("migrateBody");
        var list = (companies || []).filter(function (c) { return c.id !== user.company_id; });
        if (!list.length) {
          body.innerHTML = "<p style=\"margin:0\">没有其他可迁移的公司，请先创建目标公司。</p>";
          return;
        }
        var html = '<select id="migrateSelect" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">';
        list.forEach(function (c) {
          html += '<option value="' + escapeHtml(c.id) + '">' +
                  escapeHtml(c.id + (c.name ? "（" + c.name + "）" : "")) + "</option>";
        });
        html += "</select>";
        body.innerHTML = html;
        var ok = document.getElementById("migrateOk");
        ok.disabled = false;
        ok.onclick = function () {
          var newCid = document.getElementById("migrateSelect").value;
          root.innerHTML = "";
          patchUser(user.id, { company_id: newCid })
            .then(function () { loadUsers(); })
            .catch(function (err) { alert("失败：" + err.message); });
        };
      })
      .catch(function (err) {
        // 拉列表失败（网络/权限）——回退手输，不让功能不可用
        var body = document.getElementById("migrateBody");
        body.innerHTML = '<p style="margin:0 0 8px">公司列表加载失败（' + escapeHtml(err.message) +
          '），可手输公司 ID：</p>' +
          '<input id="migrateInput" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;" value="' + escapeHtml(user.company_id || "") + '">';
        var ok = document.getElementById("migrateOk");
        ok.disabled = false;
        ok.onclick = function () {
          var newCid = (document.getElementById("migrateInput").value || "").trim();
          if (!newCid) { alert("公司 ID 不能为空"); return; }
          root.innerHTML = "";
          patchUser(user.id, { company_id: newCid })
            .then(function () { loadUsers(); })
            .catch(function (err2) { alert("失败：" + err2.message); });
        };
      });
  }

  function onPlanChange(e) {
    var sel = e.target.closest(".plan-select");
    if (!sel) return;
    var userId = sel.getAttribute("data-user");
    var val = sel.value;
    var user = USERS_BY_ID[userId] || {};
    // 下拉只是入口：打开订阅弹窗（预选档位），确认才生效——
    // 直接改下拉就覆盖订阅会绕过时长选择和替换确认
    showSubscriptionModal(user, val === "inherit" ? "inherit" : val);
  }

  /**
   * 订阅管理弹窗：把 plan+到期视为用户的「当前订阅」统一管理。
   * - 显示当前订阅状态（档位/到期/剩余天数）
   * - 档位选择 + 快捷时长 chips（7天试用/1个月/3个月/1年/永久/自定义）
   * - 同档位+时长 = 续期（从当前到期顺延，预览新到期）；换档 = 替换（明示）
   */
  function showSubscriptionModal(user, presetPlan) {
    var root = document.getElementById("modalRoot");
    currentModalUser = user.id; // previewExpiry 用
    var currentPlan = user.plan || "";
    var targetPlan = presetPlan || currentPlan || "free";
    var currentExp = parseExpiry(user.plan_expires_at);
    var state = { plan: targetPlan, duration: "1m" };

    // 当前订阅描述
    var curDesc;
    if (!currentPlan) {
      curDesc = "继承公司档位（无账号级订阅）";
    } else if (!currentExp) {
      curDesc = PLAN_LABELS_U[currentPlan] + " · 永久有效";
    } else if (currentExp.expired) {
      curDesc = '<span style="color:#e74c3c">' + PLAN_LABELS_U[currentPlan] + " · 已过期（" + currentExp.date + "）</span>";
    } else {
      curDesc = PLAN_LABELS_U[currentPlan] + " · 至 " + currentExp.date + "（剩 " + currentExp.daysLeft + " 天）";
    }

    root.innerHTML = '<div class="modal-overlay"><div class="modal">' +
      "<h3>管理订阅</h3>" +
      "<p>用户：<b>" + escapeHtml(user.email) + "</b><br>" +
      '<span style="font-size:12px">当前：' + curDesc + "</span></p>" +
      '<div style="margin:10px 0;">' +
      '<label style="display:block;font-size:13px;color:#374151;margin-bottom:6px;">档位</label>' +
      '<select id="subPlanSelect" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;">' +
      '<option value="inherit"' + (state.plan === "inherit" ? " selected" : "") + '>继承公司（退订）</option>' +
      '<option value="free"' + (state.plan === "free" ? " selected" : "") + '>免费版</option>' +
      '<option value="pro"' + (state.plan === "pro" ? " selected" : "") + '>个人版</option>' +
      '<option value="team"' + (state.plan === "team" ? " selected" : "") + '>专业版</option>' +
      "</select></div>" +
      '<div style="margin:10px 0;">' +
      '<label style="display:block;font-size:13px;color:#374151;margin-bottom:6px;">时长</label>' +
      '<div id="subDurationChips" style="display:flex;flex-wrap:wrap;gap:6px;"></div>' +
      '<div id="subCustomWrap" style="display:none;margin-top:8px;">' +
      '<input type="date" id="subCustomDate" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;">' +
      "</div>" +
      '<p id="subPreview" style="font-size:12px;color:#2563eb;margin:10px 0 0;"></p>' +
      "</div>" +
      '<div class="actions">' +
      '<button class="btn-secondary" id="subCancel">取消</button>' +
      '<button class="btn-primary" id="subOk">确认</button>' +
      "</div></div></div>";

    var chipsEl = document.getElementById("subDurationChips");
    var customWrap = document.getElementById("subCustomWrap");
    var previewEl = document.getElementById("subPreview");
    var planSel = document.getElementById("subPlanSelect");

    function renderChips() {
      chipsEl.innerHTML = "";
      PLAN_DURATIONS.forEach(function (d) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = d.label;
        b.className = "sub-chip" + (state.duration === d.key ? " sub-chip-active" : "");
        b.style.cssText = "padding:5px 12px;border:1px solid " +
          (state.duration === d.key ? "#2563eb;background:#eff6ff;" : "#d1d5db;background:#fff;") +
          "border-radius:16px;font-size:12px;cursor:pointer;color:" +
          (state.duration === d.key ? "#2563eb" : "#374151") + ";";
        b.onclick = function () {
          state.duration = d.key;
          renderChips();
          updatePreview();
        };
        chipsEl.appendChild(b);
      });
    }

    function updatePreview() {
      customWrap.style.display = state.duration === "custom" ? "block" : "none";
      if (state.plan === "inherit") {
        previewEl.textContent = "确认后：退订账号级订阅，回退公司档位";
        return;
      }
      var planChanged = state.plan !== currentPlan;
      var label = PLAN_LABELS_U[state.plan] || state.plan;
      var text = "确认后：" + label;
      if (state.duration === "forever") {
        text += " · 永久有效";
      } else if (state.duration === "custom") {
        var d = document.getElementById("subCustomDate").value;
        text += d ? " · 至 " + d : " · 请选择日期";
      } else {
        // 预览与后端同规则：到期日 =（基准 + N 单位）前一天；
        // 续期基准 = 原到期日次日，换档/新订阅基准 = 现在
        text += " · 至 " + previewExpiry(state.plan, state.duration);
      }
      if (planChanged && currentPlan) {
        var oldDesc = currentExp && !currentExp.expired ? PLAN_LABELS_U[currentPlan] + "（至 " + currentExp.date + "）" : PLAN_LABELS_U[currentPlan];
        text += "；将替换当前 " + oldDesc + " 订阅";
      } else if (!planChanged && currentExp && !currentExp.expired && state.duration !== "custom" && state.duration !== "forever") {
        text += "（续期，从当前到期顺延）";
      }
      previewEl.textContent = text;
    }

    planSel.onchange = function () {
      state.plan = planSel.value;
      updatePreview();
    };

    document.getElementById("subCancel").onclick = function () {
      root.innerHTML = "";
      loadUsers(); // 还原下拉框选中值
    };
    document.getElementById("subOk").onclick = function () {
      var body = { plan: state.plan };
      if (state.plan !== "inherit") {
        if (state.duration === "forever") {
          body.plan_expires = "";  // 清除到期 = 永久
        } else if (state.duration === "custom") {
          var d = document.getElementById("subCustomDate").value;
          if (!d) { alert("请选择自定义日期"); return; }
          body.plan_expires = d;
        } else {
          body.plan_duration = state.duration;
        }
      }
      root.innerHTML = "";
      patchUser(user.id, body)
        .then(function () { loadUsers(); })
        .catch(function (err) { alert("失败：" + err.message); });
    };

    renderChips();
    updatePreview();
  }

  /**
   * 删除用户确认弹窗：只删账号不删公司（公司含数据，若因此成为
   * "无用户孤儿公司"，响应会提示可去公司管理另行删除）。
   */
  function showDeleteUserModal(user) {
    var root = document.getElementById("modalRoot");
    root.innerHTML = '<div class="modal-overlay"><div class="modal">' +
      "<h3>删除用户</h3>" +
      "<p>确认删除 <b>" + escapeHtml(user.email) + "</b>？</p>" +
      '<p style="font-size:12px;color:#6b7280;margin:0 0 16px;">' +
      "该账号将立即失效且不可恢复。其公司「" + escapeHtml(user.company_name || user.company_id || "—") +
      "」及数据会保留；若删除后该公司再无用户，可前往公司管理删除。</p>" +
      '<div class="actions">' +
      '<button class="btn-secondary" id="delUserCancel">取消</button>' +
      '<button class="btn-primary" id="delUserOk" style="background:#e74c3c;">确认删除</button>' +
      "</div></div></div>";

    document.getElementById("delUserCancel").onclick = function () { root.innerHTML = ""; };
    document.getElementById("delUserOk").onclick = function () {
      root.innerHTML = "";
      fetch(resolveApiBase() + "/api/users/" + user.id, { method: "DELETE", headers: authHeaders() })
        .then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
            return d;
          });
        })
        .then(function (d) {
          setStatus("已删除 " + (d.deleted_email || "") +
            (d.company_orphaned ? "。其公司已无用户，可前往公司管理删除。" : ""));
          loadUsers();
        })
        .catch(function (err) { alert("删除失败：" + err.message); });
    };
  }

  function showTempPasswordModal(pw) {
    var root = document.getElementById("modalRoot");
    root.innerHTML = '<div class="modal-overlay"><div class="modal">' +
      "<h3>临时密码已生成</h3>" +
      "<p>请立即复制并通过安全渠道（线下/电话）告知用户。此密码只显示一次。</p>" +
      '<div class="temp-pw" id="tempPw">' + escapeHtml(pw) + "</div>" +
      '<div class="actions">' +
      '<button class="btn-secondary" id="copyPwBtn">复制密码</button>' +
      '<button class="btn-primary" id="closeModalBtn">关闭</button>' +
      "</div></div></div>";
    document.getElementById("copyPwBtn").onclick = function () {
      var text = document.getElementById("tempPw").textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () { alert("已复制到剪贴板"); });
      } else {
        alert("请手动选择密码复制：" + text);
      }
    };
    document.getElementById("closeModalBtn").onclick = function () { root.innerHTML = ""; };
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("searchBtn").addEventListener("click", function () {
      PAGE = 1;
      loadUsers();
    });
    document.getElementById("searchInput").addEventListener("keypress", function (e) {
      if (e.key === "Enter") { PAGE = 1; loadUsers(); }
    });
    document.getElementById("planFilter").addEventListener("change", function () { PAGE = 1; loadUsers(); });
    document.getElementById("statusFilter").addEventListener("change", function () { PAGE = 1; loadUsers(); });
    document.getElementById("usersBody").addEventListener("click", onTableClick);
    document.getElementById("usersBody").addEventListener("change", onPlanChange);
    document.getElementById("pagination").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-page]");
      if (!btn) return;
      PAGE = parseInt(btn.getAttribute("data-page"), 10);
      loadUsers();
    });
    // 初始加载必须等角色判定完成：TENANT_MODE 决定走 /api/users/mine
    // 还是超管列表——并行起跑会让租户先打超管端点吃 403
    loadRoleContext().then(function () { loadUsers(); });
  });
})();
