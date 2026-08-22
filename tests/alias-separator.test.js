/**
 * 回归测试：Excel 别名分隔符导致价格变 0 的问题（2026-08-21 修复）。
 *
 * 事故链路：config-collect.js 旧 split(/[,，]+/) 只认逗号 →
 * 用户在"Excel 别名"输入框用顿号/分号分隔 → 整串成一个别名 →
 * Excel 列名匹配失败 → face_price 缺失 → 脱敏预计算报价 = 0 → 客户端价格显示 0。
 *
 * 修复验证点：
 *   1. collectConfig 的别名收集正则（此处直接复刻修复后的正则验证拆分行为）
 *   2. diagnosePriceMapping 能检测到面价未匹配（消灭静默失败）
 *   3. 后端 normalize_field 同步拆分（由 test_alias_separator.py 验证 Python 侧）
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const ConfigCore = require("../apps/lib/config-core");
const DataUtils = require("../admin/lib/data-utils");
const ExportUtils = require("../admin/lib/export-utils");

// 与 admin/lib/config-collect.js 修复后的正则保持一致
const ALIAS_SPLIT_RE = /[,，、;；|｜\t\n\r]+/;

function collectAliases(value) {
  return value.split(ALIAS_SPLIT_RE).map((item) => item.trim()).filter(Boolean);
}

test("别名收集：支持逗号/顿号/分号/竖线/制表符/换行分隔", () => {
  assert.deepEqual(collectAliases("销售单价, 面价, 目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价，面价，目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价、面价、目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价；面价；目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价; 面价; 目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价|面价|目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价｜面价｜目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases("销售单价\t面价\n目录价"), ["销售单价", "面价", "目录价"]);
  assert.deepEqual(collectAliases(""), []);
  assert.deepEqual(collectAliases("、,,；"), []);
});

test("别名收集：英文别名中的空格不被拆分", () => {
  assert.deepEqual(collectAliases("List Price, Unit Cost"), ["List Price", "Unit Cost"]);
});

function buildConfig(excelAliases) {
  return ConfigCore.normalizeConfig({
    fields: [
      { key: "code", label: "代码", source: "price", excel_aliases: collectAliases("代码, 货号") },
      { key: "spec", label: "型号", source: "price", excel_aliases: collectAliases("规格型号, 型号") },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: collectAliases(excelAliases) },
    ],
    merger: { primary_field: "spec" },
    pricing: { tax_rate: 13, face_price_tax_inclusive: true, decimal_places: 1, rounding: { mode: "ceil", integer_above: 100 } },
  });
}

const EXCEL_ROW = { "代码": "15.03.001A", "型号": "WNMG080408-UC5115", "销售单价": "128.5" };

test("端到端：顿号分隔别名（修复后）报价不再为 0", async () => {
  const cfg = buildConfig("销售单价、面价、目录价");
  const merged = DataUtils.mergePriceTables([[EXCEL_ROW]], cfg);
  const result = await ExportUtils.createPriceBundleScript(merged, "", cfg, { desensitize: true });
  const row = result.dataset.rows[0];
  assert.ok(row, "数据行不应被丢弃");
  // 128.5 × 55% = 70.675；ceil 到一位小数为 70.7，折后价未超过阈值 100，不取整为整数。
  assert.equal(row.fields.quote_price, "70.7");
});

test("端到端：分号分隔别名（修复后）报价不再为 0", async () => {
  const cfg = buildConfig("销售单价；面价；目录价");
  const merged = DataUtils.mergePriceTables([[EXCEL_ROW]], cfg);
  const result = await ExportUtils.createPriceBundleScript(merged, "", cfg, { desensitize: true });
  assert.equal(result.dataset.rows[0].fields.quote_price, "70.7");
});

test("diagnosePriceMapping：面价未匹配时返回缺失字段（消灭静默失败）", () => {
  // 模拟坏别名（整串未拆分，等同修复前的数据）
  const badCfg = ConfigCore.normalizeConfig({
    fields: [
      { key: "code", label: "代码", source: "price", excel_aliases: ["代码", "货号"] },
      { key: "spec", label: "型号", source: "price", excel_aliases: ["规格型号", "型号"] },
      { key: "face_price", label: "面价", type: "number", source: "price", excel_aliases: ["销售单价、面价、目录价"] },
    ],
    merger: { primary_field: "spec" },
  });
  const missing = DataUtils.diagnosePriceMapping([EXCEL_ROW], badCfg);
  assert.ok(missing, "应检测到面价字段缺失");
  assert.equal(missing[0].key, "face_price");

  // 正常配置不应报警
  const goodCfg = buildConfig("销售单价, 面价, 目录价");
  assert.equal(DataUtils.diagnosePriceMapping([EXCEL_ROW], goodCfg), null);
});
