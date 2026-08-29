"""登录用户自助修改密码测试：/api/auth/change-password。

验证：
1. 正确旧密码 + 合规新密码 → 200，新密码可登录、旧密码失效
2. 旧密码错误 → 401（防会话劫持后直接改密）
3. 新密码少于 8 位 → 422
4. 未认证 / 超管 API Key 认证 → 401（仅 JWT 用户可用）
5. 停用账号 → 401
6. 改密后清除未消费的 reset_token（防旧重置链接绕过旧密码）
7. 改密后当前 JWT 仍有效（无状态 token 至自然过期）
"""

import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.api.passwords import hash_password
from backend.smart_quotation.store import QuotationStore


class ChangePasswordTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.store.create_company("test-co", "测试公司")
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        self.admin_key = "admin-secret-key"
        from backend.smart_quotation.api import routes_auth
        routes_auth.configure_jwt("test-jwt-secret-32chars-or-more-xxxxx")
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                ("user-1", "user@test.com", hash_password("password123"),
                 "test-co", self.store.now()),
            )
            conn.commit()

    def _login_token(self):
        resp = self.client.post(
            "/api/auth/login",
            json={"email": "user@test.com", "password": "password123"},
        )
        self.assertEqual(resp.status_code, 200)
        return resp.json()["token"]

    def _reset_token(self):
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "select reset_token from users where email = ?", ("user@test.com",)
            ).fetchone()
            return row["reset_token"] if row else None

    def test_change_password_success(self):
        """正确旧密码修改成功：新密码可登录，旧密码失效。"""
        token = self._login_token()
        resp = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

        old_login = self.client.post(
            "/api/auth/login",
            json={"email": "user@test.com", "password": "password123"},
        )
        self.assertEqual(old_login.status_code, 401)
        new_login = self.client.post(
            "/api/auth/login",
            json={"email": "user@test.com", "password": "newpass456"},
        )
        self.assertEqual(new_login.status_code, 200)

    def test_change_password_wrong_old_password(self):
        """旧密码错误返回 401。"""
        token = self._login_token()
        resp = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "wrong-old-pass", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 401)

    def test_change_password_short_new_password(self):
        """新密码少于 8 位返回 422。"""
        token = self._login_token()
        resp = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "short"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 422)

    def test_change_password_requires_jwt(self):
        """未认证或超管 API Key 认证都返回 401（API Key 无用户密码概念）。"""
        resp_anon = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
        )
        self.assertEqual(resp_anon.status_code, 401)

        resp_key = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp_key.status_code, 401)

    def test_change_password_deactivated_user(self):
        """停用账号即使 JWT 未过期也不能改密。"""
        token = self._login_token()
        self.store.update_user("user-1", is_active=False)
        resp = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 401)

    def test_change_password_clears_pending_reset_token(self):
        """改密后清除未消费的 reset_token，防旧重置链接绕过旧密码。"""
        self.client.post("/api/auth/forgot-password", json={"email": "user@test.com"})
        self.assertIsNotNone(self._reset_token())

        token = self._login_token()
        resp = self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(self._reset_token())

    def test_jwt_still_valid_after_change(self):
        """无状态 JWT 无法吊销：改密后当前 token 仍可用。"""
        token = self._login_token()
        self.client.post(
            "/api/auth/change-password",
            json={"old_password": "password123", "new_password": "newpass456"},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp = self.client.get(
            "/api/auth/profile",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(resp.status_code, 200)


if __name__ == "__main__":
    unittest.main()
