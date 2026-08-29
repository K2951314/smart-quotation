"""公司 CRUD + 访问令牌管理 + 配置继承/Tier 解析。"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID

# 双后端 IntegrityError：SQLite + PostgreSQL（psycopg2 懒加载）
def _get_integrity_errors():
    try:
        from psycopg2 import errors as _pg_errors
        return (sqlite3.IntegrityError, _pg_errors.UniqueViolation)
    except ImportError:
        return sqlite3.IntegrityError

_IntegrityError = _get_integrity_errors()


class CompanyNameTaken(ValueError):
    """公司名已被占用（区别于 ID 冲突——register 据此决定 409 而非重试）。"""


# 默认利润率（未配置 tier 且无 meta.profit_margin 时使用）
DEFAULT_PROFIT_MARGIN = 10.0


class CompaniesMixin:
    """公司管理：CRUD、令牌生成/验证/轮换、配置继承、Tier 利润率解析。"""

    # 令牌默认有效期：90 天。可通过 company meta.token_expires_days 覆盖。
    DEFAULT_TOKEN_EXPIRES_DAYS = 90

    # ─── 配置继承 + Tier 解析 ──────────────────────────────

    def resolve_data_company_id(self, company_id: str) -> str:
        """解析数据归属公司 ID。

        成员公司（meta.parent_company_id 已设置）的配置/商品数据/bundle
        全部从 parent 读取；独立公司（无 parent_company_id）行为不变。

        防环：若 parent 等于自身或 parent 链超过 3 层，停止回退。
        """
        current = company_id
        for _ in range(3):  # 最多 3 层，防环
            try:
                company = self.get_company(current)
            except LookupError:
                return current
            parent_id = (company.get("meta") or {}).get("parent_company_id")
            if not parent_id or parent_id == current:
                return current
            current = parent_id
        return current

    def resolve_subscription_plan(self, company_id: str) -> str:
        """解析公司的订阅档位（free/pro/team）。

        订阅语义（业务模型）：
        - 管理员公司（is_admin=true）＝供应商的「客户」，订阅档位（meta.plan）
          由供应商分配；未显式设 plan 时回退部署 license tier。
        - 成员公司（parent_company_id 指向管理员）＝客户的「客户」（终端），
          不自订阅——无条件继承其管理员公司的订阅档位（自己的 meta.plan 忽略），
          只有利润率（tier）是独立的。
        - 独立公司（注册用户）＝直接订阅，未设 plan 时 fail-closed 到 free。

        优先级：
        1. 成员公司 → 无条件继承 parent（管理员公司）的订阅档位
        2. 管理员公司 / 独立公司的 meta.plan（显式分配）
        3. 供应商性质公司（is_admin / default）→ 部署 license tier
        4. 普通独立公司 → free（fail-closed）

        注意：与 resolve_profit_margin（利润率分组）无关——plan 管功能/配额，
        tier（利润率）管加价，是两套独立体系。
        """
        from ..license import TIER_PRESETS, TIER_FREE, verify_license
        is_vendor = company_id == DEFAULT_COMPANY_ID
        plan: str | None = None
        parent_id: str | None = None
        try:
            company = self.get_company(company_id)
            meta = company.get("meta") or {}
            plan = meta.get("plan")
            is_vendor = is_vendor or bool(meta.get("is_admin"))
            parent_id = meta.get("parent_company_id")
        except LookupError:
            pass
        # 成员公司（客户的客户）：无条件继承数据归属公司（parent 管理员）的订阅档位
        if parent_id and parent_id != company_id:
            data_company_id = self.resolve_data_company_id(company_id)
            if data_company_id != company_id:
                return self.resolve_subscription_plan(data_company_id)
        # 管理员公司 / 独立公司：显式 meta.plan 优先（供应商单独调档的覆盖）
        if plan in TIER_PRESETS:
            return plan
        # 无显式 plan → 回退 owner 账号的订阅（账号升级，名下公司自动跟着升级）。
        # 用 resolve_user_plan 保证到期感知（账号档位过期 → 公司回退 free）；
        # owner 无 plan/已失效 → fail-closed 到 free——绝不穿透部署 license 档位：
        # 多租户下注册公司虽有 is_admin 标记，但不是供应商公司。
        owner_id = meta.get("owner_user_id")
        if owner_id:
            return self.resolve_user_plan(owner_id)
        # 无 owner 的历史公司：供应商性质（is_admin / default）回退部署 license tier
        if is_vendor:
            payload = verify_license()
            if payload:
                tier = payload.get("tier")
                if tier in TIER_PRESETS:
                    return tier
        # 普通独立公司未显式设 plan 时 fail-closed 到 free
        return TIER_FREE

    def resolve_user_plan(self, user_id: str | None, company_id: str | None = None) -> str:
        """解析用户的订阅档位（账号级优先，渐进兼容）。

        优先级：
        1. users.plan（账号级显式分配，覆盖公司级；带 plan_expires_at 到期时间，
           过期后视为未分配）
        2. 回退 resolve_subscription_plan(company_id)（现有公司级 plan + 继承逻辑）
        3. fail-closed 到 free

        设计：resolve_subscription_plan 完全不变（公司级配额/继承的权威）。
        账号级 plan 只影响 session 展示和超管分配入口，配额门控仍用公司级。
        """
        from ..license import TIER_PRESETS, TIER_FREE
        if user_id:
            try:
                with closing(self.connect()) as conn:
                    row = conn.execute(
                        "SELECT plan, plan_expires_at FROM users WHERE id = ?", (user_id,)
                    ).fetchone()
                if row and row["plan"] in TIER_PRESETS:
                    expires_str = row["plan_expires_at"]
                    if expires_str:
                        # 到期检查：过期/非法时间都视为未分配，回退公司级
                        try:
                            expires_dt = datetime.fromisoformat(expires_str)
                            if expires_dt.tzinfo is None:
                                expires_dt = expires_dt.replace(tzinfo=timezone.utc)
                            if datetime.now(timezone.utc) >= expires_dt:
                                return (
                                    self.resolve_subscription_plan(company_id)
                                    if company_id else TIER_FREE
                                )
                        except (ValueError, TypeError):
                            pass
                    return row["plan"]
            except Exception:  # noqa: BLE001 users 表不存在或迁移未跑
                pass
        if company_id:
            return self.resolve_subscription_plan(company_id)
        return TIER_FREE

    def resolve_profit_margin(self, company_id: str) -> float:
        """解析公司利润率（优先级：tier → meta.profit_margin → 默认 10）。

        1. 若公司 meta.tier 已设置，到 parent（或自身）的 meta.tiers 查找
        2. tier 未匹配或未设置 → fallback 到 meta.profit_margin
        3. 都未设置 → 默认 10
        """
        try:
            company = self.get_company(company_id)
        except LookupError:
            if company_id == DEFAULT_COMPANY_ID:
                return DEFAULT_PROFIT_MARGIN
            return DEFAULT_PROFIT_MARGIN
        meta = company.get("meta") or {}

        # 1. tier 解析
        tier_name = meta.get("tier")
        if tier_name:
            tiers = self.get_tiers(company_id)
            for tier in tiers:
                if tier.get("name") == tier_name:
                    try:
                        return float(tier.get("profit_margin", DEFAULT_PROFIT_MARGIN))
                    except (TypeError, ValueError):
                        return DEFAULT_PROFIT_MARGIN

        # 2. fallback meta.profit_margin
        pm = meta.get("profit_margin")
        if pm is not None:
            try:
                return float(pm)
            except (TypeError, ValueError):
                pass

        # 3. 默认值
        return DEFAULT_PROFIT_MARGIN

    def get_tiers(self, company_id: str) -> list[dict[str, Any]]:
        """获取作用于该公司的 Tier 列表。

        - 成员公司：从 parent 的 meta.tiers 读取
        - 管理员/独立公司：从自身 meta.tiers 读取
        """
        data_company_id = self.resolve_data_company_id(company_id)
        try:
            company = self.get_company(data_company_id)
        except LookupError:
            return []
        return (company.get("meta") or {}).get("tiers") or []

    def resolve_company_profile(self, company_id: str) -> dict[str, Any]:
        """解析公司完整 profile（含 tier 利润率 + plan 订阅档位 + watermark）。

        供 /api/public/company/{id} 使用。
        plan 是该公司订阅档位（每客户不同订阅的核心），watermark 由 plan 决定。
        """
        try:
            company = self.get_company(company_id)
        except LookupError:
            if company_id == DEFAULT_COMPANY_ID:
                plan = self.resolve_subscription_plan(company_id)
                watermark = self._resolve_watermark(company_id)
                return {
                    "id": "default",
                    "name": "默认",
                    "role": "company",
                    "profit_margin": DEFAULT_PROFIT_MARGIN,
                    "tier": None,
                    "parent_company_id": None,
                    "plan": plan,
                    "watermark": watermark,
                    "watermark_config": self._resolve_watermark_config() if watermark else None,
                }
            raise
        meta = company.get("meta") or {}
        role = "admin" if meta.get("is_admin") else "company"
        profit_margin = self.resolve_profit_margin(company_id)
        plan = self.resolve_subscription_plan(company_id)
        watermark = self._resolve_watermark(company_id)
        return {
            "id": company["id"],
            "name": company["name"],
            "role": role,
            "profit_margin": profit_margin,
            "tier": meta.get("tier"),
            "parent_company_id": meta.get("parent_company_id"),
            "plan": plan,
            "watermark": watermark,
            "watermark_config": self._resolve_watermark_config() if watermark else None,
        }

    def _resolve_watermark(self, company_id: str) -> bool:
        """从公司订阅档位（plan）获取 watermark 标志（free=True，pro/team=False）。

        客户门户根据此字段决定是否显示水印。
        """
        from ..license import get_plan_quota
        plan = self.resolve_subscription_plan(company_id)
        return bool(get_plan_quota(plan, "watermark", True))

    @staticmethod
    def _resolve_watermark_config() -> dict[str, str | None]:
        """从环境变量读取自定义水印内容。

        返回包含以下字段的 dict（均为可选，未设置时为 None）：
        - text: 水印文字（如 "Powered by 智能询价"），未设时前端用默认文案
        - phone: 联系电话（点击可拨号），如 "18863995420"
        - wechat_qr: 微信二维码图片 URL（点击放大长按识别）

        所有值来自环境变量，不硬编码在源码中（安全 + 可部署时配置）。
        """
        import os
        return {
            "text": os.environ.get("WATERMARK_TEXT", "").strip() or None,
            "phone": os.environ.get("WATERMARK_PHONE", "").strip() or None,
            "wechat_qr": os.environ.get("WATERMARK_WECHAT_QR", "").strip() or None,
        }

    def list_companies(self) -> list[dict[str, Any]]:
        """列出所有公司（按创建时间降序），确保 default 始终在列表中。"""
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "select id, name, created_at, meta_json from companies order by created_at desc"
            ).fetchall()
        out = []
        has_default = False
        for row in rows:
            item = {"id": row["id"], "name": row["name"], "created_at": row["created_at"]}
            try:
                item["meta"] = json.loads(row["meta_json"] or "{}")
            except json.JSONDecodeError:
                item["meta"] = {}
            out.append(item)
            if row["id"] == "default":
                has_default = True
        if not has_default:
            out.append({"id": "default", "name": "默认", "created_at": "", "meta": {}})
        return out

    def get_company(self, company_id: str) -> dict[str, Any]:
        """获取单个公司（含 meta）。不存在时 raise LookupError。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select id, name, created_at, meta_json from companies where id = ?",
                (company_id,),
            ).fetchone()
        if not row:
            raise LookupError(f"company {company_id} not found")
        try:
            meta = json.loads(row["meta_json"] or "{}")
        except json.JSONDecodeError:
            meta = {}
        return {"id": row["id"], "name": row["name"], "created_at": row["created_at"], "meta": meta}

    def create_company(self, company_id: str, name: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """创建公司，自动生成访问令牌。

        去重：同 ID → ValueError（已存在）；同名公司 → ValueError（公司名已存在）。
        """
        company_id = str(company_id).strip()
        if not company_id:
            raise ValueError("company_id 不能为空")
        name = str(name).strip()
        if not name:
            raise ValueError("公司名称不能为空")
        meta = dict(meta or {})
        if not meta.get("access_token"):
            meta["access_token"] = self._generate_access_token()
        if not meta.get("token_created_at"):
            meta["token_created_at"] = datetime.now(timezone.utc).isoformat()
        with closing(self.connect()) as conn:
            # 公司名唯一（去重机制：已有名字不能再被其他账号注册）
            if conn.execute(
                "select 1 from companies where name = ?", (name,)
            ).fetchone():
                raise CompanyNameTaken(f"公司名「{name}」已被占用")
            try:
                conn.execute(
                    "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                    (company_id, name, self.now(), json.dumps(meta, ensure_ascii=False)),
                )
            except _IntegrityError as exc:
                raise ValueError(f"company {company_id} 已存在") from exc
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return {"id": company_id, "name": name, "meta": meta}

    @staticmethod
    def _generate_access_token() -> str:
        """生成 URL 安全的随机访问令牌（43 字符，256 位熵）。"""
        return secrets.token_urlsafe(32)

    def verify_company_token(self, company_id: str, token: str) -> bool:
        """验证公司访问令牌（compare_digest 防时序攻击 + 过期检查）。"""
        if not token:
            return False
        try:
            company = self.get_company(company_id)
        except LookupError:
            return False
        meta = company.get("meta") or {}
        stored_token = meta.get("access_token", "")
        if not stored_token:
            return False
        if not secrets.compare_digest(token, stored_token):
            return False
        token_created_at = meta.get("token_created_at", "")
        if token_created_at:
            try:
                created = datetime.fromisoformat(token_created_at.replace("Z", "+00:00"))
                expires_days = int(meta.get("token_expires_days", self.DEFAULT_TOKEN_EXPIRES_DAYS))
                age = datetime.now(timezone.utc) - created
                if age.days > expires_days:
                    return False
            except (ValueError, TypeError):
                pass
        return True

    def find_company_by_token(self, token: str) -> str | None:
        """用 token 反查公司 ID（遍历所有公司，compare_digest 匹配）。

        用于前端请求 bundle/version.json 时漏传 company_id 的兜底场景：
        后端收到 X-Company-Token 但 company_id=default，用 token 找出真实公司。
        公司数量受 license 限制（通常 ≤5），遍历开销可接受。
        """
        if not token:
            return None
        for company in self.list_companies():
            meta = company.get("meta") or {}
            stored_token = meta.get("access_token", "")
            if stored_token and secrets.compare_digest(token, stored_token):
                # 复用过期检查逻辑
                token_created_at = meta.get("token_created_at", "")
                if token_created_at:
                    try:
                        created = datetime.fromisoformat(token_created_at.replace("Z", "+00:00"))
                        expires_days = int(meta.get("token_expires_days", self.DEFAULT_TOKEN_EXPIRES_DAYS))
                        age = datetime.now(timezone.utc) - created
                        if age.days > expires_days:
                            return None
                    except (ValueError, TypeError):
                        pass
                return company["id"]
        return None

    def regenerate_company_token(self, company_id: str) -> dict[str, Any]:
        """重新生成公司访问令牌（旧令牌立即失效）。"""
        company = self.get_company(company_id)
        meta = dict(company.get("meta") or {})
        meta["access_token"] = self._generate_access_token()
        meta["token_created_at"] = datetime.now(timezone.utc).isoformat()
        return self.update_company(company_id, meta=meta)

    def update_company(self, company_id: str, name: str | None = None, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """更新公司名称和/或 meta。

        改名规则：每个公司只有一次改名机会（meta.name_changed_at 已用即拒绝）；
        新名与其他公司重名 → ValueError。
        """
        if name is not None:
            cur = self.get_company(company_id)
            new_name = str(name).strip()
            if not new_name:
                raise ValueError("公司名称不能为空")
            meta_now = dict(cur.get("meta") or {})
            if new_name != cur.get("name"):
                if meta_now.get("name_changed_at"):
                    raise ValueError("该公司已用过改名机会，不能再改名")
                with closing(self.connect()) as conn:
                    if conn.execute(
                        "select 1 from companies where name = ? and id != ?",
                        (new_name, company_id),
                    ).fetchone():
                        raise ValueError(f"公司名「{new_name}」已被占用")
                # 标记改名已用
                meta_now["name_changed_at"] = self.now()
                if meta is None:
                    meta = meta_now
                else:
                    meta = dict(meta)
                    meta["name_changed_at"] = meta_now["name_changed_at"]
        with closing(self.connect()) as conn:
            if name is not None:
                conn.execute("update companies set name = ? where id = ?", (str(name).strip(), company_id))
            if meta is not None:
                conn.execute(
                    "update companies set meta_json = ? where id = ?",
                    (json.dumps(meta, ensure_ascii=False), company_id),
                )
            if conn.total_changes == 0:
                raise LookupError(f"company {company_id} not found")
            conn.commit()
        self._mark_db_dirty(immediate=True)
        return self.get_company(company_id)

    def rename_company_id(self, old_id: str, new_id: str, name: str | None = None) -> dict[str, Any]:
        """改公司 ID（每个公司仅限一次）。级联更新所有引用：
        users / quotation_configs / quotation_items / audit_events。
        审计事件 id 也随公司走，rename 本身留审计（新 id 下记录 old→new）。
        """
        old_id = str(old_id).strip()
        new_id = str(new_id).strip()
        if not new_id:
            raise ValueError("新 ID 不能为空")
        if not re.match(r"^[a-zA-Z0-9_\-一-鿿]+$", new_id):
            raise ValueError("公司ID只能含中文/英文/数字/下划线/连字符")
        if new_id == DEFAULT_COMPANY_ID:
            raise ValueError("default 是系统保留 ID")
        if new_id == old_id:
            return self.get_company(old_id)
        cur = self.get_company(old_id)
        meta = dict(cur.get("meta") or {})
        if meta.get("id_changed_at"):
            raise ValueError("该公司已用过改 ID 机会，不能再改")
        meta["id_changed_at"] = self.now()
        with closing(self.connect()) as conn:
            if conn.execute("select 1 from companies where id = ?", (new_id,)).fetchone():
                raise ValueError(f"公司 ID「{new_id}」已存在")
            # 先建新行（保住 id 唯一性），再迁移数据引用，最后删旧行
            conn.execute(
                "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                (new_id, name or cur.get("name") or old_id, cur["created_at"], json.dumps(meta, ensure_ascii=False)),
            )
            for table in ("users", "quotation_configs", "quotation_items", "audit_events"):
                conn.execute(
                    f"update {table} set company_id = ? where company_id = ?",
                    (new_id, old_id),
                )
            conn.execute("delete from companies where id = ?", (old_id,))
            conn.commit()
        # 记审计（新 id 下，公司历史随 id 迁移保持可查）
        try:
            with closing(self.connect()) as conn:
                self.audit(
                    conn, "superadmin", "company_rename", "company", new_id,
                    {"old_id": old_id, "new_id": new_id}, company_id=new_id,
                )
                conn.commit()
        except Exception:  # noqa: BLE001
            pass
        self._mark_db_dirty(immediate=True)
        return self.get_company(new_id)

    def get_company_by_name(self, name: str) -> dict[str, Any] | None:
        """按公司名查（unique 校验用）。"""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "select id, name, created_at, meta_json from companies where name = ?",
                (str(name).strip(),),
            ).fetchone()
        if not row:
            return None
        meta = json.loads(row["meta_json"] or "{}")
        return {"id": row["id"], "name": row["name"], "created_at": row["created_at"], "meta": meta}

    def count_users_in_company(self, company_id: str, active_only: bool = True) -> int:
        """该公司下注册用户数（active_only=True 只统计启用的）。"""
        with closing(self.connect()) as conn:
            q = "select count(*) as n from users where company_id = ?"
            if active_only:
                q += " and is_active = 1"
            row = conn.execute(q, (company_id,)).fetchone()
        return int(row["n"])

    def count_companies_owned_by(self, user_id: str, primary_company_id: str | None = None) -> int:
        """该账号拥有的数据源管理员公司数（账号配额 max_companies 的计数口径）。

        所有权 = meta.owner_user_id == user_id 的顶级公司（含注册时自动创建的
        主公司）。成员公司不占此配额（营销口径的「N 家公司」= N 个管理员）。
        """
        return len(self.list_owned_company_ids(user_id, primary_company_id))

    def list_owned_company_ids(self, user_id: str, primary_company_id: str | None = None) -> set[str]:
        """账号拥有的顶级公司 ID 集合（主公司 + owner_user_id 标记的）。"""
        owned: set[str] = set()
        if primary_company_id:
            owned.add(primary_company_id)
        with closing(self.connect()) as conn:
            rows = conn.execute("select id, meta_json from companies").fetchall()
        for r in rows:
            try:
                meta = json.loads(r["meta_json"] or "{}")
            except json.JSONDecodeError:
                continue
            if meta.get("owner_user_id") == user_id and not meta.get("parent_company_id"):
                owned.add(r["id"])
        return owned

    def list_companies_for_tenant(self, user_id: str, primary_company_id: str) -> list[dict[str, Any]]:
        """租户可见公司：自己拥有的管理员公司 + 这些公司下的成员公司。"""
        owned = self.list_owned_company_ids(user_id, primary_company_id)
        result: list[dict[str, Any]] = []
        for c in self.list_companies():
            meta = c.get("meta") or {}
            if c["id"] in owned:
                result.append(c)
            elif meta.get("parent_company_id") in owned:
                result.append(c)
        return result

    def delete_company(self, company_id: str) -> dict[str, str]:
        """删除公司 + 级联删除其所有配置/数据/审计。

        安全策略：default 租户不可删除（防止误删导致系统不可用）。
        """
        if company_id == DEFAULT_COMPANY_ID:
            raise ValueError("默认公司不能删除")
        with closing(self.connect()) as conn:
            row = conn.execute("select id from companies where id = ?", (company_id,)).fetchone()
            if not row:
                raise LookupError(f"company {company_id} not found")
            conn.execute("delete from quotation_configs where company_id = ?", (company_id,))
            conn.execute("delete from quotation_items where company_id = ?", (company_id,))
            conn.execute("delete from audit_events where company_id = ?", (company_id,))
            # 级联停用关联用户（不删除，保留记录供审计；其 JWT 因 is_active=0 立即失效）
            conn.execute(
                "update users set is_active = 0 where company_id = ?", (company_id,)
            )
            conn.execute("delete from companies where id = ?", (company_id,))
            conn.commit()
        self.cache.invalidate()
        # 级联停用绕过了 update_user，这里手动失效 is_active 缓存
        self._invalidate_user_active_cache()
        self._mark_db_dirty(immediate=True)
        return {"company_id": company_id, "status": "deleted"}
