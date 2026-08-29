"""注册输入校验测试：邮箱格式 + 重复/竞态冲突。

验证：
1. 合法邮箱注册成功（对照）
2. 畸形邮箱（无 @ / 无域名 / 含空格）→ 422
3. 含 CRLF 的邮箱 → 422（SMTP 头注入防护）
4. 超长邮箱（>254 字符）→ 422
5. 重复邮箱 → 409（正常路径：SELECT 已查到）
6. 竞态：SELECT 未查到但 INSERT 撞 unique 约束 → 409 + 清理孤立公司
"""

import gc
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api import routes_auth
from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.api.passwords import hash_password
from backend.smart_quotation.license import set_dev_tier_override
from backend.smart_quotation.store import QuotationStore


class _NoRow:
    """execute() 返回值：fetchone() 永远 None。"""

    def fetchone(self):
        return None


class _RaceConn:
    """代理连接：邮箱查重 SELECT 谎称无记录，其余 SQL 透传。

    模拟并发窗口：查重时邮箱"尚未注册"，INSERT 时另一请求已抢先写入。
    """

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        if "select id from users where email" in sql.lower():
            return _NoRow()
        return self._conn.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._conn, name)


class _RaceClosing:
    """替换 routes_auth.closing：包一层竞态代理连接。"""

    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return _RaceConn(self._conn.__enter__())

    def __exit__(self, *args):
        return self._conn.__exit__(*args)


def _race_closing(thing):
    return _RaceClosing(thing)


class RegisterValidationTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        routes_auth.configure_jwt("test-jwt-secret-32chars-or-more-xxxxx")
        # dev 默认 free 档 max_users=1，注册多个用户需要 team 档（max_users=-1）
        set_dev_tier_override("team")
        self.addCleanup(set_dev_tier_override, None)

    def _register(self, email, company_name="测试公司"):
        return self.client.post(
            "/api/auth/register",
            json={"email": email, "password": "password123", "company_name": company_name},
        )

    def _counts(self):
        with closing(self.store.connect()) as conn:
            users = conn.execute("select count(*) as n from users").fetchone()["n"]
            companies = conn.execute("select count(*) as n from companies").fetchone()["n"]
        return users, companies

    def test_register_valid_email_ok(self):
        """对照：合法邮箱注册成功。"""
        resp = self._register("valid@example.com")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("token", resp.json())

    def test_register_malformed_email_rejected(self):
        """畸形邮箱（无 @ / 无域名 / 含空格）→ 422。"""
        for email in ("not-an-email", "a@nodot", "a b@test.com", "@example.com", "a@.com"):
            resp = self._register(email)
            self.assertEqual(resp.status_code, 422, f"{email!r} 应被拒绝")
            self.assertIn("邮箱格式", resp.json()["detail"])

    def test_register_crlf_email_rejected(self):
        """含 CRLF 的邮箱 → 422（SMTP 头注入入口被封）。"""
        resp = self._register("a@b.com\r\nBcc: evil@evil.com")
        self.assertEqual(resp.status_code, 422)

    def test_register_overlong_email_rejected(self):
        """超过 254 字符的邮箱 → 422。"""
        local = "a" * 250
        resp = self._register(f"{local}@example.com")
        self.assertEqual(resp.status_code, 422)

    def test_register_duplicate_email_conflict(self):
        """重复邮箱 → 409（正常路径：查重 SELECT 已查到）。"""
        first = self._register("dup@example.com")
        self.assertEqual(first.status_code, 200)
        second = self._register("dup@example.com")
        self.assertEqual(second.status_code, 409)
        self.assertIn("已注册", second.json()["detail"])

    def test_register_race_integrity_error_returns_409_and_cleans_company(self):
        """竞态窗口：查重未命中但 INSERT 撞 unique → 409，且回滚孤立公司。"""
        self.store.create_company("race-co", "竞态公司")
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                ("racer-1", "race@example.com", hash_password("password123"),
                 "race-co", self.store.now()),
            )
            conn.commit()
        users_before, companies_before = self._counts()
        self.assertEqual(users_before, 1)
        self.assertEqual(companies_before, 2)  # default + race-co

        with mock.patch.object(routes_auth, "closing", _race_closing):
            resp = self._register("race@example.com")

        self.assertEqual(resp.status_code, 409)
        self.assertIn("已注册", resp.json()["detail"])
        # 孤立公司已被清理：公司数不变、用户数不变
        users_after, companies_after = self._counts()
        self.assertEqual(users_after, users_before)
        self.assertEqual(companies_after, companies_before)
        # 竞态异常的 traceback 与帧形成引用循环，SQLite 文件句柄要等 GC 才释放；
        # Windows 上临时目录清理会因文件被占而失败，这里显式回收（产品代码无泄漏，
        # 所有连接都经 closing() 关闭）
        gc.collect()


if __name__ == "__main__":
    unittest.main()
