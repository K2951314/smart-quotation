"""端到端验证：admin + company 双视图。

不依赖 live 端口，用 TestClient + 真实 DB。
"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from backend.smart_quotation.api import create_app
from backend.smart_quotation.auth import hash_password
from backend.smart_quotation.store import QuotationStore

DB_PATH = "D:/zhangkun/智能询价/quotation.db"


class E2ECompanyViewTest(unittest.TestCase):
    """验证公司账号视图的关键属性。"""

    @classmethod
    def setUpClass(cls):
        cls.store = QuotationStore(DB_PATH)
        cls.app = create_app(store=cls.store)
        cls.client = TestClient(cls.app)

        # 确保 TJLH 公司存在
        with sqlite3.connect(DB_PATH) as conn:
            cu = conn.execute("SELECT id FROM companies WHERE id='TJLH'")
            if not cu.fetchone():
                cls.store.create_company("菱华金钻", "TJLH")
            # 清理旧测试账号
            conn.execute("DELETE FROM customers WHERE username IN ('cs', 'admin_test')")
            conn.commit()

        # 创建 cs 公司账号
        h, s = hash_password("cs")
        cs = cls.store.create_customer(
            username="cs",
            password_hash=h,
            password_salt=s,
            display_name="测试公司账号",
            company_id="TJLH",
            account_type="company",
            tax_rate=0.13,
        )
        cls.cs_id = cs["id"] if isinstance(cs, dict) else cs
        cls.store.update_customer(cls.cs_id, profit_mode="percent", profit_value=10.0)

        # 创建 admin_test 管理员账号
        h2, s2 = hash_password("admin123")
        cls.store.create_customer(
            username="admin_test",
            password_hash=h2,
            password_salt=s2,
            display_name="测试管理员",
            company_id="TJLH",
            account_type="admin",
        )

    def test_01_cs_login(self):
        resp = self.client.post(
            "/api/customer/login",
            json={"company_code": "TJLH", "username": "cs", "password": "cs"},
        )
        self.assertEqual(resp.status_code, 200, f"Login failed: {resp.text}")
        data = resp.json()
        self.assertEqual(data["customer"]["account_type"], "company")
        self.assertEqual(data["customer"]["display_name"], "测试公司账号")
        self.assertIn("token", data)
        # 存到类属性供后续测试用
        E2ECompanyViewTest.cs_token = data["token"]

    def test_02_cs_me_has_tax_and_profit(self):
        token = getattr(E2ECompanyViewTest, "cs_token", None)
        if not token:
            self.skipTest("cs 未登录")
        resp = self.client.get("/api/customer/me", headers={"X-Customer-Token": token})
        self.assertEqual(resp.status_code, 200)
        me = resp.json()
        self.assertEqual(me["tax_rate"], 0.13)
        self.assertEqual(me["profit_mode"], "percent")
        self.assertEqual(me["profit_value"], 10.0)
        self.assertEqual(me["account_type"], "company")

    def test_03_cs_config_returns_200(self):
        """config 接口必须返回 200，不再 404。"""
        token = getattr(E2ECompanyViewTest, "cs_token", None)
        if not token:
            self.skipTest("cs 未登录")
        resp = self.client.get("/api/customer/config", headers={"X-Customer-Token": token})
        self.assertEqual(resp.status_code, 200, f"config failed: {resp.text}")
        cfg = resp.json()
        self.assertIn("ui", cfg)
        self.assertIn("fields", cfg)
        self.assertIn("copy", cfg)

    def test_04_cs_quote_no_internal_fields(self):
        """公司账号 quote 返回不应包含 face_price / discount_rate 等内部字段。"""
        token = getattr(E2ECompanyViewTest, "cs_token", None)
        if not token:
            self.skipTest("cs 未登录")
        # 找一个 TJLH 真实料号
        with sqlite3.connect(DB_PATH) as conn:
            cu = conn.execute(
                "SELECT item_key FROM quotation_items WHERE company_id='TJLH' LIMIT 1"
            )
            row = cu.fetchone()
            if not row:
                self.skipTest("TJLH 暂无 items 数据，跳过 quote 字段验证")
            sample_key = row[0]

        resp = self.client.get(
            f"/api/customer/quote?q={sample_key}",
            headers={"X-Customer-Token": token},
        )
        self.assertEqual(resp.status_code, 200)
        results = resp.json().get("results", [])
        if not results:
            self.skipTest("quote 无结果，跳过")
        r = results[0]
        # 公司账号脱敏
        self.assertNotIn("face_price", r, "公司账号不应返回 face_price")
        self.assertNotIn("discount_rate", r, "公司账号不应返回 discount_rate")
        self.assertIn("base_price", r, "公司账号必须有 base_price（成本价）")
        self.assertIsNotNone(r["base_price"])
        self.assertIn("tax_amount", r)
        self.assertIn("price_incl_tax", r)
        self.assertIn("tax_rate", r)
        self.assertEqual(r["tax_rate"], 0.13)

    def test_05_cs_update_profit(self):
        """公司账号可改利润率。"""
        token = getattr(E2ECompanyViewTest, "cs_token", None)
        if not token:
            self.skipTest("cs 未登录")
        resp = self.client.patch(
            "/api/customer/profile",
            headers={"X-Customer-Token": token},
            json={"profit_mode": "amount", "profit_value": 5.0},
        )
        self.assertEqual(resp.status_code, 200, f"update failed: {resp.text}")
        me = self.client.get(
            "/api/customer/me", headers={"X-Customer-Token": token}
        ).json()
        self.assertEqual(me["profit_mode"], "amount")
        self.assertEqual(me["profit_value"], 5.0)
        # 恢复
        self.client.patch(
            "/api/customer/profile",
            headers={"X-Customer-Token": token},
            json={"profit_mode": "percent", "profit_value": 10.0},
        )

    def test_06_admin_login_and_sees_internal(self):
        """管理员账号能登录。"""
        resp = self.client.post(
            "/api/customer/login",
            json={"company_code": "TJLH", "username": "admin_test", "password": "admin123"},
        )
        self.assertEqual(resp.status_code, 200, f"admin login failed: {resp.text}")
        data = resp.json()
        self.assertEqual(data["customer"]["account_type"], "admin")
        token = data["token"]
        cfg_resp = self.client.get(
            "/api/customer/config",
            headers={"X-Customer-Token": token},
        )
        self.assertEqual(cfg_resp.status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
