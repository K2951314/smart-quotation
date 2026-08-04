"""分析 CSS 文件结构，统计各功能模块的行数分布。"""
import re
import sys
from collections import Counter


def analyze_blocks(filepath):
    with open(filepath, encoding="utf-8") as f:
        lines = f.readlines()

    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("/*") or line.startswith("*"):
            i += 1
            continue
        if "{" in lines[i]:
            selector = line.split("{")[0].strip()
            depth = lines[i].count("{") - lines[i].count("}")
            start = i + 1
            j = i + 1
            while j < len(lines) and depth > 0:
                depth += lines[j].count("{") - lines[j].count("}")
                j += 1
            blocks.append((selector, start, j, j - start))
            i = j
        else:
            i += 1
    return blocks, len(lines)


def categorize(sel):
    s = sel.lower()
    if sel.startswith("@media"):
        return "MEDIA_QUERY"
    if "is-company" in s:
        return "COMPANY_MODE"
    if "auth" in s or "authgate" in s:
        return "AUTH_GATE"
    if any(k in s for k in ["result-row", "result-side", "result-metrics", "resultbody",
                            "metric-inline", "result-card", "appendresult"]):
        return "RESULT_LAYOUT"
    if any(k in s for k in ["discount-panel", "discount-config", "step-preset",
                            "discountstep", "btndefaultdiscount", "discount-stepper"]):
        return "DISCOUNT_CONTROLS"
    if any(k in s for k in ["profit-config", "btnprofitconfig", "profit-manual", "profit-margin"]):
        return "PROFIT_CONTROLS"
    if any(k in s for k in ["toolbar", "console", "query-bar", "search-",
                            "queryinput", "control-bar"]):
        return "TOOLBAR_SEARCH"
    if any(k in s for k in ["modal", "overlay", "backdrop", "config-modal"]):
        return "MODAL_OVERLAY"
    if any(k in s for k in ["toast", "notification"]):
        return "TOAST"
    if sel.startswith(".btn") or sel == "button" or "button" in s:
        return "BUTTONS"
    if any(k in s for k in ["header", ".banner", "nav", "h1", "h2", "h3", "heading"]):
        return "HEADER_TYPOGRAPHY"
    if sel.startswith(":root") or "--" in sel:
        return "CSS_VARIABLES"
    if any(k in s for k in ["input", "select", "textarea", "checkbox",
                            "spinbutton", "field-group"]):
        return "FORM_CONTROLS"
    if "mobile" in s or "back-top" in s:
        return "MOBILE_UTILS"
    return "OTHER"


def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else "apps/styles.css"
    blocks, total = analyze_blocks(filepath)
    cat_lines = Counter()
    for sel, start, end, nlines in blocks:
        cat = categorize(sel)
        cat_lines[cat] += nlines

    print(f"文件: {filepath} (总 {total} 行)")
    print(f"{'分类':25s} {'行数':>6s}")
    print("-" * 35)
    for cat, n in cat_lines.most_common():
        print(f"{cat:25s} {n:6d}")


if __name__ == "__main__":
    main()
