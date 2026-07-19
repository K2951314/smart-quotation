import base64
import json
import tempfile
import unittest
from pathlib import Path

from backend.smart_quotation.config import normalize_config, validate_config
from backend.smart_quotation.engine import QuotationEngine
from backend.smart_quotation.store import QuotationStore


class BackendV1Test(unittest.TestCase):
    def make_store(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        store = QuotationStore(str(db_path))
        store.init_schema()
        return store

    def test_imports_v2_config_as_schema_v3(self):
        store = self.make_store()
        config = store.normalize_config({
            "schema_version": 2,
            "version": "2026-06-01.1",
            "pricing": {
                "decimal_places": 1,
                "rounding_threshold": 100,
            },
            "fields": [
                {"key": "spec", "label": "规格型号", "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "type": "number"},
            ],
            "discount_rules": [
                {"id": "other", "label": "默认", "percent": 55, "default": True, "conditions": []}
            ],
        })

        self.assertEqual(config["schema_version"], 3)
        self.assertEqual(config["revision"], "2026-06-01.1")
        self.assertEqual(config["pricing"]["default_formula"], "face_price * discount_percent / 100")
        self.assertEqual(config["rules"][0]["actions"][0], {"type": "set_discount", "percent": 55})

    def test_quotes_with_rule_priority_and_rounding(self):
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "pricing": {
                "decimal_places": 1,
                "rounding": {"mode": "ceil", "integer_above": 100},
                "default_formula": "face_price * discount_percent / 100",
            },
            "fields": [
                {"key": "spec", "label": "规格型号", "searchable": True, "required": True},
                {"key": "special", "label": "特价", "searchable": True},
                {"key": "face_price", "label": "面价", "type": "number"},
                {"key": "quote_price", "label": "报价", "type": "computed", "copyable": True},
            ],
            "rules": [
                {
                    "id": "ex",
                    "label": "EX",
                    "priority": 10,
                    "when": {"all": [{"field": "special", "op": "contains", "value": "EX活动"}]},
                    "actions": [{"type": "set_discount", "percent": 32}],
                },
                {
                    "id": "default",
                    "label": "默认",
                    "priority": 9999,
                    "default": True,
                    "actions": [{"type": "set_discount", "percent": 55}],
                },
            ],
        }
        store.save_config(config, status="published")
        store.replace_items("d1", [
            {"item_key": "WNMG080408", "fields": {"spec": "WNMG080408", "special": "EX活动", "face_price": 101}},
        ])

        results = QuotationEngine(store).quote("WNMG")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["matched_rule"], "ex")
        self.assertEqual(results[0]["fields"]["quote_price"], "33")

    def test_query_returns_only_requested_keys(self):
        """查询 A-001 不应返回 B-001"""
        store = self.make_store()
        base_config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(base_config, status="published")
        store.replace_items("d1", [
            {"item_key": "A-001", "fields": {"spec": "A-001"}},
            {"item_key": "B-001", "fields": {"spec": "B-001"}},
        ])

        engine = QuotationEngine(store)
        self.assertEqual([r["item_key"] for r in engine.quote("A")], ["A-001"])
        self.assertEqual(engine.quote("X"), [])

    def test_publishing_invalidates_config_cache(self):
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(config, status="published")
        self.assertEqual(store.get_active_config()["revision"], "r1")

        store.save_config({**config, "revision": "r2"}, status="published")
        self.assertEqual(store.get_active_config()["revision"], "r2")

    def test_rollback_config_restores_previous_revision(self):
        """发布 r2 后回滚到 r1，active config 应变回 r1"""
        store = self.make_store()
        base = {
            "schema_version": 3,
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config({**base, "revision": "r1"}, status="published")
        store.save_config({**base, "revision": "r2"}, status="published")
        self.assertEqual(store.get_active_config()["revision"], "r2")

        store.rollback_config("r1")
        self.assertEqual(store.get_active_config()["revision"], "r1")

    def test_version_history_lists_all_revisions(self):
        """list_configs 应列出全部版本"""
        store = self.make_store()
        base = {
            "schema_version": 3,
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config({**base, "revision": "r1"}, status="published")
        store.save_config({**base, "revision": "r2"}, status="draft")

        configs = store.list_configs()
        revisions = {c["revision"] for c in configs}
        self.assertIn("r1", revisions)
        self.assertIn("r2", revisions)

    def test_items_stats_returns_count_and_revision(self):
        """get_items_stats 应返回条数和版本"""
        store = self.make_store()
        store.replace_items("rev-1", [
            {"item_key": "A", "fields": {"spec": "A"}},
            {"item_key": "B", "fields": {"spec": "B"}},
        ])

        stats = store.get_items_stats()
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["data_revision"], "rev-1")

    def test_audit_log_records_config_publish(self):
        """发布配置后审计日志应有记录"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(config, status="published")

        events = store.list_audit()
        self.assertTrue(any(e["action"] == "config.published" for e in events))

    def test_validate_config_rejects_missing_default_rule(self):
        """缺少 default rule 时 validate_config 应抛出 ValueError"""
        config = {
            "schema_version": 3,
            "fields": [{"key": "spec", "required": True}],
            "rules": [
                {"id": "some_rule", "actions": [{"type": "set_discount", "percent": 30}]},
            ],
        }
        with self.assertRaises(ValueError, msg="rules must include one default rule"):
            validate_config(config)

    def test_validate_config_rejects_forbidden_formula(self):
        """含有 __import__ 的公式应被拒绝"""
        config = {
            "schema_version": 3,
            "fields": [{"key": "spec", "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
            "pricing": {
                "default_formula": "__import__('os').system('ls')",
            },
        }
        with self.assertRaises(ValueError):
            validate_config(config)

    def test_validate_config_rejects_unknown_action_type(self):
        """非法 action type 应被拒绝"""
        config = {
            "schema_version": 3,
            "fields": [{"key": "spec", "required": True}],
            "rules": [
                {"id": "default", "default": True, "actions": [{"type": "exec_code", "code": "import os"}]},
            ],
        }
        with self.assertRaises(ValueError):
            validate_config(config)

    def test_parse_csv_to_rows(self):
        """parse_excel_to_rows 可以解析 CSV 内容并按 excel_aliases 映射字段"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [
                {"key": "spec", "label": "规格", "excel_aliases": ["规格型号", "型号"], "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "excel_aliases": ["销售单价", "面价"], "searchable": False},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
        }
        store.save_config(config, status="published")

        csv_content = "规格型号,销售单价,备注\nWNMG080408,101.0,测试\nTNMG160408,88.0,\n".encode("utf-8")
        rows, report = store.parse_excel_to_rows(csv_content, "test.csv")

        self.assertEqual(len(rows), 2)
        self.assertIn("spec", {k for row in rows for k in row["fields"]})
        self.assertIn("spec", report["matched"])
        self.assertIn("备注", report["unmatched"])

    def test_engine_validate_config_detects_missing_default(self):
        """engine.validate_config 应检测出缺少默认规则"""
        store = self.make_store()
        engine = QuotationEngine(store)
        config = {
            "fields": [{"key": "spec"}],
            "rules": [{"id": "r1", "actions": [{"type": "set_discount", "percent": 30}]}],
            "pricing": {"default_formula": "face_price * discount_percent / 100"},
        }

        errors = engine.validate_config(config)
        self.assertTrue(any("默认规则" in e for e in errors))

    def test_engine_validate_config_passes_valid_config(self):
        """engine.validate_config 对合法配置应返回空列表"""
        store = self.make_store()
        engine = QuotationEngine(store)
        config = {
            "fields": [
                {"key": "spec", "searchable": True, "required": True},
                {"key": "face_price", "type": "number"},
            ],
            "rules": [
                {"id": "ex", "when": {"all": [{"field": "spec", "op": "contains", "value": "EX"}]}, "actions": [{"type": "set_discount", "percent": 32}]},
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]},
            ],
            "pricing": {"default_formula": "face_price * discount_percent / 100"},
            "copy": {"columns": [{"field": "spec"}, {"field": "quote_price"}]},
        }

        errors = engine.validate_config(config)
        self.assertEqual(errors, [])

    def test_detect_brands_by_filename_prefix(self):
        """detect_brands 按文件名前缀识别品牌"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
            "merger": {
                "brand_rules": {
                    "brands": [
                        {"id": "MMC", "prefixes": ["MMC", "三菱"]},
                        {"id": "OSG", "prefixes": ["OSG"]},
                    ],
                    "defaultBrand": "OTHER",
                }
            },
        }
        store.save_config(config, status="published")

        csv1 = "规格\nWNMG080408\n".encode("utf-8")
        csv2 = "规格\nTNMG160408\n".encode("utf-8")
        files = [("MMC_价格表.csv", csv1), ("OSG_catalog.csv", csv2)]

        results = store.detect_brands(files)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["detected_brand"], "MMC")
        self.assertEqual(results[1]["detected_brand"], "OSG")

    def test_detect_brands_default_for_unknown(self):
        """无法识别的文件名应返回默认品牌"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
            "merger": {
                "brand_rules": {
                    "brands": [{"id": "MMC", "prefixes": ["MMC"]}],
                    "defaultBrand": "OTHER",
                }
            },
        }
        store.save_config(config, status="published")

        csv1 = "规格\nWNMG080408\n".encode("utf-8")
        files = [("unknown_brand.csv", csv1)]

        results = store.detect_brands(files)
        self.assertEqual(results[0]["detected_brand"], "OTHER")

    def test_build_price_bundle_without_encryption(self):
        """build_price_bundle 不加密时应返回 base64 编码的明文"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
        }
        store.save_config(config, status="published")
        store.replace_items("r1", [
            {"item_key": "WNMG080408", "fields": {"spec": "WNMG080408", "face_price": 101.0}},
        ])

        bundle = store.build_price_bundle(password="")

        self.assertFalse(bundle["secured"])
        self.assertIn("payload", bundle)
        self.assertEqual(bundle["meta"]["rowCount"], 1)

    def test_company_bundle_uses_canonical_engine(self):
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "pricing": {
                "decimal_places": 1,
                "default_formula": "face_price * discount_percent / 100 * 0.9",
            },
            "fields": [
                {"key": "spec", "label": "规格", "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "type": "number"},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(config, status="published")
        store.replace_items("r1", [
            {"item_key": "A", "fields": {"spec": "A", "face_price": 100}},
        ])

        canonical_price = QuotationEngine(store).quote("A")[0]["fields"]["quote_price"]
        bundle = store.build_price_bundle(role="company")
        bundle_price = json.loads(base64.b64decode(bundle["payload"]))["rows"][0]["fields"]["quote_price"]

        self.assertEqual(canonical_price, "45.0")
        self.assertEqual(bundle_price, "45.0")

    def test_build_price_bundle_with_encryption(self):
        """build_price_bundle 加密时应返回 secured=True"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
        }
        store.save_config(config, status="published")
        store.replace_items("r1", [
            {"item_key": "WNMG080408", "fields": {"spec": "WNMG080408", "face_price": 101.0}},
        ])

        bundle = store.build_price_bundle(password="test_password")

        self.assertTrue(bundle["secured"])
        self.assertIn("payload", bundle)
        self.assertEqual(bundle["meta"]["rowCount"], 1)

    def test_build_stock_bundle(self):
        """build_stock_bundle 只包含有 stock 字段的行"""
        store = self.make_store()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
        }
        store.save_config(config, status="published")
        store.replace_items("r1", [
            {"item_key": "WNMG080408", "fields": {"spec": "WNMG080408", "stock": "10"}},
            {"item_key": "TNMG160408", "fields": {"spec": "TNMG160408", "stock": ""}},
            {"item_key": "CCMT09T304", "fields": {"spec": "CCMT09T304"}},
        ])

        bundle = store.build_stock_bundle()

        self.assertFalse(bundle["secured"])
        self.assertEqual(bundle["meta"]["rowCount"], 1)

    def test_build_supabase_write_url(self):
        """build_supabase_write_url 应将 public URL 转为写入 URL"""
        public = "https://xxx.supabase.co/storage/v1/object/public/bundles/price.bundle.json"
        write = QuotationStore.build_supabase_write_url(public)
        self.assertIn("/storage/v1/object/bundles/price.bundle.json", write)
        self.assertNotIn("/object/public/", write)


if __name__ == "__main__":
    unittest.main()
