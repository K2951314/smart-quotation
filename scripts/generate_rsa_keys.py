#!/usr/bin/env python
"""生成 RSA 密钥对，用于 license 非对称签名（RS256）。

安全模型：
  - 私钥只在「供应商」侧保留（生成 license 时签名），绝不发给客户。
  - 公钥发给「客户部署」侧，设为环境变量 SQ_LICENSE_PUBLIC_KEY（用于验签）。
  - 即使客户侧公钥泄露，攻击者也无法伪造 license（只有私钥能签名）。

用法：
    py scripts/generate_rsa_keys.py
    py scripts/generate_rsa_keys.py --out-private keys/license_private.pem --out-public keys/license_public.pem

生成后：
    1. 私钥文件本地保管（可设环境变量 SQ_LICENSE_PRIVATE_KEY 指向其内容）。
    2. 公钥内容设为客户部署端的 SQ_LICENSE_PUBLIC_KEY 环境变量。
    3. 生成 license：py scripts/generate_license.py --tier pro --customer "客户A" --private-key keys/license_private.pem
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 license 用的 RSA 密钥对")
    parser.add_argument("--out-private", default="keys/license_private.pem",
                        help="私钥输出路径（供应商保留，勿外发）")
    parser.add_argument("--out-public", default="keys/license_public.pem",
                        help="公钥输出路径（发给客户部署侧）")
    parser.add_argument("--force", action="store_true",
                        help="已存在密钥文件时强制覆盖（⚠️ 覆盖旧私钥会导致已签发 license 永久失效）")
    args = parser.parse_args()

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    priv_path = Path(args.out_private)
    pub_path = Path(args.out_public)

    # 防误删保护：私钥/公钥已存在时拒绝覆盖（除非 --force）。
    # 旧私钥一旦被覆盖，用旧私钥签发的 license 将永远验签失败。
    existing = [p for p in (priv_path, pub_path) if p.exists()]
    if existing and not args.force:
        names = "、".join(str(p) for p in existing)
        print(f"❌ 已存在密钥文件：{names}", file=sys.stderr)
        print("   覆盖私钥会导致已签发的 license 永久失效。", file=sys.stderr)
        print("   如确要重新生成（旧 license 作废），加 --force。", file=sys.stderr)
        return 1

    # 生成 RSA 2048 密钥对
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    priv_path.parent.mkdir(parents=True, exist_ok=True)
    pub_path.parent.mkdir(parents=True, exist_ok=True)
    priv_path.write_bytes(private_pem)
    pub_path.write_bytes(public_pem)

    print(f"✅ 私钥已生成: {priv_path}  （供应商保留，绝不外发）")
    print(f"✅ 公钥已生成: {pub_path}  （设为客户部署端的 SQ_LICENSE_PUBLIC_KEY）")
    print()
    print("下一步：")
    print("  1. 生成 license（用私钥签名）：")
    print(f"     py scripts/generate_license.py --tier pro --customer \"客户A\" --private-key {priv_path}")
    print("  2. 客户部署端设环境变量 SQ_LICENSE_PUBLIC_KEY 为以下公钥内容：")
    print("     " + pub_path.read_text().replace("\n", " ")[:80] + " ...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
