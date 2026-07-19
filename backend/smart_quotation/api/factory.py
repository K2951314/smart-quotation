"""FastAPI 应用工厂：CORS 配置、共享状态初始化、路由注册、静态文件挂载。"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ..engine import QuotationEngine
from ..observability import init_sentry
from ..store import QuotationStore
from .auth import AuthContext, load_admin_api_key
from .routes_companies import register as register_companies
from .routes_config import register as register_config
from .routes_items import register as register_items
from .routes_merger import register as register_merger
from .routes_public import register as register_public
from .routes_stock import register as register_stock


def create_app(store: QuotationStore | None = None) -> FastAPI:
    """创建 FastAPI 应用实例。

    Args:
        store: 可选的 QuotationStore 实例（测试注入用）。默认新建。

    Returns:
        配置好的 FastAPI 应用，包含所有路由和中间件。
    """
    # 初始化可观测性（Sentry 按需启用，无 SENTRY_DSN 时无操作）
    init_sentry()

    app = FastAPI(title="Smart Quotation API", version="0.2.0")

    # CORS 配置：生产环境强制设置 ALLOW_ORIGINS，未设置时拒绝启动
    is_dev = os.environ.get("SQ_DEV", "0") == "1"
    raw = os.environ.get("ALLOW_ORIGINS", "").strip()

    # H2 防护：SQ_DEV=1 与 ALLOW_ORIGINS 共存 = 生产环境误开 dev 模式
    # 这会导致认证绕过 + CORS 通配，是最危险的配置错误
    if is_dev and raw:
        raise RuntimeError(
            "安全断言失败：SQ_DEV=1 与 ALLOW_ORIGINS 同时设置。\n"
            "SQ_DEV=1 会关闭公开端点认证、跳过限流、允许 CORS 通配，仅限本地开发。\n"
            "如果这是生产部署，请删除 SQ_DEV 环境变量。\n"
            "如果这是本地开发，请删除 ALLOW_ORIGINS 环境变量。"
        )

    if raw:
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        allow_credentials = True
    elif is_dev:
        origins = ["*"]
        allow_credentials = False
    else:
        raise RuntimeError(
            "生产环境必须设置 ALLOW_ORIGINS 环境变量（逗号分隔的前端域名列表）。\n"
            "例如：ALLOW_ORIGINS=https://your-app.netlify.app\n"
            "本地开发可设 SQ_DEV=1 跳过此校验。"
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=allow_credentials,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Company-Token",
            "X-Stock-Key",
        ],
    )

    # 初始化共享状态
    store = store or QuotationStore()
    store.init_schema()
    app.state.store = store
    app.state.engine = QuotationEngine(store)
    app.state.is_dev = is_dev

    # 启动期加载并校验 ADMIN_API_KEY（失败直接抛异常，拒绝启动）
    admin_api_key = load_admin_api_key()
    stock_query_key = os.environ.get("STOCK_QUERY_KEY", "").strip()
    app.state.auth = AuthContext(
        store=store,
        admin_api_key=admin_api_key,
        stock_query_key=stock_query_key,
        is_dev=is_dev,
    )

    # License 启动检查（最小缓解 P1-2：提醒但不禁启动，避免破坏现有部署）
    # 生产环境未配置 license 时记录警告；完整强制校验留待下一阶段
    import logging
    _logger = logging.getLogger(__name__)
    try:
        from ..license import verify_license
        payload = verify_license()
        if payload is None and not is_dev:
            _logger.warning(
                "SQ_LICENSE 未设置或无效。商业授权未生效，请尽快配置。"
                "完整 license 强制校验将在后续版本启用。"
            )
        elif payload is not None:
            _logger.info("License 已验证：customer=%s, expires_at=%s", payload.get("customer"), payload.get("expires_at"))
    except RuntimeError as exc:
        if not is_dev:
            _logger.warning("License 校验异常: %s", exc)

    # 注册路由模块
    register_public(app)
    register_companies(app)
    register_config(app)
    register_items(app)
    register_merger(app)
    register_stock(app)

    # 挂载静态文件
    root_dir = Path(__file__).resolve().parents[3]
    admin_dir = root_dir / "admin"
    apps_dir = root_dir / "apps"

    if admin_dir.exists():
        app.mount("/admin", StaticFiles(directory=str(admin_dir), html=True), name="admin")
    if apps_dir.exists():
        app.mount("/apps", StaticFiles(directory=str(apps_dir)), name="apps")

    return app
