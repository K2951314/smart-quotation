const assert = require("node:assert/strict");
const test = require("node:test");

const ConfigCore = require("../apps/lib/config-core");
const ExportUtils = require("../merger/lib/export-utils");
const BundleUtils = require("../merger/lib/bundle-utils");

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
