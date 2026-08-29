"""账号级 plan 解析测试：users.plan 优先、到期回退、回退公司级、回退 free。

验证 resolve_user_plan 优先级（含 plan_expires_at 到期检查）+ session 端点
返回账号级 plan。
"""

import os
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api import routes_auth
from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.api.passwords import hash_password
from backend.smart_quotation.store import QuotationStore


class UserPlanTest(unittest.TestCase):
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
        self.store.create_company("co-a", "公司A")
        self._create_user("u1", "alice@test.com", "password123", "co-a")

    def _create_user(self, uid, email, password, company_id):
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                (uid, email, hash_password(password), company_id, self.store.now()),
            )
            conn.commit()

    def _session(self, uid="u1", cid="co-a", email="alice@test.com"):
        jwt = routes_auth._create_jwt(uid, cid, email)
        return self.client.get("/api/auth/session", headers={"Authorization": f"Bearer {jwt}"})

    def test_resolve_user_plan_account_level(self):
        """users.plan 优先于公司级 plan。"""
        # 公司级设 free，账号级设 pro——session 应返回 pro
        self.store.update_company("co-a", meta={"plan": "free"})
        self.client.patch(
            "/api/users/u1", json={"plan": "pro"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        resp = self._session()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["plan"], "pro")

    def test_resolve_user_plan_fallback_company(self):
        """users.plan=NULL 时回退公司级 plan。"""
        self.store.update_company("co-a", meta={"plan": "team"})
        resp = self._session()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["plan"], "team")

    def test_resolve_user_plan_fallback_free(self):
        """公司和账号都未设 plan → free。"""
        resp = self._session()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["plan"], "free")

    # ─── 档位到期（plan_expires_at）────────────────────────

    def _set_plan_with_expiry(self, plan, expires_payload):
        """超管设置档位 + 到期（expires_payload 直接进 JSON）。"""
        body = {"plan": plan}
        if expires_payload is not ...:
            body["plan_expires"] = expires_payload
        return self.client.patch(
            "/api/users/u1", json=body,
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )

    def test_plan_with_expiry_date(self):
        """设置档位带到期日期：未到期前生效，get_user 返回 plan_expires_at。"""
        future = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")
        resp = self._set_plan_with_expiry("pro", future)
        self.assertEqual(resp.status_code, 200)
        user = resp.json()["user"]
        self.assertEqual(user["plan"], "pro")
        self.assertIsNotNone(user["plan_expires_at"])
        # session 在到期前返回分配的档位
        self.assertEqual(self._session().json()["plan"], "pro")

    def test_plan_without_expiry_is_permanent(self):
        """设置档位未传到期 → 永久（plan_expires_at 清空）。"""
        resp = self._set_plan_with_expiry("pro", ...)
        self.assertEqual(resp.status_code, 200)
        user = resp.json()["user"]
        self.assertEqual(user["plan"], "pro")
        self.assertIsNone(user["plan_expires_at"])

    def test_plan_expiry_date_normalizes_to_end_of_day(self):
        """纯日期到期时间归一化到当日末（23:59:59 UTC）。"""
        future = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")
        resp = self._set_plan_with_expiry("pro", future)
        stored = resp.json()["user"]["plan_expires_at"]
        self.assertIn("T23:59:59", stored)

    def test_plan_expired_falls_back_to_company(self):
        """档位到期后 resolve_user_plan 回退公司级。"""
        self.store.update_company("co-a", meta={"plan": "team"})
        past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        resp = self._set_plan_with_expiry("pro", past)
        self.assertEqual(resp.status_code, 200)
        # 账号级 pro 已过期 → 回退公司级 team
        self.assertEqual(self._session().json()["plan"], "team")
        # 列表里 plan_expires_at 仍保留（供超管看到过期状态）

    def test_plan_expiry_invalid_date_rejected(self):
        """非法到期日期 422。"""
        resp = self._set_plan_with_expiry("pro", "not-a-date")
        self.assertEqual(resp.status_code, 422)
        self.assertIn("到期时间", resp.json()["detail"])

    def test_plan_expiry_only_without_plan_rejected(self):
        """未分配档位的用户单独设置到期时间 422。"""
        resp = self.client.patch(
            "/api/users/u1", json={"plan_expires": "2027-01-01"},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 422)

    def test_plan_expiry_update_only(self):
        """只改到期时间不改档位：现有档位保留，到期更新。"""
        self._set_plan_with_expiry("pro", ...)
        new_exp = (datetime.now(timezone.utc) + timedelta(days=90)).strftime("%Y-%m-%d")
        resp = self.client.patch(
            "/api/users/u1", json={"plan_expires": new_exp},
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )
        self.assertEqual(resp.status_code, 200)
        user = resp.json()["user"]
        self.assertEqual(user["plan"], "pro")
        self.assertIn("T23:59:59", user["plan_expires_at"])

    def test_plan_inherit_clears_expiry(self):
        """inherit 清除档位时连到期时间一起清。"""
        self._set_plan_with_expiry("pro", "2027-01-01")
        resp = self._set_plan_with_expiry("inherit", ...)
        self.assertEqual(resp.status_code, 200)
        user = resp.json()["user"]
        self.assertIsNone(user["plan"])
        self.assertIsNone(user["plan_expires_at"])

    # ─── 订阅时长（plan_duration）：续期/替换/试用 ──────────

    def _patch(self, body):
        return self.client.patch(
            "/api/users/u1", json=body,
            headers={"Authorization": f"Bearer {self.admin_key}"},
        )

    @staticmethod
    def _add_months(dt, n):
        """日历月加法（与后端 _add_calendar_months 同规则）。"""
        import calendar as _c
        total = dt.month - 1 + n
        y = dt.year + total // 12
        m = total % 12 + 1
        d = min(dt.day, _c.monthrange(y, m)[1])
        return dt.replace(year=y, month=m, day=d)

    def _expected_expiry(self, base, months=None, days=None):
        """到期时刻 =（基准日 + N 单位）前一天末尾（23:59:59Z）。"""
        end = self._add_months(base, months) if months else base + timedelta(days=days)
        d = end.date() - timedelta(days=1)
        return datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc)

    def test_duration_1m_calendar_month(self):
        """1 个月 = 日历月：8-28 订阅 → 至 9-27（前一天末尾）。"""
        now = datetime.now(timezone.utc)
        resp = self._patch({"plan": "pro", "plan_duration": "1m"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        self.assertEqual(exp, self._expected_expiry(now, months=1))

    def test_duration_3m_calendar_months(self):
        """3 个月按日历：8-28 订阅 → 至 11-27。"""
        now = datetime.now(timezone.utc)
        resp = self._patch({"plan": "pro", "plan_duration": "3m"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        self.assertEqual(exp, self._expected_expiry(now, months=3))

    def test_duration_1y_calendar_year(self):
        """1 年按日历年。"""
        now = datetime.now(timezone.utc)
        resp = self._patch({"plan": "pro", "plan_duration": "1y"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        self.assertEqual(exp, self._expected_expiry(now, months=12))

    def test_duration_7d_trial(self):
        """7d 试用：覆盖订阅日起 7 个日历日（至 base+6 日的末尾）。"""
        now = datetime.now(timezone.utc)
        resp = self._patch({"plan": "pro", "plan_duration": "7d"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        self.assertEqual(exp, self._expected_expiry(now, days=7))

    def test_duration_extend_same_plan_from_current_expiry(self):
        """同档位续期：从原到期日次日顺延整月（至 3-31 续 3 个月 → 至 6-30）。"""
        self._patch({"plan": "team", "plan_expires": "2027-03-31"})
        resp = self._patch({"plan": "team", "plan_duration": "3m"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        # 基准 = 3-31 次日（4-1），+3 日历月 = 7-1，前一天 = 6-30
        self.assertEqual(exp, self._expected_expiry(
            datetime(2027, 4, 1, 23, 59, 59, tzinfo=timezone.utc), months=3))

    def test_duration_change_plan_replaces_from_now(self):
        """换档位：旧订阅作废，新订阅从现在起算（替换语义）。"""
        future = (datetime.now(timezone.utc) + timedelta(days=60)).strftime("%Y-%m-%d")
        self._patch({"plan": "team", "plan_expires": future})

        resp = self._patch({"plan": "pro", "plan_duration": "1m"})
        self.assertEqual(resp.status_code, 200)
        now = datetime.now(timezone.utc)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        # 换档从现在起算（≈ now+1 个月），而不是旧到期(60 天后)再 +1 月
        self.assertEqual(exp, self._expected_expiry(now, months=1))
        self.assertEqual(resp.json()["user"]["plan"], "pro")

    def test_duration_expired_same_plan_counts_from_now(self):
        """同档位但已过期：续期从现在起算（而不是从过去的到期顺延）。"""
        past = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
        self._patch({"plan": "pro", "plan_expires": past})

        now = datetime.now(timezone.utc)
        resp = self._patch({"plan": "pro", "plan_duration": "1m"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        self.assertEqual(exp, self._expected_expiry(now, months=1))

    def test_duration_invalid_rejected(self):
        """非法时长 422。"""
        resp = self._patch({"plan": "pro", "plan_duration": "2w"})
        self.assertEqual(resp.status_code, 422)
        self.assertIn("无效时长", resp.json()["detail"])

    def test_duration_audits_old_and_new(self):
        """审计记录订阅变更的 old→new（替换可追溯）。"""
        self._patch({"plan": "team", "plan_expires": "2027-06-30"})
        resp = self._patch({"plan": "pro", "plan_duration": "1m"})
        self.assertEqual(resp.status_code, 200)
        changes = resp.json()["changes"]
        self.assertEqual(changes.get("plan_old"), "team")
        self.assertIsNotNone(changes.get("plan_expires_old"))
        # 审计事件落库
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "select payload_json from audit_events "
                "where action = 'user_update' and target_id = 'u1' "
                "order by created_at desc limit 1"
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertIn("plan_old", row["payload_json"])

    def test_duration_only_no_plan(self):
        """只传 duration 不改档位：延长现有订阅（从原到期日次日整月顺延）。"""
        self._patch({"plan": "pro", "plan_duration": "1m"})
        old_exp = datetime.fromisoformat(self.store.get_user("u1")["plan_expires_at"])
        resp = self._patch({"plan_duration": "3m"})
        self.assertEqual(resp.status_code, 200)
        exp = datetime.fromisoformat(resp.json()["user"]["plan_expires_at"])
        # 基准 = 原到期日次日，+3 日历月，前一天
        base = old_exp + timedelta(days=1)
        self.assertEqual(exp, self._expected_expiry(base, months=3))
        self.assertEqual(resp.json()["user"]["plan"], "pro")

    def test_delete_company_deactivates_users(self):
        """删除公司时关联用户被停用（级联）。"""
        # 先让用户活跃
        self.assertTrue(self.store.is_user_active("u1"))
        # 删除公司
        self.store.delete_company("co-a")
        # 用户被停用
        self.assertFalse(self.store.is_user_active("u1"))


if __name__ == "__main__":
    unittest.main()
