#!/usr/bin/env python3
"""
build_standalone.py — 从 apps/ 源码生成单文件独立 HTML
用法: python3 build_standalone.py [输出路径]
默认输出: apps/standalone.html

不影响原有 apps/ 目录结构，只新增一个独立文件。
"""

import re
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"✅ 已生成: {path}")

def build():
    # 读取源码
    html_src = read_file(os.path.join(BASE, 'apps', 'index.html'))
    css_src = read_file(os.path.join(BASE, 'apps', 'styles.css'))
    query_regex = read_file(os.path.join(BASE, 'apps', 'lib', 'query-regex.js'))
    discount_utils = read_file(os.path.join(BASE, 'apps', 'lib', 'discount-utils.js'))
    result_sort = read_file(os.path.join(BASE, 'apps', 'lib', 'result-sort.js'))
    config_core = read_file(os.path.join(BASE, 'apps', 'lib', 'config-core.js'))
    app_js = read_file(os.path.join(BASE, 'apps', 'app.js'))

    # ===== 修复 1: Cache API 兼容 file:// =====
    old_cache = '''async function fetchFileWithCache(filename, version, fileType, sourceConfig) {
  const source = sourceConfig || getDataSourceConfig();
  const cacheName = source.cache_name || "quotation-cache-v4";
  const fileUrl = buildRemoteFileUrl(source, filename, `v=${encodeURIComponent(version)}`);

  const cache = await caches.open(cacheName);
  let response = await cache.match(fileUrl);

  if (!response) {
    console.log(`[${filename}] 缓存未命中或版本更新，从 Supabase 下载...`);
    response = await fetch(fileUrl);
    if (response.ok) {
      await cache.put(fileUrl, response.clone());
      // 异步清理旧缓存，不阻塞流程
      cleanOldCache(cache, filename, fileUrl);
    } else {
      throw new Error(`${filename} 下载失败`);
    }
  }

  const text = await response.text();
  try {
    if (fileType === 'json') {
      applyAppConfig(JSON.parse(text));
    } else if (fileType === 'bundle') {
      // Bundle files are stored as pure JSON data, not executable JS.
      return JSON.parse(text);
    }
  } catch (e) {
    console.error(`[${filename}] JSON 解析失败:`, e);
    throw new Error(`${filename} 数据格式异常，无法解析`);
  }
  return null;
}'''

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

    # ===== 修复 2: 添加一个标记，让 app.js 知道这是单文件模式 =====
    # 在 app.js 第一行后加一个注释标记
    # 实际上不需要，因为我们在 CSS/JS 都内联后，从文件系统看就跟原来一样

    # ===== 构建独立 HTML =====
    # 提取 body 内容
    body_start = html_src.index('<body>') + len('<body>')
    body_end = html_src.index('</body>')
    body_content = html_src[body_start:body_end]

    # 移除外部引用的标签
    body_content = body_content.replace('<link rel="stylesheet" href="./styles.css">', '')

    # 移除 script 引用（支持 ?v=4 等版本号）
    body_content = re.sub(
        r'<script src="\./lib/query-regex\.js(\?v=[\d]+)?"></script>',
        '', body_content)
    body_content = re.sub(
        r'<script src="\./lib/discount-utils\.js(\?v=[\d]+)?"></script>',
        '', body_content)
    body_content = re.sub(
        r'<script src="\./lib/result-sort\.js(\?v=[\d]+)?"></script>',
        '', body_content)
    body_content = re.sub(
        r'<script src="\./lib/config-core\.js(\?v=[\d]+)?"></script>',
        '', body_content)
    body_content = re.sub(
        r'<script src="\./app\.js(\?v=[\d]+)?"></script>',
        '', body_content)

    standalone = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#f7f3ec">
<title>智能询价系统</title>
<style>
{css_src}
</style>
</head>
<body>
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

    # 输出
    output = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, 'apps', 'standalone.html')
    write_file(output, standalone)

    # 统计
    size_kb = len(standalone.encode('utf-8')) / 1024
    lines = standalone.count('\n')
    print(f"📊 {size_kb:.1f} KB, {lines} 行")
    print(f"\n💡 提示：standalone.html 可以:")
    print(f"   - 双击用浏览器打开（电脑/手机）")
    print(f"   - 发送给客户直接使用")
    print(f"   - Open with → 任何浏览器")
    print(f"   - 数据从远程云端加载（需联网）")
    print(f"   - 三菱库存功能正常使用")

if __name__ == '__main__':
    build()