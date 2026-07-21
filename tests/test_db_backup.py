import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend.smart_quotation.store import QuotationStore
from backend.smart_quotation.store.db_backup import download_db


class _SqliteResponse:
    def read(self):
        return b"SQLite format 3\x00" + b"\x00" * 128

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False


class DbBackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = str(Path(self.tmp.name) / "quotation.db")

    def make_store(self):
        store = QuotationStore(self.db_path)
        store.init_schema()
        return store

    def test_download_uses_project_url_for_private_bucket(self):
        with patch.dict(os.environ, {
            "SQ_SUPABASE_PROJECT_URL": "https://project.supabase.co",
            "SQ_SUPABASE_SERVICE_KEY": "service-key",
        }, clear=True), patch("urllib.request.urlopen", return_value=_SqliteResponse()) as urlopen:
            self.assertTrue(download_db(self.db_path))

        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://project.supabase.co/storage/v1/object/sq-db-backup/quotation.db",
        )

    def test_company_create_requests_immediate_backup(self):
        store = self.make_store()
        manager = Mock()
        store.set_backup_manager(manager)

        store.create_company("tenant-a", "Tenant A")

        manager.mark_critical_dirty.assert_called_once_with()

    def test_config_save_requests_immediate_backup(self):
        store = self.make_store()
        manager = Mock()
        store.set_backup_manager(manager)

        store.save_config({"revision": "r1"}, status="published")

        manager.mark_critical_dirty.assert_called_once_with()

    def test_published_config_keeps_full_rules_while_desensitize_strips_them(self):
        """完整配置随 SQLite 备份进入私有 bucket；脱敏后的公开配置不含折扣规则。

        覆盖规格文档 §3「完整配置与公开配置」的边界：
        - get_active_config 返回完整规则（rules + pricing.default_formula），
          供管理端从 Railway 已发布配置读取完整折扣。
        - desensitize_config 移除 rules、pricing.default_formula，并打上
          _desensitized 标记，供 company 角色的 /api/config/active 返回。
        """
        store = self.make_store()
        # v2 配置：discount_rules 会被 normalize 成 rules + default_formula
        store.save_config(
            {
                "schema_version": 2,
                "version": "2026-07-21.1",
                "pricing": {"decimal_places": 1, "rounding_threshold": 100},
                "fields": [
                    {"key": "spec", "label": "规格型号", "searchable": True, "required": True},
                    {"key": "face_price", "label": "面价", "type": "number"},
                ],
                "discount_rules": [
                    {"id": "other", "label": "默认", "percent": 55, "default": True, "conditions": []}
                ],
            },
            status="published",
        )

        full = store.get_active_config()
        self.assertIn("rules", full)
        self.assertTrue(full["rules"])
        self.assertEqual(
            full["pricing"]["default_formula"],
            "face_price * discount_percent / 100",
        )

        safe = store.desensitize_config(full)
        self.assertNotIn("rules", safe)
        self.assertNotIn("discount_rules", safe)
        self.assertNotIn("default_formula", safe.get("pricing", {}))
        self.assertTrue(safe.get("_desensitized"))


if __name__ == "__main__":
    unittest.main()
