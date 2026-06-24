"""客户账号、专属定价、税务、利润率功能测试。"""

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.smart_quotation.api import create_app
from backend.smart_quotation.auth import hash_password, verify_password
from backend.smart_quotation.store import QuotationStore


class CustomerFeaturesTest(unittest.TestCase):
    def make_store(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = QuotationStore(str(Path(tmp.name) / "quotation.db"))
        store.init_schema()
        return store

    def seed_company_with_items(self, store, code="co-a"):
        """创建公司 + 发布配置 + 写入料号数据。"""
        company_id = store.create_company("Company A", code)
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [
                {"key": "spec", "label": "规格", "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "type": "number"},
                {"key": "brand", "label": "品牌", "searchable": True},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
            "pricing": {"decimal_places": 1, "rounding": {"mode": "ceil", "integer_above": 100}},
        }
        store.save_config(company_id, config, status="published")
        store.replace_items(company_id, "d1", [
            {"item_key": "A-001", "fields": {"spec": "A-001", "face_price": 100, "brand": "OSG"}},
            {"item_key": "A-002", "fields": {"spec": "A-002", "face_price": 200, "brand": "三菱"}},
        ])
        return company_id

    def admin_headers(self, client, company_id, username="test_admin"):
        store = client.app.state.store
        if not store.get_customer_by_username(company_id, username):
            pw_hash, pw_salt = hash_password("admin-pass")
            store.create_customer(
                company_id=company_id,
                username=username,
                password_hash=pw_hash,
                password_salt=pw_salt,
                display_name="测试管理员",
                account_type="admin",
            )
        resp = client.post("/api/customer/login", json={
            "company_code": company_id,
            "username": username,
            "password": "admin-pass",
        })
        self.assertEqual(resp.status_code, 200, resp.text)
        return {"X-Customer-Token": resp.json()["token"]}

    def create_customer_via_api(self, client, company_id, username="cust1", password="pass123",
                                 display_name="测试客户", discount_rate=0.65, tax_rate=0.13):
        resp = client.post(f"/api/companies/{company_id}/customers", json={
            "username": username,
            "password": password,
            "display_name": display_name,
            "discount_rate": discount_rate,
            "tax_rate": tax_rate,
        }, headers=self.admin_headers(client, company_id))
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def login(self, client, company_code="co-a", username="cust1", password="pass123"):
        resp = client.post("/api/customer/login", json={
            "company_code": company_code,
            "username": username,
            "password": password,
        })
        return resp

    # ─── Authentication Tests ──────────────────────────────────────────

    def test_login_success(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        resp = self.login(client)
        self.assertEqual(resp.status_code, 200, resp.text)
        data = resp.json()
        self.assertIn("token", data)
        self.assertEqual(data["customer"]["display_name"], "测试客户")
        self.assertEqual(data["customer"]["company_id"], company_id)

    def test_login_wrong_password(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        resp = self.login(client, password="wrong")
        self.assertEqual(resp.status_code, 401)

    def test_login_wrong_company_code(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        resp = self.login(client, company_code="nonexistent")
        self.assertEqual(resp.status_code, 404)

    def test_login_disabled_customer(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        customer = self.create_customer_via_api(client, company_id)

        # 停用客户
        client.patch(
            f"/api/companies/{company_id}/customers/{customer['id']}",
            json={"status": "disabled"},
            headers=self.admin_headers(client, company_id),
        )

        resp = self.login(client)
        self.assertEqual(resp.status_code, 403)

    def test_logout_invalidates_token(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        token = self.login(client).json()["token"]
        headers = {"X-Customer-Token": token}

        # 登出前可用
        resp = client.get("/api/customer/me", headers=headers)
        self.assertEqual(resp.status_code, 200)

        # 登出
        resp = client.post("/api/customer/logout", headers=headers)
        self.assertEqual(resp.status_code, 200)

        # 登出后不可用
        resp = client.get("/api/customer/me", headers=headers)
        self.assertEqual(resp.status_code, 401)

    def test_no_token_returns_401(self):
        store = self.make_store()
        self.seed_company_with_items(store)
        client = TestClient(create_app(store))

        resp = client.get("/api/customer/me")
        self.assertEqual(resp.status_code, 401)

        resp = client.get("/api/customer/me", headers={"X-Customer-Token": "invalid"})
        self.assertEqual(resp.status_code, 401)

    # ─── Customer CRUD Tests ───────────────────────────────────────────

    def test_customer_crud(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))

        # 创建
        customer = self.create_customer_via_api(client, company_id, username="user1")
        self.assertEqual(customer["username"], "user1")
        self.assertEqual(customer["discount_rate"], 0.65)
        self.assertNotIn("password_hash", customer)

        # 列表
        admin_headers = self.admin_headers(client, company_id)
        resp = client.get(f"/api/companies/{company_id}/customers", headers=admin_headers)
        self.assertTrue(any(item["id"] == customer["id"] for item in resp.json()))

        # 详情
        resp = client.get(f"/api/companies/{company_id}/customers/{customer['id']}", headers=admin_headers)
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("password_hash", resp.json())

        # 更新
        resp = client.patch(
            f"/api/companies/{company_id}/customers/{customer['id']}",
            json={"discount_rate": 0.5},
            headers=admin_headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["discount_rate"], 0.5)

        # 删除
        resp = client.delete(f"/api/companies/{company_id}/customers/{customer['id']}", headers=admin_headers)
        self.assertEqual(resp.status_code, 200)

        # 确认删除
        resp = client.get(f"/api/companies/{company_id}/customers/{customer['id']}", headers=admin_headers)
        self.assertEqual(resp.status_code, 404)

    def test_duplicate_username_rejected(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))

        self.create_customer_via_api(client, company_id, username="dup")
        resp = client.post(f"/api/companies/{company_id}/customers", json={
            "username": "dup", "password": "pass", "display_name": "重复",
        }, headers=self.admin_headers(client, company_id))
        self.assertEqual(resp.status_code, 409)

    def test_cross_tenant_isolation(self):
        store = self.make_store()
        company_a = self.seed_company_with_items(store, code="co-a")
        company_b = store.create_company("Company B", "co-b")
        config = {
            "schema_version": 3, "revision": "r1",
            "fields": [{"key": "spec", "label": "规格", "searchable": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        store.save_config(company_b, config, status="published")

        client = TestClient(create_app(store))
        cust_a = self.create_customer_via_api(client, company_a, username="userA")
        cust_b = self.create_customer_via_api(client, company_b, username="userA")

        # 从 A 不能访问 B 的客户
        resp = client.get(
            f"/api/companies/{company_a}/customers/{cust_b['id']}",
            headers=self.admin_headers(client, company_a),
        )
        self.assertEqual(resp.status_code, 404)

    def test_password_reset(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        customer = self.create_customer_via_api(client, company_id)

        # 重置密码
        resp = client.post(
            f"/api/companies/{company_id}/customers/{customer['id']}/reset-password",
            json={"new_password": "newpass456"},
            headers=self.admin_headers(client, company_id),
        )
        self.assertEqual(resp.status_code, 200)

        # 旧密码登录失败
        resp = self.login(client, password="pass123")
        self.assertEqual(resp.status_code, 401)

        # 新密码登录成功
        resp = self.login(client, password="newpass456")
        self.assertEqual(resp.status_code, 200)

    # ─── Pricing Calculation Tests ─────────────────────────────────────

    def test_customer_quote_base_price(self):
        """基础价 = 品牌折扣价（engine quote_price = 面价 × 品牌折扣%）。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id, discount_rate=0.65)

        token = self.login(client).json()["token"]
        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        self.assertEqual(resp.status_code, 200, resp.text)

        result = resp.json()["results"][0]
        # config rules default percent=50 → quote_price = 100 × 50% = 50
        # base_price = quote_price (品牌折扣价) = 50
        self.assertEqual(float(result["base_price"]), 50.0)
        # 无利润 → final_quote = base_price
        self.assertEqual(float(result["final_quote"]), 50.0)
        # tax = 50 * 0.13 = 6.5
        self.assertAlmostEqual(float(result["tax_amount"]), 6.5, places=1)
        # incl_tax = 50 + 6.5 = 56.5
        self.assertEqual(float(result["price_incl_tax"]), 56.5)

    def test_customer_quote_with_profit_percent(self):
        """利润率模式：final = base × (1 + profit%/100)。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id, discount_rate=0.65)

        token = self.login(client).json()["token"]
        # 设利润率 10%
        client.patch("/api/customer/profile", json={"profit_mode": "percent", "profit_value": 10},
                     headers={"X-Customer-Token": token})

        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        result = resp.json()["results"][0]
        # base = 50 (品牌折扣价), final = 50 * 1.1 = 55 (ceil 可能 55.0 或 55.1 浮点)
        self.assertEqual(float(result["base_price"]), 50.0)
        self.assertAlmostEqual(float(result["final_quote"]), 55.0, places=1)

    def test_customer_quote_with_profit_amount(self):
        """利润额模式：final = base + amount。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id, discount_rate=0.65)

        token = self.login(client).json()["token"]
        client.patch("/api/customer/profile", json={"profit_mode": "amount", "profit_value": 20},
                     headers={"X-Customer-Token": token})

        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        result = resp.json()["results"][0]
        # base = 50 (品牌折扣价), final = 50 + 20 = 70
        self.assertEqual(float(result["final_quote"]), 70.0)

    def test_price_override_takes_priority(self):
        """价格覆盖优先于折扣率计算。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        customer = self.create_customer_via_api(client, company_id, discount_rate=0.65)

        # 设价格覆盖：A-001 覆盖为 50
        resp = client.put(
            f"/api/companies/{company_id}/customers/{customer['id']}/prices",
            json={"overrides": [{"item_key": "A-001", "override_price": 50}]},
            headers=self.admin_headers(client, company_id),
        )
        self.assertEqual(resp.status_code, 200)

        token = self.login(client).json()["token"]
        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        result = resp.json()["results"][0]
        # override 优先：base = 50（override 值），不是品牌折扣价 50
        self.assertEqual(float(result["base_price"]), 50.0)

    def test_price_override_crud(self):
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        customer = self.create_customer_via_api(client, company_id)

        # 批量 upsert
        admin_headers = self.admin_headers(client, company_id)
        resp = client.put(
            f"/api/companies/{company_id}/customers/{customer['id']}/prices",
            json={"overrides": [
                {"item_key": "A-001", "override_price": 50},
                {"item_key": "A-002", "override_price": 120},
            ]},
            headers=admin_headers,
        )
        self.assertEqual(resp.status_code, 200)

        # 列表
        resp = client.get(f"/api/companies/{company_id}/customers/{customer['id']}/prices", headers=admin_headers)
        self.assertEqual(len(resp.json()), 2)

        # 删除单条
        resp = client.delete(
            f"/api/companies/{company_id}/customers/{customer['id']}/prices/A-001",
            headers=admin_headers,
        )
        self.assertEqual(resp.status_code, 200)

        resp = client.get(f"/api/companies/{company_id}/customers/{customer['id']}/prices", headers=admin_headers)
        self.assertEqual(len(resp.json()), 1)

    # ─── face_price Filtering Tests ───────────────────────────────────

    def test_face_price_not_in_customer_quote(self):
        """客户报价响应中不含 face_price。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        token = self.login(client).json()["token"]
        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        result = resp.json()["results"][0]
        self.assertNotIn("face_price", result["fields"])
        self.assertNotIn("discount_rate", result)
        self.assertNotIn("discount_percent", result)

    def test_customer_config_excludes_face_price_field(self):
        """公司账号配置中不含 face_price 字段定义。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_id)

        token = self.login(client).json()["token"]
        resp = client.get("/api/customer/config", headers={"X-Customer-Token": token})
        field_keys = [f["key"] for f in resp.json()["fields"]]
        self.assertNotIn("face_price", field_keys)
        self.assertIn("spec", field_keys)

    # ─── Admin Account Tests ──────────────────────────────────────────

    def create_admin_via_api(self, client, company_id, username="admin1", password="admin123"):
        resp = client.post(f"/api/companies/{company_id}/customers", json={
            "username": username,
            "password": password,
            "display_name": "管理员",
            "discount_rate": 1.0,
            "tax_rate": 0.13,
            "account_type": "admin",
        }, headers=self.admin_headers(client, company_id))
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def test_admin_sees_face_price_and_discount(self):
        """管理员报价返回面价、折扣率、报价（完整数据）。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_admin_via_api(client, company_id)

        token = self.login(client, username="admin1", password="admin123").json()["token"]
        resp = client.get("/api/customer/quote", params={"q": "A-001"},
                          headers={"X-Customer-Token": token})
        self.assertEqual(resp.status_code, 200, resp.text)

        result = resp.json()["results"][0]
        self.assertTrue(result["is_admin"])
        # 管理员能看到面价
        self.assertEqual(float(result["face_price"]), 100.0)
        # 管理员能看到折扣率（config rules default 50%）
        self.assertEqual(float(result["discount_percent"]), 50.0)
        # 报价 = 100 × 50% = 50
        self.assertEqual(float(result["quote_price"]), 50.0)
        # 管理员 fields 中有 face_price
        self.assertIn("face_price", result["fields"])
        # 管理员没有 base_price/final_quote/tax 等字段
        self.assertNotIn("base_price", result)
        self.assertNotIn("final_quote", result)
        self.assertNotIn("tax_amount", result)

    def test_admin_config_includes_rules(self):
        """管理员配置包含完整 rules/pricing。"""
        store = self.make_store()
        company_id = self.seed_company_with_items(store)
        client = TestClient(create_app(store))
        self.create_admin_via_api(client, company_id)

        token = self.login(client, username="admin1", password="admin123").json()["token"]
        resp = client.get("/api/customer/config", headers={"X-Customer-Token": token})
        config = resp.json()
        # 管理员能看到 rules
        self.assertIn("rules", config)
        self.assertIn("pricing", config)
        # 管理员能看到 face_price 字段定义
        field_keys = [f["key"] for f in config.get("fields", [])]
        self.assertIn("face_price", field_keys)

    def test_admin_company_switcher(self):
        """管理员可查看所有活跃公司列表。"""
        store = self.make_store()
        company_a = self.seed_company_with_items(store, code="co-a")
        company_b = store.create_company("Company B", "co-b")

        client = TestClient(create_app(store))
        self.create_admin_via_api(client, company_a)

        token = self.login(client, username="admin1", password="admin123").json()["token"]
        resp = client.get("/api/customer/companies", headers={"X-Customer-Token": token})
        companies = resp.json()
        # 管理员能看到所有公司
        self.assertGreaterEqual(len(companies), 2)
        codes = [c["code"] for c in companies]
        self.assertIn("co-a", codes)
        self.assertIn("co-b", codes)

    def test_company_account_only_sees_own_company(self):
        """公司账号只能看到自己的公司。"""
        store = self.make_store()
        company_a = self.seed_company_with_items(store, code="co-a")
        company_b = store.create_company("Company B", "co-b")

        client = TestClient(create_app(store))
        self.create_customer_via_api(client, company_a, username="user1")

        token = self.login(client, username="user1").json()["token"]
        resp = client.get("/api/customer/companies", headers={"X-Customer-Token": token})
        companies = resp.json()
        # 公司账号只看到自己的公司
        self.assertEqual(len(companies), 1)
        self.assertEqual(companies[0]["code"], "co-a")

    def test_admin_can_query_other_company(self):
        """管理员可通过 company_id 参数查看其他公司报价。"""
        store = self.make_store()
        company_a = self.seed_company_with_items(store, code="co-a")
        company_b = store.create_company("Company B", "co-b")
        config_b = {
            "schema_version": 3, "revision": "r1",
            "fields": [
                {"key": "spec", "label": "规格", "searchable": True},
                {"key": "face_price", "label": "面价", "type": "number"},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 40}]}],
        }
        store.save_config(company_b, config_b, status="published")
        store.replace_items(company_b, "d1", [
            {"item_key": "B-001", "fields": {"spec": "B-001", "face_price": 200}},
        ])

        client = TestClient(create_app(store))
        self.create_admin_via_api(client, company_a)

        token = self.login(client, username="admin1", password="admin123").json()["token"]
        # 管理员查询 company_b 的 B-001
        resp = client.get("/api/customer/quote", params={"q": "B-001", "company_id": company_b},
                          headers={"X-Customer-Token": token})
        self.assertEqual(resp.status_code, 200, resp.text)
        result = resp.json()["results"][0]
        # company_b 的规则是 40% 折扣 → 200 × 40% = 80
        self.assertEqual(float(result["quote_price"]), 80.0)
        self.assertEqual(float(result["face_price"]), 200.0)

    # ─── Password Hashing Tests ───────────────────────────────────────

    def test_password_hash_and_verify(self):
        pw = "test_password_123"
        h, s = hash_password(pw)
        self.assertTrue(verify_password(pw, h, s))
        self.assertFalse(verify_password("wrong", h, s))

    def test_password_salt_is_unique(self):
        h1, s1 = hash_password("same")
        h2, s2 = hash_password("same")
        self.assertNotEqual(s1, s2)  # 不同 salt
        self.assertNotEqual(h1, h2)  # 不同 hash
        self.assertTrue(verify_password("same", h1, s1))
        self.assertTrue(verify_password("same", h2, s2))


if __name__ == "__main__":
    unittest.main()
