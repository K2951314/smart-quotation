"""验证条件请求缓存机制是否正常工作。"""
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8001"

# 1. 获取 HTML 的 ETag
req = urllib.request.Request(f"{BASE}/apps/index.html", method="HEAD")
resp = urllib.request.urlopen(req)
etag = resp.headers.get("etag")
print(f"HTML ETag: {etag}")
print(f"HTML Cache-Control: {resp.headers.get('cache-control')}")

# 2. 带 If-None-Match 重新请求（模拟浏览器缓存校验）
req2 = urllib.request.Request(f"{BASE}/apps/index.html", method="HEAD", headers={"If-None-Match": etag})
try:
    resp2 = urllib.request.urlopen(req2)
    print(f"条件请求结果: {resp2.status} (内容未变时应返回304)")
except urllib.error.HTTPError as e:
    print(f"条件请求结果: {e.code} {'✅ 304 Not Modified — 缓存有效，不传内容' if e.code == 304 else '❌'}")

# 3. CSS 的缓存头
req3 = urllib.request.Request(f"{BASE}/apps/styles/responsive.css", method="HEAD")
resp3 = urllib.request.urlopen(req3)
print(f"\nCSS Cache-Control: {resp3.headers.get('cache-control')}")
print(f"CSS ETag: {resp3.headers.get('etag')}")

# 4. API 路由不受影响
req4 = urllib.request.Request(f"{BASE}/api/health", method="GET")
resp4 = urllib.request.urlopen(req4)
print(f"\nAPI /health Cache-Control: {resp4.headers.get('cache-control')} (应为 None — API 不受中间件影响)")
print(f"API /health Status: {resp4.status}")
