"""密码找回测试：forgot-password / reset-password 全流程。

验证：
1. 未知邮箱也返回成功（防枚举）
2. 已知邮箱生成 reset_token
3. dev 模式打印链接到日志
4. 有效 token 重置成功
5. 过期 token 被拒
6. token 一次性（重置后失效）
7. 短密码被拒
8. 重置后可用新密码登录
9. 畸形邮箱走统一响应（不查库不生成 token）
10. mailer 拒绝含换行的收件地址（SMTP 注入防护）
11. reset_token 列存 SHA-256 哈希而非明文（DB 泄露不能直接构造链接）
"""

import os
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.api.passwords import hash_password
from backend.smart_quotation.store import QuotationStore


class PasswordResetTest(unittest.TestCase):
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
        # 插入一个真实用户
        from backend.smart_quotation.api import routes_auth
        routes_auth.configure_jwt("test-jwt-secret-32chars-or-more-xxxxx")
        self._create_user("user-1", "user@test.com", "password123", "test-co")

    def _create_user(self, uid, email, password, company_id):
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                (uid, email, hash_password(password), company_id, self.store.now()),
            )
            conn.commit()

    def _forgot_and_capture_token(self, email):
        """触发 forgot-password，从 mailer 调用中捕获邮件链接里的明文 token。

        DB 的 reset_token 列存哈希，明文只出现在重置链接（邮件）里。
        """
        from backend.smart_quotation import mailer
        captured = {}

        def fake_send(to_addr, reset_url):
            captured["url"] = reset_url
            return True

        with mock.patch.object(mailer, "send_password_reset_email", fake_send):
            resp = self.client.post("/api/auth/forgot-password", json={"email": email})
        self.assertEqual(resp.status_code, 200)
        return parse_qs(urlparse(captured["url"]).query)["token"][0]

    def _get_reset_token_hash(self, email):
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "select reset_token from users where email = ?", (email,)
            ).fetchone()
            return row["reset_token"] if row else None

    def test_forgot_password_unknown_email_returns_ok(self):
        """未知邮箱也返回相同成功响应（防枚举）。"""
        resp = self.client.post(
            "/api/auth/forgot-password",
            json={"email": "nobody@test.com"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertIn("已发送", resp.json()["message"])

    def test_forgot_password_known_email_sets_token(self):
        """已知邮箱生成 reset_token；DB 存哈希而非明文。"""
        token = self._forgot_and_capture_token("user@test.com")
        self.assertIsNotNone(token)
        self.assertGreaterEqual(len(token), 32)
        # DB 列存 SHA-256 hex（64 字符），且不等于明文 token
        stored = self._get_reset_token_hash("user@test.com")
        self.assertIsNotNone(stored)
        self.assertEqual(len(stored), 64)
        self.assertNotEqual(stored, token)
        import hashlib
        self.assertEqual(stored, hashlib.sha256(token.encode()).hexdigest())
        # 校验过期时间在 29~31 分钟后
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "select reset_expires from users where email = ?", ("user@test.com",)
            ).fetchone()
            expires = datetime.fromisoformat(row["reset_expires"])
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            delta = expires - datetime.now(timezone.utc)
            self.assertGreater(delta.total_seconds(), 29 * 60)
            self.assertLess(delta.total_seconds(), 31 * 60)

    def test_reset_password_valid_token(self):
        """有效 token 重置成功，可用新密码登录。"""
        token = self._forgot_and_capture_token("user@test.com")

        resp = self.client.post(
            "/api/auth/reset-password",
            json={"token": token, "password": "newpassword456"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])

        # 新密码可登录
        login = self.client.post(
            "/api/auth/login",
            json={"email": "user@test.com", "password": "newpassword456"},
        )
        self.assertEqual(login.status_code, 200)

    def test_reset_password_short_password_rejected(self):
        """新密码少于 8 位被拒。"""
        token = self._forgot_and_capture_token("user@test.com")
        resp = self.client.post(
            "/api/auth/reset-password",
            json={"token": token, "password": "123"},
        )
        self.assertEqual(resp.status_code, 422)

    def test_reset_password_invalid_token(self):
        """无效 token 返回 401。"""
        resp = self.client.post(
            "/api/auth/reset-password",
            json={"token": "invalid-token-xxx", "password": "newpassword456"},
        )
        self.assertEqual(resp.status_code, 401)

    def test_reset_password_one_time_token(self):
        """token 一次性——重置后同一 token 再用失败。"""
        token = self._forgot_and_capture_token("user@test.com")

        resp1 = self.client.post(
            "/api/auth/reset-password",
            json={"token": token, "password": "newpassword456"},
        )
        self.assertEqual(resp1.status_code, 200)

        # 同一 token 再用应失败
        resp2 = self.client.post(
            "/api/auth/reset-password",
            json={"token": token, "password": "anotherpass789"},
        )
        self.assertEqual(resp2.status_code, 401)

    def test_reset_password_expired_token(self):
        """过期 token 被拒。"""
        token = self._forgot_and_capture_token("user@test.com")
        # 手动把过期时间设到过去（保留 token 哈希不动）
        past = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        with closing(self.store.connect()) as conn:
            conn.execute(
                "update users set reset_expires = ? where email = ?",
                (past, "user@test.com"),
            )
            conn.commit()

        resp = self.client.post(
            "/api/auth/reset-password",
            json={"token": token, "password": "newpassword456"},
        )
        self.assertEqual(resp.status_code, 401)
        # 过期后 token 应被清空
        self.assertIsNone(self._get_reset_token_hash("user@test.com"))

    def test_forgot_password_malformed_email_unified_response(self):
        """畸形邮箱走统一成功响应：不查库、不生成 token（防注入+防枚举）。"""
        resp = self.client.post(
            "/api/auth/forgot-password",
            json={"email": "user@test.com\r\nBcc: evil@evil.com"},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertIn("已发送", resp.json()["message"])
        # 真实存在的 user@test.com 不应被生成 token
        self.assertIsNone(self._get_reset_token_hash("user@test.com"))

    def test_send_email_rejects_newline_recipient(self):
        """mailer 拒绝含换行的收件地址（SMTP 命令注入防护）。"""
        from backend.smart_quotation.mailer import send_email
        self.assertFalse(
            send_email("a@b.com\r\nRCPT TO:<evil@evil.com>", "主题", "<p>x</p>")
        )
        self.assertFalse(send_email("a@b.com\n", "主题", "<p>x</p>"))
        # 正常地址在未配置 SMTP 时降级为日志，返回 True
        self.assertTrue(send_email("a@b.com", "主题", "<p>x</p>"))


if __name__ == "__main__":
    unittest.main()
