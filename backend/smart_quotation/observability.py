"""可观测性模块：Sentry 集成 + 结构化日志。

设计原则：
- SENTRY_DSN 环境变量设置时才初始化 Sentry，否则完全无操作。
- 不引入硬依赖：sentry-sdk 按需 import。
- 关键操作（配置发布、数据导入、登录）通过 capture_event 上报。
- 本地开发零成本：不需要 Sentry 账号也能正常运行。
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_sentry_initialized = False
_sentry_available = False


def init_sentry() -> None:
    """初始化 Sentry SDK。环境变量 SENTRY_DSN 未设置时跳过。"""
    global _sentry_initialized, _sentry_available
    if _sentry_initialized:
        return
    _sentry_initialized = True

    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
    except ImportError:
        # sentry-sdk 未安装，静默跳过
        logger.warning("SENTRY_DSN 已设置但 sentry-sdk 未安装，请运行：pip install sentry-sdk[fastapi]")
        return

    environment = os.environ.get("SENTRY_ENVIRONMENT", "production")
    release = os.environ.get("SENTRY_RELEASE", "smart-quotation@0.2.0")
    traces_sample_rate = float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1"))

    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=release,
        traces_sample_rate=traces_sample_rate,
        integrations=[FastApiIntegration()],
        # 安全：不发送请求体（可能含敏感数据）
        send_default_pii=False,
        max_request_body_size="never",
    )
    _sentry_available = True
    logger.info("Sentry 已初始化 (env=%s, release=%s)", environment, release)


def capture_exception(exc: BaseException, **context: Any) -> None:
    """上报异常到 Sentry。未初始化时静默忽略。"""
    if not _sentry_available:
        return
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            for key, value in context.items():
                scope.set_context(key, value)
            sentry_sdk.capture_exception(exc)
    except Exception:
        # Sentry 本身出错不影响业务
        pass


def capture_message(msg: str, level: str = "info", **context: Any) -> None:
    """上报消息到 Sentry。未初始化时静默忽略。"""
    if not _sentry_available:
        return
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            for key, value in context.items():
                scope.set_context(key, value)
            sentry_sdk.capture_message(msg, level=level)
    except Exception:
        pass


def capture_event(event_name: str, **context: Any) -> None:
    """上报自定义事件（如 config.published、items.replaced）到 Sentry。"""
    if not _sentry_available:
        return
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            for key, value in context.items():
                scope.set_context(key, value)
            sentry_sdk.add_breadcrumb(
                category="event",
                message=event_name,
                level="info",
                data=context,
            )
    except Exception:
        pass


def is_available() -> bool:
    """Sentry 是否已启用。"""
    return _sentry_available
