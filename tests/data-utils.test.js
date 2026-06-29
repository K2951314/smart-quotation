const assert = require("node:assert/strict");
const test = require("node:test");

const ConfigCore = require("../apps/lib/config-core");
const DataUtils = require("../admin/lib/data-utils");

test("buildPriceDataset emits v2 rows from configured Excel aliases", () => {
  const config = ConfigCore.normalizeConfig({
    fields: [
      { key: "code", label: "编码", source: "price", excel_aliases: ["编码"] },
      { key: "spec", label: "型号", source: "price", excel_aliases: ["型号"], required: true },
      { key: "face_price", label: "价格", type: "number", source: "price", excel_aliases: ["价格"] },
      { key: "delivery", label: "交期", source: "price", excel_aliases: ["交期"], searchable: true, copyable: true },
    ],
    merger: { primary_field: "spec" },
  });

  const dataset = DataUtils.buildPriceDataset([
    { 编码: "C001", 型号: "WNMG080408", 价格: "88.6", 交期: "现货", brand: "OSG" },
  ], config);

  assert.equal(dataset.schema_version, 2);
  assert.equal(dataset.primary_field, "spec");
  assert.deepEqual(dataset.rows, [
    {
      key: "WNMG080408",
      fields: {
        code: "C001",
        spec: "WNMG080408",
        face_price: 88.6,
        delivery: "现货",
        brand: "OSG",
      },
    },
  ]);
});

test("buildStockDataset emits v2 stock rows from configured stock columns", () => {
  const config = ConfigCore.normalizeConfig({
    merger: {
      stock_key_field: "code",
      stock_columns: {
        code: ["物料"],
        warehouse: ["仓库"],
        quantity: ["数量"],
        status: ["状态"],
      },
    },
  });

  const dataset = DataUtils.buildStockDataset([
    { 物料: "C001", 仓库: "上海", 数量: "3", 状态: "可用" },
    { 物料: "C001", 仓库: "宁波", 数量: "0", 状态: "" },
  ], config);

  assert.equal(dataset.schema_version, 2);
  assert.equal(dataset.key_field, "code");
  assert.deepEqual(dataset.rows, [
    { key: "C001", fields: { code: "C001", stock: "上海:3(可用)" } },
  ]);
});
