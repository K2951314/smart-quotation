const assert = require("node:assert/strict");
const test = require("node:test");

// stock-query.js 是浏览器脚本，Node 下 require 需预置最小全局桩（仅 buildStockClipboardLine 用到）
global.document = { getElementById: () => null };
global.getCopyColumns = () => [{ field: "spec", label: "规格", line: "main", default: true }];
global.makeCopyCheckboxId = (field) => "cb_" + field;
global.getCurrentPriceSettings = () => ({ decimals: 2, threshold: 100 });
global.fieldToRowProp = (field) => field;

const StockQuery = require("../apps/lib/stock-query");

test("isMitsubishiRow 只放行名称字段包含'刀具'的行", () => {
  assert.equal(StockQuery.isMitsubishiRow({ name: "刀具" }), true);
  assert.equal(StockQuery.isMitsubishiRow({ name: "三菱刀具" }), true);
  assert.equal(StockQuery.isMitsubishiRow({ name: "立铣刀具(盘铣刀)" }), true);
  assert.equal(StockQuery.isMitsubishiRow({ name: "MITSUBISHI" }), false);
  assert.equal(StockQuery.isMitsubishiRow({ name: "铣刀" }), false);
  assert.equal(StockQuery.isMitsubishiRow({ brand: "三菱", name: "车刀" }), false);
  assert.equal(StockQuery.isMitsubishiRow({ name: "" }), false);
  assert.equal(StockQuery.isMitsubishiRow({}), false);
  assert.equal(StockQuery.isMitsubishiRow(null), false);
});

test("parseStockResultLine 解析后端 上海库存N/日本库存M 行与厂家无货行", () => {
  const r = StockQuery.parseStockResultLine("WNMG080408 UC5115 上海库存3 日本库存2");
  assert.equal(r.shanghai, 3);
  assert.equal(r.japan, 2);
  assert.equal(r.error, null);

  const zero = StockQuery.parseStockResultLine("WNMG080408 厂家无货");
  assert.equal(zero.shanghai, 0);
  assert.equal(zero.japan, 0);
  assert.equal(zero.error, null);
});

test("buildStockClipboardLine 输出 上海库存/日本库存（消除与价格混淆的歧义）", () => {
  const line = StockQuery.buildStockClipboardLine(
    { spec: "WNMG080408" },
    { shanghai: 3, japan: 2, error: null, needsTerminal: false }
  );
  assert.equal(line, "WNMG080408 上海库存3 日本库存2");
});

test("buildStockClipboardLine 三菱型号查到但 0 库存时输出 厂家无货", () => {
  const line = StockQuery.buildStockClipboardLine(
    { spec: "WNMG080408" },
    { shanghai: 0, japan: 0, error: null, needsTerminal: false }
  );
  assert.equal(line, "WNMG080408 厂家无货");
});

test("buildStockClipboardLine 带商流标记时追加 需要提供终端客户", () => {
  const line = StockQuery.buildStockClipboardLine(
    { spec: "WNMG080408" },
    { shanghai: 5, japan: 0, error: null, needsTerminal: true }
  );
  assert.equal(line, "WNMG080408 上海库存5 需要提供终端客户");
});
