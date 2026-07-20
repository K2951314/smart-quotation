"""三菱库存查询端点。"""

from __future__ import annotations

import os

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ..mitsubishi_stock import get_engine as get_stock_engine
from ..observability import capture_event, capture_exception
from .auth import verify_stock_key


def register(app) -> None:
    """注册三菱库存查询端点。"""
    auth = app.state.auth
    store = app.state.store
    STOCK_QUERY_MAX_LINES = 50
    # 每日配额（24h 滚动窗口）：默认 500 次/天/公司
    # 通过环境变量 STOCK_QUERY_DAILY_LIMIT 配置
    try:
        STOCK_QUERY_DAILY_LIMIT = int(os.environ.get("STOCK_QUERY_DAILY_LIMIT", "500"))
    except ValueError:
        STOCK_QUERY_DAILY_LIMIT = 500

    @app.post("/api/stock-query")
    async def stock_query(request: Request):
        """查询三菱官网实时库存。

        请求头：X-Stock-Key: <key>  或  X-Company-Token: <token>
        请求体：{"queries": "型号1 材质1\\n型号2 材质2\\n..."}
        响应：{"results": ["型号 材质 上海库存N 日本库存M", ...], "count": N}

        性能策略：
        - GWT-RPC 是同步阻塞调用（单次 1-5 秒），用 run_in_threadpool 避免阻塞事件循环。
        - 否则三菱官网慢响应时，整个后端的所有其他请求都会被卡住。

        安全策略：
        - 公司级日配额：每个 company_id 每天最多 STOCK_QUERY_DAILY_LIMIT 次查询，
          防止令牌泄露后被刷爆三菱账号配额。
        - admin/stock-key 共享配额，防止 admin key 滥用。
        """
        # 1. 认证 + 获取配额键
        quota_key = verify_stock_key(request)
        # 2. 频率限制（短窗口：60s/30 次）
        auth.check_rate_limit(auth.get_client_id(request))
        # 3. 日配额检查（长窗口：24h 滚动，SQLite 持久化，跨 Worker 共享）
        try:
            today_count = store.count_stock_queries_today(quota_key)
        except Exception:
            today_count = 0  # DB 异常不阻塞查询，仅记录 warning
        if today_count >= STOCK_QUERY_DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=f"今日库存查询次数已达上限（{STOCK_QUERY_DAILY_LIMIT} 次），请明天再试或联系管理员",
            )

        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体不是合法 JSON")

        query_text = body.get("queries", "") if isinstance(body, dict) else ""
        lines = [ln.strip() for ln in str(query_text).split("\n") if ln.strip()]
        if not lines:
            return {"results": [], "count": 0}
        if len(lines) > STOCK_QUERY_MAX_LINES:
            raise HTTPException(status_code=422, detail=f"单次最多查询 {STOCK_QUERY_MAX_LINES} 条，请分批提交")

        engine = get_stock_engine()
        # ensure_ready 含登录请求（同步阻塞），放线程池执行
        if not await run_in_threadpool(engine.ensure_ready):
            capture_event("stock_query.login_failed", company_id=auth.get_client_id(request))
            raise HTTPException(status_code=503, detail="三菱官网登录失败，请检查 config.ini 中的账号密码")

        results = []
        for line in lines:
            parts = line.split(None, 1)
            model = parts[0]
            material = parts[1] if len(parts) > 1 else ""
            if not model:
                continue

            try:
                # search 是同步 GWT-RPC 调用，放线程池避免阻塞事件循环
                shanghai, japan, error = await run_in_threadpool(engine.search, model, material)
            except Exception as exc:
                capture_exception(exc, endpoint="stock_query", model=model)
                shanghai, japan, error = 0, 0, "查询异常"

            stock_parts = []
            if shanghai > 0:
                stock_parts.append(f"上海库存{shanghai}")
            if japan > 0:
                stock_parts.append(f"日本库存{japan}")

            inv = " ".join(stock_parts) if stock_parts else ("无货" if not error else "")
            tag = f" {material}" if material else ""

            if error:
                results.append(f"{model}{tag} {error}")
            else:
                results.append(f"{model}{tag} {inv}")

        # 4. 查询成功后记录（用于日配额统计）
        try:
            store.record_stock_query(quota_key)
        except Exception:
            pass  # DB 写入失败不阻塞返回结果

        return {"results": results, "count": len(results)}
