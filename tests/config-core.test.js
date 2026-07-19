const assert = require("node:assert/strict");
const test = require("node:test");

const ConfigCore = require("../apps/lib/config-core");

test("normalizes partial v2 config with safe defaults", () => {
  const config = ConfigCore.normalizeConfig({
    schema_version: 2,
    pricing: {
      decimal_places: 2,
      discount_step: { default: 0.5, presets: [0.25, 0.5, 1] },
    },
    fields: [
      { key: "code", label: "货号", excel_aliases: ["货号"], searchable: true, copyable: true },
      { key: "spec", label: "型号", excel_aliases: ["型号"], searchable: true, required: true },
      { key: "face_price", label: "目录价", type: "number", excel_aliases: ["目录价"] },
    ],
  });

  assert.equal(config.schema_version, 2);
  assert.equal(config.pricing.decimal_places, 2);
  assert.equal(config.pricing.rounding_threshold, 100);
  assert.deepEqual(config.pricing.discount_step.presets, [0.25, 0.5, 1]);
  assert.equal(ConfigCore.getField(config, "code").label, "货号");
  assert.equal(ConfigCore.getField(config, "stock").label, "库存");
});

test("normalizes config-level version and current Supabase bucket defaults", () => {
  const config = ConfigCore.normalizeConfig({
    schema_version: 2,
    version: "2026-06-01.1",
  });

  assert.equal(config.version, "2026-06-01.1");
  // base_url 默认为空字符串（由部署期 window.SQ_SUPABASE_BASE_URL 或 admin 配置注入）
  // 源码中不得硬编码真实 Supabase URL（安全规则）
  assert.equal(config.data_source.base_url, "");
  assert.equal(ConfigCore.getConfigVersion(config), "2026-06-01.1");
});

test("falls back to legacy version fields for cache version compatibility", () => {
  assert.equal(
    ConfigCore.getConfigVersion({ data_source: { cache_version: "2026-06-legacy" } }),
    "2026-06-legacy"
  );
  assert.equal(ConfigCore.getConfigVersion({}), "");
});

test("maps Excel rows by configured aliases and preserves configured extra fields", () => {
  const config = ConfigCore.normalizeConfig({
    fields: [
      { key: "code", label: "编码", excel_aliases: ["编码"], source: "price", searchable: true },
      { key: "spec", label: "规格", excel_aliases: ["产品型号"], source: "price", required: true },
      { key: "face_price", label: "单价", type: "number", excel_aliases: ["含税单价"], source: "price" },
      { key: "delivery", label: "交期", excel_aliases: ["交期"], source: "price", searchable: true, copyable: true },
    ],
  });

  const fields = ConfigCore.mapExcelRowToFields({
    编码: "A-001",
    产品型号: "WNMG080408",
    含税单价: "1,234.50",
    交期: "现货",
  }, config, "price");

  assert.deepEqual(fields, {
    code: "A-001",
    spec: "WNMG080408",
    face_price: 1234.5,
    delivery: "现货",
  });
});

test("adapts legacy bundles into the v2 internal row model and joins stock", () => {
  const config = ConfigCore.normalizeConfig({});
  const priceRows = ConfigCore.adaptPricePayload({
    bySpec: {
      WNMG080408: {
        c: "C001",
        p: 100,
        s: "EX活动",
        r: "常用",
        b: "OSG",
        n: "刀具",
        m: "ABC",
        a: "别名",
      },
    },
  }, config);
  const stockRows = ConfigCore.adaptStockPayload({ byCode: { C001: "上海:2" } }, config);
  const rows = ConfigCore.mergePriceAndStockRows(priceRows, stockRows, config);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "WNMG080408");
  assert.equal(rows[0].fields.code, "C001");
  assert.equal(rows[0].fields.spec, "WNMG080408");
  assert.equal(rows[0].fields.face_price, 100);
  assert.equal(rows[0].fields.stock, "上海:2");
});

test("search, discount rules, and copy output are driven by config", () => {
  const config = ConfigCore.normalizeConfig({
    fields: [
      { key: "code", label: "代码", searchable: true, copyable: true },
      { key: "spec", label: "规格", searchable: true, copyable: true },
      { key: "face_price", label: "面价", type: "number" },
      { key: "quote_price", label: "报价", type: "computed", copyable: true },
      { key: "delivery", label: "交期", searchable: true, copyable: true },
    ],
    copy: {
      price_prefix: "含税",
      columns: [
        { field: "code", label: "代码", default: true, line: "main" },
        { field: "spec", label: "规格", default: true, line: "main" },
        { field: "quote_price", label: "报价", default: true, line: "main", prefix: "含税" },
        { field: "delivery", label: "交期", default: true, line: "detail", prefix: "交期 " },
      ],
    },
    discount_rules: [
      { id: "fast", label: "快速", percent: 40, conditions: [{ field: "delivery", contains: "现货" }] },
    ],
  });

  const row = {
    key: "WNMG080408",
    fields: {
      code: "C001",
      spec: "WNMG080408",
      face_price: 100,
      quote_price: "40",
      delivery: "现货",
    },
  };

  assert.equal(ConfigCore.rowMatchesText(row, "现货", config), true);
  assert.deepEqual(ConfigCore.getDiscountPreset(row, config), {
    percent: 40,
    label: "快速 40%",
    source: "fast",
    category: "fast",
  });
  assert.equal(
    ConfigCore.renderCopyText([row], config, ["code", "spec", "quote_price", "delivery"]),
    "C001 WNMG080408 含税40\n交期 现货\n"
  );
});

test("validates config and reports missing required pieces", () => {
  const result = ConfigCore.validateConfig({
    fields: [
      { key: "code", label: "代码" },
      { key: "", label: "空字段" },
    ],
    pricing: { discount_step: { presets: ["bad"] } },
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("fields[1].key")));
  assert.ok(result.errors.some((message) => message.includes("discount_step.presets")));
});
