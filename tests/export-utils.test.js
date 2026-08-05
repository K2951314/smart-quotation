const assert = require("node:assert/strict");
const test = require("node:test");

const ConfigCore = require("../apps/lib/config-core");
const ExportUtils = require("../admin/lib/export-utils");
const BundleUtils = require("../admin/lib/bundle-utils");

test("createPriceBundleScript passes custom config through to v2 payload", async () => {
  const config = ConfigCore.normalizeConfig({
    fields: [
      { key: "sku", label: "SKU", source: "price", excel_aliases: ["SKU"], required: true },
      { key: "spec", label: "规格", source: "price", excel_aliases: ["规格"] },
      { key: "face_price", label: "价格", type: "number", source: "price", excel_aliases: ["价格"] },
    ],
    merger: { primary_field: "sku" },
  });

  const result = await ExportUtils.createPriceBundleScript([
    { SKU: "S-001", 规格: "WNMG080408", 价格: "18" },
  ], "", config);
  const decoded = BundleUtils.decodePlainPayload(result.bundle.payload);
  const payload = JSON.parse(decoded);

  assert.equal(result.script.trim().startsWith("{"), true);
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.primary_field, "sku");
  assert.equal(payload.rows[0].key, "S-001");
});

test("createStockBundleScript passes custom stock config through to v2 payload", () => {
  const config = ConfigCore.normalizeConfig({
    merger: {
      stock_key_field: "code",
      stock_columns: {
        code: ["编码"],
        warehouse: ["库位"],
        quantity: ["可用"],
        status: ["状态"],
      },
    },
  });

  const result = ExportUtils.createStockBundleScript([
    { 编码: "C001", 库位: "A仓", 可用: "7", 状态: "正常" },
  ], config);
  const payload = JSON.parse(BundleUtils.decodePlainPayload(result.bundle.payload));

  assert.equal(payload.schema_version, 2);
  assert.equal(payload.key_field, "code");
  assert.deepEqual(payload.rows, [
    { key: "C001", fields: { code: "C001", stock: "A仓:7(正常)" } },
  ]);
});

test("desensitizePriceDataset uses admin discount rules (not 55% fallback) when contains condition matches", async () => {
  // 回归：_conditionMatches 的 contains 操作符曾逻辑反转（检查"条件值包含字段值"
  // 而非"字段值包含条件值"），导致规则匹配失败、quote_price 退回默认 55%，
  // 客户端最终拿到"统一五五折"而非管理端配置的真实折扣。
  const config = {
    schema_version: 3,
    fields: [
      { key: "spec", label: "规格型号", source: "price", excel_aliases: ["规格型号"], searchable: true, copyable: true, required: true, result_area: "identity" },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["面价"], searchable: false, copyable: false, required: false, result_area: "metric" },
      { key: "brand", label: "品牌", source: "price", excel_aliases: ["品牌"], searchable: false, copyable: false, required: false, result_area: "detail" },
    ],
    merger: { primary_field: "spec" },
    pricing: { decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
    rules: [
      { id: "osg", label: "OSG", priority: 10, when: { all: [{ field: "brand", op: "contains", value: "OSG" }] }, actions: [{ type: "set_discount", percent: 32 }] },
      { id: "default", label: "默认", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 55 }] },
    ],
  };

  const result = await ExportUtils.createPriceBundleScript(
    [{ "规格型号": "WNMG080408", "面价": "100", "品牌": "OSG-Tool" }],
    "",
    config,
    { desensitize: true }
  );
  const payload = JSON.parse(BundleUtils.decodePlainPayload(result.bundle.payload));
  const row = payload.rows[0];

  // face_price 必须被移除（脱敏）
  assert.equal(row.fields.face_price, undefined, "face_price should be removed after desensitization");
  // quote_price 必须基于管理端折扣 32% 计算（toFixed(1) 格式与后端对齐），而不是默认 55%
  assert.equal(row.fields.quote_price, "32.0", "quote_price should use admin discount (32%), not 55% fallback");
});

test("desensitizePriceDataset falls back to default rule when no condition matches", async () => {
  const config = {
    schema_version: 3,
    fields: [
      { key: "spec", label: "规格型号", source: "price", excel_aliases: ["规格型号"], required: true },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["面价"] },
      { key: "brand", label: "品牌", source: "price", excel_aliases: ["品牌"] },
    ],
    merger: { primary_field: "spec" },
    pricing: { decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
    rules: [
      { id: "osg", label: "OSG", priority: 10, when: { all: [{ field: "brand", op: "contains", value: "OSG" }] }, actions: [{ type: "set_discount", percent: 32 }] },
      { id: "default", label: "默认", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 45 }] },
    ],
  };

  const result = await ExportUtils.createPriceBundleScript(
    [{ "规格型号": "WNMG080408", "面价": "100", "品牌": "MITSUBISHI" }],
    "",
    config,
    { desensitize: true }
  );
  const payload = JSON.parse(BundleUtils.decodePlainPayload(result.bundle.payload));
  const row = payload.rows[0];

  assert.equal(row.fields.face_price, undefined);
  // 未匹配 OSG 规则 → 走默认 45%
  assert.equal(row.fields.quote_price, "45.0");
});

test("desensitizePriceDataset removes all sensitive fields, not just face_price", async () => {
  // 回归：前端 SENSITIVE_FIELDS 曾只有 2 个字段，后端有 15 个。
  // 若 admin 在 config 里定义了 cost/margin 等字段，会泄露到 Supabase public bucket。
  const config = {
    schema_version: 3,
    fields: [
      { key: "spec", label: "规格型号", source: "price", excel_aliases: ["规格型号"], required: true },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["面价"] },
      { key: "cost", label: "成本", type: "number", source: "price", excel_aliases: ["成本"] },
      { key: "margin", label: "利润", type: "number", source: "price", excel_aliases: ["利润"] },
    ],
    merger: { primary_field: "spec" },
    pricing: { decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
    rules: [
      { id: "default", label: "默认", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 50 }] },
    ],
  };

  const result = await ExportUtils.createPriceBundleScript(
    [{ "规格型号": "WNMG080408", "面价": "100", "成本": "60", "利润": "20" }],
    "",
    config,
    { desensitize: true }
  );
  const payload = JSON.parse(BundleUtils.decodePlainPayload(result.bundle.payload));
  const row = payload.rows[0];

  assert.equal(row.fields.face_price, undefined, "face_price must be removed");
  assert.equal(row.fields.cost, undefined, "cost must be removed (sensitive)");
  assert.equal(row.fields.margin, undefined, "margin must be removed (sensitive)");
  assert.equal(row.fields.quote_price, "50.0", "quote_price = 100 * 50% = 50.0");
});

test("desensitizePriceDataset honors config.security.sensitive_fields override", async () => {
  const config = {
    schema_version: 3,
    fields: [
      { key: "spec", label: "规格型号", source: "price", excel_aliases: ["规格型号"], required: true },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["面价"] },
      { key: "internal_note", label: "内部备注", source: "price", excel_aliases: ["内部备注"] },
    ],
    merger: { primary_field: "spec" },
    pricing: { decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
    security: { sensitive_fields: ["face_price", "internal_note"] },
    rules: [
      { id: "default", label: "默认", priority: 9999, default: true, actions: [{ type: "set_discount", percent: 50 }] },
    ],
  };

  const result = await ExportUtils.createPriceBundleScript(
    [{ "规格型号": "WNMG080408", "面价": "100", "内部备注": "采购价 60" }],
    "",
    config,
    { desensitize: true }
  );
  const payload = JSON.parse(BundleUtils.decodePlainPayload(result.bundle.payload));
  const row = payload.rows[0];

  assert.equal(row.fields.face_price, undefined, "face_price removed per override");
  assert.equal(row.fields.internal_note, undefined, "internal_note removed per override");
  assert.equal(row.fields.spec, "WNMG080408", "spec preserved");
});
