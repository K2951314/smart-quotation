/**
 * 回归测试：管理员价格通道（2026-08-21 修复）。
 *
 * 问题：成员公司（利润版）价格正常，管理员账号价格显示 0。
 * 根因：公开桶的 price.bundle.json 是强制脱敏版（无 face_price），
 * 所有角色共用；渲染时 company 模式有 quote_price 兜底，admin 模式
 * 依赖 face_price → 0。
 *
 * 修复：双 bundle 通道——
 *   - price.bundle.json：脱敏明文（company 角色，不变）
 *   - price.admin.bundle.json：完整数据 AES-GCM 加密，密码 = 公司 access_token
 *     （admin 角色下载后用本地登录令牌自动解密）
 *
 * 验证点：
 *   1. 端到端：admin 端生成加密完整包 → apps 端用 token 解密 → 含 face_price
 *   2. 错误 token 解密失败（安全性）
 *   3. getDataSourceConfig：admin+Supabase → 管理员包；company → 普通包；
 *      admin+后端代理 → 普通文件名（后端按角色生成）
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ConfigCore = require("../apps/lib/config-core");
const DataUtils = require("../admin/lib/data-utils");
const ExportUtils = require("../admin/lib/export-utils");
const BundleUtils = require("../admin/lib/bundle-utils");

const ADMIN_TOKEN = "kqCqlox5SZfkc_cjuye611XxPEpLpaxFOeUpH200Vu4"; // 模拟公司 access_token（43字符随机串）

function buildTestConfig() {
  return ConfigCore.normalizeConfig({
    fields: [
      { key: "spec", label: "型号", source: "price", excel_aliases: ["型号"], searchable: true },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价", "面价"] },
    ],
    merger: { primary_field: "spec" },
    pricing: { decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
  });
}

const PRICE_ROWS = [
  { "型号": "WNMG080408-UC5115", "销售单价": "128.5" },
  { "型号": "APMT1604", "销售单价": "66" },
];

test("端到端：管理员加密包含完整面价，token 可解密还原", async () => {
  const cfg = buildTestConfig();
  // admin 后台一键同步：desensitize=false + token 加密
  const result = await ExportUtils.createPriceBundleScript(PRICE_ROWS, ADMIN_TOKEN, cfg, { desensitize: false });
  assert.equal(result.bundle.secured, true, "管理员包必须加密");

  // apps 端：parsePriceBundle 内部走 decryptData（与 BundleUtils.decryptText 同布局）
  const dataset = await BundleUtils.decodePriceBundle(result.bundle, ADMIN_TOKEN);
  assert.equal(dataset.schema_version, 2);
  assert.equal(dataset.rows.length, 2);
  const row = dataset.rows[0];
  assert.equal(row.key, "WNMG080408-UC5115");
  assert.equal(Number(row.fields.face_price), 128.5, "管理员包必须含完整面价");
});

test("安全：错误 token 无法解密管理员包", async () => {
  const cfg = buildTestConfig();
  const result = await ExportUtils.createPriceBundleScript(PRICE_ROWS, ADMIN_TOKEN, cfg, { desensitize: false });
  await assert.rejects(
    () => BundleUtils.decodePriceBundle(result.bundle, "wrong-token"),
    /解密|decrypt|operation/i,
  );
});

test("安全：公开脱敏包不含面价（与管理员包并存的前提）", async () => {
  const cfg = buildTestConfig();
  const result = await ExportUtils.createPriceBundleScript(PRICE_ROWS, "", cfg, { desensitize: true });
  assert.equal(result.bundle.secured, false);
  const dataset = await BundleUtils.decodePriceBundle(result.bundle, "");
  assert.equal(dataset.rows[0].fields.face_price, undefined, "公开包不得含面价");
  assert.ok(dataset.rows[0].fields.quote_price, "公开包必须含预计算报价");
});

// ─── getDataSourceConfig 角色切换（vm 沙箱加载 data-load.js）────────────

function loadDataLoadModule({ profile, supabaseBaseUrl, configBaseUrl }) {
  const context = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    SUPABASE_BASE_URL: supabaseBaseUrl || "",
    // mock 全局依赖
    getAuthProfile: () => profile,
    getAppConfig: () => ({ data_source: { base_url: configBaseUrl || "" } }),
    getCompanyId: () => "admin",
    getApiBase: () => "https://api.example.com",
    window: {},
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "../apps/lib/data-load.js"), "utf8");
  vm.runInContext(code, context);
  return context;
}

test("getDataSourceConfig：admin 角色 + Supabase → 管理员加密包文件名", () => {
  const ctx = loadDataLoadModule({
    profile: { role: "admin" },
    configBaseUrl: "https://xxx.supabase.co/storage/v1/object/public/bundles",
  });
  const source = ctx.getDataSourceConfig();
  assert.equal(source.price_bundle_file, "price.admin.bundle.json");
  assert.equal(source.public_price_bundle_file, "price.bundle.json", "回退文件名必须是公开脱敏包");
});

test("getDataSourceConfig：company 角色 + Supabase → 公开脱敏包（行为不变）", () => {
  const ctx = loadDataLoadModule({
    profile: { role: "company" },
    configBaseUrl: "https://xxx.supabase.co/storage/v1/object/public/bundles",
  });
  const source = ctx.getDataSourceConfig();
  assert.equal(source.price_bundle_file, "price.bundle.json");
});

test("getDataSourceConfig：stock_only 角色 → 公开脱敏包（行为不变）", () => {
  const ctx = loadDataLoadModule({
    profile: { role: "stock_only" },
    configBaseUrl: "https://xxx.supabase.co/storage/v1/object/public/bundles",
  });
  assert.equal(ctx.getDataSourceConfig().price_bundle_file, "price.bundle.json");
});

test("getDataSourceConfig：admin 角色 + 后端代理（无 Supabase）→ 普通文件名（后端按角色生成）", () => {
  const ctx = loadDataLoadModule({
    profile: { role: "admin" },
    supabaseBaseUrl: "",
    configBaseUrl: "",
  });
  const source = ctx.getDataSourceConfig();
  assert.equal(source.price_bundle_file, "price.bundle.json");
  assert.equal(source.base_url, "https://api.example.com", "无 Supabase 时回退后端代理");
});

test("getDataSourceConfig：未登录（无 profile）→ 公开脱敏包", () => {
  const ctx = loadDataLoadModule({
    profile: null,
    configBaseUrl: "https://xxx.supabase.co/storage/v1/object/public/bundles",
  });
  assert.equal(ctx.getDataSourceConfig().price_bundle_file, "price.bundle.json");
});
