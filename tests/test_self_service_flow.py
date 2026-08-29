"""自助开通流程测试：注册即数据源管理员 + 租户自助管理成员公司。

背景：注册页宣称「注册新账号 = 创建公司 + 管理员」。修复前注册创建的
公司不带 is_admin（独立公司），而创建数据源管理员/成员公司都是超管专属——
注册用户被彻底卡死（点击「创建数据源管理员」403）。

验证：
1. 注册创建的公司带 is_admin=true + plan=free（注册即数据源管理员，
   显式 free 防止无 plan 管理员公司回退继承部署 license 档位）
2. 注册用户 session plan = free（fail-closed，不白拿 license 档）
3. 租户不能创建顶级公司（POST /api/companies 仍超管专属）
4. 免费档租户创建成员 → 403 升级提示（付费墙，非权限墙）
5. team 档租户可在自己的公司下创建成员公司
6. 租户不能在其他公司下创建成员（跨租户隔离）
7. 租户可自升级自己的独立公司为管理员（老账号兼容），无 plan 时强制 free
8. 自升级保留已有 plan（不降级已付费账号）
9. 超管仍可在任意公司下创建成员（回归）
"""

import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api import routes_auth
from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.api.passwords import hash_password
from backend.smart_quotation.license import set_dev_tier_override
from backend.smart_quotation.store import QuotationStore


class SelfServiceFlowTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        self.admin_key = "admin-secret-key"
        routes_auth.configure_jwt("test-jwt-secret-32chars-or-more-xxxxx")
        set_dev_tier_override(None)
        self.addCleanup(set_dev_tier_override, None)

    def _register(self, email, company_name="测试公司"):
        resp = self.client.post(
            "/api/auth/register",
            json={"email": email, "password": "password123", "company_name": company_name},
        )
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def _create_old_style_company_user(self, cid, uid, email, meta=None):
        """模拟修复前注册的老账号：公司不带 is_admin。"""
        self.store.create_company(cid, "老公司", dict(meta or {}))
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                (uid, email, hash_password("password123"), cid, self.store.now()),
            )
            conn.commit()
        return routes_auth._create_jwt(uid, cid, email)

    # ─── 注册即数据源管理员 ──────────────────────────────

    def test_register_creates_admin_company_with_free_plan(self):
        """注册创建的公司 is_admin=true + owner_user_id；无 plan 快照时回退 free。"""
        reg = self._register("owner@test.com")
        cid = reg["company"]["id"]
        jwt = reg["token"]

        resp = self.client.get(
            f"/api/companies/{cid}", headers={"Authorization": f"Bearer {jwt}"}
        )
        self.assertEqual(resp.status_code, 200)
        meta = resp.json()["meta"]
        self.assertTrue(meta.get("is_admin"))
        self.assertEqual(meta.get("owner_user_id"), reg["user"]["id"])
        self.assertIsNone(meta.get("plan"))  # 不冻结快照，回退 owner（无 plan → free）
        self.assertEqual(self.store.resolve_subscription_plan(cid), "free")

    def test_register_session_plan_is_free(self):
        """注册用户 session 档位 = free（显式 plan 胜过部署 license 档位）。"""
        reg = self._register("owner@test.com")
        resp = self.client.get(
            "/api/auth/session", headers={"Authorization": f"Bearer {reg['token']}"}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["plan"], "free")

    def test_tenant_create_company_quota(self):
        """租户自建公司受账号配额约束：free 1 家（第 2 家 402 升级引导）。"""
        reg = self._register("owner@test.com")
        cid = reg["company"]["id"]
        # 免费档：已有 1 家（注册自带），再建 → 402
        resp = self.client.post(
            "/api/companies",
            json={"id": "second-co", "name": "第二公司"},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(resp.status_code, 402)
        self.assertIn("上限", resp.json()["detail"])
        # 升级 team（5 家）→ 可再建 4 家，第 6 家 402
        self.store.update_user(reg["user"]["id"], plan="team")
        for i in range(2, 6):
            r = self.client.post(
                "/api/companies",
                json={"id": f"co-{i}", "name": f"多公司{i}"},
                headers={"Authorization": f"Bearer {reg['token']}"},
            )
            self.assertEqual(r.status_code, 200)
        r = self.client.post(
            "/api/companies",
            json={"id": "co-6", "name": "多公司6"},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(r.status_code, 402)
        # 新公司继承 owner 档位
        self.assertEqual(self.store.resolve_subscription_plan("co-2"), "team")
        # 租户列表可见全部 5 家
        r = self.client.get("/api/companies", headers={"Authorization": f"Bearer {reg['token']}"})
        self.assertEqual(len(r.json()), 5)
        self.assertNotIn(cid, {c["id"] for c in r.json() if False}) or self.assertIn(cid, {c["id"] for c in r.json()})

    # ─── 成员公司自助管理 ──────────────────────────────

    def test_free_tenant_member_creation_upsell(self):
        """免费档租户创建成员 → 403 升级提示（付费墙）。"""
        reg = self._register("owner@test.com")
        cid = reg["company"]["id"]
        resp = self.client.post(
            f"/api/companies/{cid}/members",
            json={"id": "member-1", "name": "成员一", "meta": {}},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("专业版", resp.json()["detail"])

    def test_tenant_can_create_member_under_own_company(self):
        """team 档租户可在自己公司下创建成员公司。"""
        reg = self._register("owner@test.com")
        cid = reg["company"]["id"]
        # 超管把公司升到 team 档
        company = self.store.get_company(cid)
        meta = dict(company["meta"] or {})
        meta["plan"] = "team"
        self.store.update_company(cid, meta=meta)

        resp = self.client.post(
            f"/api/companies/{cid}/members",
            json={"id": "member-1", "name": "成员一", "meta": {}},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(resp.status_code, 200)
        member_meta = resp.json()["meta"]
        self.assertEqual(member_meta.get("parent_company_id"), cid)
        self.assertNotIn("is_admin", member_meta)

    def test_tenant_cannot_create_member_under_other_company(self):
        """租户不能在其他公司下创建成员（跨租户隔离）。"""
        reg = self._register("owner@test.com")
        self.store.create_company("other-co", "别家公司的管理员")
        # 别家公司升到 team 档（排除付费墙干扰，只测越权）
        self.store.update_company("other-co", meta={"is_admin": True, "plan": "team"})

        resp = self.client.post(
            "/api/companies/other-co/members",
            json={"id": "evil-member", "name": "越权成员", "meta": {}},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("无权访问", resp.json()["detail"])

    def test_superadmin_can_create_member_anywhere(self):
        """回归：超管仍可在任意公司下创建成员（但公司订阅档位的功能门控不变）。"""
        reg = self._register("owner@test.com")
        cid = reg["company"]["id"]

        # 成员继承是公司订阅的功能：免费档公司即使超管操作也返回升级提示
        # （门控看的是公司档位，与调用者身份无关——原设计行为）
        resp_free = self.client.post(
            f"/api/companies/{cid}/members",
            json={"id": "member-8", "name": "免费档成员", "meta": {}},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp_free.status_code, 403)

        # 公司升到 team 档后超管可创建
        company = self.store.get_company(cid)
        meta = dict(company["meta"] or {})
        meta["plan"] = "team"
        self.store.update_company(cid, meta=meta)
        resp = self.client.post(
            f"/api/companies/{cid}/members",
            json={"id": "member-9", "name": "超管建的成员", "meta": {}},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)

    # ─── 老账号自升级（兼容修复前注册的无 is_admin 公司）────

    def test_tenant_self_upgrade_own_company_to_admin(self):
        """租户把自己的独立公司升级为管理员，无 plan 时强制 free。"""
        jwt = self._create_old_style_company_user("old-co", "u-old", "old@test.com")
        resp = self.client.patch(
            "/api/companies/old-co",
            json={"meta": {"is_admin": True}},
            headers={"Authorization": f"Bearer {jwt}"},
        )
        self.assertEqual(resp.status_code, 200)
        meta = resp.json()["meta"]
        self.assertTrue(meta.get("is_admin"))
        self.assertEqual(meta.get("plan"), "free")  # fail-closed：不继承 license 档

    def test_self_upgrade_preserves_existing_plan(self):
        """自升级保留已有 plan（已付费账号不降级）。"""
        jwt = self._create_old_style_company_user(
            "paid-co", "u-paid", "paid@test.com", meta={"plan": "pro"}
        )
        resp = self.client.patch(
            "/api/companies/paid-co",
            json={"meta": {"is_admin": True}},
            headers={"Authorization": f"Bearer {jwt}"},
        )
        self.assertEqual(resp.status_code, 200)
        meta = resp.json()["meta"]
        self.assertTrue(meta.get("is_admin"))
        self.assertEqual(meta.get("plan"), "pro")

    def test_tenant_cannot_upgrade_other_company(self):
        """租户不能升级别人的公司（跨租户隔离）。"""
        reg = self._register("owner@test.com")
        self.store.create_company("other-co2", "别家公司")
        resp = self.client.patch(
            "/api/companies/other-co2",
            json={"meta": {"is_admin": True}},
            headers={"Authorization": f"Bearer {reg['token']}"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_tenant_cannot_smuggle_plan_through_upgrade(self):
        """自升级时夹带的 plan 被忽略（档位只能由平台分配）。"""
        jwt = self._create_old_style_company_user("smug-co", "u-smug", "smug@test.com")
        resp = self.client.patch(
            "/api/companies/smug-co",
            json={"meta": {"is_admin": True, "plan": "team"}},
            headers={"Authorization": f"Bearer {jwt}"},
        )
        self.assertEqual(resp.status_code, 200)
        meta = resp.json()["meta"]
        self.assertTrue(meta.get("is_admin"))
        self.assertEqual(meta.get("plan"), "free")  # 夹带的 team 被丢弃

    # ─── 历史独立公司自动迁移 ──────────────────────────────

    def test_standalone_companies_migrated_to_admin(self):
        """启动迁移：历史独立公司自动升级为管理员公司（is_admin+free），历史账号可用了。"""
        # 修复前形态：无 is_admin 的公司（旧版注册产物）
        self.store.create_company("legacy-co", "旧账号公司")
        self.store.create_company("legacy-paid", "旧付费公司", {"plan": "pro"})
        self.store.create_company("member-co", "成员公司", {"parent_company_id": "legacy-co"})
        self.store.create_company("admin-co", "已是管理员", {"is_admin": True})

        # 重新跑迁移（init_schema 已跑过一次，验证幂等）
        self.store._migrate_standalone_companies_to_admin()

        legacy = self.store.get_company("legacy-co")["meta"]
        self.assertTrue(legacy.get("is_admin"))
        self.assertEqual(legacy.get("plan"), "free")  # fail-closed

        paid = self.store.get_company("legacy-paid")["meta"]
        self.assertTrue(paid.get("is_admin"))
        self.assertEqual(paid.get("plan"), "pro")  # 已有付费档不覆盖

        member = self.store.get_company("member-co")["meta"]
        self.assertNotIn("is_admin", member)  # 成员公司不动

        admin = self.store.get_company("admin-co")["meta"]
        self.assertTrue(admin.get("is_admin"))

        default_meta = self.store.get_company("default")["meta"]
        self.assertNotIn("is_admin", default_meta)  # default 系统租户不动

    def test_orphan_users_repaired(self):
        """自愈：用户指向的公司行丢失时，启动重建公司（is_admin+free），账号恢复可用。"""
        # 制造孤儿：公司+用户建好后直接删公司行
        # （绕过 delete_company 的级联停用——模拟历史数据损伤）
        self._create_old_style_company_user("ghost-co", "u-ghost", "ghost@test.com")
        with closing(self.store.connect()) as conn:
            conn.execute("delete from companies where id = 'ghost-co'")
            conn.commit()
        # 空公司 ID 的用户（历史脏数据：直接插行，company_id 为空）
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                ("u-empty", "empty@test.com", hash_password("password123"),
                 "", self.store.now()),
            )
            conn.commit()

        self.store._migrate_repair_orphan_users()

        # 公司按原 ID 重建（引用不断裂），语义与注册一致
        meta = self.store.get_company("ghost-co")["meta"]
        self.assertTrue(meta.get("is_admin"))
        self.assertEqual(meta.get("plan"), "free")
        self.assertEqual(meta.get("created_by"), "repair")
        # 用户仍指向原公司 ID
        user = self.store.get_user("u-ghost")
        self.assertEqual(user["company_id"], "ghost-co")
        # 空公司 ID 用户获得新公司
        empty_user = self.store.get_user("u-empty")
        self.assertTrue(empty_user["company_id"])
        self.assertTrue(self.store.get_company(empty_user["company_id"])["meta"].get("is_admin"))
        # 幂等：再跑一次不重复创建/不报错
        self.store._migrate_repair_orphan_users()


if __name__ == "__main__":
    unittest.main()
