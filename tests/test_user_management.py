"""用户管理测试（超管）：列表/改档位/停用/迁移/重置密码。

验证：
1. 列表需超管权限（租户 403）
2. 分页、搜索
3. 改档位（账号级 plan）
4. 停用账号——登录被拒、JWT 失效
5. 迁移公司
6. 超管重置密码（返回临时密码）
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
from backend.smart_quotation.store import QuotationStore


class UserManagementTest(unittest.TestCase):
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
        self._create_user("u1", "alice@test.com", "password123", "co-a")
        self._create_user("u2", "bob@test.com", "password123", "co-b")
        self.store.create_company("co-a", "公司A")
        self.store.create_company("co-b", "公司B")

    def _create_user(self, uid, email, password, company_id):
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                (uid, email, hash_password(password), company_id, self.store.now()),
            )
            conn.commit()

    def _jwt(self, uid, cid, email):
        return routes_auth._create_jwt(uid, cid, email)

    def test_list_users_requires_superadmin(self):
        """非超管调列表返回 403。"""
        jwt = self._jwt("u1", "co-a", "alice@test.com")
        resp = self.client.get("/api/users", headers={"Authorization": f"Bearer {jwt}"})
        self.assertEqual(resp.status_code, 403)

    def test_list_users_superadmin(self):
        """超管看到全部用户。"""
        resp = self.client.get(
            "/api/users", headers={"Authorization": f"Bearer {self.admin_key}"}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["total"], 2)
        emails = [u["email"] for u in data["users"]]
        self.assertIn("alice@test.com", emails)
        self.assertIn("bob@test.com", emails)

    def test_list_users_search(self):
        """按邮箱搜索。"""
        resp = self.client.get(
            "/api/users?search=alice", headers={"Authorization": f"Bearer {self.admin_key}"}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["total"], 1)
        self.assertEqual(resp.json()["users"][0]["email"], "alice@test.com")

    def test_list_users_plan_filters(self):
        """plan 筛选：具体档位精确匹配；inherit 筛出 plan IS NULL（继承公司）。"""
        self.store.update_user("u1", plan="pro")  # u1 账号级 pro，u2 未设置

        resp_pro = self.client.get(
            "/api/users?plan=pro", headers={"Authorization": f"Bearer {self.admin_key}"}
        )
        self.assertEqual(resp_pro.status_code, 200)
        self.assertEqual(resp_pro.json()["total"], 1)
        self.assertEqual(resp_pro.json()["users"][0]["email"], "alice@test.com")

        resp_inherit = self.client.get(
            "/api/users?plan=inherit", headers={"Authorization": f"Bearer {self.admin_key}"}
        )
        self.assertEqual(resp_inherit.status_code, 200)
        self.assertEqual(resp_inherit.json()["total"], 1)
        self.assertEqual(resp_inherit.json()["users"][0]["email"], "bob@test.com")

    def test_update_user_plan(self):
        """超管设置账号级档位。"""
        resp = self.client.patch(
            "/api/users/u1",
            json={"plan": "pro"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["user"]["plan"], "pro")

    def test_update_user_plan_invalid(self):
        """非法档位 422。"""
        resp = self.client.patch(
            "/api/users/u1",
            json={"plan": "platinum"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 422)

    def test_update_user_plan_inherit(self):
        """plan=inherit 清除账号级 plan。"""
        self.client.patch(
            "/api/users/u1", json={"plan": "pro"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self.client.patch(
            "/api/users/u1", json={"plan": "inherit"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["user"]["plan"])

    def test_update_user_deactivate(self):
        """停用账号——登录被拒、JWT 失效。"""
        # 停用
        resp = self.client.patch(
            "/api/users/u1", json={"is_active": False},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["user"]["is_active"])

        # 登录被拒
        login = self.client.post(
            "/api/auth/login",
            json={"email": "alice@test.com", "password": "password123"},
        )
        self.assertEqual(login.status_code, 401)

        # 旧 JWT 失效（is_active 校验）
        jwt = self._jwt("u1", "co-a", "alice@test.com")
        session = self.client.get(
            "/api/auth/session", headers={"Authorization": f"Bearer {jwt}"}
        )
        self.assertEqual(session.status_code, 401)

    def test_update_user_migrate_company(self):
        """迁移公司。"""
        resp = self.client.patch(
            "/api/users/u1", json={"company_id": "co-b"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["user"]["company_id"], "co-b")

    def test_update_user_migrate_nonexistent_company(self):
        """迁移到不存在的公司返回 404。"""
        resp = self.client.patch(
            "/api/users/u1", json={"company_id": "no-such-co"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 404)

    def test_admin_reset_password(self):
        """超管重置密码返回临时密码，可用临时密码登录。"""
        resp = self.client.post(
            "/api/users/u1/reset-password",
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        temp_pw = resp.json()["temp_password"]
        self.assertGreaterEqual(len(temp_pw), 12)

        # 临时密码可登录
        login = self.client.post(
            "/api/auth/login",
            json={"email": "alice@test.com", "password": temp_pw},
        )
        self.assertEqual(login.status_code, 200)

    # ─── is_active 缓存（require_admin_api 每请求校验）──────────

    def test_is_user_active_cache_invalidated_on_update(self):
        """停用写路径即时失效缓存——TTL 内的下一个请求也看到新状态。"""
        self.assertTrue(self.store.is_user_active("u1"))  # 预热缓存
        self.store.update_user("u1", is_active=False)
        # 缓存已失效，立即读到 False（不等 60s TTL）
        self.assertFalse(self.store.is_user_active("u1"))

    def test_is_user_active_cache_ttl_refresh(self):
        """TTL 过期后缓存条目重新查库（模拟另一 Worker 的直写 DB 变更）。"""
        import time as _time

        self.assertTrue(self.store.is_user_active("u1"))  # 预热
        # 绕过 store 写路径模拟外部变更
        with closing(self.store.connect()) as conn:
            conn.execute("update users set is_active = 0 where id = ?", ("u1",))
            conn.commit()
        # 缓存未过期 → 仍是旧值（60s stale 窗口是文档化的取舍）
        self.assertTrue(self.store.is_user_active("u1"))
        # 把缓存时间戳拨到 61s 前 → 强制重新查库
        self.store._user_active_cache["u1"] = (True, _time.monotonic() - 61)
        self.assertFalse(self.store.is_user_active("u1"))


if __name__ == "__main__":
    unittest.main()
