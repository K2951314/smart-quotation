"""用户管理路由（超管专属）。

提供注册用户列表、改档位、启停、迁移公司、超管重置密码。
认证依赖 require_superadmin——平台级操作，租户无权。
"""

from __future__ import annotations

import secrets
from contextlib import closing
from typing import Any

from fastapi import Depends, HTTPException, Query

from .auth import require_admin_api, require_superadmin
from .models import SubAccountCreate, UserUpdate
from .passwords import hash_password
# 邮箱正则与 routes_auth 共用（项目内已有跨模块引用先例：auth.py 引 _decode_jwt）
from .routes_auth import _EMAIL_RE


def register(app) -> None:
    """注册用户管理端点（超管专属）。"""
    store = app.state.store

    @app.get("/api/users", dependencies=[Depends(require_superadmin)])
    def list_users(
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
        search: str = Query("", description="按邮箱模糊搜索"),
        plan: str = Query("", description="按档位筛选"),
        company_id: str = Query("", description="按公司筛选"),
        is_active: bool | None = Query(None, description="按状态筛选"),
    ) -> dict[str, Any]:
        """列出所有注册用户（超管）。"""
        offset = (page - 1) * page_size
        users, total = store.list_users(
            search=search,
            plan=plan,
            company_id=company_id,
            is_active=is_active,
            limit=page_size,
            offset=offset,
        )
        return {"users": users, "total": total, "page": page, "page_size": page_size}

    @app.get("/api/users/mine")
    def list_my_sub_accounts(auth: dict[str, Any] = Depends(require_admin_api)) -> dict[str, Any]:
        """当前租户的子账号列表（含自己）。配额展示用 seats 计数。"""
        if auth["role"] != "tenant":
            raise HTTPException(status_code=403, detail="仅登录租户可查看子账号")
        from ..license import get_plan_quota
        cid = auth["company_id"]
        plan = store.resolve_user_plan(auth["user_id"], cid)
        max_users = int(get_plan_quota(plan, "max_users", 1))
        users, total = store.list_users(company_id=cid, limit=200)
        return {"users": users, "total": total, "seats_max": max_users, "seats_used": total}

    @app.post("/api/users/sub")
    def create_sub_account(payload: SubAccountCreate, auth: dict[str, Any] = Depends(require_admin_api)) -> dict[str, Any]:
        """创建子账号（租户给自己公司添加登录席位）。

        配额：账号档位的 max_users（免费 1 / 个人 3 / 专业不限），
        计数口径 = 本公司全部用户（含停用——占坑）。超额 402 引导升级。
        子账号与主账号同权（同一公司数据），删除由列表页操作。
        """
        if auth["role"] != "tenant":
            raise HTTPException(status_code=403, detail="仅登录租户可创建子账号")
        from ..license import get_plan_quota

        email = payload.email.strip().lower()
        if not _EMAIL_RE.match(email) or len(email) > 254:
            raise HTTPException(status_code=422, detail="邮箱格式不正确")
        if len(payload.password) < 8:
            raise HTTPException(status_code=422, detail="密码至少 8 位")

        cid = auth["company_id"]
        plan = store.resolve_user_plan(auth["user_id"], cid)
        max_users = int(get_plan_quota(plan, "max_users", 1))
        used = store.count_users_in_company(cid, active_only=False)
        if max_users >= 0 and used >= max_users:
            raise HTTPException(
                status_code=402,
                detail=f"已达当前档位席位上限（{max_users} 个账号），请升级订阅。",
            )

        with closing(store.connect()) as conn:
            if conn.execute("select 1 from users where email = ?", (email,)).fetchone():
                raise HTTPException(status_code=409, detail="该邮箱已注册")
            user_id = secrets.token_urlsafe(16)
            conn.execute(
                "insert into users(id, email, password_hash, company_id, created_at) "
                "values(?, ?, ?, ?, ?)",
                (user_id, email, hash_password(payload.password), cid, store.now()),
            )
            conn.commit()
        store._mark_db_dirty(immediate=True)

        try:
            with closing(store.connect()) as conn:
                store.audit(
                    conn, auth["user_id"], "sub_account_create", "user", user_id,
                    {"email": email}, company_id=cid,
                )
                conn.commit()
        except Exception:  # noqa: BLE001
            pass

        return {"ok": True, "user": store.get_user(user_id), "seats_used": used + 1, "seats_max": max_users}

    @app.get("/api/users/{user_id}", dependencies=[Depends(require_superadmin)])
    def get_user(user_id: str) -> dict[str, Any]:
        """获取单个用户详情（超管）。"""
        user = store.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="用户不存在")
        return user

    @app.patch("/api/users/{user_id}", dependencies=[Depends(require_superadmin)])
    def update_user(user_id: str, payload: UserUpdate) -> dict[str, Any]:
        """更新用户属性：档位/启停/公司迁移（超管）。

        订阅语义（把 plan+plan_expires_at 视为用户的「当前订阅」）：
        - plan: ""=不改，"inherit"=退订回公司级，free/pro/team=分配
        - plan_duration: "7d"/"1m"/"3m"/"6m"/"1y" 快捷时长（月/年按日历计）。
          同档位 = 续期：从原到期日次日顺延（不截短剩余时间）；
          换档位 = 替换：旧订阅作废，新订阅从现在起算。
          到期日 =（基准日 + N 单位）的前一天末尾：8-28 订 1 个月 → 至 9-27。
        - plan_expires: 绝对到期（"YYYY-MM-DD"，当日末 UTC），与 duration
          二选一，同时传时 duration 优先；都不传 = 永久
        - 只传 plan_expires 不改 plan = 只调整现有订阅的到期时间

        审计 changes 带 old→new，订阅替换/续期可追溯。
        超管豁免档位上限；校验全部通过后单次写库。
        """
        import calendar as _calendar
        from ..license import TIER_PRESETS
        from datetime import datetime, timedelta, timezone

        user = store.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="用户不存在")

        updates: dict[str, Any] = {}

        # plan_expires 规范化：日期字符串 → 当日末（23:59:59）UTC ISO。
        # 空/None 语义见 docstring；非法日期 422。
        def _normalize_expires(raw: str | None) -> str | None:
            if raw is None or raw == "":
                return None
            raw = raw.strip()
            if not raw:
                return None
            try:
                if len(raw) == 10:  # 纯日期 "YYYY-MM-DD"：当日末到期
                    dt = datetime.fromisoformat(raw).replace(
                        hour=23, minute=59, second=59
                    )
                else:
                    dt = datetime.fromisoformat(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc).isoformat()
            except ValueError:
                raise HTTPException(
                    status_code=422,
                    detail=f"无效的到期时间: {raw}，格式应为 YYYY-MM-DD",
                )

        _DURATIONS = {"7d", "1m", "3m", "6m", "1y"}
        now = datetime.now(timezone.utc)

        def _add_calendar_months(dt: datetime, months: int) -> datetime:
            """日历月加法：月末截断（1-31 + 1 月 → 2-28/29）。"""
            total = dt.month - 1 + months
            year = dt.year + total // 12
            month = total % 12 + 1
            day = min(dt.day, _calendar.monthrange(year, month)[1])
            return dt.replace(year=year, month=month, day=day)

        def _expiry_at_day_end(end_day: datetime) -> str:
            """到期时刻 = 指定日期的 23:59:59Z（该日全天有效，次日 0 点失效）。"""
            d = end_day.date() - timedelta(days=1)
            return datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc).isoformat()

        def _resolve_new_expires(target_plan: str) -> str | None:
            """计算新订阅的到期时间。

            规则：到期日 =（基准日 + N 单位）的前一天末尾——
            8-28 订阅 1 个月 → 至 9-27；+3 个月 → 至 11-27（整月自然语义）。
            同档位续期基准 = 原到期日次日（原到期日全天仍有效，顺延不截短）；
            换档位/已过期基准 = 现在。
            """
            if payload.plan_duration:
                if payload.plan_duration not in _DURATIONS:
                    raise HTTPException(
                        status_code=422,
                        detail=f"无效时长: {payload.plan_duration}，"
                        f"可选: {', '.join(sorted(_DURATIONS))}",
                    )
                dur = payload.plan_duration
                base = now
                if target_plan == user.get("plan"):
                    # 续期：原订阅未过期则从原到期日次日顺延
                    old_exp = user.get("plan_expires_at")
                    if old_exp:
                        try:
                            old_dt = datetime.fromisoformat(old_exp)
                            if old_dt.tzinfo is None:
                                old_dt = old_dt.replace(tzinfo=timezone.utc)
                            if old_dt > now:
                                base = old_dt + timedelta(days=1)
                        except ValueError:
                            pass
                if dur == "7d":
                    end = base + timedelta(days=7)
                elif dur == "1m":
                    end = _add_calendar_months(base, 1)
                elif dur == "3m":
                    end = _add_calendar_months(base, 3)
                elif dur == "6m":
                    end = _add_calendar_months(base, 6)
                else:  # 1y
                    end = _add_calendar_months(base, 12)
                return _expiry_at_day_end(end)
            # 绝对日期或永久（无 duration 时）
            return _normalize_expires(payload.plan_expires)

        # plan 处理
        if payload.plan:
            if payload.plan == "inherit":
                updates["plan"] = None  # 退订，回退公司级
                updates["plan_expires_at"] = None  # 连到期一起清
            elif payload.plan in TIER_PRESETS:
                updates["plan"] = payload.plan
                updates["plan_expires_at"] = _resolve_new_expires(payload.plan)
            else:
                raise HTTPException(status_code=422, detail=f"无效订阅档位: {payload.plan}")
        elif payload.plan_duration or payload.plan_expires is not None:
            # 不改档位只调订阅时长/到期：现有档位必须存在
            if not user.get("plan"):
                raise HTTPException(
                    status_code=422, detail="该用户未分配档位，无法单独调整订阅时长"
                )
            updates["plan_expires_at"] = _resolve_new_expires(user["plan"])

        # is_active 处理
        if payload.is_active is not None:
            updates["is_active"] = payload.is_active

        # company_id 迁移（目标公司存在性先校验，再写库）
        if payload.company_id is not None:
            try:
                store.get_company(payload.company_id)
            except LookupError:
                raise HTTPException(status_code=404, detail="目标公司不存在")
            updates["company_id"] = payload.company_id

        if updates:
            store.update_user(user_id, **updates)

        changes = {
            k: ("inherit(回退公司级)" if k == "plan" and v is None else v)
            for k, v in updates.items()
        }
        # 订阅变更追溯：审计带 old→new（换档/续期/退订都可从审计还原）
        plan_changed = "plan" in updates or "plan_expires_at" in updates
        if plan_changed:
            changes["plan_old"] = user.get("plan")
            changes["plan_expires_old"] = user.get("plan_expires_at")

        # 审计
        try:
            with closing(store.connect()) as conn:
                store.audit(
                    conn, "superadmin", "user_update", "user", user_id, {"changes": changes},
                    company_id=user.get("company_id", "default"),
                )
                conn.commit()
        except Exception:  # noqa: BLE001
            pass

        return {"ok": True, "user": store.get_user(user_id), "changes": changes}

    @app.delete("/api/users/{user_id}")
    def delete_user(user_id: str, auth: dict[str, Any] = Depends(require_admin_api)) -> dict[str, Any]:
        """删除用户。

        - 超管：可删除任意用户
        - 租户：只能删除自己公司的子账号，且不能删自己（账号自毁会失去
          管理入口；如需注销请联系平台）
        """
        target = store.get_user(user_id)
        if not target:
            raise HTTPException(status_code=404, detail="用户不存在")

        if auth["role"] == "tenant":
            if target.get("company_id") != auth["company_id"]:
                raise HTTPException(status_code=403, detail="只能删除自己公司的子账号")
            if user_id == auth["user_id"]:
                raise HTTPException(status_code=422, detail="不能删除当前登录的账号")

        store.delete_user(user_id)
        company_id = target.get("company_id")
        remaining = store.count_users_in_company(company_id, active_only=False) if company_id else 0

        try:
            with closing(store.connect()) as conn:
                store.audit(
                    conn, auth.get("user_id", "superadmin"), "user_delete", "user", user_id,
                    {"email": target.get("email"), "company_id": company_id},
                    company_id=company_id or "default",
                )
                conn.commit()
        except Exception:  # noqa: BLE001
            pass

        return {
            "ok": True,
            "deleted_email": target.get("email"),
            "company_id": company_id,
            "company_orphaned": bool(company_id and remaining == 0),
        }

    @app.post("/api/users/{user_id}/reset-password", dependencies=[Depends(require_superadmin)])
    def admin_reset_password(user_id: str) -> dict[str, Any]:
        """超管强制重置用户密码：生成临时密码，明文只返回一次。

        超管需通过安全渠道（线下/电话）告知用户。同时清空 reset_token
        防旧 token 残留。临时密码用 token_urlsafe(12)（16 字符 URL-safe）。
        """
        user = store.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="用户不存在")

        temp_password = secrets.token_urlsafe(12)
        store.update_user(
            user_id,
            password_hash=hash_password(temp_password),
            reset_token=None,  # 清空旧 reset token
            reset_expires=None,
        )

        try:
            with closing(store.connect()) as conn:
                store.audit(
                    conn, "superadmin", "admin_password_reset", "user", user_id, {},
                    company_id=user.get("company_id", "default"),
                )
                conn.commit()
        except Exception:  # noqa: BLE001
            pass

        return {
            "ok": True,
            "temp_password": temp_password,
            "message": "临时密码已生成，请通过安全渠道告知用户。用户登录后建议自行修改密码。",
        }
