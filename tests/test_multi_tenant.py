"""多租户隔离性测试：default 租户保护、跨租户隔离。"""

import os
import tempfile
import unittest
from pathlib import Path

# 测试环境：dev 模式，不设 ALLOW_ORIGINS（与 SQ_DEV 互斥断言）
os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.store import QuotationStore


class MultiTenantTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        self.admin_key = "admin-secret-key"  # SQ_DEV=1 时的弱默认值

    def test_default_company_cannot_be_deleted(self):
        """DELETE /api/companies/default 应返回 409，且 default 租户仍存在。"""
        # 确认 default 存在
        self.assertIn("default", [c["id"] for c in self.store.list_companies()])

        # 尝试删除
        resp = self.client.delete(
            "/api/companies/default",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 409)

        # 确认 default 仍存在
        self.assertIn("default", [c["id"] for c in self.store.list_companies()])

    def test_non_default_company_can_be_deleted(self):
        """非 default 租户可以正常删除。"""
        self.store.create_company("tenant-a", "租户A")
        resp = self.client.delete(
            "/api/companies/tenant-a",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("tenant-a", [c["id"] for c in self.store.list_companies()])

    def test_tenant_data_isolation(self):
        """租户 A 的商品数据对租户 B 不可见。"""
        self.store.create_company("tenant-a", "租户A")
        self.store.create_company("tenant-b", "租户B")

        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.store.save_config(config, status="published", company_id="tenant-a")
        self.store.save_config(config, status="published", company_id="tenant-b")

        self.store.replace_items("d1", [
            {"item_key": "A-001", "fields": {"spec": "A-001"}},
        ], company_id="tenant-a")
        self.store.replace_items("d1", [
            {"item_key": "B-001", "fields": {"spec": "B-001"}},
        ], company_id="tenant-b")

        # 租户 A 只看到 A-001
        a_stats = self.store.get_items_stats(company_id="tenant-a")
        self.assertEqual(a_stats["count"], 1)

        # 租户 B 只看到 B-001
        b_stats = self.store.get_items_stats(company_id="tenant-b")
        self.assertEqual(b_stats["count"], 1)


if __name__ == "__main__":
    unittest.main()
