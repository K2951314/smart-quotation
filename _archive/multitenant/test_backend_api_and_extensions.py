import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.smart_quotation.api import create_app
from backend.smart_quotation.erp import ERPNextAdapter
from backend.smart_quotation.plugins import PluginRegistry
from backend.smart_quotation.store import QuotationStore


class BackendApiAndExtensionsTest(unittest.TestCase):
    def make_store(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(self._cleanup_tmp, tmp)
        store = QuotationStore(str(Path(tmp) / "quotation.db"))
        store.init_schema()
        return store

    @staticmethod
    def _cleanup_tmp(tmp_dir):
        import shutil
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except PermissionError:
            pass  # Windows file lock race

    def seed_company(self, store):
        company_id = store.create_company("Company A", "company-a")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [
                {"key": "spec", "label": "规格", "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "type": "number"},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(company_id, config, status="published")
        store.replace_items(company_id, "d1", [{"item_key": "A-001", "fields": {"spec": "A-001", "face_price": 80}}])
        return company_id

    def test_api_quotes_company_scoped_data(self):
        store = self.make_store()
        company_id = self.seed_company(store)

        # Create an admin customer and a valid session token
        from backend.smart_quotation.auth import new_token, hash_token, hash_password, expires_in
        pw_hash, pw_salt = hash_password("test123")
        token = new_token()
        token_hash = hash_token(token)

        now = datetime.now(timezone.utc).isoformat()
        with store.connect() as conn:
            conn.execute(
                """INSERT INTO customers
                   (id, company_id, username, password_hash, password_salt, display_name,
                    status, account_type, discount_rate, tax_rate, profit_mode, profit_value,
                    notes, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (1, company_id, "admin_test", pw_hash, pw_salt, "Admin", "active",
                 "admin", 0.65, 0.13, "none", 0, None, now, now)
            )
            conn.execute(
                """INSERT INTO customer_sessions
                   (token_hash, customer_id, company_id, created_at, expires_at, last_used_at)
                   VALUES(?,?,?,?,?,?)""",
                (token_hash, 1, company_id, now, expires_in(), now)
            )
            conn.commit()

        client = TestClient(create_app(store))
        response = client.get(
            f"/api/companies/{company_id}/quote",
            params={"q": "A-001"},
            headers={"Authorization": "Bearer admin-secret-key"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"][0]["item_key"], "A-001")
        self.assertEqual(response.json()["config_revision"], "r1")

    def test_export_and_import_config_as_yaml(self):
        store = self.make_store()
        company_id = self.seed_company(store)

        exported = store.export_config(company_id, "r1", fmt="yaml")
        imported = store.import_config(company_id, exported, fmt="yaml", status="draft")

        self.assertEqual(imported["schema_version"], 3)
        self.assertEqual(imported["company_id"], company_id)
        self.assertEqual(imported["revision"], "r1")

    def test_plugin_registry_rejects_duplicate_names(self):
        registry = PluginRegistry()
        registry.register_condition("is_special", lambda fields, config: True, {"type": "object"})

        with self.assertRaises(ValueError):
            registry.register_condition("is_special", lambda fields, config: False, {"type": "object"})

    def test_erpnext_adapter_is_optional_until_configured(self):
        adapter = ERPNextAdapter()

        with self.assertRaises(NotImplementedError):
            adapter.require_configured({"enabled": False})


if __name__ == "__main__":
    unittest.main()
