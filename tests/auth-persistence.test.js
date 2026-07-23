const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// ─── 登录持久化（ADR-005 方案B）────────────────────────────
// 覆盖 stock-query.js 的凭证存储路由（_authWrite/_authRead/_authClear、
// getCompanyToken/getStockQueryKey/clearAllAuth）与 auth.js 的 initAuthGate
// 复选框逻辑。沙箱 mock window.location/sessionStorage/localStorage/history/document。

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function loadAuthModules({ href, elements, local, session } = {}) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  Object.entries(local || {}).forEach(([k, v]) => localStorage.setItem(k, v));
  Object.entries(session || {}).forEach(([k, v]) => sessionStorage.setItem(k, v));

  const url = new URL(href || "https://app.netlify.app/");
  const replacedUrls = [];
  let reloadCount = 0;
  const location = {
    href: url.href,
    protocol: url.protocol,
    hostname: url.hostname,
    search: url.search,
    hash: url.hash,
    reload: () => { reloadCount++; },
  };
  const document = {
    title: "test",
    getElementById: (id) => (elements && elements[id]) || null,
  };
  // 产品代码走 window.history.replaceState，mock 挂到 window 并记录调用（断言 URL 剥离用）
  const history = {
    replaceState: (_state, _title, newUrl) => { replacedUrls.push(String(newUrl)); },
  };
  const context = {
    console,
    URL,
    URLSearchParams,
    window: { location, __COMPANY_PROFILE__: null, history },
    location,
    document,
    localStorage,
    sessionStorage,
    history,
    // state.js 提供的全局（沙箱中直接预定义，避免加载 state.js 的副作用）
    g_AuthProfile: null,
    AUTH_STORAGE_KEY: "sq-auth-profile",
    // auth.js 顶层 monkey-patch 需要这两个全局已存在
    appendResultRow: function () {},
    calcDiscountedPrice: function () {},
  };
  vm.createContext(context);
  for (const file of ["stock-query.js", "auth.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../apps/lib", file), "utf8"),
      context,
    );
  }
  return {
    context,
    localStorage,
    sessionStorage,
    replacedUrls,
    getReloadCount: () => reloadCount,
  };
}

function makeGateElements({ keepChecked, pastedLink }) {
  const gate = { style: {} };
  const enterBtn = {
    onclick: null,
    click() { if (this.onclick) this.onclick(); },
  };
  const elements = {
    authGate: gate,
    authGateLink: { value: pastedLink || "", addEventListener() {} },
    authGateCompanyId: { value: "", addEventListener() {} },
    authGateToken: { value: "", addEventListener() {} },
    authGateStockKey: { value: "", addEventListener() {} },
    btnAuthGateEnter: enterBtn,
  };
  if (keepChecked !== undefined) {
    elements.authGateKeepLogin = { checked: keepChecked };
  }
  return { gate, enterBtn, elements };
}

test("1) keep-login checked: URL token persists to localStorage and is stripped from URL", () => {
  const { context, localStorage, sessionStorage, replacedUrls } = loadAuthModules({
    href: "https://app.netlify.app/#company_id=tenant-a&token=tok-url-1",
    local: { sq_keep_login: "1" },
  });

  const token = context.getCompanyToken();

  assert.equal(token, "tok-url-1");
  assert.equal(localStorage.getItem("sq_company_token"), "tok-url-1");
  assert.equal(sessionStorage.getItem("sq_company_token"), null);
  assert.equal(replacedUrls.length, 1);
  assert.ok(!replacedUrls[0].includes("tok-url-1"), "URL 中的 token 应被剥离");
});

test("2) keep-login unchecked: gate enter stores token in sessionStorage only", () => {
  const { enterBtn, elements } = makeGateElements({
    keepChecked: false,
    pastedLink: "https://app.netlify.app/#company_id=tenant-a&token=tok-paste-2",
  });
  const { context, localStorage, sessionStorage } = loadAuthModules({ elements });

  const passed = context.initAuthGate();
  assert.equal(passed, false); // 无凭证：gate 显示并绑定进入按钮
  enterBtn.click();

  assert.equal(localStorage.getItem("sq_keep_login"), "0");
  assert.equal(localStorage.getItem("sq_company_token"), null);
  assert.equal(sessionStorage.getItem("sq_company_token"), "tok-paste-2");
  assert.equal(localStorage.getItem("sq_company_id"), "tenant-a");
});

test("3) persisted localStorage credentials reopen without the auth gate", () => {
  const gate = { style: {} };
  const { context } = loadAuthModules({
    elements: { authGate: gate },
    local: { sq_company_token: "tok-persist-3", sq_company_id: "tenant-a" },
  });

  assert.equal(context.getCompanyToken(), "tok-persist-3");
  const passed = context.initAuthGate();
  assert.equal(passed, true);
  assert.equal(gate.style.display, "none");
});

test("4) clearAllAuth wipes credential keys from both storages", () => {
  const { context, localStorage, sessionStorage, getReloadCount } = loadAuthModules({
    local: {
      sq_company_token: "tok-l",
      sq_stock_key: "sk-l",
      "sq-auth-profile": "{}",
      sq_company_id: "tenant-a",
      sq_keep_login: "1",
    },
    session: {
      sq_company_token: "tok-s",
      sq_stock_key: "sk-s",
      "sq-auth-profile": "{}",
    },
  });

  context.clearAllAuth();

  for (const k of ["sq_company_token", "sq_stock_key", "sq-auth-profile", "sq_company_id", "sq_keep_login"]) {
    assert.equal(localStorage.getItem(k), null, `localStorage ${k} 应清除`);
    assert.equal(sessionStorage.getItem(k), null, `sessionStorage ${k} 应清除`);
  }
  assert.equal(getReloadCount(), 1);
});

test("5) legacy session-only token still resolves (no regression)", () => {
  const { context, localStorage } = loadAuthModules({
    session: { sq_company_token: "tok-session-5" },
  });

  assert.equal(context.getCompanyToken(), "tok-session-5");
  assert.equal(localStorage.getItem("sq_company_token"), null); // 读取不迁移、不污染 local
});

test("6) fresh URL token overrides the persisted local token", () => {
  const { context, localStorage } = loadAuthModules({
    href: "https://app.netlify.app/#token=tok-new-6",
    local: { sq_company_token: "tok-old-6" },
  });

  assert.equal(context.getCompanyToken(), "tok-new-6");
  assert.equal(localStorage.getItem("sq_company_token"), "tok-new-6");
});
