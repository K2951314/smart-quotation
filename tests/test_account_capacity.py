"""账号容量（plan 配额）测试：多公司所有权 + 子账号席位。

第一性原理模型：
- 订阅是账号级的（users.plan），公司是账号拥有的容器；
- max_companies = 账号可拥有的数据源管理员公司数（营销口径「N 家公司」）；
- max_users = 账号名下登录席位（子账号），免费 1 / 个人 3 / 专业不限；
- 部署 license 的 max_companies/max_users 是供应商总量门禁，独立于账号配额。

验证：
1. team 账号自建到 5 家，第 6 家 402
2. 自建公司继承 owner 档位；owner 升级后公司跟随（无 plan 快照冻结）
3. free 账号第 2 家 402（升级引导而非 403）
4. 子账号席位：pro 3 席位，超 402；team 不限
5. 租户删除子账号（自己公司内）OK；删自己 422；删别家公司用户 403
6. 越权防护：不能给别人公司创建子账号、owner 回退不穿透 license 档
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
from backend.smart_quotation.store import QuotationStore


class AccountCapacityTest(unittest.TestCase):
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

    def _register(self, email, company_name):
        r = self.client.post(
            "/api/auth/register",
            json={"email": email, "password": "password123", "company_name": company_name},
        )
        self.assertEqual(r.status_code, 200)
        return r.json()

    def _h(self, token):
        return {"Authorization": f"Bearer {token}"}

    # ─── 多公司所有权 ──────────────────────────────────

    def test_team_tenant_can_own_five_companies(self):
        """team 账号自建到 5 家，第 6 家 402。"""
        reg = self._register("team@t.com", "团队公司")
        self.store.update_user(reg["user"]["id"], plan="team")
        h = self._h(reg["token"])
        for i in range(2, 6):
            r = self.client.post(
                "/api/companies",
                json={"id": f"multi-{i}", "name": f"团队公司{i}"},
                headers=h,
            )
            self.assertEqual(r.status_code, 200, f"第 {i} 家应创建成功")
        r = self.client.post(
            "/api/companies", json={"id": "multi-6", "name": "团队公司6"}, headers=h
        )
        self.assertEqual(r.status_code, 402)
        self.assertIn("升级", r.json()["detail"])

    def test_created_company_inherits_owner_plan_and_follows_upgrade(self):
        """自建公司继承 owner 档位；owner 升级后公司自动跟随（无快照冻结）。"""
        reg = self._register("grow@t.com", "成长公司")
        uid = reg["user"]["id"]
        h = self._h(reg["token"])
        self.store.update_user(uid, plan="team")
        r = self.client.post(
            "/api/companies", json={"id": "branch", "name": "分公司"}, headers=h
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.store.resolve_subscription_plan("branch"), "team")
        # owner 降级 → 公司跟随
        self.store.update_user(uid, plan="free")
        self.assertEqual(self.store.resolve_subscription_plan("branch"), "free")

    def test_owner_fallback_never_penetrates_license_tier(self):
        """owner 无 plan 时 fail-closed free——注册公司是 is_admin 也不穿透 license 档。"""
        reg = self._register("noob@t.com", "新号公司")
        cid = reg["company"]["id"]
        # dev 部署 license tier=team；owner 无 plan → 必须 free
        self.assertEqual(self.store.resolve_subscription_plan(cid), "free")

    def test_free_tenant_second_company_upsell(self):
        """free 账号第 2 家 → 402（升级引导，非权限拒绝）。"""
        reg = self._register("solo@t.com", "独营公司")
        r = self.client.post(
            "/api/companies", json={"id": "extra", "name": "第二家"},
            headers=self._h(reg["token"]),
        )
        self.assertEqual(r.status_code, 402)

    def test_member_companies_do_not_consume_company_quota(self):
        """成员公司不占 max_companies 配额（配额口径 = 管理员公司数）。"""
        reg = self._register("hq@t.com", "总部公司")
        uid = reg["user"]["id"]
        self.store.update_user(uid, plan="team")
        h = self._h(reg["token"])
        # 建第 2 家 admin + 在两家下面各建成员（公司名全局唯一，成员名带前缀）
        self.client.post("/api/companies", json={"id": "hq2", "name": "分部"}, headers=h)
        for admin_id in (reg["company"]["id"], "hq2"):
            r = self.client.post(
                f"/api/companies/{admin_id}/members",
                json={"id": f"m-{admin_id}", "name": f"成员-{admin_id}"}, headers=h,
            )
            self.assertEqual(r.status_code, 200)
        # 仍可建到第 5 家 admin（成员不占额）
        for i in range(3, 6):
            r = self.client.post(
                "/api/companies", json={"id": f"hq-{i}", "name": f"公司{i}"}, headers=h
            )
            self.assertEqual(r.status_code, 200)

    # ─── 子账号席位 ────────────────────────────────────

    def test_sub_account_seats_pro(self):
        """pro 3 席位：主账号 + 2 子账号，第 4 个 402。"""
        reg = self._register("boss@t.com", "老板公司")
        self.store.update_user(reg["user"]["id"], plan="pro")
        h = self._h(reg["token"])
        for i in range(2):
            r = self.client.post(
                "/api/users/sub",
                json={"email": f"sub{i}@t.com", "password": "password123"},
                headers=h,
            )
            self.assertEqual(r.status_code, 200)
        r = self.client.post(
            "/api/users/sub",
            json={"email": "sub9@t.com", "password": "password123"},
            headers=h,
        )
        self.assertEqual(r.status_code, 402)
        self.assertIn("席位", r.json()["detail"])

    def test_sub_account_team_unlimited(self):
        """team 席位不限：连建 6 个子账号全部成功。"""
        reg = self._register("corp@t.com", "集团公司")
        self.store.update_user(reg["user"]["id"], plan="team")
        h = self._h(reg["token"])
        for i in range(6):
            r = self.client.post(
                "/api/users/sub",
                json={"email": f"staff{i}@t.com", "password": "password123"},
                headers=h,
            )
            self.assertEqual(r.status_code, 200)

    def test_sub_account_validation_and_dup(self):
        """子账号：邮箱格式/密码长度 422；重复邮箱 409。"""
        reg = self._register("va@t.com", "校验公司")
        self.store.update_user(reg["user"]["id"], plan="pro")
        h = self._h(reg["token"])
        self.assertEqual(self.client.post(
            "/api/users/sub", json={"email": "bad-email", "password": "password123"},
            headers=h).status_code, 422)
        self.assertEqual(self.client.post(
            "/api/users/sub", json={"email": "x@t.com", "password": "short"},
            headers=h).status_code, 422)
        self.assertEqual(self.client.post(
            "/api/users/sub", json={"email": "ok@t.com", "password": "password123"},
            headers=h).status_code, 200)
        self.assertEqual(self.client.post(
            "/api/users/sub", json={"email": "ok@t.com", "password": "password123"},
            headers=h).status_code, 409)

    def test_sub_account_requires_tenant(self):
        """超管/无凭证调子账号端点 403（子账号是租户自助功能）。"""
        reg = self._register("a@t.com", "A公司")
        h = self._h(self.admin_key)
        self.assertEqual(self.client.post(
            "/api/users/sub", json={"email": "s@t.com", "password": "password123"},
            headers=h).status_code, 403)

    def test_tenant_delete_scope(self):
        """租户删除范围：自己公司子账号 OK；删自己 422；删别家用户 403。"""
        reg_a = self._register("a@t.com", "A公司")
        self.store.update_user(reg_a["user"]["id"], plan="pro")
        ha = self._h(reg_a["token"])
        self.client.post("/api/users/sub", json={"email": "a1@t.com", "password": "password123"}, headers=ha)
        reg_b = self._register("b@t.com", "B公司")
        hb = self._h(reg_b["token"])
        # A 删自己 422
        self.assertEqual(self.client.delete(f"/api/users/{reg_a['user']['id']}", headers=ha).status_code, 422)
        # A 删 B 的主账号 403
        self.assertEqual(self.client.delete(f"/api/users/{reg_b['user']['id']}", headers=ha).status_code, 403)
        # A 删自己公司子账号 200
        mine = self.client.get("/api/users/mine", headers=ha).json()
        sid = [u for u in mine["users"] if u["email"] == "a1@t.com"][0]["id"]
        self.assertEqual(self.client.delete(f"/api/users/{sid}", headers=ha).status_code, 200)

    def test_tenant_cannot_use_superadmin_user_apis(self):
        """租户不能改档位/迁移/重置密码（超管专属不动摇）。"""
        reg = self._register("r@t.com", "R公司")
        h = self._h(reg["token"])
        self.assertEqual(self.client.patch(
            f"/api/users/{reg['user']['id']}", json={"plan": "team"}, headers=h).status_code, 403)
        self.assertEqual(self.client.post(
            f"/api/users/{reg['user']['id']}/reset-password", headers=h).status_code, 403)

    # ─── plan 快照冻结问题（机器默认 vs 超管显式）────────────

    def test_machine_free_snapshot_unfreezes_and_follows_owner(self):
        """机器写入的 plan=free 快照（自愈/迁移/早期注册）被解冻：账号升专业版后公司跟随。"""
        reg = self._register("zz@t.com", "冻结公司")
        uid = reg["user"]["id"]
        cid = reg["company"]["id"]
        # 模拟历史损伤：公司被写死 plan=free 快照（旧版自愈/注册行为）
        company = self.store.get_company(cid)
        meta = dict(company["meta"] or {})
        meta["plan"] = "free"
        self.store.update_company(cid, meta=meta)
        # 账号升专业版——快照会压住 owner 链
        self.store.update_user(uid, plan="team")
        self.assertEqual(self.store.resolve_subscription_plan(cid), "free")  # 冻结中
        # 启动迁移解冻
        self.store._migrate_unfreeze_machine_plans()
        meta = self.store.get_company(cid)["meta"]
        self.assertIsNone(meta.get("plan"))
        self.assertEqual(self.store.resolve_subscription_plan(cid), "team")  # 跟随账号

    def test_superadmin_explicit_free_survives_unfreeze(self):
        """超管显式分配的 free（plan_source=superadmin）不被解冻。"""
        reg = self._register("sv@t.com", "显式公司")
        uid = reg["user"]["id"]
        cid = reg["company"]["id"]
        self.store.update_user(uid, plan="team")
        # 超管显式分配 free（走 PATCH，打 plan_source 标）
        r = self.client.patch(
            f"/api/companies/{cid}",
            json={"meta": {"plan": "free"}},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(r.status_code, 200)
        self.store._migrate_unfreeze_machine_plans()
        meta = self.store.get_company(cid)["meta"]
        self.assertEqual(meta.get("plan"), "free")  # 显式 free 尊重
        self.assertEqual(self.store.resolve_subscription_plan(cid), "free")

    def test_list_companies_includes_resolved_plan(self):
        """公司列表带 resolved_plan（生效档位），跟随账号档位而非快照。"""
        reg = self._register("rp@t.com", "生效公司")
        cid = reg["company"]["id"]
        h = {"Authorization": f"Bearer {self.admin_key}"}
        r = self.client.get("/api/companies", headers=h)
        row = [c for c in r.json() if c["id"] == cid][0]
        self.assertEqual(row["resolved_plan"], "free")
        # 账号升 team → 生效档位跟随
        self.store.update_user(reg["user"]["id"], plan="team")
        r = self.client.get("/api/companies", headers=h)
        row = [c for c in r.json() if c["id"] == cid][0]
        self.assertEqual(row["resolved_plan"], "team")

    def test_owner_expired_plan_falls_back_free(self):
        """owner 账号档位过期（plan_expires_at 已过）→ 公司回退 free（到期感知）。"""
        from datetime import datetime, timedelta, timezone
        reg = self._register("exp@t.com", "过期公司")
        cid = reg["company"]["id"]
        past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        self.client.patch(
            f"/api/users/{reg['user']['id']}",
            json={"plan": "team", "plan_expires": past},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        # 账号级 team 已过期 → 公司回退 free
        self.assertEqual(self.store.resolve_subscription_plan(cid), "free")


if __name__ == "__main__":
    unittest.main()
