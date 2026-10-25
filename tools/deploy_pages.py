#!/usr/bin/env python3
"""把 static/ 目录发布到 GitHub Pages 仓库根目录（保留 ocr/ 等已有文件）。

为什么用 Git Data API 而不是 git push：
    沙箱到 github.com:443 的 git 协议会超时，但 api.github.com 正常。
    Git Data API 能一次提交几十个文件，只走 HTTPS API，没有这个问题。

用法：
    GITHUB_TOKEN=xxx python3 tools/deploy_pages.py --owner githubAlong --repo my-workbench
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.request
import urllib.error

API = "https://api.github.com"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "static")

# 站点不认识的开发文件，别推到线上
SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_DIRS = {"node_modules", ".git"}


def call(token, method, path, payload=None):
    url = API + path
    data = None
    headers = {
        "Authorization": "token " + token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "workbench-deploy",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise SystemExit(f"[{method} {path}] HTTP {e.code}\n{detail[:800]}")


def collect(root):
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_NAMES:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                files[rel] = f.read()
    return files


def is_binary(blob):
    if b"\0" in blob[:8000]:
        return True
    return blob[:8000].decode("utf-8", "ignore").count("\ufffd") > 8


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default="githubAlong")
    ap.add_argument("--repo", default="my-workbench")
    ap.add_argument("--branch", default="master")
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--message", default="feat: 完整版工作台上线（静态版，数据存本地浏览器）")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--prune", action="store_true",
                    help="删除远端存在但本地没有的文件（站点改结构时用，会跳过 ocr/ 等大体积资源）")
    ap.add_argument("--keep", default="ocr",
                    help="prune 时仍要保留的顶层目录，逗号分隔")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("缺少 GITHUB_TOKEN")

    files = collect(os.path.abspath(args.src))
    print(f"待发布 {len(files)} 个文件，共 {sum(len(v) for v in files.values()) / 1024:.0f} KB")

    repo_path = f"/repos/{args.owner}/{args.repo}"

    # 1. 取分支当前 HEAD
    ref = call(token, "GET", f"{repo_path}/git/ref/heads/{args.branch}")
    base_sha = ref["object"]["sha"]
    print(f"基准提交 {base_sha[:8]}")

    # 2. 取基准提交的完整树（含 ocr/ 等我们要保留的文件）
    base_commit = call(token, "GET", f"{repo_path}/git/commits/{base_sha}")
    base_tree_sha = base_commit["tree"]["sha"]
    base_tree = call(token, "GET", f"{repo_path}/git/trees/{base_tree_sha}?recursive=1")
    remote = {}
    for node in base_tree.get("tree", []):
        if node["type"] == "blob":
            remote[node["path"]] = node["sha"]
    print(f"远端现有 {len(remote)} 个文件")

    # 3. 只上传内容有变化的文件（比对 git blob sha，避免无意义的新 blob）
    tree_entries = []
    changed = skipped = 0
    for rel in sorted(files):
        blob = files[rel]
        header = b"blob %d\0" % len(blob)
        local_sha = hashlib.sha1(header + blob).hexdigest()
        if remote.get(rel) == local_sha:
            skipped += 1
            continue
        if args.dry:
            print(f"  [dry] 改 {rel}")
            continue
        if is_binary(blob):
            created = call(token, "POST", f"{repo_path}/git/blobs", {
                "content": base64.b64encode(blob).decode("ascii"),
                "encoding": "base64",
            })
        else:
            created = call(token, "POST", f"{repo_path}/git/blobs", {
                "content": blob.decode("utf-8"),
                "encoding": "utf-8",
            })
        tree_entries.append({
            "path": rel, "mode": "100644", "type": "blob", "sha": created["sha"],
        })
        changed += 1
        print(f"  + {rel}  ({len(blob) / 1024:.1f} KB)")

    print(f"变更 {changed} 个，未变 {skipped} 个")

    # 3.5 清理远端多余文件（站点从 static/ 切到 dist/ 后，旧的 js/ 目录会残留）
    if args.prune:
        keep = [k.strip() for k in args.keep.split(",") if k.strip()]
        for rel in sorted(remote):
            if rel in files:
                continue
            if any(rel == k or rel.startswith(k + "/") for k in keep):
                continue
            if rel in ("README.md", ".nojekyll"):
                continue
            tree_entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": None})
            print(f"  - 删除 {rel}")

    if args.dry or not tree_entries:
        print("无改动，结束")
        return

    # 4. 建新树（base_tree 让未列出的文件原样保留，比如 ocr/）
    new_tree = call(token, "POST", f"{repo_path}/git/trees", {
        "base_tree": base_tree_sha,
        "tree": tree_entries,
    })

    # 5. 建提交 + 移动分支
    commit = call(token, "POST", f"{repo_path}/git/commits", {
        "message": args.message,
        "tree": new_tree["sha"],
        "parents": [base_sha],
    })
    call(token, "PATCH", f"{repo_path}/git/refs/heads/{args.branch}", {
        "sha": commit["sha"], "force": False,
    })
    print(f"已推送 {commit['sha'][:8]} → {args.branch}")
    print(f"站点：https://{args.owner.lower()}.github.io/{args.repo}/")


if __name__ == "__main__":
    main()
