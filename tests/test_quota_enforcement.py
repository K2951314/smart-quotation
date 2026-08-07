"""订阅档位配额门控测试：max_brands / watermark / session quota 返回。

验证：
1. POST /api/config 在免费版（max_brands=2）时拒绝保存超过 2 条规则的配置
2. /api/auth/session 返回完整 quota 对象（供前端做前置阻断）
3. /api/public/company/{id} 返回 watermark 字段（免费版 True）
4. 开发模式 tier 覆盖后，配额随档位变化
5. max_brands=-1（个人版/专业版）时不限制规则数量
"""

import os
import tempfile
import unittest
from pathlib import Path

# 测试环境：dev 模式，不设 ALLOW_ORIGINS（与 SQ_DEV 互斥断言）
os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.license import set_dev_tier_override, TIER_PRESETS
from backend.smart_quotation.store import QuotationStore


class QuotaEnforcementTest(unittest.TestCase):
    """订阅配额门控测试。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        self.admin_key = "admin-secret-key"
        # 每个测试前清除 tier 覆盖
        set_dev_tier_override(None)

    def tearDown(self):
        set_dev_tier_override(None)

    # ─── max_brands 门控 ──────────────────────────────────────

    def test_free_tier_rejects_excess_rules(self):
        """免费版（max_brands=2）保存 3 条规则应返回 402。"""
        set_dev_tier_override("free")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [
                {"id": "r1", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "r2", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]},
            ],
        }
        resp = self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 402)
        self.assertIn("2", resp.json()["detail"])

    def test_free_tier_allows_within_limit(self):
        """免费版（max_brands=2）保存 2 条规则应成功。"""
        set_dev_tier_override("free")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [
                {"id": "r1", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]},
            ],
        }
        resp = self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    def test_pro_tier_unlimited_rules(self):
        """个人版（max_brands=-1）保存大量规则应成功。"""
        set_dev_tier_override("pro")
        rules = [
            {"id": f"r{i}", "actions": [{"type": "set_discount", "percent": 50}]}
            for i in range(19)
        ]
        rules.append({"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]})
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": rules,
        }
        resp = self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── /api/auth/session quota 返回 ─────────────────────────

    def test_session_returns_quota_object(self):
        """/api/auth/session 应返回 quota 对象，含所有配额字段。"""
        set_dev_tier_override("free")
        resp = self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("quota", data)
        quota = data["quota"]
        # 验证所有配额字段都存在
        for field in [
            "max_companies", "max_users", "max_skus", "max_brands",
            "max_config_revisions", "stock_query_daily_limit",
            "audit_log_days", "watermark",
        ]:
            self.assertIn(field, quota, f"quota 缺少 {field}")

        # 免费版配额值检查
        self.assertEqual(quota["max_brands"], TIER_PRESETS["free"]["max_brands"])
        self.assertEqual(quota["max_skus"], TIER_PRESETS["free"]["max_skus"])
        self.assertTrue(quota["watermark"], "免费版 watermark 应为 True")

    def test_session_quota_changes_with_tier(self):
        """切换 tier 覆盖后，session 返回的 quota 应随档位变化。"""
        # 免费版
        set_dev_tier_override("free")
        resp = self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        free_quota = resp.json()["quota"]
        self.assertEqual(free_quota["max_brands"], 2)
        self.assertTrue(free_quota["watermark"])

        # 切换到个人版
        set_dev_tier_override("pro")
        resp = self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        pro_quota = resp.json()["quota"]
        self.assertEqual(pro_quota["max_brands"], -1)
        self.assertFalse(pro_quota["watermark"])

    # ─── watermark 门控 ────────────────────────────────────────

    def test_company_profile_includes_watermark_free(self):
        """/api/public/company/{id} 免费版应返回 watermark=True。"""
        set_dev_tier_override("free")
        resp = self.client.get(
            "/api/public/company/default",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("watermark", data)
        self.assertTrue(data["watermark"])

    def test_company_profile_includes_watermark_pro(self):
        """/api/public/company/{id} 个人版应返回 watermark=False。"""
        set_dev_tier_override("pro")
        resp = self.client.get(
            "/api/public/company/default",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("watermark", data)
        self.assertFalse(data["watermark"])

    # ─── import_config 配额门控（防绕过）──────────────────────

    def test_free_tier_rejects_import_excess_rules(self):
        """免费版导入超过 max_brands 条规则的配置应返回 402。

        防止通过 import 绕过 save_config 的配额检查。
        """
        set_dev_tier_override("free")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [
                {"id": "r1", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "r2", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "r3", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]},
            ],
        }
        import json as _json
        resp = self.client.post(
            "/api/config/import",
            json={"content": _json.dumps(config), "fmt": "json"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 402)
        self.assertIn("2", resp.json()["detail"])

    def test_pro_tier_allows_import_many_rules(self):
        """个人版导入大量规则应成功（max_brands=-1 不限制）。"""
        set_dev_tier_override("pro")
        rules = [
            {"id": f"r{i}", "actions": [{"type": "set_discount", "percent": 50}]}
            for i in range(10)
        ]
        rules.append({"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]})
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": rules,
        }
        import json as _json
        resp = self.client.post(
            "/api/config/import",
            json={"content": _json.dumps(config), "fmt": "json"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── audit_log 功能门控 ──────────────────────────────────────

    def test_free_tier_audit_log_forbidden(self):
        """免费版访问 /api/audit 应返回 403（audit_log 是付费功能）。"""
        set_dev_tier_override("free")
        resp = self.client.get(
            "/api/audit",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("付费功能", resp.json()["detail"])

    def test_pro_tier_audit_log_allowed(self):
        """个人版访问 /api/audit 应返回 200。"""
        set_dev_tier_override("pro")
        # 先保存一个配置，让 audit 有记录
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self.client.get(
            "/api/audit",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── bundle_encryption 功能门控 ─────────────────────────────

    def test_free_tier_bundle_encryption_forbidden(self):
        """免费版使用密码生成加密价格包应返回 403。"""
        set_dev_tier_override("free")
        # 先保存一个配置 + 一些数据，让 bundle 可以生成
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self.client.post(
            "/api/merger/bundle/generate",
            json={
                "role": "admin",
                "password": "secret123",
                "deploy": False,
            },
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("加密", resp.json()["detail"])

    def test_pro_tier_bundle_encryption_allowed(self):
        """个人版使用密码生成加密价格包应成功。"""
        set_dev_tier_override("pro")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self.client.post(
            "/api/merger/bundle/generate",
            json={
                "role": "admin",
                "password": "secret123",
                "deploy": False,
            },
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    def test_free_tier_bundle_no_password_allowed(self):
        """免费版不使用密码生成价格包应成功（不加密不需要 bundle_encryption 功能）。"""
        set_dev_tier_override("free")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self.client.post(
            "/api/merger/bundle/generate",
            json={
                "role": "admin",
                "password": "",
                "deploy": False,
            },
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── dev tier 切换端点 ─────────────────────────────────────

    def test_dev_set_tier_endpoint(self):
        """POST /api/dev/set-tier 应切换 tier 并影响 session quota。"""
        # 切换到 free
        resp = self.client.post(
            "/api/dev/set-tier",
            json={"tier": "free"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["tier"], "free")

        # 验证 session quota 已变化
        resp = self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.json()["quota"]["max_brands"], 2)

        # 切换到 pro
        resp = self.client.post(
            "/api/dev/set-tier",
            json={"tier": "pro"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

        resp = self.client.get(
            "/api/auth/session",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.json()["quota"]["max_brands"], -1)

    # ─── rollback_config 配额门控（防降级后绕过）──────────────

    def test_free_tier_rollback_rejects_excess_rules(self):
        """免费版回滚到超过 max_brands 的旧版本应返回 402。

        攻击场景：用户在 pro 档位保存了 5 条规则，降级到 free 后
        试图通过 rollback 绕过限制——必须被拦截。
        """
        # 1. 先用 pro 档位保存 3 条规则（超过 free 的 max_brands=2）
        set_dev_tier_override("pro")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [
                {"id": "r1", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "r2", "actions": [{"type": "set_discount", "percent": 50}]},
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]},
            ],
        }
        resp = self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        revision = resp.json()["revision"]

        # 2. 切换到 free 档位
        set_dev_tier_override("free")

        # 3. 尝试回滚到那个版本——应被 402 拒绝
        resp = self.client.post(
            f"/api/config/{revision}/publish",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 402)

    def test_pro_tier_rollback_allows_within_limit(self):
        """个人版回滚到符合配额的版本应成功。"""
        # 1. 用 pro 保存 1 条规则
        set_dev_tier_override("pro")
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        resp = self.client.post(
            "/api/config",
            json={"config": config, "status": "published"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        revision = resp.json()["revision"]

        # 2. 回滚——应成功
        resp = self.client.post(
            f"/api/config/{revision}/publish",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── max_config_revisions 门控（版本自动清理）────────────

    def test_free_tier_revision_limit_auto_cleanup_on_save(self):
        """免费版（max_config_revisions=3）保存第 4 个版本时自动删除最旧版本。"""
        set_dev_tier_override("free")
        for i in range(4):
            config = {
                "schema_version": 3,
                "revision": f"rev-{i}",
                "fields": [{"key": "spec", "searchable": True, "required": True}],
                "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
            }
            resp = self.client.post(
                "/api/config",
                json={"config": config, "status": "published"},
                headers={"Authorization": f"Bearer {self.admin_key}"},
            )
            self.assertEqual(resp.status_code, 200)

        # 应只剩 3 个版本（最旧的 rev-0 被自动删除）
        resp = self.client.get(
            "/api/configs",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 3)

    def test_free_tier_revision_limit_on_import(self):
        """免费版导入配置时也应触发版本自动清理。"""
        set_dev_tier_override("free")
        import json as _json
        # 先保存 3 个版本（达到上限）
        for i in range(3):
            config = {
                "schema_version": 3,
                "revision": f"rev-{i}",
                "fields": [{"key": "spec", "searchable": True, "required": True}],
                "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
            }
            self.client.post(
                "/api/config",
                json={"config": config, "status": "published"},
                headers={"Authorization": f"Bearer {self.admin_key}"},
            )

        # 导入第 4 个版本——应自动删除最旧的
        config = {
            "schema_version": 3,
            "revision": "imported-1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        resp = self.client.post(
            "/api/config/import",
            json={"content": _json.dumps(config), "fmt": "json"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

        # 应只剩 3 个版本
        resp = self.client.get(
            "/api/configs",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(len(resp.json()), 3)

    def test_free_tier_revision_limit_on_rollback(self):
        """免费版回滚时也应触发版本自动清理。"""
        set_dev_tier_override("free")
        # 先保存 3 个版本（达到上限）
        for i in range(3):
            config = {
                "schema_version": 3,
                "revision": f"rev-{i}",
                "fields": [{"key": "spec", "searchable": True, "required": True}],
                "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
            }
            resp = self.client.post(
                "/api/config",
                json={"config": config, "status": "published"},
                headers={"Authorization": f"Bearer {self.admin_key}"},
            )
            self.assertEqual(resp.status_code, 200)
        first_revision = resp.json()["revision"]

        # 回滚到第一个版本——会创建第 4 个版本，应自动删除最旧的
        resp = self.client.post(
            f"/api/config/rev-0/publish",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

        # 应只剩 3 个版本
        resp = self.client.get(
            "/api/configs",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(len(resp.json()), 3)


if __name__ == "__main__":
    unittest.main()
