"""生产模式（非 dev）启动路径的回归测试。

背景：conftest 全局 setdefault("SQ_DEV", "1")，所有测试都跑在 dev 模式，
导致 factory.create_app 里的 `if not is_dev:` 分支（含 pg_adapter 导入、
数据库架构断言、ALLOW_ORIGINS 校验）从未被测试覆盖。

dev 分支曾在此分支写入错误的相对导入 `from .pg_adapter`（应为
`from ..store.pg_adapter`），本地测试全绿、上 Railway（非 dev）直接
ModuleNotFoundError 启动失败。本测试用子进程隔离环境变量，强制走非 dev
路径，确保此类「只在生产炸」的 bug 不再漏网。
"""

import os
import subprocess
import sys


def _project_root() -> str:
    # tests/ 的上一级即项目根（backend 包所在目录）
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_create_app_non_dev_does_not_fail_on_pg_adapter_import():
    """create_app 在非 dev 模式下，必须能正确解析 pg_adapter 的导入。

    任何非 ModuleNotFoundError(pg_adapter) 的异常都视为「导入已修复、代码继续
    往下执行」（例如缺 DATABASE_URL 会进架构断言、缺 DB 会连接失败）——这些都
    说明 pg_adapter 导入成功，bug 已修复。
    """
    env = dict(os.environ)
    env["SQ_DEV"] = "0"  # 模拟 Railway 生产模式
    env["DATABASE_URL"] = "postgresql://user:pass@localhost:5432/test"
    env["ALLOW_ORIGINS"] = "https://example.com"

    # 子进程必须以退出码 0 成功完成——任何异常（含 UnboundLocalError）
    # 都会让子进程以非零退出码结束，这里直接断言退出码，不再用
    # `except Exception: pass` 吞异常（正是此前的吞异常让 UnboundLocalError
    # 漏网，导致全量 500 上了生产）。
    code = (
        "from backend.smart_quotation.api import factory\n"
        "factory.create_app()\n"
    )

    result = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        cwd=_project_root(),
        capture_output=True,
        text=True,
    )

    # 唯一允许的失败：本地未装 psycopg2-binary 导致 ModuleNotFoundError。
    # 此情况下 pg_adapter 的 import 已成功解析（不是相对导入 bug），
    # 只是 psycopg2 二进制缺失——与本次回归目标无关。
    pg_module_missing = (
        result.returncode != 0
        and "ModuleNotFoundError" in result.stderr
        and "psycopg2" in result.stderr
    )
    assert pg_module_missing or result.returncode == 0, (
        "create_app 在非 dev 模式下异常中断（退出码 "
        + str(result.returncode)
        + "）：\n--- stdout ---\n" + result.stdout
        + "\n--- stderr ---\n" + result.stderr
    )


def test_create_app_same_origin_allows_missing_allow_origins():
    """前后端同源部署（如全部托管在 Railway）时，ALLOW_ORIGINS 可为空。

    同源请求无需 CORS 预检，跳过 CORS 中间件是安全正确的行为。此前该分支
    强制 RuntimeError，导致同源部署无法启动。此测试确保空 ALLOW_ORIGINS
    不再被拒绝（只要 pg_adapter 导入 + 数据库断言都能过）。
    """
    env = dict(os.environ)
    env["SQ_DEV"] = "0"
    env["DATABASE_URL"] = "postgresql://user:pass@localhost:5432/test"
    env.pop("ALLOW_ORIGINS", None)  # 同源部署：不设置

    # 不再用 `except Exception: pass` 吞异常——那样会把 UnboundLocalError
    # 等真 bug 也吞掉。改为精确捕获 RuntimeError 并检查消息内容，其它异常
    # 让子进程以非零退出码结束，此处断言退出码即可暴露真 bug。
    code = (
        "import sys\n"
        "from backend.smart_quotation.api import factory\n"
        "try:\n"
        "    factory.create_app()\n"
        "    sys.exit(0)\n"
        "except RuntimeError as e:\n"
        "    if 'ALLOW_ORIGINS' in str(e):\n"
        "        print('ALLOW_ORIGINS_REJECTED:' + str(e)[:200])\n"
        "        sys.exit(0)\n"
        "    # 其他 RuntimeError（如 PG 架构断言）与本测试无关，让子进程报错\n"
        "    raise\n"
    )

    result = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        cwd=_project_root(),
        capture_output=True,
        text=True,
    )

    assert "ALLOW_ORIGINS_REJECTED" not in result.stdout, (
        "同源部署下 ALLOW_ORIGINS 仍被强制拒绝：\n" + result.stdout + result.stderr
    )
    # 允许的退出路径：退出码 0（create_app 成功 或 RuntimeError 含 ALLOW_ORIGINS）
    # 或 本地缺 psycopg2-binary（ModuleNotFoundError）。
    pg_module_missing = (
        result.returncode != 0
        and "ModuleNotFoundError" in result.stderr
        and "psycopg2" in result.stderr
    )
    assert pg_module_missing or result.returncode == 0, (
        "create_app 在同源部署模式下异常中断（退出码 "
        + str(result.returncode)
        + "）：\n--- stdout ---\n" + result.stdout
        + "\n--- stderr ---\n" + result.stderr
    )


def test_create_app_dev_mode_no_unbound_local_error():
    """create_app 在 SQ_DEV=1 下必须不抛 UnboundLocalError。

    回归守卫：07d3643 在顶部加了 `import logging` 并在 create_app 内
    第 100 行调用 `logging.getLogger(...)`，但没删掉函数内第 244 行残留的
    局部 `import logging`。Python 作用域规则把 `logging` 判为整个
    create_app 的局部变量，导致第 100 行在局部 import 执行前访问 →
    UnboundLocalError，create_app 直接崩溃，所有 API 返回 500。

    这个 bug 在子进程测试（test_create_app_non_dev_does_not_fail_on_pg_adapter_import）
    里被 `except Exception: pass` 吞掉，所以漏网。此测试直接 import 调用，
    让 UnboundLocalError 显式暴露。
    """
    import os

    os.environ["SQ_DEV"] = "1"
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("ALLOW_ORIGINS", None)

    from backend.smart_quotation.api.factory import create_app

    try:
        app = create_app()
    except UnboundLocalError as exc:
        raise AssertionError(
            "create_app 抛 UnboundLocalError——检查 factory.py 是否有函数内"
            "对已顶部 import 的模块再次局部 import（Python 作用域陷阱）。\n"
            f"异常: {exc}"
        ) from exc
    assert app is not None
    assert len(app.routes) > 0
