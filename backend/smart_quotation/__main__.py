from __future__ import annotations

import os
import uvicorn


def main() -> None:
    # reload=True 在中文路径下文件监控会乱码失效，改为 reload=False
    # 开发时需手动重启；若有强烈需要热重载，请在纯 ASCII 路径下运行
    reload = os.environ.get("SQ_RELOAD", "0") == "1"
    uvicorn.run("backend.smart_quotation.api:create_app", host="127.0.0.1", port=8001, reload=reload, factory=True)


if __name__ == "__main__":
    main()
