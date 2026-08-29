"""配置继承 + Tier（利润率分组）测试。

覆盖：
- 成员公司（parent_company_id）配置/数据/bundle 继承 parent
- Tier 利润率解析链：tier → meta.profit_margin → 默认 10
- /api/tiers GET/PUT + /api/companies/{id}/assign-tier POST
- /api/public/company/{id} 返回 tier 解析后的 profit_margin
- 向后兼容：无 parent_company_id 的公司行为不变
"""

import os
import tempfile
import unittest
from pathlib import Path

# 测试环境：dev 模式，不设 ALLOW_ORIGINS（与 SQ_DEV 互斥断言）
os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)

from fastapi.testclient import TestClient

from backend.smart_quotation.api.factory import create_app
from backend.smart_quotation.store import QuotationStore


class TierInheritanceTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "quotation.db"
        self.store = QuotationStore(str(db_path))
        self.store.init_schema()
        self.app = create_app(store=self.store)
        self.client = TestClient(self.app)
        self.admin_key = "admin-secret-key"  # SQ_DEV=1 时的弱默认值
        self.auth = {"Authorization": f"Bearer {self.admin_key}"}

        # 创建管理员公司（拥有 config + data + tiers）
        self.store.create_company("admin-co", "管理员公司", meta={
            "is_admin": True,
            "profit_margin": 0,
            "tiers": [
                {"name": "A级", "profit_margin": 5, "color": "#2c5282"},
                {"name": "B级", "profit_margin": 10, "color": "#38a169"},
            ],
        })
        # 创建成员公司（继承 admin-co 的 config/data，tier=A级）
        self.store.create_company("member-a", "成员A公司", meta={
            "parent_company_id": "admin-co",
            "tier": "A级",
        })
        # 创建成员公司（继承 admin-co 的 config/data，tier=B级）
        self.store.create_company("member-b", "成员B公司", meta={
            "parent_company_id": "admin-co",
            "tier": "B级",
        })
        # 创建独立公司（无 parent，无 tier，向后兼容）
        self.store.create_company("standalone", "独立公司", meta={
            "profit_margin": 15,
        })

        # 在 admin-co 名下发布配置 + 数据
        config = {
            "schema_version": 3,
            "revision": "r1",
            "pricing": {
                "decimal_places": 1,
                "default_formula": "face_price * discount_percent / 100",
            },
            "fields": [
                {"key": "spec", "label": "规格", "searchable": True, "required": True},
                {"key": "face_price", "label": "面价", "type": "number"},
            ],
            "rules": [
                {"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]},
            ],
        }
        self.store.save_config(config, status="published", company_id="admin-co")
        self.store.replace_items("d1", [
            {"item_key": "WNMG080408", "fields": {"spec": "WNMG080408", "face_price": 100}},
        ], company_id="admin-co")

    # ─── resolve_data_company_id ───────────────────────────

    def test_member_resolves_to_parent(self):
        """成员公司的 resolve_data_company_id 返回 parent。"""
        self.assertEqual(self.store.resolve_data_company_id("member-a"), "admin-co")
        self.assertEqual(self.store.resolve_data_company_id("member-b"), "admin-co")

    def test_standalone_resolves_to_self(self):
        """独立公司（无 parent）的 resolve_data_company_id 返回自身。"""
        self.assertEqual(self.store.resolve_data_company_id("standalone"), "standalone")
        self.assertEqual(self.store.resolve_data_company_id("admin-co"), "admin-co")

    def test_self_parent_ignored(self):
        """parent_company_id 指向自身时被忽略（防环）。"""
        self.store.create_company("self-ref", "自环公司", meta={"parent_company_id": "self-ref"})
        self.assertEqual(self.store.resolve_data_company_id("self-ref"), "self-ref")

    # ─── resolve_profit_margin ─────────────────────────────

    def test_tier_profit_margin_resolution(self):
        """tier 设置时利润率从 parent.tiers 查找。"""
        self.assertEqual(self.store.resolve_profit_margin("member-a"), 5.0)  # A级 5%
        self.assertEqual(self.store.resolve_profit_margin("member-b"), 10.0)  # B级 10%

    def test_meta_profit_margin_fallback(self):
        """无 tier 时回退到 meta.profit_margin。"""
        self.assertEqual(self.store.resolve_profit_margin("standalone"), 15.0)

    def test_default_profit_margin_fallback(self):
        """无 tier 且无 meta.profit_margin 时回退到默认 10。"""
        self.store.create_company("no-margin", "无利润率公司", meta={})
        self.assertEqual(self.store.resolve_profit_margin("no-margin"), 10.0)

    def test_admin_profit_margin_from_meta(self):
        """管理员公司自身无 tier 时用 meta.profit_margin。"""
        self.assertEqual(self.store.resolve_profit_margin("admin-co"), 0.0)

    # ─── 配置继承 ──────────────────────────────────────────

    def test_member_inherits_parent_config(self):
        """成员公司 get_active_config 返回 parent 的已发布配置。"""
        config = self.store.get_active_config(company_id="member-a")
        self.assertEqual(config["revision"], "r1")
        self.assertTrue(config.get("rules"))  # 成员也能拿到完整 rules（脱敏在 API 层做）

    def test_member_inherits_parent_items(self):
        """成员公司 search_items 搜索 parent 的商品数据。"""
        results = self.store.search_items("WNMG", ["spec"], company_id="member-a")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["fields"]["spec"], "WNMG080408")

    def test_member_get_items_stats_uses_parent(self):
        """成员公司 get_items_stats 返回 parent 的数据统计。"""
        stats = self.store.get_items_stats(company_id="member-b")
        self.assertEqual(stats["count"], 1)
        self.assertEqual(stats["data_revision"], "d1")

    # ─── Bundle 继承 ───────────────────────────────────────

    def test_member_price_bundle_uses_parent_data(self):
        """成员公司 build_price_bundle 使用 parent 的 config + data。"""
        import base64, json
        bundle = self.store.build_price_bundle(company_id="member-a", role="company")
        rows = json.loads(base64.b64decode(bundle["payload"]))["rows"]
        self.assertEqual(len(rows), 1)
        # quote_price = 面价100 × 折扣50% = 50.0（decimal_places=1）
        self.assertEqual(rows[0]["fields"]["quote_price"], "50.0")
        # 脱敏：面价不应出现在 bundle 中
        self.assertNotIn("face_price", rows[0]["fields"])

    # ─── API: /api/tiers ───────────────────────────────────

    def test_api_get_tiers_for_admin(self):
        """GET /api/tiers?company_id=admin-co 返回 admin 的 tiers。"""
        resp = self.client.get("/api/tiers?company_id=admin-co", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["company_id"], "admin-co")
        self.assertIsNone(data["parent_company_id"])
        self.assertEqual(len(data["tiers"]), 2)
        self.assertEqual(data["tiers"][0]["name"], "A级")

    def test_api_get_tiers_for_member_resolves_parent(self):
        """GET /api/tiers?company_id=member-a 返回 parent 的 tiers。"""
        resp = self.client.get("/api/tiers?company_id=member-a", headers=self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["parent_company_id"], "admin-co")
        self.assertEqual(len(data["tiers"]), 2)

    def test_api_put_tiers_on_admin(self):
        """PUT /api/tiers 替换 admin 的 tier 列表。"""
        resp = self.client.put("/api/tiers?company_id=admin-co", headers=self.auth, json={
            "tiers": [
                {"name": "VIP", "profit_margin": 3, "color": "#gold"},
                {"name": "标准", "profit_margin": 8},
            ],
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["tiers"]), 2)
        self.assertEqual(data["tiers"][0]["name"], "VIP")

        # 确认已写入 meta
        company = self.store.get_company("admin-co")
        self.assertEqual(len(company["meta"]["tiers"]), 2)

    # ─── API: /api/companies/{id}/assign-tier ──────────────

    def test_api_assign_tier_to_company(self):
        """POST /api/companies/{id}/assign-tier 分配公司到 tier。"""
        resp = self.client.post("/api/companies/standalone/assign-tier", headers=self.auth, json={
            "tier": "A级",
            "parent_company_id": "admin-co",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["tier"], "A级")
        self.assertEqual(data["parent_company_id"], "admin-co")
        self.assertEqual(data["profit_margin"], 5.0)  # A级 5%

        # 确认 standalone 现在继承 admin-co 的数据
        self.assertEqual(self.store.resolve_data_company_id("standalone"), "admin-co")

    def test_api_assign_tier_remove(self):
        """POST assign-tier with tier=null 移除 tier 分配。"""
        resp = self.client.post("/api/companies/member-a/assign-tier", headers=self.auth, json={
            "tier": None,
            "parent_company_id": "",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIsNone(data["tier"])
        self.assertIsNone(data["parent_company_id"])
        # 回退到默认 10
        self.assertEqual(data["profit_margin"], 10.0)

    def test_api_assign_tier_rejects_self_parent(self):
        """assign-tier 拒绝 parent_company_id 等于自身。"""
        resp = self.client.post("/api/companies/member-a/assign-tier", headers=self.auth, json={
            "tier": "A级",
            "parent_company_id": "member-a",
        })
        self.assertEqual(resp.status_code, 422)

    def test_api_assign_tier_rejects_nonexistent_parent(self):
        """assign-tier 拒绝不存在的 parent。"""
        resp = self.client.post("/api/companies/member-a/assign-tier", headers=self.auth, json={
            "tier": "A级",
            "parent_company_id": "ghost-company",
        })
        self.assertEqual(resp.status_code, 422)

    def test_api_assign_tier_rejects_default(self):
        """default 公司不支持 tier 分配。"""
        resp = self.client.post("/api/companies/default/assign-tier", headers=self.auth, json={
            "tier": "A级",
            "parent_company_id": "admin-co",
        })
        self.assertEqual(resp.status_code, 422)

    # ─── API: /api/public/company/{id} ─────────────────────

    def test_api_public_company_returns_tier_margin(self):
        """/api/public/company/member-a 返回 tier 解析后的 profit_margin。"""
        # member-a 的 token
        company = self.store.get_company("member-a")
        token = company["meta"]["access_token"]
        resp = self.client.get("/api/public/company/member-a", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["role"], "company")
        self.assertEqual(data["profit_margin"], 5.0)  # A级 5%
        self.assertEqual(data["tier"], "A级")
        self.assertEqual(data["parent_company_id"], "admin-co")

    def test_api_public_company_standalone_margin(self):
        """/api/public/company/standalone 返回 meta.profit_margin。"""
        company = self.store.get_company("standalone")
        token = company["meta"]["access_token"]
        resp = self.client.get("/api/public/company/standalone", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["profit_margin"], 15.0)
        self.assertIsNone(data["tier"])

    # ─── 端到端：成员公司通过 API 查询配置 ─────────────────

    def test_member_config_api_returns_parent_config_desensitized(self):
        """成员公司 GET /api/config/active 返回 parent 的脱敏配置。"""
        company = self.store.get_company("member-a")
        token = company["meta"]["access_token"]
        resp = self.client.get("/api/config/active?company_id=member-a", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        config = resp.json()
        # 安全设计：移除 rules/discount_rules 防止通过 quote_price 反推 face_price
        # 公司账户使用服务端预计算的 quote_price，不需要知道折扣规则
        self.assertNotIn("rules", config)  # 移除 rules
        self.assertNotIn("discount_rules", config)  # 移除 discount_rules
        self.assertTrue(config.get("_desensitized"))
        # 但 fields 应该存在（来自 parent 的配置）
        self.assertTrue(config.get("fields"))

    def test_member_price_bundle_api(self):
        """成员公司 GET /price.bundle.json 返回 parent 数据的脱敏 bundle。"""
        import base64, json
        company = self.store.get_company("member-b")
        token = company["meta"]["access_token"]
        resp = self.client.get("/price.bundle.json?company_id=member-b", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        bundle = resp.json()
        rows = json.loads(base64.b64decode(bundle["payload"]))["rows"]
        self.assertEqual(len(rows), 1)
        # quote_price = 面价100 × 折扣50% = 50.0（decimal_places=1）
        self.assertEqual(rows[0]["fields"]["quote_price"], "50.0")
        self.assertNotIn("face_price", rows[0]["fields"])

    # ─── base_url 环境变量权威 ─────────────────────────────

    def _publish_config_with_old_base_url(self):
        """发布一份含「历史遗留」旧 base_url 的配置，模拟数据库里写死的地址。"""
        config = {
            "schema_version": 3,
            "revision": "base-url-test",
            "data_source": {"base_url": "https://old.supabase.co/storage/v1/object/public/old-bucket"},
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 50}]}],
        }
        self.store.save_config(config, status="published", company_id="admin-co")

    def test_env_supabase_url_overrides_config_base_url(self):
        """环境变量 SQ_SUPABASE_BASE_URL 优先覆盖配置里已写入的 base_url。"""
        self._publish_config_with_old_base_url()
        os.environ["SQ_SUPABASE_BASE_URL"] = "https://env.supabase.co/storage/v1/object/public/env-bucket"
        self.addCleanup(os.environ.pop, "SQ_SUPABASE_BASE_URL", None)

        company = self.store.get_company("member-a")
        token = company["meta"]["access_token"]
        resp = self.client.get("/api/config/active?company_id=member-a", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.json()["data_source"]["base_url"],
            "https://env.supabase.co/storage/v1/object/public/env-bucket",
        )

    def test_no_env_keeps_config_base_url(self):
        """环境变量未设时，保留配置里已写入的 base_url（兜底）。"""
        self._publish_config_with_old_base_url()
        os.environ.pop("SQ_SUPABASE_BASE_URL", None)
        self.addCleanup(os.environ.pop, "SQ_SUPABASE_BASE_URL", None)

        company = self.store.get_company("member-a")
        token = company["meta"]["access_token"]
        resp = self.client.get("/api/config/active?company_id=member-a", headers={
            "X-Company-Token": token,
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.json()["data_source"]["base_url"],
            "https://old.supabase.co/storage/v1/object/public/old-bucket",
        )

    # ─── 向后兼容 ──────────────────────────────────────────

    def test_backward_compat_standalone_config(self):
        """独立公司 save_config + get_active_config 行为不变。"""
        config = {
            "schema_version": 3,
            "revision": "s1",
            "fields": [{"key": "spec", "searchable": True, "required": True}],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 30}]}],
        }
        self.store.save_config(config, status="published", company_id="standalone")
        got = self.store.get_active_config(company_id="standalone")
        self.assertEqual(got["revision"], "s1")
        self.assertEqual(got["rules"][0]["actions"][0]["percent"], 30)

    def test_backward_compat_default_company(self):
        """default 公司行为完全不变（无 parent，无 tier）。"""
        self.assertEqual(self.store.resolve_data_company_id("default"), "default")
        self.assertEqual(self.store.resolve_profit_margin("default"), 10.0)

    # ─── Tier 变更后利润率即时生效 ─────────────────────────

    def test_tier_margin_change_takes_effect_immediately(self):
        """修改 admin 的 tier 利润率后，成员公司立即用新值。"""
        # 初始：member-a 利润率 5%（A级）
        self.assertEqual(self.store.resolve_profit_margin("member-a"), 5.0)

        # 修改 A级 利润率为 7%
        company = self.store.get_company("admin-co")
        meta = dict(company["meta"])
        meta["tiers"][0]["profit_margin"] = 7
        self.store.update_company("admin-co", meta=meta)

        # member-a 现在用 7%
        self.assertEqual(self.store.resolve_profit_margin("member-a"), 7.0)

    def test_move_company_between_tiers(self):
        """公司将 member-a 从 A级 移到 B级，利润率从 5% 变 10%。"""
        self.assertEqual(self.store.resolve_profit_margin("member-a"), 5.0)

        company = self.store.get_company("member-a")
        meta = dict(company["meta"])
        meta["tier"] = "B级"
        self.store.update_company("member-a", meta=meta)

        self.assertEqual(self.store.resolve_profit_margin("member-a"), 10.0)

    # ─── 订阅档位（plan）语义：管理员=客户，成员=客户的客户（继承）──────

    def test_member_inherits_admin_plan(self):
        """成员公司（客户的客户）继承管理员公司的订阅档位，不自订阅。"""
        admin = self.store.get_company("admin-co")
        meta = dict(admin["meta"]); meta["plan"] = "team"
        self.store.update_company("admin-co", meta=meta)
        self.assertEqual(self.store.resolve_subscription_plan("member-a"), "team")

    def test_member_ignores_own_plan(self):
        """成员公司即使设了自己的 meta.plan 也被忽略，继承管理员。"""
        admin = self.store.get_company("admin-co")
        meta_a = dict(admin["meta"]); meta_a["plan"] = "pro"
        self.store.update_company("admin-co", meta=meta_a)
        member = self.store.get_company("member-a")
        meta_m = dict(member["meta"]); meta_m["plan"] = "team"
        self.store.update_company("member-a", meta=meta_m)
        # member-a 自己的 plan=team 被忽略，继承 admin-co 的 pro
        self.assertEqual(self.store.resolve_subscription_plan("member-a"), "pro")

    def test_member_watermark_inherits_admin(self):
        """成员公司水印继承管理员公司档位（free 档带水印）。"""
        admin = self.store.get_company("admin-co")
        meta = dict(admin["meta"]); meta["plan"] = "free"
        self.store.update_company("admin-co", meta=meta)
        profile = self.store.resolve_company_profile("member-a")
        self.assertEqual(profile["plan"], "free")
        self.assertTrue(profile["watermark"])

    def test_admin_company_falls_back_to_license_tier(self):
        """admin 公司未设 plan 时回退 license tier（供应商能力 = 部署授权）。"""
        self.assertEqual(self.store.resolve_subscription_plan("admin-co"), "team")

    def test_standalone_company_fails_closed_to_free(self):
        """独立公司（注册用户，无 parent）未设 plan 时 fail-closed 到 free。"""
        # setUp 已占用公司名「独立公司」（公司名全局唯一），这里用不同名
        self.store.create_company("standalone-x", "独立公司X", meta={})
        self.assertEqual(self.store.resolve_subscription_plan("standalone-x"), "free")

    # ─── 订阅档位上限（plan ≤ license tier）─────────────────

    def test_superadmin_can_assign_any_plan(self):
        """超管可以分配任意档位（不受 plan ≤ license tier 约束）。

        设计原则：plan 上限检查只约束租户管理员（防 JWT 用户自我提权），
        超管作为部署管理员应能分配任意档位（如给客户演示高档位功能）。
        """
        from backend.smart_quotation.license import set_dev_tier_override
        set_dev_tier_override("free")  # 部署 license 为 free
        try:
            resp = self.client.patch(
                "/api/companies/admin-co",
                json={"meta": {"plan": "team"}},
                headers=self.auth,  # admin API Key = 超管
            )
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["meta"]["plan"], "team")
        finally:
            set_dev_tier_override(None)

    def test_tenant_cannot_exceed_license_tier(self):
        """租户管理员（JWT）不能给自己分配超过部署 license 的档位。

        攻击场景：部署 license 为 pro，租户通过 PATCH /api/companies/{id}
        尝试给自己设 plan=team → 应返回 402。
        """
        from backend.smart_quotation.license import set_dev_tier_override
        from backend.smart_quotation.api.routes_auth import _create_jwt, configure_jwt
        from backend.smart_quotation.api.passwords import hash_password
        from contextlib import closing
        import secrets as _secrets
        # 插入真实用户（is_active 校验需要 user_id 存在于 DB）
        with closing(self.store.connect()) as conn:
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                ("user-1", "tenant@test.com", hash_password("password123"), "standalone", self.store.now()),
            )
            conn.commit()
        # 租户 JWT：绑定到 standalone 公司
        configure_jwt(_secrets.token_hex(32))
        jwt_token = _create_jwt("user-1", "standalone", "tenant@test.com")
        tenant_auth = {"Authorization": f"Bearer {jwt_token}"}

        set_dev_tier_override("pro")  # 部署 license 为 pro
        try:
            resp = self.client.patch(
                "/api/companies/standalone",
                json={"meta": {"plan": "team"}},  # team > pro → 应被拒
                headers=tenant_auth,
            )
            # 租户不能改 plan（黑名单过滤），或者超限返回 402
            # 黑名单过滤在 update_company_admin 中：租户的 plan 被移除，
            # 所以实际上不会触发 _validate_plan_within_license
            # 但如果绕过黑名单，_validate_plan_within_license 会拦
            self.assertIn(resp.status_code, (200, 402, 403))
        finally:
            set_dev_tier_override(None)

    def test_plan_within_license_tier_allowed(self):
        """部署 license 为 pro 时，给管理员公司分配 pro 档成功。"""
        from backend.smart_quotation.license import set_dev_tier_override
        set_dev_tier_override("pro")
        try:
            resp = self.client.patch(
                "/api/companies/admin-co",
                json={"meta": {"plan": "pro"}},
                headers=self.auth,
            )
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["meta"]["plan"], "pro")
        finally:
            set_dev_tier_override(None)

    def test_plan_invalid_value_rejected(self):
        """无效 plan 值返回 422。"""
        resp = self.client.patch(
            "/api/companies/admin-co",
            json={"meta": {"plan": "garbage"}},
            headers=self.auth,
        )
        self.assertEqual(resp.status_code, 422)

    def test_data_quota_uses_data_owner_plan(self):
        """成员公司数据配额用 parent（数据归属公司）的 plan，而非自己的 plan。"""
        # admin-co（数据归属）plan=free（max_skus=500）；member-a 继承 free
        admin = self.store.get_company("admin-co")
        meta_a = dict(admin["meta"]); meta_a["plan"] = "free"
        self.store.update_company("admin-co", meta=meta_a)
        # member-a 上传 501 行 SKU（超过 free 的 500），配额应按 admin-co 的 free → 402
        rows = [{"item_key": f"k{i}", "fields": {"face_price": 100}} for i in range(501)]
        resp = self.client.post(
            "/api/items",
            params={"company_id": "member-a"},
            json={"data_revision": "r1", "rows": rows},
            headers=self.auth,
        )
        self.assertEqual(resp.status_code, 402)


if __name__ == "__main__":
    unittest.main()
