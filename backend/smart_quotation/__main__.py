from __future__ import annotations

import os
import uvicorn

# 启动时自动加载 .env 文件（python-dotenv）
# .env 文件已通过 .gitignore 排除，不会入库。
# 所有敏感配置（API Key、三菱凭据、License 等）都放在 .env 中。
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv 未安装时静默跳过，仍可从系统环境变量读取


def main() -> None:
    reload = os.environ.get("SQ_RELOAD", "0") == "1"
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run("backend.smart_quotation.api:create_app", host=host, port=port, reload=reload, factory=True)


if __name__ == "__main__":
    main()
