"""Admin 商品数据路由：替换/上传/回滚/报价查询。"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, File, HTTPException, Query, UploadFile

import logging

from ..observability import capture_event
from ..store import DEFAULT_COMPANY_ID
from .auth import require_admin_api
from .models import ItemsReplace

logger = logging.getLogger(__name__)

# 文件上传大小上限：10MB（Excel 文件通常不超过此大小）
MAX_UPLOAD_SIZE = 10 * 1024 * 1024


def register(app) -> None:
    """注册商品数据端点（需 admin 认证）。"""
    store = app.state.store
    engine = app.state.engine

    @app.get("/api/items/stats", dependencies=[Depends(require_admin_api)])
    def get_items_stats(company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        return store.get_items_stats(company_id=company_id)

    @app.post("/api/items", dependencies=[Depends(require_admin_api)])
    def replace_items(payload: ItemsReplace, company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, int | str]:
        store.replace_items(payload.data_revision, payload.rows, company_id=company_id)
        capture_event("items.replaced", company_id=company_id, data_revision=payload.data_revision, count=len(payload.rows))
        return {"count": len(payload.rows)}

    @app.post("/api/items/upload", dependencies=[Depends(require_admin_api)])
    async def upload_items(
        file: UploadFile = File(...),
        data_revision: str = Query("", description="留空则自动从文件名生成"),
        write: bool = Query(False, description="True 时直接写入，False 仅预览"),
        company_id: str = Query(DEFAULT_COMPANY_ID),
        face_price_tax_inclusive: bool | None = Query(None, description="面价是否含税；None 则使用 config 默认"),
    ) -> dict[str, Any]:
        content = await file.read()
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail=f"文件过大（{len(content) // 1024 // 1024}MB），上限 {MAX_UPLOAD_SIZE // 1024 // 1024}MB")
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
            rev = data_revision or (filename.rsplit(".", 1)[0] + "_" + store.now()[:10])
            store.replace_items(rev, rows, company_id=company_id)
            return {"action": "written", "data_revision": rev, "count": len(rows), "report": report}
        return {"action": "preview", "count": len(rows), "report": report, "preview": rows[:5]}

    @app.delete("/api/items/rollback", dependencies=[Depends(require_admin_api)])
    def rollback_items(
        data_revision: str = Query(..., description="要回滚的库存版本，删除该版本的所有行"),
        company_id: str = Query(DEFAULT_COMPANY_ID),
    ) -> dict[str, Any]:
        try:
            return store.delete_items_revision(data_revision, company_id=company_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/quote", dependencies=[Depends(require_admin_api)])
    def quote(q: str = Query(..., min_length=1), company_id: str = Query(DEFAULT_COMPANY_ID)) -> dict[str, Any]:
        try:
            config = store.get_active_config(company_id=company_id)
            return {
                "config_revision": config["revision"],
                "results": engine.quote(q, company_id=company_id),
            }
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
