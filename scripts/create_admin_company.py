#!/usr/bin/env python3
"""创建管理员专用公司并复制 default 公司的已发布配置和数据。

用途：
  为管理员生成一个独立的 company_id=admin 访问入口，
  复用 default 公司 2026-07-15 已发布的配置和商品数据，
  这样管理员能看到完整数据（面价、折扣），与客户隔离。

使用方式：
  py scripts/create_admin_company.py

  环境变量：
    SQ_DEV=1                 # 本地开发模式
    ADMIN_COMPANY_ID=admin   # 可选，默认 "admin"
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# 确保项目根目录在 sys.path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.smart_quotation.store import QuotationStore, DEFAULT_COMPANY_ID


def main() -> int:
    os.environ.setdefault("SQ_DEV", "1")
    admin_id = os.environ.get("ADMIN_COMPANY_ID", "admin").strip()
    if not admin_id or admin_id == DEFAULT_COMPANY_ID:
        print(f"[admin] 非法的管理员公司 ID: {admin_id!r}", file=sys.stderr)
        return 1

    db_path = ROOT / "quotation.db"
    if not db_path.exists():
        print(f"[admin] 数据库不存在: {db_path}", file=sys.stderr)
        return 1

    store = QuotationStore(str(db_path))
    store.init_schema()

    # 1. 检查 default 公司的已发布配置
    print(f"[admin] 正在读取 {DEFAULT_COMPANY_ID} 公司的已发布配置...")
    try:
        source_config = store.get_active_config(company_id=DEFAULT_COMPANY_ID)
    except LookupError:
        print(f"[admin] 错误：{DEFAULT_COMPANY_ID} 公司没有已发布的配置", file=sys.stderr)
        return 1

    published_at = source_config.get("revision", "")
    print(f"[admin] 源配置版本: {published_at}")
    print(f"[admin] 字段数量: {len(source_config.get('fields', []))}")
    print(f"[admin] 规则数量: {len(source_config.get('rules', []))}")

    # 2. 检查 admin 公司是否已存在
    existing_companies = [c["id"] for c in store.list_companies()]
    if admin_id in existing_companies:
        print(f"[admin] 公司 {admin_id!r} 已存在，将更新配置和数据...")
        # 获取现有令牌（不重新生成）
        admin_company = store.get_company(admin_id)
        existing_token = (admin_company.get("meta") or {}).get("access_token", "")
    else:
        print(f"[admin] 创建管理员公司: {admin_id!r}")
        admin_company = store.create_company(admin_id, "管理员")
        existing_token = (admin_company.get("meta") or {}).get("access_token", "")

    # 2.1 标记为管理员公司（meta.is_admin=true）
    # 这样 require_company_access 会返回 "admin" 角色，前端也能看到完整数据
    admin_meta = dict(admin_company.get("meta") or {})
    if not admin_meta.get("is_admin"):
        admin_meta["is_admin"] = True
        store.update_company(admin_id, meta=admin_meta)
        print(f"[admin] 已标记 is_admin=true（管理员角色）")

    # 3. 把 default 公司的配置复制到 admin 公司（保持版本号，但状态为 published）
    print(f"[admin] 复制配置到 {admin_id!r} 公司...")
    # 使用新版本号避免冲突，加上 admin 后缀
    admin_revision = f"{published_at}-admin" if published_at else f"admin-{datetime.now(timezone.utc).strftime('%Y-%m-%d.%H%M%S')}"
    source_config_copy = json.loads(json.dumps(source_config))
    source_config_copy["revision"] = admin_revision
    store.save_config(source_config_copy, status="published", company_id=admin_id)
    print(f"[admin] 配置已发布: revision={admin_revision}")

    # 4. 复制商品数据
    print(f"[admin] 复制商品数据到 {admin_id!r} 公司...")
    stats = store.get_items_stats(company_id=DEFAULT_COMPANY_ID)
    if stats.get("data_revision"):
        src_revision = stats["data_revision"]
        # 读取 default 公司的全部商品
        from contextlib import closing
        with closing(store.connect()) as conn:
            rows = conn.execute(
                "SELECT item_key, fields_json FROM quotation_items WHERE company_id = ? ORDER BY id",
                (DEFAULT_COMPANY_ID,),
            ).fetchall()
        if rows:
            admin_rows = [
                {"item_key": r["item_key"], "fields": json.loads(r["fields_json"])}
                for r in rows
            ]
            store.replace_items(src_revision, admin_rows, company_id=admin_id)
            print(f"[admin] 已复制 {len(admin_rows)} 条商品数据 (data_revision={src_revision})")
        else:
            print(f"[admin] 源公司没有商品数据")
    else:
        print(f"[admin] 源公司没有商品数据，跳过")

    # 5. 输出访问信息
    print()
    print("=" * 60)
    print("[admin] 管理员公司配置完成！")
    print("=" * 60)
    print(f"公司 ID: {admin_id}")
    print(f"访问令牌: {existing_token}")
    print()
    print("管理员访问链接（本地开发）：")
    print(f"  http://127.0.0.1:8001/?company_id={admin_id}&token={existing_token}")
    print()
    print("管理员访问链接（生产环境，替换为你的域名）：")
    print(f"  https://your-netlify-site.netlify.app/?company_id={admin_id}&token={existing_token}")
    print()
    print("说明：")
    print("  - 管理员模式下可以看到面价、折扣、配置入口")
    print("  - 客户使用各自的 company_id + token，与管理员隔离")
    print("  - 令牌默认有效期 90 天，可在 admin 后台轮换")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
