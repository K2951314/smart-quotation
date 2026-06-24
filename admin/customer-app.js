/**
 * 客户管理模块 — 独立 IIFE，复用 app.js 的 $/request/escapeHtml/setStatus。
 * 管理：客户 CRUD、密码重置、价格覆盖、利润/税率配置。
 */
(function () {
  "use strict";

  let g_CustomerEventsBound = false;
  let g_ActiveCustomerId = null; // 当前操作的客户 ID（编辑/价格覆盖）

  // ─── Helpers ──────────────────────────────────────────────────────

  function currentCompanyId() {
    // 优先从 state.config.company_id，回退到输入框
    if (typeof state !== "undefined" && state.config && state.config.company_id) {
      return state.config.company_id;
    }
    const input = document.getElementById("companyId");
    return input ? input.value.trim() : "";
  }

  function api(path, options) {
    return request(path, options);
  }

  function fmtPct(v) {
    return (parseFloat(v) * 100).toFixed(1) + "%";
  }

  // ─── Customer List ────────────────────────────────────────────────

  async function listCustomers() {
    const companyId = currentCompanyId();
    if (!companyId) {
      setStatus("错误：请先选择或创建公司", true);
      return;
    }
    try {
      const customers = await api(`/api/companies/${encodeURIComponent(companyId)}/customers`);
      renderCustomerList(customers);
    } catch (err) {
      setStatus(`加载客户失败：${err.message}`, true);
    }
  }

  function renderCustomerList(customers) {
    const list = document.getElementById("custList");
    if (!customers.length) {
      list.innerHTML = '<p style="color:var(--muted);">暂无客户，点击"创建客户"添加</p>';
      setStatus("共 0 个客户");
      return;
    }
    list.innerHTML = `<div class="company-chips">${customers.map((c) => {
      const statusBadge = c.status === "active"
        ? '<span class="badge badge-green">活跃</span>'
        : '<span class="badge badge-muted">停用</span>';
      const profitStr = c.profit_mode === "percent"
        ? `利润 ${c.profit_value}%`
        : c.profit_mode === "amount"
          ? `利润 ¥${c.profit_value}`
          : "无利润";
      const typeBadge = c.account_type === "admin"
        ? '<span class="badge badge-green">管理员</span>'
        : '<span class="badge badge-muted">公司</span>';
      return `
        <div class="company-chip-card" style="flex-wrap:wrap;gap:4px;">
          <strong style="min-width:120px;">${escapeHtml(c.display_name)}</strong>
          <small style="color:var(--muted);">${escapeHtml(c.username)}</small>
          ${typeBadge}
          ${statusBadge}
          <small>折扣 ${(c.discount_rate * 100).toFixed(0)}%</small>
          <small>税率 ${(c.tax_rate * 100).toFixed(1)}%</small>
          <small>${profitStr}</small>
          <div style="width:100%;display:flex;gap:4px;margin-top:4px;">
            <button type="button" class="small-btn" data-cust-edit="${escapeHtml(c.id)}">编辑</button>
            <button type="button" class="small-btn" data-cust-prices="${escapeHtml(c.id)}" data-cust-name="${escapeHtml(c.display_name)}">价格覆盖</button>
            <button type="button" class="small-btn warn-btn" data-cust-resetpw="${escapeHtml(c.id)}">重置密码</button>
            <button type="button" class="small-btn" data-cust-toggle="${escapeHtml(c.id)}" data-cust-status="${escapeHtml(c.status)}">
              ${c.status === "active" ? "停用" : "激活"}
            </button>
            <button type="button" class="small-btn danger-btn" data-cust-delete="${escapeHtml(c.id)}">删除</button>
          </div>
        </div>
      `;
    }).join("")}</div>`;
    setStatus(`共 ${customers.length} 个客户`);
  }

  // ─── Create Customer ──────────────────────────────────────────────

  function showCreateForm() {
    document.getElementById("custCreateForm").style.display = "grid";
    document.getElementById("custUsername").focus();
  }

  function hideCreateForm() {
    document.getElementById("custCreateForm").style.display = "none";
    ["custUsername", "custPassword", "custDisplayName", "custNotes"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    document.getElementById("custDiscountRate").value = "0.65";
    document.getElementById("custTaxRate").value = "0.13";
  }

  async function createCustomer() {
    const companyId = currentCompanyId();
    if (!companyId) {
      setStatus("错误：请先选择公司", true);
      return;
    }
    const username = document.getElementById("custUsername").value.trim();
    const password = document.getElementById("custPassword").value;
    const displayName = document.getElementById("custDisplayName").value.trim();
    const accountType = document.getElementById("custAccountType").value;
    const discountRate = parseFloat(document.getElementById("custDiscountRate").value) || 1.0;
    const taxRate = parseFloat(document.getElementById("custTaxRate").value) || 0;
    const notes = document.getElementById("custNotes").value.trim();

    if (!username || !password || !displayName) {
      setStatus("错误：用户名、密码、客户名称不能为空", true);
      return;
    }
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers`, {
        method: "POST",
        body: JSON.stringify({
          username, password, display_name: displayName,
          discount_rate: discountRate, tax_rate: taxRate, notes,
          account_type: accountType,
        }),
      });
      setStatus(`客户 ${displayName} 已创建（${accountType === "admin" ? "管理员" : "公司账号"}）`);
      hideCreateForm();
      await listCustomers();
    } catch (err) {
      setStatus(`创建失败：${err.message}`, true);
    }
  }

  // ─── Edit Customer ────────────────────────────────────────────────

  async function showEditPanel(customerId) {
    const companyId = currentCompanyId();
    try {
      const customer = await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}`);
      g_ActiveCustomerId = customerId;
      document.getElementById("custEditId").value = customerId;
      document.getElementById("custEditName").textContent = customer.display_name;
      document.getElementById("custEditDisplayName").value = customer.display_name;
      document.getElementById("custEditAccountType").value = customer.account_type || "company";
      document.getElementById("custEditDiscountRate").value = customer.discount_rate;
      document.getElementById("custEditTaxRate").value = customer.tax_rate;
      document.getElementById("custEditProfitMode").value = customer.profit_mode;
      document.getElementById("custEditProfitValue").value = customer.profit_value;
      document.getElementById("custEditStatus").value = customer.status;
      document.getElementById("custEditPanel").style.display = "flex";
    } catch (err) {
      setStatus(`加载客户失败：${err.message}`, true);
    }
  }

  function hideEditPanel() {
    document.getElementById("custEditPanel").style.display = "none";
    g_ActiveCustomerId = null;
  }

  async function saveCustomerEdit() {
    const companyId = currentCompanyId();
    const customerId = document.getElementById("custEditId").value;
    const payload = {
      display_name: document.getElementById("custEditDisplayName").value.trim(),
      account_type: document.getElementById("custEditAccountType").value,
      discount_rate: parseFloat(document.getElementById("custEditDiscountRate").value),
      tax_rate: parseFloat(document.getElementById("custEditTaxRate").value),
      profit_mode: document.getElementById("custEditProfitMode").value,
      profit_value: parseFloat(document.getElementById("custEditProfitValue").value) || 0,
      status: document.getElementById("custEditStatus").value,
    };
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setStatus("客户信息已更新");
      hideEditPanel();
      await listCustomers();
    } catch (err) {
      setStatus(`更新失败：${err.message}`, true);
    }
  }

  // ─── Delete / Toggle / Reset Password ─────────────────────────────

  async function deleteCustomer(customerId) {
    const companyId = currentCompanyId();
    if (!confirm(`确认删除客户 ${customerId}？\n\n此操作将删除该客户的所有数据和价格覆盖，且不可恢复！`)) return;
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}`, {
        method: "DELETE",
      });
      setStatus("客户已删除");
      await listCustomers();
    } catch (err) {
      setStatus(`删除失败：${err.message}`, true);
    }
  }

  async function toggleCustomerStatus(customerId, currentStatus) {
    const companyId = currentCompanyId();
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setStatus(`客户已${newStatus === "active" ? "激活" : "停用"}`);
      await listCustomers();
    } catch (err) {
      setStatus(`操作失败：${err.message}`, true);
    }
  }

  async function resetPassword(customerId) {
    const newPw = prompt(`为客户 ${customerId} 设置新密码：`);
    if (!newPw) return;
    if (newPw.length < 4) {
      setStatus("错误：密码至少 4 个字符", true);
      return;
    }
    const companyId = currentCompanyId();
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ new_password: newPw }),
      });
      setStatus("密码已重置，该客户所有会话已作废");
    } catch (err) {
      setStatus(`重置失败：${err.message}`, true);
    }
  }

  // ─── Price Overrides ──────────────────────────────────────────────

  async function showPricePanel(customerId, customerName) {
    g_ActiveCustomerId = customerId;
    document.getElementById("custPriceName").textContent = customerName;
    document.getElementById("custPricePanel").style.display = "block";
    await listPriceOverrides(customerId);
  }

  async function listPriceOverrides(customerId) {
    const companyId = currentCompanyId();
    try {
      const overrides = await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(customerId)}/prices`);
      const tbody = document.getElementById("custPriceRows");
      if (!overrides.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center;">暂无价格覆盖</td></tr>';
        return;
      }
      tbody.innerHTML = overrides.map((o) => `
        <tr>
          <td>${escapeHtml(o.item_key)}</td>
          <td>¥${escapeHtml(o.override_price)}</td>
          <td>${escapeHtml(o.notes || "")}</td>
          <td><button type="button" class="small-btn danger-btn" data-cust-price-del="${escapeHtml(o.item_key)}">删除</button></td>
        </tr>
      `).join("");
    } catch (err) {
      setStatus(`加载价格覆盖失败：${err.message}`, true);
    }
  }

  function toggleAddPriceRow() {
    const row = document.getElementById("custPriceAddRow");
    row.style.display = row.style.display === "none" ? "grid" : "none";
  }

  async function addPriceOverride() {
    const companyId = currentCompanyId();
    const itemKey = document.getElementById("custPriceItemKey").value.trim();
    const price = parseFloat(document.getElementById("custPriceValue").value);
    if (!itemKey || isNaN(price)) {
      setStatus("错误：商品编码和覆盖价不能为空", true);
      return;
    }
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(g_ActiveCustomerId)}/prices`, {
        method: "PUT",
        body: JSON.stringify({ overrides: [{ item_key: itemKey, override_price: price }] }),
      });
      setStatus("价格覆盖已添加");
      document.getElementById("custPriceItemKey").value = "";
      document.getElementById("custPriceValue").value = "";
      await listPriceOverrides(g_ActiveCustomerId);
    } catch (err) {
      setStatus(`添加失败：${err.message}`, true);
    }
  }

  async function deletePriceOverride(itemKey) {
    const companyId = currentCompanyId();
    if (!confirm(`确认删除 ${itemKey} 的价格覆盖？`)) return;
    try {
      await api(`/api/companies/${encodeURIComponent(companyId)}/customers/${encodeURIComponent(g_ActiveCustomerId)}/prices/${encodeURIComponent(itemKey)}`, {
        method: "DELETE",
      });
      setStatus("价格覆盖已删除");
      await listPriceOverrides(g_ActiveCustomerId);
    } catch (err) {
      setStatus(`删除失败：${err.message}`, true);
    }
  }

  // ─── Event Binding ────────────────────────────────────────────────

  function bindEvents() {
    if (g_CustomerEventsBound) return;
    g_CustomerEventsBound = true;

    // 按钮事件
    document.getElementById("custListBtn").addEventListener("click", listCustomers);
    document.getElementById("custCreateBtn").addEventListener("click", showCreateForm);
    document.getElementById("custCreateConfirmBtn").addEventListener("click", createCustomer);
    document.getElementById("custCreateCancelBtn").addEventListener("click", hideCreateForm);
    document.getElementById("custEditSaveBtn").addEventListener("click", saveCustomerEdit);
    document.getElementById("custEditCancelBtn").addEventListener("click", hideEditPanel);
    document.getElementById("custPriceAddBtn").addEventListener("click", toggleAddPriceRow);
    document.getElementById("custPriceSaveBtn").addEventListener("click", addPriceOverride);

    // 事件委托（客户列表中的动态按钮）
    document.body.addEventListener("click", (e) => {
      const editId = e.target.getAttribute("data-cust-edit");
      const pricesId = e.target.getAttribute("data-cust-prices");
      const pricesName = e.target.getAttribute("data-cust-name");
      const resetPwId = e.target.getAttribute("data-cust-resetpw");
      const toggleId = e.target.getAttribute("data-cust-toggle");
      const toggleStatus = e.target.getAttribute("data-cust-status");
      const deleteId = e.target.getAttribute("data-cust-delete");
      const priceDelKey = e.target.getAttribute("data-cust-price-del");

      if (editId) showEditPanel(editId);
      else if (pricesId) showPricePanel(pricesId, pricesName || "");
      else if (resetPwId) resetPassword(resetPwId);
      else if (toggleId) toggleCustomerStatus(toggleId, toggleStatus);
      else if (deleteId) deleteCustomer(deleteId);
      else if (priceDelKey) deletePriceOverride(priceDelKey);
    });
  }

  // DOM 就绪后绑定
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }

  // 暴露到全局以便 app.js 调用（可选）
  window._customerApp = { listCustomers };
})();
