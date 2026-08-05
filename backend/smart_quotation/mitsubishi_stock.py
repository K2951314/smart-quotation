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
    """解析 GWT-RPC 响应 → {success, strings[], raw_payload, error}"""
    if text.startswith("//EX"):
        m = re.search(r"'([^']*)'", text[4:])
        return {"success": False, "error": m.group(1) if m else "未知服务器错误"}
    if not text.startswith("//OK"):
        return {"success": False, "error": "非正常响应"}

    body = text[4:]
    # GWT-RPC 响应格式: //OK[数字部分,["strings表"],尾部]
    # 需要提取完整 payload（含数字部分 + strings 表 + 尾部），
    # 因为 _detect_needs_terminal 要读数字部分的固定位置字段。
    # 用第一个 [ 和最后一个 ] 来提取（而非 rfind("[")，后者只定位到 strings 表的 [）
    bs, be = body.find("["), body.rfind("]")
    if bs < 0 or be < 0 or be <= bs:
        return {"success": False, "error": "响应格式异常"}

    raw_payload = body[bs + 1 : be]
    strings = []
    for q in ('"', "'"):
        strings = [m.group(1) for m in re.finditer(rf"{q}([^{q}]*){q}", raw_payload)]
        if strings:
            break

    return {"success": True, "strings": strings, "raw_payload": raw_payload}


def _detect_needs_terminal(raw_payload):
    """从 GWT-RPC raw_payload 检测是否需要提供终端客户。

    通过批量型号分析发现的标志位编码规则：
    - 标志位在 item 的倒数第2位（相对于item末尾）
    - 如果倒数第2位的字符串值是 '1'，则需要终端客户
    - 否则不需要终端客户

    关键修复：必须先按 'GI' 分隔符分割 items，再检测每个 item。
    整个 nums 数组长度可能是 87（多item），但每个 item 只有 48-50 个元素。

    支持单 item 和多 item 响应检测。
    """
    if not raw_payload:
        return False

    # raw_payload 格式: 数字部分,[strings表],尾部
    # 找到 strings 表的开始位置（,[ 之前是数字部分）
    bracket_idx = raw_payload.find(',[')
    if bracket_idx < 0:
        return False

    nums_part = raw_payload[:bracket_idx]
    # 用逗号分割数字部分（包含数字和字符串引用如 'B', 'ooSA'）
    nums = nums_part.split(',')
    nums_len = len(nums)

    # 提取 strings 表
    strings = []
    for q in ('"', "'"):
        strings = [m.group(1) for m in re.finditer(rf"{q}([^{q}]*){q}", raw_payload)]
        if strings:
            break

    def check_item_needs_terminal(item_nums, item_strings):
        """检查单个 item 是否需要终端客户

        关键发现：标志位在 item 的倒数第2位
        - 如果该位置引用字符串 '1'，则需要终端客户
        - 否则不需要
        """
        item_len = len(item_nums)
        if item_len < 10:
            return False

        # 标志位在倒数第2位
        flag_index = item_len - 2

        if flag_index < 0 or flag_index >= item_len:
            return False

        val = item_nums[flag_index]

        # 检查该位置是否引用字符串 '1'
        if val != '0' and val.isdigit():
            str_idx = int(val)
            if str_idx < len(item_strings) and item_strings[str_idx] == '1':
                return True

        return False

    # 检查是否为多 item 响应（按 'GI' 分隔符判断）
    gi_positions = [i for i, v in enumerate(nums) if v == "'GI'"]

    # 多 item 响应（有 GI 分隔符）
    if gi_positions:
        any_needs_terminal = False

        for i, gi_pos in enumerate(gi_positions):
            if i == 0:
                item_nums = nums[0:gi_pos]
            else:
                item_nums = nums[gi_positions[i-1]+1:gi_pos]

            # 只检查长度足够的item（排除尾部元数据）
            if len(item_nums) >= 40:
                if check_item_needs_terminal(item_nums, strings):
                    any_needs_terminal = True
                    break

        if any_needs_terminal:
            logger.info("[终端客户检测] 多item响应需要终端客户")
        return any_needs_terminal

    # 单 item 响应（没有 GI 分隔符）
    if nums_len >= 40:
        result = check_item_needs_terminal(nums, strings)
        if result:
            logger.info("[终端客户检测] 单item响应需要终端客户")
        return result

    logger.debug("[终端客户检测] 数组长度不足: len=%s", nums_len)
    return False


def _detect_needs_terminal_from_strings(raw_payload):
    """备用检测逻辑：从 strings 表中检测是否需要终端客户。

    某些型号的响应格式不同，数字部分长度不足，此时尝试从 strings 表中检测。
    如果 strings 表中包含 "EC不可下单" 或 "商流可视化" 字样，认为需要终端客户。
    """
    if not raw_payload:
        return False

    # 提取 strings 表部分
    bracket_idx = raw_payload.find(',[')
    if bracket_idx < 0:
        return False

    strings_start = bracket_idx + 2
    strings_end = raw_payload.rfind(']')
    if strings_end < 0 or strings_end <= strings_start:
        return False

    strings_part = raw_payload[strings_start:strings_end]
    # 检查是否包含关键字
    has_ec = '"EC不可下单"' in strings_part or 'EC不可下单' in strings_part
    has_visual = '"商流可视化"' in strings_part or '商流可视化' in strings_part

    result = has_ec or has_visual
    if result:
        logger.info(
            "[终端客户检测-备用] 从strings表检测到: EC不可下单=%s, 商流可视化=%s, strings=%s",
            has_ec, has_visual, strings_part[:200]
        )
    return result


def _extract_stock(strings, raw_payload=None):
    """从 GWT 字符串表提取 (shanghai, japan, needs_terminal, model_found)

    Returns:
        (shanghai_stock, japan_stock, needs_terminal, model_found)
        model_found: bool, 是否在三菱官网查得到该型号
    """

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

    # 判断是否查得到型号
    # 查得到型号的特征：raw_payload 中有 GI 分隔符（多item）或长度足够（单item）
    model_found = False
    if raw_payload:
        bracket_idx = raw_payload.find(",[")
        if bracket_idx > 0:
            nums_part = raw_payload[:bracket_idx]
            nums = nums_part.split(",")
            # 有 GI 分隔符 或 nums 长度足够（>40）表示查得到型号
            if "'GI'" in nums or len(nums) > 40:
                model_found = True

    vals = [clean(s) for s in strings[4:] if is_stock(s)]
    shanghai = vals[0] if len(vals) >= 1 else 0
    japan = vals[1] if len(vals) >= 2 else 0
    needs_terminal = _detect_needs_terminal(raw_payload)
    return (shanghai, japan, needs_terminal, model_found)


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
            # 缓存格式：(shanghai, japan, needs_terminal, error, timestamp)
            if entry and now - entry[4] < self._CACHE_TTL:
                return (entry[0], entry[1], entry[2], entry[3])
        return None

    def _cache_put(self, model_val, material_val, shanghai, japan, needs_terminal, error):
        # 只缓存成功结果（error is None）——错误可能是临时的，不应缓存
        if error is not None:
            return
        key = self._cache_key(model_val, material_val)
        now = time.time()
        with self._cache_lock:
            # 简单淘汰：超过上限时删最早的条目
            if len(self._cache) >= self._CACHE_MAX:
                oldest_key = min(self._cache, key=lambda k: self._cache[k][4])
                del self._cache[oldest_key]
            self._cache[key] = (shanghai, japan, needs_terminal, error, now)

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
                return 0, 0, False, f"HTTP {r.status_code}"
            resp = _parse_gwt(r.text)
            if not resp["success"]:
                err = resp.get("error", "")
                if bool(material_val) and "ClassNotFound" in err:
                    return self.search(model_val, "")
                # 截断第三方服务端返回的错误内容，避免冗长/不可控文本进入 API 响应
                return 0, 0, False, (err[:100] if err else "查询失败")
            stock = _extract_stock(resp["strings"], resp.get("raw_payload"))
            shanghai, japan, needs_terminal, model_found = stock
            # 如果查不到型号（官网没有这个型号），返回特定错误码以便前端区分
            if not model_found:
                return 0, 0, False, "MODEL_NOT_FOUND"
            return shanghai, japan, needs_terminal, None
        except requests.Timeout:
            return 0, 0, False, "查询超时"
        except requests.ConnectionError:
            return 0, 0, False, "连接失败"
        except Exception as e:
            # 异常详情可能含内部 URL/连接信息，仅记日志，对外返回泛化文案
            logger.warning("三菱库存查询异常 (model=%s): %s", model_val, e)
            return 0, 0, False, "查询失败"


# 模块级单例，全局复用登录态
_engine: QueryEngine | None = None


def get_engine() -> QueryEngine:
    global _engine
    if _engine is None:
        _engine = QueryEngine()
    return _engine
