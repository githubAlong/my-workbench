#!/bin/sh
# 我的工作台 —— 一键启动（含公网访问）
# Mac / Linux 用。双击或在终端执行：sh start_public.sh

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "           我的工作台  一键启动（含公网访问）"
echo "============================================================"
echo

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[!] 没找到 Node.js"
  echo "    请先去 https://nodejs.org 下载 LTS 版本安装，装完重新运行本脚本。"
  exit 1
fi
echo "[1/4] Node.js 已就绪：$(node -v)"

# ---------- 2. 准备配置 ----------
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[2/4] 已生成配置文件 .env"
else
  echo "[2/4] 配置文件已存在，直接沿用"
fi

# ---------- 3. 找 cloudflared ----------
CF=""
if [ -x "./cloudflared" ]; then
  CF="./cloudflared"
elif command -v cloudflared >/dev/null 2>&1; then
  CF="cloudflared"
fi

if [ -z "$CF" ]; then
  echo "[3/4] 本机没有 cloudflared，正在自动下载…"
  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS" in
    Darwin)
      [ "$ARCH" = "arm64" ] && URL="cloudflared-darwin-arm64.tgz" || URL="cloudflared-darwin-amd64.tgz"
      curl -fL --max-time 300 -o cf.tar.gz "https://github.com/cloudflare/cloudflared/releases/latest/download/$URL" \
        && tar -xzf cf.tar.gz && rm -f cf.tar.gz && CF="./cloudflared"
      ;;
    Linux)
      [ "$ARCH" = "aarch64" ] && BIN="cloudflared-linux-arm64" || BIN="cloudflared-linux-amd64"
      curl -fL --max-time 300 -o cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN" \
        && chmod +x cloudflared && CF="./cloudflared"
      ;;
    *)
      echo "[!] 没识别出你的系统：$OS"
      exit 1
      ;;
  esac
  if [ -z "$CF" ] || [ ! -x "$CF" ]; then
    echo "[!] 自动下载失败，请手动下载 cloudflared 放到本目录："
    echo "    https://github.com/cloudflare/cloudflared/releases/latest"
    exit 1
  fi
fi
echo "[3/4] cloudflared 已就绪"

# ---------- 4. 启动 ----------
echo "[4/4] 正在启动服务并打通公网隧道…"
echo
echo "------------------------------------------------------------"
echo "  日志里会出现两样东西："
echo "    1. 本机地址  http://localhost:3000"
echo "    2. 公网地址  https://xxxx-xxxx.trycloudflare.com"
echo "  把第 2 个复制下来，手机/iPad 在任何网络下都能打开。"
echo "------------------------------------------------------------"
echo

node server/index.mjs > /tmp/wb-server.log 2>&1 &
SERVER_PID=$!
echo "服务已启动（PID $SERVER_PID），日志：/tmp/wb-server.log"

# 退出时顺手收掉服务
cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

sleep 4

"$CF" tunnel --url http://localhost:3000 --no-autoupdate
