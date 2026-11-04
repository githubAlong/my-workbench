#!/usr/bin/env bash
# 发布脚本：把 dev 合并到 master 并推送，然后自动切回 dev。
# 用法：./scripts/release.sh [-y|--yes] [-n|--dry-run]
#   -y  跳过确认
#   -n  只预览要合并的提交，不执行任何写操作
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

DEV_BRANCH="dev"
PROD_BRANCH="master"
PAGES_URL="https://githubalong.github.io/my-workbench/"

ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'x %s\n' "$*" >&2; exit 1; }

# ---------- 1. 前置检查 ----------
cur="$(git rev-parse --abbrev-ref HEAD)"
[ "$cur" = "$DEV_BRANCH" ] || fail "当前在 $cur 分支，请先 git checkout $DEV_BRANCH"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  fail "有未提交的改动，先 commit 再发布"
fi

say "== 同步远端 =="
git fetch origin --quiet || fail "git fetch 失败（代理？试试 HTTPS_PROXY= git ...）"

behind="$(git rev-list --count "$DEV_BRANCH".."origin/$DEV_BRANCH" 2>/dev/null || echo 0)"
if [ "$behind" -gt 0 ]; then
  fail "本地 $DEV_BRANCH 落后 origin/$DEV_BRANCH $behind 个提交，先 git pull --ff-only"
fi

ahead="$(git rev-list --count "origin/$DEV_BRANCH".."$DEV_BRANCH" 2>/dev/null || echo 0)"
if [ "$ahead" -gt 0 ]; then
  fail "本地有 $ahead 个提交还没推到 origin/$DEV_BRANCH，先 git push"
fi

# ---------- 2. 待合并清单 ----------
PENDING="$(git log --oneline "origin/$PROD_BRANCH..$DEV_BRANCH" || true)"
if [ -z "$PENDING" ]; then
  say "dev 与 master 内容一致，没有需要发布的提交。"
  exit 0
fi

count="$(printf '%s\n' "$PENDING" | wc -l | tr -d ' ')"
say ""
say "将把 $count 个提交从 $DEV_BRANCH 合并到 $PROD_BRANCH："
printf '%s\n' "$PENDING" | sed 's/^/  /'
say ""
say "改动文件："
git diff --stat "origin/$PROD_BRANCH..$DEV_BRANCH" | sed 's/^/  /'
say ""

if [ "$DRY_RUN" -eq 1 ]; then
  say "（dry-run，未做任何改动）"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '确认发布到线上？(y/N) '
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) say "已取消，什么都没动。"; exit 0 ;;
  esac
fi

# ---------- 3. 合并 + 推送 ----------
restore() { git checkout "$DEV_BRANCH" --quiet 2>/dev/null || true; }
trap 'restore; printf "x 发布中断，已切回 %s\n" "$DEV_BRANCH" >&2' ERR

say "== 切到 $PROD_BRANCH =="
git checkout "$PROD_BRANCH" --quiet
git merge --ff-only "origin/$PROD_BRANCH" --quiet || fail "本地 $PROD_BRANCH 与远端分叉，请手动处理"

msg="release: 合并 $DEV_BRANCH 到 $PROD_BRANCH（$(date +%Y-%m-%d\ %H:%M)）"
if ! git merge --no-ff "$DEV_BRANCH" -m "$msg" --quiet; then
  say "合并有冲突，解决后执行：git commit，然后 git checkout $DEV_BRANCH"
  trap - ERR
  exit 1
fi

say "== 推送 $PROD_BRANCH =="
git push origin "$PROD_BRANCH" || fail "push 失败，本地已合并，重试：git push origin $PROD_BRANCH"

# dev 停在原处：master 只多了一个合并提交，下次发布继续从 dev 出发即可
git checkout "$DEV_BRANCH" --quiet
trap - ERR

say ""
say "已发布。"
say "  线上：$PAGES_URL"
say "  GitHub Pages 需要 1~2 分钟构建；如果改了静态资源记得升 sw.js 缓存版本号。"
say "  现在在 $DEV_BRANCH 分支，继续开发即可。"
