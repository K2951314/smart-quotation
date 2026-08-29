"""LLM 后台辅助模块（NVIDIA NIM kimi-k3，免费档）。

定位：LLM 是锦上添花——所有调用方必须有非 LLM 的降级路径（自己接管），
本模块任何失败都只返回 None，绝不抛错、绝不阻塞主流程。

自我约束（应对免费档 40 RPM + 服务不稳定）：
- 客户端限流：滑动窗口默认 30 RPM（低于 NVIDIA 40 留余量），
  超预算立即返回 None（宁可不用也不排队等待）。
- 结果缓存：相同输入直接命中（映射建议类任务天然可缓存）。
- 熔断：连续 3 次失败熔断 5 分钟，期间直接降级，不浪费配额。
- 未配置 LLM_API_KEY 时模块整体禁用（is_enabled()=False）。

环境变量：
  LLM_API_KEY    NVIDIA API Key（nvapi-...，未设置=禁用）
  LLM_BASE_URL   默认 https://integrate.api.nvidia.com/v1
  LLM_MODEL      默认 moonshotai/kimi-k3
  LLM_RPM        客户端限流（默认 30）
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any

logger = logging.getLogger(__name__)

_BASE_URL = "https://integrate.api.nvidia.com/v1"
_TIMEOUT_SEC = 8
_RATE_WINDOW_SEC = 60.0
_MAX_TOKENS = 512
_TEMPERATURE = 0.1  # 映射/归一化类任务要确定性输出

# 熔断：连续失败 N 次 → 冷却期
_FAILURE_THRESHOLD = 3
_BREAKER_COOLDOWN_SEC = 300.0

# 模块级共享状态（单 Worker 足够）
_hit_times: deque[float] = deque()
_failures = 0
_breaker_until = 0.0
_cache: dict[str, Any] = {}
_CACHE_MAX = 256


def is_enabled() -> bool:
    """LLM 是否可用（配置了 key 且未熔断）。"""
    return bool(os.environ.get("LLM_API_KEY", "").strip())


# 语义别名：路由层读起来更顺（llm_enabled()）
llm_enabled = is_enabled


def _rpm_limit() -> int:
    try:
        return max(1, int(os.environ.get("LLM_RPM", "30")))
    except ValueError:
        return 30


def _under_rate_budget() -> bool:
    """滑动窗口限流：超预算立即 False（不等待——调用方降级）。"""
    now = time.monotonic()
    while _hit_times and now - _hit_times[0] > _RATE_WINDOW_SEC:
        _hit_times.popleft()
    if len(_hit_times) >= _rpm_limit():
        return False
    _hit_times.append(now)
    return True


def _breaker_open() -> bool:
    return time.monotonic() < _breaker_until


def _record_success() -> None:
    global _failures
    _failures = 0


def _record_failure(reason: str) -> None:
    global _failures, _breaker_until
    _failures += 1
    if _failures >= _FAILURE_THRESHOLD:
        _breaker_until = time.monotonic() + _BREAKER_COOLDOWN_SEC
        _failures = 0
        logger.warning("LLM 连续失败已熔断 %d 分钟: %s", int(_BREAKER_COOLDOWN_SEC / 60), reason)


def chat(user_prompt: str, system_prompt: str = "") -> str | None:
    """调用 LLM。任何失败（未配置/限流/熔断/超时/HTTP 错误）返回 None。

    带结果缓存：相同 prompt 直接命中，不消耗 RPM 预算。
    """
    global _failures
    if not is_enabled() or _breaker_open():
        return None

    key = hashlib.sha256(f"{os.environ.get('LLM_MODEL','')}|{system_prompt}|{user_prompt}".encode()).hexdigest()
    if key in _cache:
        return _cache[key]

    if not _under_rate_budget():
        logger.debug("LLM 本地限流触发，降级")
        return None

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    payload = json.dumps({
        "model": os.environ.get("LLM_MODEL", "moonshotai/kimi-k3"),
        "messages": messages,
        "temperature": _TEMPERATURE,
        "max_tokens": _MAX_TOKENS,
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        _BASE_URL.rstrip("/") + "/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["LLM_API_KEY"].strip(),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        _record_success()
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()  # 简单防膨胀
        _cache[key] = content
        return content
    except urllib.error.HTTPError as exc:
        _record_failure(f"HTTP {exc.code}")
        return None
    except Exception as exc:  # noqa: BLE001 网络/解析失败都降级
        _record_failure(str(exc))
        return None


_SYSTEM_COLUMN_MAPPING = (
    "你是数据集成助手。把 Excel 列名映射到给定的标准字段。"
    "只输出一个 JSON 对象，键为列名，值为字段 key 或 null（无合适字段时）。"
    "不要输出任何解释、markdown 代码块或多余文本。"
)


def suggest_column_mapping(
    columns: list[str], fields: list[dict[str, Any]]
) -> dict[str, str]:
    """LLM 兜底列名映射：静态别名表没匹配上的列，交给 kimi-k3 猜。

    返回 {列名: field_key}（只含高置信映射）。任何失败返回 {}，
    调用方（Excel 解析）据此完全走原路径——LLM 只是锦上添花。
    """
    if not columns or not fields:
        return {}
    field_list = [
        {"key": f.get("key", ""), "label": f.get("label", ""), "aliases": f.get("excel_aliases", [])}
        for f in fields
        if f.get("key")
    ]
    user_prompt = (
        f"标准字段列表：{json.dumps(field_list, ensure_ascii=False)}\n"
        f"Excel 列名：{json.dumps(columns, ensure_ascii=False)}\n"
        "输出 JSON 映射。语义模糊的列宁可映射 null，不要乱猜。"
    )
    content = chat(user_prompt, system_prompt=_SYSTEM_COLUMN_MAPPING)
    if not content:
        return {}
    # 容忍模型输出 ```json 围栏
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    try:
        data = json.loads(cleaned)
    except (ValueError, TypeError):
        logger.debug("LLM 列映射输出非 JSON，忽略: %.120s", content)
        return {}
    if not isinstance(data, dict):
        return {}
    valid_keys = {f["key"] for f in field_list}
    result: dict[str, str] = {}
    for col, key in data.items():
        col = str(col).strip()
        key = str(key).strip() if key else ""
        if col in columns and key in valid_keys:
            result[col] = key
    return result
