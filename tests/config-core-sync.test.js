const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// 防漂移守卫：apps/ 与 admin/ 的 config-core.js 必须逐字节一致。
// 两份文件是手工复制维护的，若单边修改 normalizePricing 等核心逻辑，
// admin 写出的 config.json 与客户台的解析会静默分叉（历史 bug：取整字段错配）。
// 若本测试失败，请运行 `py scripts/sync-config-core.py` 同步（以 apps 版为基准）。
const appsPath = path.join(__dirname, "..", "apps", "lib", "config-core.js");
const adminPath = path.join(__dirname, "..", "admin", "lib", "config-core.js");

test("apps 与 admin 的 config-core.js 逐字节一致", () => {
  const apps = fs.readFileSync(appsPath, "utf8");
  const admin = fs.readFileSync(adminPath, "utf8");
  assert.equal(apps.length > 0, true, "apps/lib/config-core.js 不应为空");
  assert.equal(apps, admin, "两份 config-core.js 不一致，请运行 py scripts/sync-config-core.py 同步");
});
