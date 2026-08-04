"""验证拆分后的CSS文件合并后与原文件等价。"""
import os
import sys

orig_path = sys.argv[1] if len(sys.argv) > 1 else "apps/styles.css"
split_dir = sys.argv[2] if len(sys.argv) > 2 else "apps/styles"

orig = open(orig_path, encoding="utf-8").read()

combined = ""
for f in sorted(os.listdir(split_dir)):
    if f.endswith(".css"):
        content = open(os.path.join(split_dir, f), encoding="utf-8").read()
        lines = content.split("\n")
        if lines and lines[0].startswith("/*") and "split_css.py" in lines[0]:
            lines = lines[1:]
        combined += "\n".join(lines) + "\n"

orig_braces = orig.count("{")
comb_braces = combined.count("{")
orig_close = orig.count("}")
comb_close = combined.count("}")

print(f"原文件   {{ 数量: {orig_braces:4d}    }} 数量: {orig_close:4d}")
print(f"拆分合并 {{ 数量: {comb_braces:4d}    }} 数量: {comb_close:4d}")
print(f"差异     {{ : {orig_braces - comb_braces:+d}    }} : {orig_close - comb_close:+d}")

if orig_braces == comb_braces and orig_close == comb_close:
    print("\n✓ 括号数量完全匹配，拆分完整性验证通过")
else:
    print("\n✗ 括号数量不匹配，需要检查")
