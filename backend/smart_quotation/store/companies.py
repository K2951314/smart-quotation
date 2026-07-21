"""公司 CRUD + 访问令牌管理。"""

from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

from .base import DEFAULT_COMPANY_ID


class CompaniesMixin:
    """公司管理：CRUD、令牌生成/验证/轮换。"""

    # 令牌默认有效期：90 天。可通过 company meta.token_expires_days 覆盖。
    DEFAULT_TOKEN_EXPIRES_DAYS = 90

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
        """创建公司，自动生成访问令牌。"""
        company_id = str(company_id).strip()
        if not company_id:
            raise ValueError("company_id 不能为空")
        meta = dict(meta or {})
        if not meta.get("access_token"):
            meta["access_token"] = self._generate_access_token()
        if not meta.get("token_created_at"):
            meta["token_created_at"] = datetime.now(timezone.utc).isoformat()
        with closing(self.connect()) as conn:
            try:
                conn.execute(
                    "insert into companies(id, name, created_at, meta_json) values(?, ?, ?, ?)",
                    (company_id, str(name).strip(), self.now(), json.dumps(meta, ensure_ascii=False)),
                )
            except sqlite3.IntegrityError as exc:
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
        """更新公司名称和/或 meta。"""
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
            conn.execute("delete from companies where id = ?", (company_id,))
            conn.commit()
        self.cache.invalidate()
        self._mark_db_dirty(immediate=True)
        return {"company_id": company_id, "status": "deleted"}
