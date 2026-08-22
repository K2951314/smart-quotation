"""RSA 非对称 license 签名测试（RS256）+ HMAC 向后兼容。

覆盖：
- RS256 签名 → 公钥验签通过
- 篡改 payload 后验签失败（防伪造）
- 错误公钥验签失败
- HS256（旧 HMAC）向后兼容
"""
import base64
import json
import os
import time
import unittest

from backend.smart_quotation import license as license_mod


class LicenseRSATest(unittest.TestCase):
    # 需在 setUp/tearDown 之间保存/恢复的环境变量，避免污染其他测试文件
    # （如 test_tier_inheritance 依赖模块级 setdefault("SQ_DEV","1") 只执行一次）
    _ENV_KEYS = ("SQ_DEV", "SQ_LICENSE", "SQ_LICENSE_SECRET", "SQ_LICENSE_PUBLIC_KEY", "SQ_LICENSE_PRIVATE_KEY")

    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in self._ENV_KEYS}
        os.environ["SQ_LICENSE_SECRET"] = "test-secret-for-rsa"
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_pem = priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")
        self.public_pem = priv.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")

        # 清理缓存，避免跨用例污染
        license_mod._license_cache = None
        license_mod._license_verified_at = 0

    def tearDown(self):
        # 恢复 setUp 前的环境变量状态，杜绝污染其他测试文件
        for k in self._ENV_KEYS:
            if self._saved_env.get(k) is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = self._saved_env[k]
        license_mod._license_cache = None
        license_mod._license_verified_at = 0

    def test_rsa_sign_and_verify(self):
        """RS256 签名 → 公钥验签通过。"""
        os.environ["SQ_LICENSE_PUBLIC_KEY"] = self.public_pem
        lic = license_mod.generate_tiered_license(
            "客户A", "pro", "2027-12-31T23:59:59Z", private_key=self.private_pem
        )
        payload = license_mod._decode_license(lic)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["tier"], "pro")
        self.assertEqual(payload["customer"], "客户A")

    def test_rsa_tampered_payload_fails(self):
        """篡改 payload 后验签失败（防伪造）。"""
        os.environ["SQ_LICENSE_PUBLIC_KEY"] = self.public_pem
        lic = license_mod.generate_tiered_license(
            "客户A", "pro", "2027-12-31T23:59:59Z", private_key=self.private_pem
        )
        obj = json.loads(base64.b64decode(lic).decode("utf-8"))
        obj["payload"]["tier"] = "team"  # 篡改为 team
        tampered = base64.b64encode(
            json.dumps(obj, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        self.assertIsNone(license_mod._decode_license(tampered))

    def test_rsa_wrong_public_key_fails(self):
        """错误公钥验签失败。"""
        os.environ["SQ_LICENSE_PUBLIC_KEY"] = "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----"
        lic = license_mod.generate_tiered_license(
            "客户A", "pro", "2027-12-31T23:59:59Z", private_key=self.private_pem
        )
        self.assertIsNone(license_mod._decode_license(lic))

    def test_hmac_backward_compat(self):
        """未配公钥时，旧 HMAC（HS256）license 仍可验签（向后兼容）。"""
        lic = license_mod.generate_tiered_license(
            "客户B", "team", "2027-12-31T23:59:59Z", secret="test-secret-for-rsa"
        )
        payload = license_mod._decode_license(lic)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["tier"], "team")

    def test_expiry_status_valid_grace_expired(self):
        """过期状态判定：valid / grace（宽限期）/ expired。"""
        now = time.time()
        fmt = lambda ts: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
        # 未过期 → valid
        self.assertEqual(license_mod._expiry_status({"expires_at": fmt(now + 86400)}, now), "valid")
        # 过期 3 天 → grace（宽限期）
        self.assertEqual(license_mod._expiry_status({"expires_at": fmt(now - 3 * 86400)}, now), "grace")
        # 过期 10 天 → expired（超宽限期）
        self.assertEqual(license_mod._expiry_status({"expires_at": fmt(now - 10 * 86400)}, now), "expired")
        # 无过期时间 → valid
        self.assertEqual(license_mod._expiry_status({}, now), "valid")

    def test_verify_license_grace_period_passes(self):
        """宽限期内（过期未超 7 天）verify_license 仍返回 payload（放行）。"""
        now = time.time()
        past3 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3 * 86400))
        lic = license_mod.generate_tiered_license("客户C", "pro", past3, secret="test-secret-for-rsa")
        os.environ["SQ_LICENSE"] = lic
        os.environ.pop("SQ_LICENSE_PUBLIC_KEY", None)
        os.environ.pop("SQ_DEV", None)
        license_mod._license_cache = None
        license_mod._license_verified_at = 0
        try:
            payload = license_mod.verify_license(force=True)
            self.assertIsNotNone(payload)
            self.assertEqual(payload["tier"], "pro")
        finally:
            os.environ.pop("SQ_LICENSE", None)

    def test_verify_license_expired_fail_closed(self):
        """超宽限期（过期 10 天）verify_license 返回 None（fail-closed）。"""
        now = time.time()
        past10 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 10 * 86400))
        lic = license_mod.generate_tiered_license("客户D", "pro", past10, secret="test-secret-for-rsa")
        os.environ["SQ_LICENSE"] = lic
        os.environ.pop("SQ_LICENSE_PUBLIC_KEY", None)
        os.environ.pop("SQ_DEV", None)
        license_mod._license_cache = None
        license_mod._license_verified_at = 0
        try:
            self.assertIsNone(license_mod.verify_license(force=True))
        finally:
            os.environ.pop("SQ_LICENSE", None)


if __name__ == "__main__":
    unittest.main()
