import unittest
from pathlib import Path


class AdminGuiTest(unittest.TestCase):
    def _read(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / "admin" / "index.html").read_text(encoding="utf-8")
        js = (root / "admin" / "app.js").read_text(encoding="utf-8")
        return html, js

    def test_admin_gui_exposes_non_technical_configuration_flow(self):
        html, js = self._read()

        # 导航项
        for label in ["公司管理", "字段配置", "报价规则", "复制模板", "ERPNext", "发布配置",
                      "页面显示", "版本历史", "审计日志", "数据导入"]:
            self.assertIn(label, html, f"HTML 中未找到导航项: {label}")

        # 核心 API 端点
        for endpoint in ["/api/companies", "/config", "/items", "/quote"]:
            self.assertIn(endpoint, js, f"app.js 中未找到端点: {endpoint}")

        # 新增 API 端点
        for endpoint in ["/configs", "/audit", "/items/stats", "/publish"]:
            self.assertIn(endpoint, js, f"app.js 中未找到新增端点: {endpoint}")

        # 高级 JSON 区域
        self.assertIn("advancedJson", html)

        # 核心渲染函数
        for fn in ["renderFieldRows", "renderRuleRows", "renderCopyRows", "renderUiConfig", "renderPricing"]:
            self.assertIn(fn, js, f"app.js 中未找到渲染函数: {fn}")

        # 版本历史 / 审计 / 统计
        for fn in ["loadHistory", "rollbackToRevision", "loadAudit", "loadStats", "parseFieldPreview"]:
            self.assertIn(fn, js, f"app.js 中未找到新增函数: {fn}")

    def test_admin_gui_has_ui_config_section(self):
        html, _ = self._read()

        for elem_id in ["uiAppTitle", "uiIdentity", "uiMetrics", "uiChips", "uiDetails"]:
            self.assertIn(elem_id, html, f"HTML 中未找到 UI 配置元素: {elem_id}")

        for elem_id in ["pricingFormula", "pricingDecimals", "pricingRoundMode", "pricingIntegerAbove"]:
            self.assertIn(elem_id, html, f"HTML 中未找到定价配置元素: {elem_id}")

    def test_admin_gui_has_history_and_audit_sections(self):
        html, _ = self._read()

        for elem_id in ["historyRows", "auditRows", "historyTable", "loadHistoryBtn", "loadAuditBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到历史/审计元素: {elem_id}")

    def test_admin_gui_has_data_import_tabs(self):
        html, _ = self._read()

        for elem_id in ["fieldPreviewTable", "dataStats", "parsePreviewBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到数据导入元素: {elem_id}")

    def test_admin_gui_has_file_upload_and_company_management(self):
        """新增：文件上传区 + 公司删除/重命名按钮应存在于 HTML"""
        html, js = self._read()

        # 文件上传
        for elem_id in ["fileInput", "uploadArea", "writeDataBtn", "cancelUploadBtn", "selectFileBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到文件上传元素: {elem_id}")

        # 公司管理
        for elem_id in ["renamePanel", "renameValue", "confirmRenameBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到公司管理元素: {elem_id}")

        # JS 函数
        for fn in ["deleteCompany", "openRenamePanel", "confirmRename", "handleFileUpload",
                   "writeUploadedData", "validateConfig"]:
            self.assertIn(fn, js, f"app.js 中未找到函数: {fn}")

    def test_admin_gui_has_validate_section(self):
        """新增：发布配置区应有校验按钮和校验结果区"""
        html, js = self._read()

        self.assertIn("validateConfigBtn", html)
        self.assertIn("validateResult", html)
        self.assertIn("validateConfig", js)

    def test_admin_gui_has_merger_section(self):
        """新增：数据拼接区应有品牌识别和 Bundle 生成元素"""
        html, js = self._read()

        # 导航
        self.assertIn("数据拼接", html)

        # 品牌识别阶段
        for elem_id in ["mergerFiles", "detectBrandsBtn", "brandDetectionResult", "brandDetectionBody", "importByBrandBtn"]:
            self.assertIn(elem_id, html, f"HTML 中未找到数据拼接元素: {elem_id}")

        # Bundle 生成阶段
        for elem_id in ["bundlePassword", "supabaseAnonKey", "generateBundleBtn", "deployBundleBtn", "bundleResult"]:
            self.assertIn(elem_id, html, f"HTML 中未找到 Bundle 元素: {elem_id}")

        # JS 函数
        for fn in ["detectBrands", "importByBrand", "generateBundle", "importSingleMergerFile", "getBrandOptions"]:
            self.assertIn(fn, js, f"app.js 中未找到数据拼接函数: {fn}")


if __name__ == "__main__":
    unittest.main()
