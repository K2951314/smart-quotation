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
        # 诊断信息：列出当前进程能读到的相关环境变量键名（不打印值，脱敏）
        # 帮助定位 Railway/Render 等平台变量未生效的问题
        related_keys = sorted(
            k for k in os.environ
            if k.startswith(("SQ_", "ALLOW_", "MMC_", "ADMIN_", "STOCK_", "SENTRY_"))
        )
        # 检查常见的拼写错误
        common_typos = [
            "ALLOW_ORIGIN", "ALLOW_ORIGINS", "ALLOW_ORIGINS ",
            "Allow_Origins", "allow_origins", "CORS_ORIGINS", "ALLOWED_ORIGINS",
        ]
        detected_typos = [k for k in common_typos if k in os.environ and k != "ALLOW_ORIGINS"]
        raise RuntimeError(
            "生产环境必须设置 ALLOW_ORIGINS 环境变量（逗号分隔的前端域名列表）。\n"
            "例如：ALLOW_ORIGINS=https://your-app.netlify.app\n"
            "本地开发可设 SQ_DEV=1 跳过此校验。\n\n"
            "─── 诊断信息 ───\n"
            f"当前进程读到的相关环境变量键名（共 {len(related_keys)} 个）：\n"
            + ("\n".join(f"  - {k}" for k in related_keys) if related_keys else "  （无，没有任何 SQ_/ALLOW_/MMC_ 等变量被读取到）")
            + (f"\n检测到可能的拼写错误变量：{detected_typos}\n请检查是否应为 ALLOW_ORIGINS" if detected_typos else "")
            + "\n\n常见原因：\n"
            "  1. Railway/Render 设置变量后服务未重新部署（去 Deployments 手动 Redeploy）\n"
            "  2. 变量设在错误的 Service 或 Environment 上（检查是否在当前部署的 service 下）\n"
            "  3. 变量名拼写错误（必须是 ALLOW_ORIGINS，全大写，下划线）\n"
            "  4. 变量值为空或只有空白字符"
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
    # DB_PATH 环境变量：生产环境指向持久化 Volume 挂载点（如 Railway Volume /data/quotation.db）
    # 未设置时回退到默认 quotation.db（本地开发行为不变）
    db_path = os.environ.get("DB_PATH") or "quotation.db"

    # Railway 免费版无持久化 Volume：启动时从 Supabase Storage 恢复 SQLite 备份
    # 配置 SQ_SUPABASE_BASE_URL + SQ_SUPABASE_SERVICE_KEY 后生效（详见 db_backup.py）
    if not os.path.exists(db_path):
        from ..store.db_backup import download_db
        download_db(db_path)  # 失败不阻塞，继续用空数据库启动

    store = store or QuotationStore(db_path=db_path)
    store.init_schema()

    # 注册数据库备份：按需上传 + 退出时上传到 Supabase Storage
    # 防止 Railway 重新部署时 SQLite 数据丢失
    # 不注册 SIGTERM handler——uvicorn 自己有优雅关闭逻辑，会触发 atexit
    from ..store.db_backup import upload_db, _get_backup_config, _latest_mtime
    import atexit
    import threading

    def _backup_now() -> None:
        upload_db(db_path)

    # 仅当配置了 Supabase 备份时才启动备份线程（本地开发/未配置时零开销，不浪费资源）
    if _get_backup_config():
        # 退出时备份（uvicorn 收到 SIGTERM 优雅关闭后会触发 atexit）
        atexit.register(_backup_now)

        # 按需备份：每 1 分钟检查 SQLite 主文件 + -wal + -shm 的 mtime，变了才上传
        # WAL 模式下写入只改 -wal，必须监控 -wal 才能可靠检测写入（否则漏备份丢数据）
        # 避免高频全量上传消耗 Supabase 带宽（免费版 2GB/月）
        _STOP = threading.Event()

        def _on_demand_backup() -> None:
            last = _latest_mtime(db_path)
            while not _STOP.wait(60):  # 每 1 分钟检查
                current = _latest_mtime(db_path)
                if current != last:
                    if _backup_now():
                        last = current

        _backup_thread = threading.Thread(target=_on_demand_backup, daemon=True)
        _backup_thread.start()
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
