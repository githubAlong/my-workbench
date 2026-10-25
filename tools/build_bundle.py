#!/usr/bin/env python3
"""把 static/js 的 ES 模块打成一个 bundle，部署到 dist/。

为什么需要这一步：
    GitHub Pages 没有 HTTP/2 推送，也不做 smart bundle。18 个 .js 文件
    每个都要单独回源，冷启动 TTFB 2~10 秒；并行发出去也只能排进浏览器
    每域 6 个连接的队列，实测首次打开要 20 秒才看到完整首页。

    打成 1 个文件后，请求数从 18 → 1，首次打开降到 1~2 秒。
    代价是改一行代码要重新构建——所以 dist/ 是产物，static/ 才是源码。

用法：
    python3 tools/build_bundle.py          # 构建到 dist/
    python3 tools/build_bundle.py --serve  # 构建后起本地服务器
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SRC = os.path.join(ROOT, "static")
DIST = os.path.join(ROOT, "dist")

# 打进主页 bundle 的入口
ENTRY = os.path.join(SRC, "js", "main.js")


def run(cmd, **kw):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"命令失败：{cmd}")
    return r.stdout.strip()


def build():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST, exist_ok=True)

    # 1. 静态资源原样拷过去（html / css / 图标 / manifest / sw）
    for name in ["index.html", "student.html", "manifest.webmanifest", "sw.js"]:
        shutil.copy2(os.path.join(SRC, name), os.path.join(DIST, name))
    for d in ["css", "icons"]:
        src_d = os.path.join(SRC, d)
        if os.path.isdir(src_d):
            shutil.copytree(src_d, os.path.join(DIST, d))

    # 2. 主程序打包
    npx = "npx --yes esbuild"
    run(
        f'{npx} "{ENTRY}" --bundle --format=esm --target=es2022 '
        f'--outfile="{os.path.join(DIST, "app.js")}" --legal-comments=none --log-level=warning --minify --keep-names'
    )
    print(f"app.js       {os.path.getsize(os.path.join(DIST, 'app.js')) / 1024:7.1f} KB")

    # 3. 学生端单独打包：只含 localapi（老师分享出去的页面，不该带整个工作台）
    #    student.html 是内联 module，esbuild 不能直接吃 HTML，
    #    所以把内联脚本抽出来当入口，再回填 <script src>。
    stu = os.path.join(SRC, "student.html")
    stu_html = open(stu, encoding="utf-8").read()
    marker = '<script type="module">'
    if marker in stu_html:
        pre, rest = stu_html.split(marker, 1)
        inline, post = rest.split("</script>", 1)
        # 临时入口必须放在 static/ 里，否则内联脚本里的 './js/localapi.js'
        # 会相对仓库根目录解析，找不到文件
        tmp_entry = os.path.join(SRC, ".tmp_student_entry.js")
        open(tmp_entry, "w", encoding="utf-8").write(inline)
        try:
            run(
                f'{npx} "{tmp_entry}" --bundle --format=esm --target=es2022 '
                f'--outfile="{os.path.join(DIST, "student.bundle.js")}" '
                f'--legal-comments=none --log-level=warning --minify --keep-names'
            )
        finally:
            os.remove(tmp_entry)
        out_html = pre + '<script type="module" src="student.bundle.js"></script>' + post
        open(os.path.join(DIST, "student.html"), "w", encoding="utf-8").write(out_html)
        print(f"student.bundle.js  {os.path.getsize(os.path.join(DIST, 'student.bundle.js')) / 1024:7.1f} KB")

    # 4. 改写 index.html / student.html 的脚本引用
    idx = os.path.join(DIST, "index.html")
    html = open(idx, encoding="utf-8").read()
    html = html.replace('src="js/main.js"', 'src="app.js"')
    open(idx, "w", encoding="utf-8").write(html)

    # 5. sw.js 的资源清单同步成实际产物
    swp = os.path.join(DIST, "sw.js")
    sw = open(swp, encoding="utf-8").read()
    if "'./js/" in sw:
        import re
        sw = re.sub(r"const ASSETS = \[.*?\];",
                    "const ASSETS = ['./', './index.html', './app.js', './student.html', "
                    "'./student.bundle.js', './css/app.css', './manifest.webmanifest'];", sw, flags=re.S)
        open(swp, "w", encoding="utf-8").write(sw)

    total = 0
    for dirpath, _, files in os.walk(DIST):
        for f in files:
            total += os.path.getsize(os.path.join(dirpath, f))
    print(f"dist/ 合计 {total / 1024:.0f} KB")
    return DIST


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args()
    d = build()
    if a.serve:
        os.chdir(d)
        os.execvp("python3", ["python3", "-m", "http.server", "8899", "--bind", "127.0.0.1"])
