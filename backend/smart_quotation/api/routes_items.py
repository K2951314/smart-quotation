"""Admin 商品数据路由：替换/上传/回滚/报价查询。

租户隔离：所有端点使用 Depends(resolve_company_id)，JWT 用户只能操作自己公司的数据。
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, File, HTTPException, Query, UploadFile

import logging

from ..license import get_plan_quota
from ..observability import capture_event
from .auth import resolve_company_id
from .models import ItemsReplace

logger = logging.getLogger(__name__)

# 文件上传大小上限：10MB（Excel 文件通常不超过此大小）
MAX_UPLOAD_SIZE = 10 * 1024 * 1024


async def _read_upload_limited(file: UploadFile, max_size: int) -> bytes:
    """分块读取上传文件，超过 max_size 立即中止（防超大文件全量缓冲 OOM DoS）。

    旧实现 `await file.read()` 把整个文件读入内存后才校验大小，
    攻击者上传 1GB 文件时服务器先全量缓冲再返回 413。
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)  # 1MB 分块
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            raise HTTPException(
                status_code=413,
                detail=f"文件过大（>{max_size // 1024 // 1024}MB），上限 {max_size // 1024 // 1024}MB",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _check_sku_quota(count: int, store, company_id: str) -> None:
    """检查 SKU 数量是否超出「数据归属公司订阅档位」上限。-1 表示不限。

    成员公司数据实际写入 parent（store.replace_items 内部 resolve_data_company_id），
    故配额必须用数据归属公司的 plan，而非操作公司，否则成员公司可用自己
    更高档的 plan 绕过 parent 的数据池上限。
    """
    data_company_id = store.resolve_data_company_id(company_id)
    plan = store.resolve_subscription_plan(data_company_id)
    max_skus = get_plan_quota(plan, "max_skus", -1)
    if max_skus >= 0 and count > max_skus:
        raise HTTPException(
            status_code=402,
            detail=f"SKU 数量（{count}）超出当前订阅上限（{max_skus}），请升级订阅。",
        )


def register(app) -> None:
    """注册商品数据端点（需 admin 认证）。"""
    store = app.state.store
    engine = app.state.engine

    @app.get("/api/items/stats")
    def get_items_stats(company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        return store.get_items_stats(company_id=company_id)

    @app.post("/api/items")
    def replace_items(payload: ItemsReplace, company_id: str = Depends(resolve_company_id)) -> dict[str, int | str]:
        _check_sku_quota(len(payload.rows), store, company_id)
        store.replace_items(payload.data_revision, payload.rows, company_id=company_id)
        capture_event("items.replaced", company_id=company_id, data_revision=payload.data_revision, count=len(payload.rows))
        return {"count": len(payload.rows)}

    @app.post("/api/items/upload")
    async def upload_items(
        file: UploadFile = File(...),
        data_revision: str = Query("", description="留空则自动从文件名生成"),
        write: bool = Query(False, description="True 时直接写入，False 仅预览"),
        company_id: str = Depends(resolve_company_id),
        face_price_tax_inclusive: bool | None = Query(None, description="面价是否含税；None 则使用 config 默认"),
    ) -> dict[str, Any]:
        content = await _read_upload_limited(file, MAX_UPLOAD_SIZE)
        filename = file.filename or "upload.xlsx"
        try:
            rows, report = store.parse_excel_to_rows(
                content, filename, company_id=company_id,
                face_price_tax_inclusive=face_price_tax_inclusive,
            )
        except ImportError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ValueError as exc:
            logger.warning("Excel 解析失败: %s", exc, exc_info=True)
            raise HTTPException(status_code=422, detail="文件解析失败，请检查格式和列名是否匹配配置") from exc
        except Exception as exc:
            logger.warning("Excel 解析异常: %s", exc, exc_info=True)
            raise HTTPException(status_code=422, detail="文件解析异常，请检查文件是否损坏") from exc

        if write:
            _check_sku_quota(len(rows), store, company_id)
            rev = data_revision or (filename.rsplit(".", 1)[0] + "_" + store.now()[:10])
            store.replace_items(rev, rows, company_id=company_id)
            return {"action": "written", "data_revision": rev, "count": len(rows), "report": report}
        return {"action": "preview", "count": len(rows), "report": report, "preview": rows[:5]}

    @app.delete("/api/items/rollback")
    def rollback_items(
        data_revision: str = Query(..., description="要回滚的库存版本，删除该版本的所有行"),
        company_id: str = Depends(resolve_company_id),
    ) -> dict[str, Any]:
        try:
            return store.delete_items_revision(data_revision, company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/quote")
    def quote(q: str = Query(..., min_length=1), company_id: str = Depends(resolve_company_id)) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id=company_id)
            return {
                "config_revision": config["revision"],
                "results": engine.quote(q, company_id=company_id),
            }
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
