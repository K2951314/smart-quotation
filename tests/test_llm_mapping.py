"""LLM 列名映射测试：kimi-k3 兜底映射 + 限流/熔断/降级接管。

验证：
1. 未配置 LLM_API_KEY → suggest 返回 {}（解析走原路径，行为不变）
2. chat 成功 → 列名映射（无效列/无效字段 key 被剔除）
3. markdown 围栏输出容错
4. 解析失败/非 dict 输出 → {}（降级）
5. 本地限流：窗口内超预算 → chat 返回 None（不排队不等待）
6. 熔断：连续失败 N 次 → 冷却期内直接返回 None
7. parse_excel_to_rows + column_mapper：未匹配列被 LLM 映射；mapper 抛异常不炸
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SQ_DEV", "1")
os.environ.pop("ALLOW_ORIGINS", None)
os.environ.pop("LLM_API_KEY", None)  # 默认禁用，单测里按需打开

from backend.smart_quotation import llm
from backend.smart_quotation.store import QuotationStore


def _reset_llm_state():
    """清空模块级限流/熔断/缓存状态（测试间隔离）。"""
    llm._hit_times.clear()
    llm._failures = 0
    llm._breaker_until = 0.0
    llm._cache.clear()


FIELDS = [
    {"key": "spec", "label": "型号"},
    {"key": "face_price", "label": "面价"},
    {"key": "stock", "label": "库存"},
]


class SuggestColumnMappingTest(unittest.TestCase):
    def setUp(self):
        _reset_llm_state()
        os.environ.pop("LLM_API_KEY", None)

    def tearDown(self):
        _reset_llm_state()
        os.environ.pop("LLM_API_KEY", None)

    def test_disabled_without_key(self):
        """未配置 key → 直接降级返回 {}。"""
        self.assertFalse(llm.is_enabled())
        self.assertEqual(llm.suggest_column_mapping(["物料编码"], FIELDS), {})

    def test_chat_returns_none_without_key(self):
        self.assertIsNone(llm.chat("hi"))

    def test_successful_mapping_with_filtering(self):
        """成功响应被解析；无效字段 key / null 被剔除，列名在请求内的保留。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        resp = {"choices": [{"message": {"content": '{"物料编码": "spec", "冒牌列": "stock", "库存数": "不存在字段", "面价": null}'}}]}
        with mock.patch.object(llm.urllib.request, "urlopen", return_value=_fake_response(resp)):
            result = llm.suggest_column_mapping(["物料编码", "冒牌列", "库存数", "面价"], FIELDS)
        # 无效字段 key 与 null 剔除；"冒牌列"在请求列中，映射合法保留
        self.assertEqual(result, {"物料编码": "spec", "冒牌列": "stock"})

    def test_markdown_fence_tolerated(self):
        """模型输出 ```json 围栏也能解析。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        content = '```json\n{"物料编码": "spec"}\n```'
        with mock.patch.object(llm.urllib.request, "urlopen", return_value=_fake_response(
                {"choices": [{"message": {"content": content}}]})):
            result = llm.suggest_column_mapping(["物料编码"], FIELDS)
        self.assertEqual(result, {"物料编码": "spec"})

    def test_non_json_output_degrades(self):
        """模型输出非 JSON → {}。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        with mock.patch.object(llm.urllib.request, "urlopen", return_value=_fake_response(
                {"choices": [{"message": {"content": "我觉得应该映射到spec字段"}}]})):
            self.assertEqual(llm.suggest_column_mapping(["物料编码"], FIELDS), {})

    def test_local_rate_limit_degrades(self):
        """本地限流：窗口内超预算 → chat 返回 None（urlopen 不被调用）。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        os.environ["LLM_RPM"] = "2"
        try:
            with mock.patch.object(llm.urllib.request, "urlopen") as mock_open:
                mock_open.return_value = _fake_response(
                    {"choices": [{"message": {"content": "ok"}}]}
                )
                self.assertIsNotNone(llm.chat("q1"))
                self.assertIsNotNone(llm.chat("q2"))
                self.assertIsNone(llm.chat("q3"))  # 第 3 次超预算
                self.assertEqual(mock_open.call_count, 2)  # 限流后不再发请求
        finally:
            os.environ.pop("LLM_RPM", None)

    def test_breaker_after_consecutive_failures(self):
        """连续 3 次失败熔断 5 分钟：期间 chat 直接 None 不发请求。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        import urllib.error
        err = urllib.error.HTTPError("url", 429, "Too Many Requests", None, None)
        with mock.patch.object(llm.urllib.request, "urlopen", side_effect=err) as mock_open:
            for _ in range(3):
                self.assertIsNone(llm.chat("q"))
            self.assertEqual(mock_open.call_count, 3)
            # 熔断期内不再发请求
            self.assertIsNone(llm.chat("q4"))
            self.assertEqual(mock_open.call_count, 3)

    def test_cache_hit_does_not_consume_budget(self):
        """相同 prompt 命中缓存：不消耗限流预算。"""
        os.environ["LLM_API_KEY"] = "nvapi-test"
        os.environ["LLM_RPM"] = "1"
        try:
            resp = _fake_response({"choices": [{"message": {"content": "ok"}}]})
            with mock.patch.object(llm.urllib.request, "urlopen", return_value=resp) as mock_open:
                self.assertEqual(llm.chat("same"), "ok")
                self.assertEqual(llm.chat("same"), "ok")  # 缓存命中
                self.assertEqual(mock_open.call_count, 1)
        finally:
            os.environ.pop("LLM_RPM", None)


def _fake_response(data):
    """构造 urlopen 返回的上下文管理器 mock。"""
    import io

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return io.BytesIO(__import__("json").dumps(data).encode("utf-8")).read()

    return _Resp()


class ExcelColumnMapperIntegrationTest(unittest.TestCase):
    def setUp(self):
        _reset_llm_state()
        os.environ.pop("LLM_API_KEY", None)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = QuotationStore(str(Path(tmp.name) / "q.db"))
        self.store.init_schema()
        config = {
            "schema_version": 3,
            "revision": "r1",
            "fields": [
                {"key": "spec", "label": "型号", "searchable": True},
                {"key": "face_price", "label": "面价"},
                {"key": "stock", "label": "库存"},
            ],
            "rules": [{"id": "default", "default": True, "actions": [{"type": "set_discount", "percent": 55}]}],
        }
        self.store.save_config(config, status="published")
        self.config = config

    def _csv(self):
        # "货号"不在任何别名表 → 走 mapper
        return "货号,面价\nABC-1,101.0\n".encode("utf-8")

    def test_mapper_maps_unmatched_column(self):
        """静态别名表未命中的列被 mapper 映射（report.matched 存字段 key）。"""
        rows, report = self.store.parse_excel_to_rows(
            self._csv(), "t.csv", column_mapper=lambda cols, fields: {"货号": "spec"},
        )
        self.assertNotIn("货号", report["unmatched"])
        self.assertIn("spec", report["matched"])
        self.assertIn("spec", {k for row in rows for k in row["fields"]})

    def test_mapper_empty_result_keeps_original_behavior(self):
        """mapper 返回 {}（LLM 降级）→ 行为与无 LLM 完全一致。"""
        rows, report = self.store.parse_excel_to_rows(
            self._csv(), "t.csv", column_mapper=lambda cols, fields: {},
        )
        self.assertIn("货号", report["unmatched"])

    def test_mapper_exception_does_not_break_parsing(self):
        """mapper 抛异常被吞掉，解析照常完成（货号未映射 → key 字段缺失的行按既有规则丢弃）。"""
        def bad_mapper(cols, fields):
            raise RuntimeError("LLM 炸了")

        rows, report = self.store.parse_excel_to_rows(self._csv(), "t.csv", column_mapper=bad_mapper)
        self.assertEqual(len(rows), 0)
        self.assertIn("货号", report["unmatched"])

    def test_mapper_suggestion_invalid_key_ignored(self):
        """mapper 建议的字段 key 不在配置中 → 忽略（不污染 col_mapping）。"""
        rows, report = self.store.parse_excel_to_rows(
            self._csv(), "t.csv", column_mapper=lambda cols, fields: {"货号": "hacked_field"},
        )
        self.assertIn("货号", report["unmatched"])


if __name__ == "__main__":
    unittest.main()
