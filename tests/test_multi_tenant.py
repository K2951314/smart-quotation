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

    def _publish_config(self, company_id, revision):
        self.store.save_config({
            "schema_version": 3,
            "revision": revision,
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 90}]}],
        }, status="published", company_id=company_id)

    def test_company_token_without_company_id_isolated_from_default(self):
        """持有公司 token 但漏传 company_id 时，应返回 token 对应公司数据，而非 default 公司数据。

        回归：旧实现 require_company_access 只用 token 反查结果做鉴权、不回传，
        路由仍按 company_id="default" 取数，导致跨租户读取 default 公司配置。
        """
        self._publish_config("default", "rd1")
        company = self.store.create_company("tenant-a", "租户A")
        self._publish_config("tenant-a", "ra1")
        token = company["meta"]["access_token"]

        # 不带 company_id，用 tenant-a 的 token 请求 /config.json
        resp = self.client.get("/config.json", headers={"X-Company-Token": token})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # 返回的应是 tenant-a 的配置（revision=ra1），而非 default 的 rd1
        self.assertEqual(body.get("revision"), "ra1")

    def test_admin_company_token_without_company_id_not_read_default(self):
        """is_admin 公司 token 漏传 company_id 时，也不得读取 default 公司的未脱敏数据。"""
        self._publish_config("default", "rd1")
        company = self.store.create_company("tenant-admin", "管理员公司", meta={"is_admin": True})
        self._publish_config("tenant-admin", "ra1")
        token = company["meta"]["access_token"]

        resp = self.client.get("/config.json", headers={"X-Company-Token": token})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # 返回管理员公司自己的配置，而非 default 公司配置
        self.assertEqual(body.get("revision"), "ra1")

    def test_rapid_saves_generate_distinct_revisions(self):
        """连续两次保存（无显式 revision）应生成两个不同版本，而非同秒覆盖。

        回归：now_revision 原为秒级精度，同一秒内两次 save_config 生成相同
        revision，on conflict(company_id, revision) do update 静默覆盖前一版本。
        """
        base = {
            "schema_version": 3,
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        c1 = self.store.save_config(dict(base), status="draft")
        c2 = self.store.save_config(dict(base), status="draft")
        self.assertNotEqual(c1["revision"], c2["revision"])
        revisions = [c["revision"] for c in self.store.list_configs()]
        self.assertIn(c1["revision"], revisions)
        self.assertIn(c2["revision"], revisions)

    def test_list_audit_days_filter(self):
        """list_audit 按 days 过滤应返回最近 N 天的日志，且跨方言不崩。

        回归：旧实现用 SQLite 专有 datetime('now', ?) 函数，PostgreSQL 无此函数，
        生产 PG 模式 + audit_log 功能时 /api/audit 会 500。
        """
        from contextlib import closing
        with closing(self.store.connect()) as conn:
            self.store.audit(conn, "tester", "config.save", "quotation_config", "r1", {}, company_id="default")
            conn.commit()

        logs = self.store.list_audit(limit=50, company_id="default", days=7)
        self.assertEqual(len(logs), 1)

        logs_all = self.store.list_audit(limit=50, company_id="default", days=None)
        self.assertEqual(len(logs_all), 1)

    def test_read_upload_limited_aborts_oversized(self):
        """分块读取上传文件超过上限应立即 413，而非先全量缓冲到内存。

        回归：旧实现 await file.read() 全量读入后才校验大小，超大文件可 OOM DoS。
        """
        import asyncio
        from fastapi import HTTPException
        from backend.smart_quotation.api.routes_items import _read_upload_limited, MAX_UPLOAD_SIZE

        class _FakeUpload:
            def __init__(self, size):
                self._remaining = size
                self.filename = "big.xlsx"

            async def read(self, n=-1):
                if self._remaining <= 0:
                    return b""
                take = self._remaining if n < 0 else min(n, self._remaining)
                self._remaining -= take
                return b"x" * take

        async def _run():
            with self.assertRaises(HTTPException) as ctx:
                await _read_upload_limited(_FakeUpload(MAX_UPLOAD_SIZE + 1), MAX_UPLOAD_SIZE)
            self.assertEqual(ctx.exception.status_code, 413)

        asyncio.run(_run())

    def test_sq_dev_with_production_signal_rejected(self):
        """SQ_DEV=1 与生产信号共存时应拒绝启动（防生产误开 dev 模式）。

        回归：旧守卫只拦 SQ_DEV=1 + ALLOW_ORIGINS 组合，SQ_DEV=1 单独存在时
        认证/授权/限流/license 全失效。
        """
        import os as _os
        signals = [
            ("ALLOW_ORIGINS", "https://example.com"),
            ("DATABASE_URL", "postgresql://u:p@localhost:5432/db"),
            ("DB_PATH", "/data/quotation.db"),
            ("SQ_LICENSE", "dummy-license-string"),
        ]
        for key, value in signals:
            _os.environ[key] = value
            try:
                with self.assertRaises(RuntimeError):
                    create_app()
            finally:
                _os.environ.pop(key, None)

    def test_health_backup_endpoint(self):
        """GET /api/health/backup 返回备份状态（测试环境未配置备份 → configured=False）。"""
        resp = self.client.get("/api/health/backup")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["available"])
        self.assertFalse(data["configured"])
        self.assertIn("last_error", data)


if __name__ == "__main__":
    unittest.main()
