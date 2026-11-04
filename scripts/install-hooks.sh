#!/usr/bin/env bash
# 启用项目自带的 git hooks（幂等，可重复执行）
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

HOOK_DIR="scripts/git-hooks"
[ -d "$HOOK_DIR" ] || { echo "x 找不到 $HOOK_DIR"; exit 1; }

chmod +x "$HOOK_DIR"/* 2>/dev/null || true
git config core.hooksPath "$HOOK_DIR"

echo "已启用 hooks：core.hooksPath = $HOOK_DIR"
ls -1 "$HOOK_DIR" | sed 's/^/  - /'
echo "关闭：git config --unset core.hooksPath"
