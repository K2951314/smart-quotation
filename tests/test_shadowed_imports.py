"""AST 扫描：检测函数内局部 import 与文件顶部 import 重叠的作用域陷阱。

背景：07d3643 在 factory.py 顶部加了 `import logging`，但没删掉
create_app 内残留的局部 `import logging`。Python 编译期作用域规则
把 `logging` 判为整个 create_app 的局部变量，导致第 100 行
`logging.getLogger(...)` 在局部 import 执行前访问 → UnboundLocalError，
create_app 崩溃，所有 API 500。

此陷阱无法被运行时测试稳定覆盖（依赖具体执行路径），但 AST 静态扫描
能在提交时立刻发现，作为 CI 守卫防止同类 bug 再次漏到生产。
"""
from __future__ import annotations

import ast
from pathlib import Path


def _top_level_imports(tree: ast.Module) -> set[str]:
    """获取文件顶部的 import 名（只看 body 顶层的 Import/ImportFrom）。"""
    top: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                top.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                top.add(alias.asname or alias.name)
    return top


def _scan_file(path: Path) -> list[str]:
    """扫描单个文件，返回问题列表。"""
    src = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError:
        return []
    top = _top_level_imports(tree)
    if not top:
        return []
    issues: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Import):
                for alias in child.names:
                    name = alias.asname or alias.name.split(".")[0]
                    if name in top:
                        issues.append(
                            f"{path}:{child.lineno}: 函数 {node.name} 内局部 "
                            f"import '{name}'，但文件顶部已 import 同名模块 "
                            f"→ UnboundLocalError 陷阱（Python 作用域规则）"
                        )
            elif isinstance(child, ast.ImportFrom):
                for alias in child.names:
                    if alias.name == "*":
                        continue
                    name = alias.asname or alias.name
                    if name in top:
                        issues.append(
                            f"{path}:{child.lineno}: 函数 {node.name} 内局部 "
                            f"from-import '{name}'，但文件顶部已 import 同名模块 "
                            f"→ UnboundLocalError 陷阱（Python 作用域规则）"
                        )
    return issues


def test_no_shadowed_imports_in_backend():
    """整个 backend/smart_quotation 不得出现函数内局部 import 与顶部 import 重叠。

    这是 07d3643 类 bug 的静态守卫——该 bug 导致 create_app 崩溃、
    全量 API 500，且因子进程测试用 except Exception: pass 吞异常而漏网。
    """
    root = Path("backend/smart_quotation")
    all_issues: list[str] = []
    for py in root.rglob("*.py"):
        all_issues.extend(_scan_file(py))
    assert not all_issues, (
        "发现函数内局部 import 与顶部 import 重叠（UnboundLocalError 陷阱）：\n"
        + "\n".join(all_issues)
        + "\n\n修复：删除函数内的局部 import，顶部已 import 同名模块。"
    )
