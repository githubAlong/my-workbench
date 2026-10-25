@echo off
chcp 65001 >nul
title 我的工作台
cd /d "%~dp0"

echo ============================================
echo            我的工作台  正在启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 Node.js
  echo     请先安装：https://nodejs.org  选 LTS 版本，一路下一步
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%i in ('node -v') do set NODEVER=%%i
echo Node.js 版本：%NODEVER%
echo.

if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [i] 已根据 .env.example 生成 .env
  )
)

echo 本机打开：   http://localhost:3000
echo.
echo 手机/iPad 打开（需连同一个 WiFi）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo    http://%%b:3000
)
echo.
echo 关掉这个窗口 = 停止服务
echo ============================================
echo.

node server/index.mjs
if errorlevel 1 (
  echo.
  echo [!] 启动失败，把上面的红色文字截图发给开发者
  pause
)
