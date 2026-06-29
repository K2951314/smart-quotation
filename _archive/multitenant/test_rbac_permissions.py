import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.smart_quotation.api import create_app
from backend.smart_quotation.auth import hash_password
from backend.smart_quotation.store import QuotationStore


class RbacPermissionsTest(unittest.TestCase):
    def make_store(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = QuotationStore(str(Path(tmp.name) / "quotation.db"))
        store.init_schema()
        return store

    def seed_accounts(self, store):
        company_id = store.create_company("Company A", "company-a")
        admin_hash, admin_salt = hash_password("admin-pass")
        store.create_customer(
            company_id=company_id,
            username="admin",
            password_hash=admin_hash,
            password_salt=admin_salt,
            display_name="Admin",
            account_type="admin",
        )
        user_hash, user_salt = hash_password("company-pass")
        store.create_customer(
            company_id=company_id,
            username="company",
            password_hash=user_hash,
            password_salt=user_salt,
            display_name="Company User",
            account_type="company",
        )
        return company_id

    def login(self, client, username, password):
        response = client.post(
            "/api/customer/login",
            json={"company_code": "company-a", "username": username, "password": password},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return {"X-Customer-Token": response.json()["token"]}

    def test_admin_endpoints_require_admin_token(self):
        store = self.make_store()
        company_id = self.seed_accounts(store)
        client = TestClient(create_app(store))

        # No API key → 401
        no_token = client.get("/api/companies")
        self.assertEqual(no_token.status_code, 401)

        # Customer token (even admin) → 401, because admin API routes use API key auth, not customer token
        admin_headers = self.login(client, "admin", "admin-pass")
        customer_token_fail = client.get("/api/companies", headers=admin_headers)
        self.assertEqual(customer_token_fail.status_code, 401)

        # Correct API key → 200
        allowed = client.get("/api/companies", headers={"Authorization": "Bearer admin-secret-key"})
        self.assertEqual(allowed.status_code, 200)
        self.assertIn(company_id, {company["id"] for company in allowed.json()})

    def test_company_token_cannot_create_customer(self):
        store = self.make_store()
        company_id = self.seed_accounts(store)
        client = TestClient(create_app(store))

        company_headers = self.login(client, "company", "company-pass")
        response = client.post(
            f"/api/companies/{company_id}/customers",
            headers=company_headers,
            json={"username": "new", "password": "new-pass", "display_name": "New User"},
        )

        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
