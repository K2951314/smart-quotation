"""三菱库存 GWT-RPC 查询引擎（提取自 mobile_server.py）

纯 HTTP 协议，不依赖浏览器。
凭据三级降级：环境变量 → config.ini（本地）→ Railway 等平台。
"""

import logging
import os
import re
import time
import threading
import configparser

import requests
from urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(category=InsecureRequestWarning)

logger = logging.getLogger(__name__)

BASE_URL = "https://mcweb.mitsubishi-materials.com/concerto-mmsc-ec"
GWT_MODULE_URL = BASE_URL + "/gwtModule/"
GWT_PERM = "3709873CCCCE1BD5AF7C55E4A0C5C0F3"
GWT_STRONG_NAME = "3F3B9BCCE5E51AE9BE17DA4486C9A825"
GWT_APP_SERVICE = "2662763268C21D40B75661AEA3EB2E3C"

RPC_HEADERS = {
    "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
    "X-GWT-Permutation": GWT_PERM,
    "X-GWT-Module-Base": GWT_MODULE_URL,
}

# config.ini 路径：优先找本项目下的，其次找三菱库存下的
_CONFIG_PATHS = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config.ini"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.ini"),
]


def load_account():
    """三级降级加载凭据：环境变量 → config.ini"""
    u = os.environ.get("MMC_USERNAME", "").strip()
    p = os.environ.get("MMC_PASSWORD", "").strip()
    c = os.environ.get("MMC_COOKIE", "").strip()
    if u and p:
        return u, p, c

    cfg = configparser.RawConfigParser()
    for cp in _CONFIG_PATHS:
        if os.path.exists(cp):
            cfg.read(cp, encoding="utf-8")
            break

    u = cfg.get("account", "username", fallback="").strip() or u
    p = cfg.get("account", "password", fallback="").strip() or p
    c = cfg.get("account", "cookie", fallback="").strip() or c
    return u, p, c


def _gwt_payload(model_val, material_val):
    """构造 GWT-RPC search 请求体"""

    def hdr(pc):
        return (
            f"7|0|13|{GWT_MODULE_URL}|"
            f"{GWT_STRONG_NAME}|"
            f"jp.co.mmc.concerto.mmsc.ec.web.gwt.client.uc.orderByItem.rpc.OrderByItemRemoteService|"
            f"executeProcess|java.lang.String/2004016611|"
            f"jp.co.mmc.concerto.core.shared.dto.ISharedDto|search|"
            f"jp.co.mmc.concerto.mmsc.ec.shared.dto.OrderByItemSharedDto/2995465772|"
            f"{model_val}|java.lang.Boolean/476441737|"
            f"java.util.ArrayList/4159755760|{pc}|"
            f"java.util.LinkedHashMap/3008245022|"
            f"1|2|3|4|2|5|6|7|8|0|0|0|9|10|1|0|0|0|0|0|0|11|0|0|12|0|0|0|500|0|0|0|0|13|0|0|0|0|0|0|0|"
        )

    return hdr(material_val) if material_val else hdr("")


def _parse_gwt(text):
    """解析 GWT-RPC 响应 → {success, strings[], error}"""
    if text.startswith("//EX"):
        m = re.search(r"'([^']*)'", text[4:])
        return {"success": False, "error": m.group(1) if m else "未知服务器错误"}
    if not text.startswith("//OK"):
        return {"success": False, "error": "非正常响应"}

    body = text[4:]
    bs, be = body.rfind("["), body.rfind("]")
    if bs < 0 or be < 0:
        return {"success": False, "error": "响应格式异常"}

    strings = []
    for q in ('"', "'"):
        strings = [m.group(1) for m in re.finditer(rf"{q}([^{q}]*){q}", body[bs + 1 : be])]
        if strings:
            break

    return {"success": True, "strings": strings}


def _extract_stock(strings):
    """从 GWT 字符串表提取 (shanghai, japan)"""

    def clean(s):
        try:
            return int(float(str(s)))
        except (ValueError, TypeError):
            return 0

    def is_stock(s):
        if not s:
            return False
        if not re.match(r"^-?\d+(\.\d+)?$", s):
            return False
        v = float(s)
        if v == -1:
            return True
        return 0 <= v < 999999

    vals = [clean(s) for s in strings[4:] if is_stock(s)]
    return (vals[0], vals[1]) if len(vals) >= 2 else (vals[0] if vals else 0, 0)


class QueryEngine:
    """三菱官网 GWT-RPC 查询引擎，线程安全（串行调用即可）。

    内置 5 分钟短期缓存：相同 (model, material) 的查询从缓存返回，
    减少三菱 RPC 调用次数（降本 + 降频）。只缓存成功结果，不缓存错误。
    """

    _CACHE_TTL = 300   # 缓存有效期 5 分钟（库存是实时数据，不能太久）
    _CACHE_MAX = 1000  # 最大缓存条目（防内存无限增长）

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9",
        })
        self._ready = False
        # 短期缓存：key -> (shanghai, japan, error, timestamp)
        self._cache = {}
        self._cache_lock = threading.Lock()

    @staticmethod
    def _cache_key(model_val, material_val):
        return f"{(model_val or '').strip().lower()}|{(material_val or '').strip().lower()}"

    def _cache_get(self, model_val, material_val):
        key = self._cache_key(model_val, material_val)
        now = time.time()
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry and now - entry[3] < self._CACHE_TTL:
                return (entry[0], entry[1], entry[2])
        return None

    def _cache_put(self, model_val, material_val, shanghai, japan, error):
        # 只缓存成功结果（error is None）——错误可能是临时的，不应缓存
        if error is not None:
            return
        key = self._cache_key(model_val, material_val)
        now = time.time()
        with self._cache_lock:
            # 简单淘汰：超过上限时删最早的条目
            if len(self._cache) >= self._CACHE_MAX:
                oldest_key = min(self._cache, key=lambda k: self._cache[k][3])
                del self._cache[oldest_key]
            self._cache[key] = (shanghai, japan, error, now)

    def _login(self, username, password):
        self.session.get(BASE_URL + "/login.jsp", timeout=30)
        r = self.session.post(
            BASE_URL + "/j_spring_security_check",
            data={"j_username": username.upper(), "j_password": password},
            timeout=30,
            allow_redirects=True,
        )
        if "login" in r.url.lower():
            return False
        self.session.post(
            BASE_URL + "/gwtModule/rpc/common/appRemoteService",
            data=f"7|0|4|{GWT_MODULE_URL}|{GWT_APP_SERVICE}|jp.co.mmc.concerto.mmsc.ec.web.gwt.client.widgets.rpc.AppRemoteService|getAppClientCacheDto|1|2|3|4|0|",
            headers=RPC_HEADERS,
            timeout=30,
        )
        return True

    def ensure_ready(self):
        if self._ready:
            return True
        u, p, c = load_account()
        if c:
            self.session.headers.update({"Cookie": c})
            r = self.session.get(BASE_URL + "/concerto_i10193.html", timeout=30)
            if "login" in r.url.lower():
                return False
            self._ready = True
            return True
        self._ready = self._login(u, p)
        return self._ready

    def search(self, model_val, material_val):
        """查询库存，优先走 5 分钟短期缓存，未命中再调 GWT-RPC。"""
        cached = self._cache_get(model_val, material_val)
        if cached is not None:
            return cached
        result = self._search_rpc(model_val, material_val)
        self._cache_put(model_val, material_val, *result)
        return result

    def _search_rpc(self, model_val, material_val):
        payload = _gwt_payload(model_val, material_val)
        try:
            r = self.session.post(
                BASE_URL + "/gwtModule/rpc/orderByItem/orderByItemRemoteService",
                data=payload,
                headers=RPC_HEADERS,
                timeout=30,
            )
            if r.status_code in (302, 401):
                self._ready = False
                if self.ensure_ready():
                    r = self.session.post(
                        BASE_URL + "/gwtModule/rpc/orderByItem/orderByItemRemoteService",
                        data=payload,
                        headers=RPC_HEADERS,
                        timeout=30,
                    )
            if r.status_code != 200:
                return 0, 0, f"HTTP {r.status_code}"
            resp = _parse_gwt(r.text)
            if not resp["success"]:
                err = resp.get("error", "")
                if bool(material_val) and "ClassNotFound" in err:
                    return self.search(model_val, "")
                # 截断第三方服务端返回的错误内容，避免冗长/不可控文本进入 API 响应
                return 0, 0, (err[:100] if err else "查询失败")
            stock = _extract_stock(resp["strings"])
            return *stock, None
        except requests.Timeout:
            return 0, 0, "查询超时"
        except requests.ConnectionError:
            return 0, 0, "连接失败"
        except Exception as e:
            # 异常详情可能含内部 URL/连接信息，仅记日志，对外返回泛化文案
            logger.warning("三菱库存查询异常 (model=%s): %s", model_val, e)
            return 0, 0, "查询失败"


# 模块级单例，全局复用登录态
_engine: QueryEngine | None = None


def get_engine() -> QueryEngine:
    global _engine
    if _engine is None:
        _engine = QueryEngine()
    return _engine
