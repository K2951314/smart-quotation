from __future__ import annotations

import os
import uvicorn


def main() -> None:
    reload = os.environ.get("SQ_RELOAD", "0") == "1"
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run("backend.smart_quotation.api:create_app", host=host, port=port, reload=reload, factory=True)


if __name__ == "__main__":
    main()
