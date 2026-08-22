"""一次性修复脚本：拆分 quotation_configs 中因分隔符未拆分而损坏的 excel_aliases。

背景：admin 表单旧版 collectConfig 只按 [,，] 拆分别名，用户输入顿号（、）、
分号（；）、竖线（|）时整串未拆分，保存为单个超长别名，导致 Excel 列名
匹配失败 → face_price 缺失 → 报价静默变 0。

本脚本扫描数据库中所有 config 的 fields[].excel_aliases，把含分隔符的
别名元素拆分为多个，回写并使缓存失效。幂等：已正常的配置不会改动。

用法（在部署机项目根目录）：
    python scripts/fix_alias_separators.py                # 修复默认 quotation.db
    python scripts/fix_alias_separators.py --db /path/to/quotation.db
    python scripts/fix_alias_separators.py --dry-run      # 只预览不修改

注意：修改的是 SQLite 数据库。执行前请先备份数据库文件。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path

# 与 backend/smart_quotation/config.py _split_excel_alias 保持一致
ALIAS_SPLIT_RE = re.compile(r"[,，、;；|｜\t\n\r]+")


def split_alias(item) -> list[str]:
    return [p.strip() for p in ALIAS_SPLIT_RE.split(str(item or "")) if p.strip()]


def fix_config_json(config_json: str) -> tuple[str, int]:
    """修复单个 config_json 字符串，返回 (新json, 拆分次数)。"""
    cfg = json.loads(config_json)
    total_splits = 0
    fields = cfg.get("fields") or []
    for field in fields:
        if not isinstance(field, dict) or "excel_aliases" not in field:
            continue
        old_aliases = field.get("excel_aliases") or []
        new_aliases: list[str] = []
        for item in old_aliases:
            parts = split_alias(item)
            if len(parts) > 1:
                total_splits += 1
                print(f"    拆分: {item!r} -> {parts}")
            new_aliases.extend(parts)
        if new_aliases != old_aliases:
            field["excel_aliases"] = new_aliases
    return json.dumps(cfg, ensure_ascii=False), total_splits


def main() -> int:
    parser = argparse.ArgumentParser(description="修复 excel_aliases 分隔符未拆分问题")
    parser.add_argument("--db", default=str(Path(__file__).resolve().parents[1] / "quotation.db"),
                        help="SQLite 数据库路径（默认项目根目录 quotation.db）")
    parser.add_argument("--dry-run", action="store_true", help="只预览将要修改的内容，不写库")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"错误：数据库不存在: {db_path}")
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "select id, company_id, revision, status, config_json from quotation_configs order by id"
        ).fetchall()
        print(f"共扫描 {len(rows)} 条配置记录")

        fixed_count = 0
        for row in rows:
            tag = f"[id={row['id']} company={row['company_id']} rev={row['revision']} status={row['status']}]"
            new_json, splits = fix_config_json(row["config_json"])
            if splits == 0:
                print(f"  {tag} 正常，跳过")
                continue
            fixed_count += 1
            if args.dry_run:
                print(f"  {tag} 将修复（{splits} 处别名拆分）[dry-run]")
            else:
                conn.execute(
                    "update quotation_configs set config_json = ? where id = ?",
                    (new_json, row["id"]),
                )
                print(f"  {tag} 已修复（{splits} 处别名拆分）")

        if args.dry_run:
            print(f"\n[dry-run] 预览完成：{fixed_count} 条配置需要修复。去掉 --dry-run 执行实际修复。")
        else:
            conn.commit()
            print(f"\n修复完成：{fixed_count}/{len(rows)} 条配置已更新。")
            print("提示：若后端正在运行，请重启后端（或等待配置缓存失效）使修复生效。")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
