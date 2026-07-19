import unittest
from pathlib import Path


class AdminGuiTest(unittest.TestCase):
    def _read(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "admin" / "index.html").read_text(encoding="utf-8")
        # 模块化后，函数分布在 app.js + lib/*.js 中，拼接为整体进行检查
        js_parts = [(root / "admin" / "app.js").read_text(encoding="utf-8")]
        lib_dir = root / "admin" / "lib"
        if lib_dir.is_dir():
            for js_file in sorted(lib_dir.glob("*.js")):
                js_parts.append(js_file.read_text(encoding="utf-8"))
        js = "\n".join(js_parts)
        return html, js

    def test_admin_gui_exposes_non_technical_configuration_flow(self):
        html, js = self._read()

        # 导航项
        for label in ["字段配置", "报价规则", "复制模板", "发布配置",
                      "页面显示", "版本历史", "审计日志", "数据拼接"]:
            self.assertIn(label, html, f"HTML 中未找到导航项: {label}")

        # 核心 API 端点（已扁平化，无 /api/companies）
        for endpoint in ["/api/config", "/configs", "/audit", "/publish"]:
            self.assertIn(endpoint, js, f"app.js 中未找到端点: {endpoint}")

        # 高级 JSON 区域
        self.assertIn("advancedJson", html)

        # 核心渲染函数
        for fn in ["renderFieldRows", "renderRuleRows", "renderCopyRows", "renderUiConfig", "renderPricing"]:
            self.assertIn(fn, js, f"app.js 中未找到渲染函数: {fn}")

        # 版本历史 / 审计
        for fn in ["loadHistory", "rollbackToRevision", "loadAudit"]:
            self.assertIn(fn, js, f"app.js 中未找到函数: {fn}")

    def test_admin_gui_has_ui_config_section(self):
        html, _ = self._read()

        for elem_id in ["uiAppTitle"]:
            self.assertIn(elem_id, html, f"HTML 中未找到 UI 配置元素: {elem_id}")

        for elem_id in ["pricingFormula", "pricingDecimals", "pricingRoundMode", "pricingIntegerAbove"]:
            self.assertIn(elem_id, html, f"HTML 中未找到定价配置元素: {elem_id}")

    def test_admin_gui_has_history_and_audit_sections(self):
        html, _ = self._read()

        for elem_id in ["historyRows", "auditRows", "historyTable", "loadHistoryBtn", "loadAuditBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到历史/审计元素: {elem_id}")

    def test_admin_gui_has_config_management(self):
        html, js = self._read()

        # 配置版本字段
        self.assertIn("revision", html)

        # JS 函数
        for fn in ["loadConfig", "saveConfig", "validateConfig", "collectConfig"]:
            self.assertIn(fn, js, f"app.js 中未找到函数: {fn}")

    def test_admin_gui_has_validate_section(self):
        """发布配置区应有校验按钮和校验结果区"""
        html, js = self._read()

        self.assertIn("validateConfigBtn", html)
        self.assertIn("validateResult", html)
        self.assertIn("validateConfig", js)

    def test_admin_gui_has_merger_section(self):
        """数据拼接区使用 mcard 卡片 UI"""
        html, js = self._read()

        # 导航
        self.assertIn("数据拼接", html)

        # merger UI 元素（当前命名）
        for elem_id in ["merger-priceFiles", "merger-stockFiles", "merger-exportPriceBtn", "merger-exportStockBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到数据拼接元素: {elem_id}")

    def test_admin_gui_has_data_source_config(self):
        """数据来源配置区"""
        html, _ = self._read()
        for elem_id in ["dsBaseUrl", "dsConfigFile", "dsPriceFile", "dsStockFile", "dsVersionFile", "dsCacheName"]:
            self.assertIn(elem_id, html, f"HTML 中未找到数据来源元素: {elem_id}")

    def test_admin_gui_has_labels_config(self):
        """标签文案配置区"""
        html, _ = self._read()
        for elem_id in ["lblSearchBtn", "lblStockBtn", "lblMmcBtn", "lblCopyBtn", "lblQueryPlaceholder", "lblStockPrefix"]:
            self.assertIn(elem_id, html, f"HTML 中未找到标签元素: {elem_id}")


if __name__ == "__main__":
    unittest.main()
