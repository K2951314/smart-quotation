#!/usr/bin/env python3
"""
build_standalone.py — 从 apps/ 源码生成单文件独立 HTML
用法:
  python3 build_standalone.py                    → 管理员版 (apps/standalone.html)
  python3 build_standalone.py --company          → 公司版 (apps/company.html, 默认配置)
  python3 build_standalone.py --company --name "某公司" --profit 10 --tax 13

不影响原有 apps/ 目录结构，只新增独立文件。
"""

import re
import sys
import os
import argparse

BASE = os.path.dirname(os.path.abspath(__file__))

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"✅ 已生成: {path}")

def build(company_mode=False, company_name="公司账号", profit_margin=10, tax_rate=13):
    # 读取源码
    html_src = read_file(os.path.join(BASE, 'apps', 'index.html'))
    css_src = read_file(os.path.join(BASE, 'apps', 'styles.css'))
    query_regex = read_file(os.path.join(BASE, 'apps', 'lib', 'query-regex.js'))
    discount_utils = read_file(os.path.join(BASE, 'apps', 'lib', 'discount-utils.js'))
    result_sort = read_file(os.path.join(BASE, 'apps', 'lib', 'result-sort.js'))
    config_core = read_file(os.path.join(BASE, 'apps', 'lib', 'config-core.js'))
    app_js = read_file(os.path.join(BASE, 'apps', 'app.js'))

    # ===== Cache API 兼容 file:// =====
    # 从 app.js 中实时提取函数，确保替换精确匹配
    fn_start = app_js.find('async function fetchFileWithCache')
    fn_end = app_js.find('async function cleanOldCache')
    old_cache = app_js[fn_start:fn_end].strip()

    new_cache = '''async function fetchFileWithCache(filename, version, fileType, sourceConfig) {
  const source = sourceConfig || getDataSourceConfig();
  const cacheName = source.cache_name || "quotation-cache-v4";
  const fileUrl = buildRemoteFileUrl(source, filename, `v=${encodeURIComponent(version)}`);

  // 单文件兼容：file:// 协议下 Cache API 不可用，直连 fetch
  let response = null;
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(cacheName);
      response = await cache.match(fileUrl);
    } catch (e) {
      response = null;
    }
  }

  if (!response) {
    console.log(`[${filename}] 缓存未命中或版本更新，从 Supabase 下载...`);
    response = await fetch(fileUrl);
    if (response.ok) {
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open(cacheName);
          await cache.put(fileUrl, response.clone());
          cleanOldCache(cache, filename, fileUrl);
        } catch (e) {}
      }
    } else {
      throw new Error(`${filename} 下载失败`);
    }
  }

  const text = await response.text();
  try {
    if (fileType === 'json') {
      applyAppConfig(JSON.parse(text));
    } else if (fileType === 'bundle') {
      return JSON.parse(text);
    }
  } catch (e) {
    console.error(`[${filename}] JSON 解析失败:`, e);
    throw new Error(`${filename} 数据格式异常，无法解析`);
  }
  return null;
}'''

    app_js_fixed = app_js.replace(old_cache, new_cache)

    # ===== 公司版：注入配置 =====
    if company_mode:
        profile_json = f'{{"role":"company","companyName":"{company_name}","profitMargin":{profit_margin},"taxRate":{tax_rate}}}'
        company_inject = f'<script>window.__COMPANY_PROFILE__ = {profile_json};</script>'
    else:
        company_inject = ''

    # ===== 构建独立 HTML =====
    body_start = html_src.index('<body>') + len('<body>')
    body_end = html_src.index('</body>')
    body_content = html_src[body_start:body_end]

    body_content = body_content.replace('<link rel="stylesheet" href="./styles.css">', '')
    body_content = re.sub(r'<script src="\./lib/query-regex\.js(\?v=[\d]+)?"></script>', '', body_content)
    body_content = re.sub(r'<script src="\./lib/discount-utils\.js(\?v=[\d]+)?"></script>', '', body_content)
    body_content = re.sub(r'<script src="\./lib/result-sort\.js(\?v=[\d]+)?"></script>', '', body_content)
    body_content = re.sub(r'<script src="\./lib/config-core\.js(\?v=[\d]+)?"></script>', '', body_content)
    body_content = re.sub(r'<script src="\./app\.js(\?v=[\d]+)?"></script>', '', body_content)

    standalone = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f7f3ec">
<title>{"智能询价 - " + company_name if company_mode else "智能询价系统"}</title>
<style>
{css_src}
</style>
</head>
<body>
{company_inject}
{body_content.strip()}
<script>
{query_regex}
</script>
<script>
{discount_utils}
</script>
<script>
{result_sort}
</script>
<script>
{config_core}
</script>
<script>
{app_js_fixed}
</script>
</body>
</html>'''

    if company_mode:
        output = os.path.join(BASE, 'company.html')
    else:
        output = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(BASE, 'standalone.html')
    write_file(output, standalone)

    size_kb = len(standalone.encode('utf-8')) / 1024
    lines = standalone.count('\n')
    print(f"📊 {size_kb:.1f} KB, {lines} 行")
    if company_mode:
        print(f"\n💡 公司专用版：无登录、无面价、无折扣配置")
        print(f"   - 公司名: {company_name}  利润率: {profit_margin}%  税率: {tax_rate}%")
    else:
        print(f"\n💡 管理员版：双击即用，完整功能")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='生成独立 HTML')
    parser.add_argument('--company', action='store_true', help='生成公司版（无登录，无面价）')
    parser.add_argument('--name', default='公司账号', help='公司名称')
    parser.add_argument('--profit', type=float, default=10, help='利润率（%）')
    parser.add_argument('--tax', type=float, default=13, help='税率（%）')
    parser.add_argument('output', nargs='?', help='输出路径（仅管理员版）')
    args = parser.parse_args()

    build(
        company_mode=args.company,
        company_name=args.name,
        profit_margin=args.profit,
        tax_rate=args.tax,
    )