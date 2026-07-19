#!/usr/bin/env python3
"""同步 config-core.js：以 apps/lib/config-core.js 为基准，复制到 admin/lib/config-core.js。

背景：
  apps/ 与 admin/ 是两个独立的静态前端，部署到不同位置（apps/ → Netlify）。
  由于无构建工具（不引入 npm/bundler），无法用 import 共享同一份文件。
  本脚本以功能更完善的 apps 版为基准，同步到 admin 版，防止双份维护漂移。

使用方式：
  py scripts/sync-config-core.py          # 同步
  py scripts/sync-config-core.py --check  # 仅检查是否一致（CI 用，不一致则退出码 1）

规则：
  - 改 config-core.js 必须改 apps/lib/config-core.js（基准），然后跑本脚本同步
  - 不要直接改 admin/lib/config-core.js，会被下次同步覆盖
"""
from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps" / "lib" / "config-core.js"
TARGET = ROOT / "admin" / "lib" / "config-core.js"


def main() -> int:
    check_only = "--check" in sys.argv

    if not SOURCE.exists():
        print(f"[sync] 错误：基准文件不存在 {SOURCE}", file=sys.stderr)
        return 1
    if not TARGET.parent.exists():
        print(f"[sync] 错误：目标目录不存在 {TARGET.parent}", file=sys.stderr)
        return 1

    if filecmp.cmp(SOURCE, TARGET, shallow=False):
        print("[sync] apps/ 与 admin/ 的 config-core.js 已一致，无需操作。")
        return 0

    if check_only:
        print("[sync] 两份 config-core.js 不一致！请运行 `py scripts/sync-config-core.py` 同步。", file=sys.stderr)
        return 1

    shutil.copy2(SOURCE, TARGET)
    print(f"[sync] 已将 {SOURCE.relative_to(ROOT)} 同步到 {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
