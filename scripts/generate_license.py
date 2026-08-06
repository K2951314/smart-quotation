#!/usr/bin/env python
"""按订阅档位生成 License 字符串。

用法：
    py scripts/generate_license.py --tier pro --customer "客户A" --expires 2027-12-31
    py scripts/generate_license.py --tier team --customer "客户B" --expires 2027-12-31 --max-companies 10
    py scripts/generate_license.py --tier free --customer "试用客户C" --expires 2026-12-31

生成的 license 字符串写到 stdout，客户把它设为环境变量 SQ_LICENSE。

可选 --secret 覆盖签名密钥（默认从 SQ_LICENSE_SECRET 环境变量读取）。
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta


def main() -> int:
    parser = argparse.ArgumentParser(description="按订阅档位生成 License")
    parser.add_argument("--tier", required=True, choices=["free", "pro", "team"],
                        help="订阅档位")
    parser.add_argument("--customer", required=True, help="客户名称")
    parser.add_argument("--expires", help="过期日期 YYYY-MM-DD（默认 1 年后）")
    parser.add_argument("--max-companies", type=int, default=None,
                        help="覆盖公司数上限（默认用档位预设）")
    parser.add_argument("--secret", default=None,
                        help="签名密钥（默认从 SQ_LICENSE_SECRET 环境变量）")
    args = parser.parse_args()

    # 计算过期时间
    if args.expires:
        try:
            dt = datetime.strptime(args.expires, "%Y-%m-%d")
        except ValueError:
            print(f"错误：日期格式不正确，应为 YYYY-MM-DD，得到 {args.expires}", file=sys.stderr)
            return 1
        expires_at = dt.strftime("%Y-%m-%dT23:59:59Z")
    else:
        # 默认 1 年后
        dt = datetime.utcnow() + timedelta(days=365)
        expires_at = dt.strftime("%Y-%m-%dT23:59:59Z")

    # 确保 SQ_DEV 不干扰（生成时不应走开发模式）
    os.environ.pop("SQ_DEV", None)

    # 延迟导入，确保 --help 不需要加载后端
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from backend.smart_quotation.license import generate_tiered_license, TIER_PRESETS

    # 构建 overrides
    overrides = {}
    if args.max_companies is not None:
        overrides["max_companies"] = args.max_companies

    # 生成
    try:
        license_str = generate_tiered_license(
            customer=args.customer,
            tier=args.tier,
            expires_at=expires_at,
            secret=args.secret,
            **overrides,
        )
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    # 输出到 stdout
    print(license_str)

    # 输出摘要到 stderr
    preset = TIER_PRESETS[args.tier]
    print(f"\n── 摘要 ──────────────────────────────", file=sys.stderr)
    print(f"档位: {args.tier}", file=sys.stderr)
    print(f"客户: {args.customer}", file=sys.stderr)
    print(f"过期: {expires_at}", file=sys.stderr)
    print(f"功能: {', '.join(preset['features'])}", file=sys.stderr)
    print(f"公司上限: {overrides.get('max_companies', preset['max_companies'])}", file=sys.stderr)
    print(f"SKU 上限: {preset['max_skus']}", file=sys.stderr)
    print(f"库存查询/天: {preset['stock_query_daily_limit']}", file=sys.stderr)
    print(f"\n将以上 license 设为环境变量 SQ_LICENSE", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
