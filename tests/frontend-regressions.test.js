const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadDataModule() {
  const calls = [];
  const context = {
    console,
    Date,
    window: { APP_CONFIG: {} },
    SUPABASE_BASE_URL: "",
    getAppConfig: () => ({}),
    getCompanyId: () => "default",
    getApiBase: () => "https://api.example",
    withToken: (url) => url,
    withAuthHeaders: () => ({}),
    isBackendUrl: () => true,
    applyAppConfig: () => {},
    fetch: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          data_source: {
            base_url: "https://project.supabase.co/storage/v1/object/public/s-q",
          },
        }),
        text: async () => JSON.stringify({
          data_source: {
            base_url: "https://project.supabase.co/storage/v1/object/public/s-q",
          },
        }),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../apps/lib/data-load.js"), "utf8"),
    context,
  );
  return { context, calls };
}

function loadDataModuleWithApiFailure() {
  const calls = [];
  const supabaseBaseUrl = "https://project.supabase.co/storage/v1/object/public/s-q";
  const context = {
    console,
    Date,
    window: { APP_CONFIG: {} },
    SUPABASE_BASE_URL: "",
    getAppConfig: () => ({}),
    getCompanyId: () => "default",
    getApiBase: () => "https://api.example",
    withToken: (url) => url,
    withAuthHeaders: () => ({}),
    // API 地址走后端代理（带 token），Supabase 地址直连（不带 token）
    isBackendUrl: (url) => String(url).indexOf("api.example") >= 0,
    applyAppConfig: () => {},
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).indexOf("/api/config/active") >= 0) {
        return { ok: false, status: 401 };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          data_source: { base_url: supabaseBaseUrl, config_file: "config.json" },
          pricing: { decimal_places: 1 },
        }),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../apps/lib/data-load.js"), "utf8"),
    context,
  );
  return { context, calls, supabaseBaseUrl };
}

test("default company loads its data source through the API", async () => {
  const { context, calls } = loadDataModule();

  await context.loadRemoteConfig({ base_url: "", config_file: "config.json" });

  assert.equal(calls[0], "https://api.example/api/config/active?company_id=default");
});

test("loadRemoteConfig falls back to Supabase config.json when the API fails", async () => {
  const { context, calls, supabaseBaseUrl } = loadDataModuleWithApiFailure();

  const config = await context.loadRemoteConfig({
    base_url: supabaseBaseUrl,
    config_file: "config.json",
  });

  // 第一个请求命中后端 API 并失败
  assert.ok(calls[0].indexOf("/api/config/active?company_id=default") >= 0);
  // 回退到 Supabase 公开桶直接拉 config.json
  assert.ok(calls[1].indexOf(supabaseBaseUrl + "/config.json") >= 0);
  // 回退配置已被应用
  assert.equal(config.pricing.decimal_places, 1);
});

test("calculateDisplayedPrice removes tax before the first result is rendered", () => {
  const context = {
    document: { getElementById: () => ({ value: "ceil" }) },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../apps/lib/search-render.js"), "utf8"),
    context,
  );

  const result = context.calculateDisplayedPrice(100, { decimals: 2, threshold: 100 }, true, 13);

  assert.equal(result.value, 88.5);
  assert.equal(result.display, "88.50");
});

test("calculateDisplayedPrice untaxed with floor rounding rounds down to 88.49", () => {
  const context = {
    document: { getElementById: () => ({ value: "floor" }) },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../apps/lib/search-render.js"), "utf8"),
    context,
  );

  const result = context.calculateDisplayedPrice(100, { decimals: 2, threshold: 100 }, true, 13);

  assert.equal(result.value, 88.49);
  assert.equal(result.display, "88.49");
});

test("calculateDisplayedPrice untaxed with round rounding keeps 88.50", () => {
  const context = {
    document: { getElementById: () => ({ value: "round" }) },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../apps/lib/search-render.js"), "utf8"),
    context,
  );

  const result = context.calculateDisplayedPrice(100, { decimals: 2, threshold: 100 }, true, 13);

  assert.equal(result.value, 88.5);
  assert.equal(result.display, "88.50");
});
