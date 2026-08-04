"""
按功能模块拆分 CSS 文件。

策略：
  1. 解析 CSS 为顶层规则块（普通规则 + @media 块）
  2. 根据选择器关键词分类到目标模块
  3. @media 块根据内部选择器分配到对应模块（保留在模块内，不再集中）
  4. 无法分类的规则归入 misc.css

输出目录：apps/styles/  和  admin/styles/
"""
import os
import re
import sys
from collections import defaultdict


# ── 模块定义：关键词 → 目标文件 ──
MODULE_RULES = [
    # (模块文件名, 匹配关键词列表, 模块描述)
    ("base", [
        ":root", "^html", "^body", "^*", "body::before", "body::after",
        "color-scheme", "box-sizing", "font-family",
        "@keyframes", "^from", "^to",
        "^code", "^h1", "^h2", "^h3", "^p",
        "h1, h2", "h1,", "h2,", "h3,",
    ], "CSS 变量、reset、全局排版、动画"),

    ("layout", [
        ".shell", ".workspace", ".masthead", ".brand-", ".eyebrow",
        ".subline", ".panel-kicker", ".toolbar", ".toolbar-",
        ".query-panel", ".query-bar", ".console", ".control-bar",
        ".result-panel", ".result-panel-header", ".result-panel-actions",
        ".result-stat", ".result-list", ".result-aside",
        ".status-badge", ".version-bar", ".mmc-btn",
        ".section-head", ".section-head-compact", ".section-head-inline",
        ".identity-line", ".identity-code", ".identity-spec",
        ".info-note", ".results-shell", ".result-summary",
        ".result-toolbar-inline", ".query-note-inline",
        ".result-controls-band", ".meta-line", ".hint",
        ".rail", ".brand", ".nav", ".topbar", ".top-actions",
        ".primary-actions", ".secondary-actions", ".actions",
        ".band", ".panel", ".js-status-bar",
        "header", "nav", ".banner",
        ".mobile-back-top", "#btnBackToTop", ".back-top",
        ".copy-title",
    ], "页面骨架、顶栏、工具栏、面板布局"),

    ("results", [
        ".result-row", ".result-side", ".result-metrics", ".result-card",
        ".result-body", "#resultBody", ".metric-inline", ".metric-label",
        ".stock-chip", ".special-chip", ".code-chip", ".spec-link",
        ".row-code", ".row-spec", ".row-stock", ".row-special",
        ".result-meta", ".appendResult", "body.is-company",
        ".profit-manual", ".discount-panel", ".discount-stepper",
        ".discount-input-wrap", "#discountPanel",
        ".price", ".discount-manual", ".discount-unit",
        ".skeleton-line", ".skeleton-line-wide", ".skeleton-line-short",
        ".state-skeleton",
        ".table-wrap", "table", "th", "td", ".key-col",
        ".rule-list", ".copy-list", ".rule-row", ".copy-row",
        ".company-list", ".company-chips", ".company-chip-card",
        ".stats-bar", ".stat-item",
        ".stock-live", ".stock-signal", ".stock-loading",
        ".stock-needs-terminal", ".stock-zero", ".stock-error",
    ], "结果列表、报价/折扣/利润单元格、表格、库存显示"),

    ("forms", [
        ".field-group", ".rounding-select", "input", "select",
        "textarea", "checkbox", "spinbutton", ".step-preset",
        "#discountStep", "#decimals", "#threshold", "#roundingMethod",
        "#queryInput", ".search-input", ".field-unit",
        ".field-shell", ".form-grid", ".wide", "label",
        ".ui-field-layout", ".ui-field-row", ".ui-field-name",
        ".ui-field-area", ".ui-layout-grid", ".ui-layout-area",
        "button", ".btn", ".btn-icon", ".btn-primary", ".btn-ghost",
        ".btnDefaultDiscounts",
        ".toggle", ".switch", ".opt-lbl", ".select-chip",
        ".select-all-toggle", "#chkSelectAll", "#chkUntaxedQuote",
        ".checkbox-pill", ".check-wrap",
        ".small-btn", ".danger-btn", ".warn-btn", ".success-btn",
        ".primary", ".tab-btn", ".tab-pane", ".import-tabs",
        ".chip-btn", ".chip-select", ".rename-panel",
        ".badge", ".badge-green", ".badge-amber", ".badge-muted",
        ".inline-test", ".advanced", ".danger",
    ], "表单控件、按钮、输入框、步进预设、徽标、工具类"),

    ("modals", [
        ".modal", ".overlay", ".backdrop", ".config-modal",
        "#discountConfigModal", "#profitConfigModal",
        ".discount-config-modal", ".discount-config-backdrop",
        ".discount-config-card", ".discount-config-head",
        ".discount-config-kicker", ".discount-config-copy",
        ".discount-config-close", ".discount-config-grid",
        ".discount-config-grid-single", ".discount-config-field",
        ".discount-config-actions",
        ".auth-gate", "#authGate", ".auth-gate-overlay",
        ".toast", ".notification", ".toast-container",
        ".state-card", ".state-kicker", ".render-state",
        ".import-panel", ".upload-area", ".upload-hint",
        ".upload-result-header", ".mapping-report", ".mapping-item",
        ".matched-fields", ".unmatched-fields", ".validate-pass",
        ".validate-fail", ".field-preview-header", ".preview-info",
        ".supabase-panel", ".supabase-panel-head", ".supabase-creds",
        ".supabase-deploy-grid", ".deploy-card", ".supabase-status",
        ".merger-cards", ".mcard", ".mcard-head", ".mcard-icon",
        ".mcard-desc", ".mcard-body", ".mcard-label", ".mcard-file",
        ".mcard-input", ".mcard-meta",
        ".merger-status", ".login-overlay", ".login-card", ".login-logo",
        ".login-error", ".login-btn", ".login-hint",
        ".company-layout", ".company-create-panel", "#companyList",
        ".field-block", ".field-hint", ".create-btn",
    ], "弹窗、认证覆盖层、提示通知、导入/部署/合并面板、公司管理"),

    ("misc", [], "未分类规则（兜底）"),
]


def parse_css_blocks(text):
    """将 CSS 文本解析为顶层规则块列表。

    返回 [(selector, body_text, full_text, start_pos), ...]
    保留注释行作为独立块（附加到下一个规则）。
    """
    blocks = []
    i = 0
    n = len(text)
    pending_comment = ""

    while i < n:
        # 跳过空白
        if text[i].isspace():
            i += 1
            continue

        # 注释块
        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end == -1:
                end = n
            else:
                end += 2
            comment = text[i:end]
            pending_comment += comment
            i = end
            continue

        # 读取选择器（直到 {）
        brace_pos = text.find("{", i)
        if brace_pos == -1:
            # 剩余非规则文本
            remaining = text[i:].strip()
            if remaining:
                pending_comment += remaining
            break

        selector = text[i:brace_pos].strip()
        # 找到匹配的 }
        depth = 1
        j = brace_pos + 1
        while j < n and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1

        body = text[brace_pos + 1:j - 1]
        full = text[i:j]
        # 附加前面的注释
        if pending_comment.strip():
            full = pending_comment + "\n" + full
        blocks.append((selector, body, full, pending_comment))
        pending_comment = ""
        i = j

    # 尾部注释
    if pending_comment.strip():
        blocks.append(("", "", pending_comment, pending_comment))

    return blocks


def categorize_selector(selector):
    """根据选择器文本返回模块名。

    匹配规则：
    - 以 ^ 开头的关键词：选择器必须以该词开头
    - 否则：选择器中包含该关键词作为子串
    """
    if not selector:
        return "misc"
    sel = selector.strip()

    # @media 块需要看内部内容，这里返回 None 表示需要进一步分析
    if sel.startswith("@media"):
        return None

    # 按模块定义顺序匹配
    for module, keywords, _desc in MODULE_RULES:
        if module == "misc":
            continue
        for kw in keywords:
            if kw.startswith("^"):
                # 锚定匹配：选择器以关键词开头
                if sel.startswith(kw[1:]):
                    return module
            else:
                # 子串匹配
                if kw in sel:
                    return module
    return "misc"


def categorize_media_block(selector, body):
    """分析 @media 块内部的选择器，返回最匹配的模块名。

    如果内部选择器涉及多个模块，返回 "responsive"（需要保留为通用响应式补丁）。
    """
    inner_blocks = parse_css_blocks(body)
    modules_found = set()
    for sel, _b, _f, _c in inner_blocks:
        if not sel:
            continue
        m = categorize_selector(sel)
        if m:
            modules_found.add(m)

    if len(modules_found) == 0:
        return "misc"
    if len(modules_found) == 1:
        return modules_found.pop()
    # 多模块 → responsive（通用响应式补丁文件）
    return "responsive"


def split_css(filepath, output_dir, prefix=""):
    """拆分 CSS 文件到 output_dir 目录。"""
    with open(filepath, encoding="utf-8") as f:
        text = f.read()

    blocks = parse_css_blocks(text)

    module_blocks = defaultdict(list)
    media_count = 0

    for selector, body, full, comment in blocks:
        if not selector:
            # 纯注释块，附加到 misc
            if comment.strip():
                module_blocks["misc"].append(comment)
            continue

        if selector.startswith("@media"):
            module = categorize_media_block(selector, body)
            media_count += 1
        else:
            module = categorize_selector(selector)

        module_blocks[module].append(full)

    # 确保 responsive 模块存在
    if "responsive" not in module_blocks and media_count > 0:
        pass  # 所有 @media 都被分配到功能模块了

    # 写入文件
    os.makedirs(output_dir, exist_ok=True)

    header_template = '/* {desc} — 由 scripts/split_css.py 自动拆分 */\n'
    module_descriptions = {m: d for m, _k, d in MODULE_RULES}
    module_descriptions["responsive"] = "通用响应式补丁（跨多组件的 @media 规则）"

    written_files = []
    for module, blocks_list in module_blocks.items():
        if not blocks_list:
            continue
        desc = module_descriptions.get(module, "其他")
        filename = f"{prefix}{module}.css"
        filepath_out = os.path.join(output_dir, filename)
        content = header_template.format(desc=desc) + "\n\n".join(blocks_list) + "\n"
        with open(filepath_out, "w", encoding="utf-8") as f:
            f.write(content)
        written_files.append((filename, len(blocks_list)))
        print(f"  {filename:30s} {len(blocks_list):4d} 块")

    return written_files


def main():
    if len(sys.argv) < 2:
        print("用法: py scripts/split_css.py <css文件路径> [输出目录] [前缀]")
        sys.exit(1)

    filepath = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None
    prefix = sys.argv[3] if len(sys.argv) > 3 else ""

    if output_dir is None:
        base = os.path.splitext(os.path.dirname(filepath))[0]
        output_dir = os.path.join(base, "styles")

    print(f"拆分: {filepath}")
    print(f"输出: {output_dir}")
    print()
    written = split_css(filepath, output_dir, prefix)
    print()
    print(f"完成，共 {len(written)} 个文件。")


if __name__ == "__main__":
    main()
