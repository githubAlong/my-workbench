@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 我的工作台 - 公网访问
cd /d "%~dp0"

echo ============================================================
echo            我的工作台  一键启动（含公网访问）
echo ============================================================
echo.

REM ==================== 1. 检查 Node ====================
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 Node.js
  echo.
  echo     请先去 https://nodejs.org 下载 LTS 版本，
  echo     双击安装包，一路点「下一步」即可。
  echo     装完后关掉本窗口，重新双击本脚本。
  echo.
  echo     现在为你打开下载页面...
  timeout /t 2 >nul
  start "" https://nodejs.org/zh-cn
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%i in ('node -v') do set NODEVER=%%i
echo [1/5] Node.js 已就绪：!NODEVER!

REM ==================== 2. 准备配置 ====================
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [2/5] 已生成配置文件 .env
  )
) else (
  echo [2/5] 配置文件已就绪
)

REM ==================== 3. 准备 cloudflared ====================
set "CF=%~dp0cloudflared.exe"

if exist "%CF%" (
  for %%A in ("%CF%") do if %%~zA GTR 20000000 (
    echo [3/5] cloudflared 已存在，跳过下载
    goto :cf_ready
  )
  echo [3/5] 发现不完整的 cloudflared，重新下载
  del /q "%CF%" >nul 2>nul
)

where cloudflared >nul 2>nul
if not errorlevel 1 (
  set "CF=cloudflared"
  echo [3/5] 系统里已装 cloudflared，直接使用
  goto :cf_ready
)

echo [3/5] 正在下载 cloudflared（约 40MB，只需一次）...
echo.

REM 三个源依次尝试，谁成功用谁
set "SRC1=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "SRC2=https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "SRC3=https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

call :try_download "%SRC1%"
call :check_cf
if defined DLOK goto :cf_ready

call :try_download "%SRC2%"
call :check_cf
if defined DLOK goto :cf_ready

call :try_download "%SRC3%"
call :check_cf
if defined DLOK goto :cf_ready

echo.
echo [!] 自动下载失败（可能是网络限制）
echo.
echo     请手动下载这个文件：
echo     %SRC2%
echo.
echo     下载完成后改名为 cloudflared.exe，放到本文件夹里，
echo     再重新双击本脚本即可。
echo.
echo     现在就为你打开下载链接...
start "" "%SRC2%"
echo.
echo     下载好的文件通常在「下载」文件夹里。
echo     把它拖到本文件夹（和本脚本放在一起）。
echo.
pause
exit /b 1

:cf_ready
if /i not "%CF%"=="cloudflared" (
  for %%A in ("%CF%") do echo    文件大小 %%~zA 字节
)

REM ==================== 4. 启动本地服务 ====================
echo [4/5] 正在启动工作台服务...
start "工作台-服务(不要关)" minimized cmd /c "node server/index.mjs"

set "UP="
for /l %%i in (1,1,15) do (
  if not defined UP (
    powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0} }catch{}; exit 1" >nul 2>nul
    if not errorlevel 1 (
      set "UP=1"
    ) else (
      timeout /t 1 >nul
    )
  )
)
if not defined UP (
  echo    [!] 服务没起来
  echo        请看看那个最小化的「工作台-服务」窗口里报了什么错
  echo.
  pause
  exit /b 1
)
echo    服务已启动：http://localhost:3000

REM ==================== 5. 打通公网 ====================
echo [5/5] 正在打通公网隧道...
echo.
echo ============================================================
echo   稍等一下，下面会出现一行地址，长这样：
echo.
echo        https://xxxx-xxxx-xxxx.trycloudflare.com
echo.
echo   这就是你的公网地址。手机 / iPad 用流量也能打开，
echo   不需要连同一个 WiFi。
echo.
echo   【重要】本窗口不能关，关了链接就断开。
echo ============================================================
echo.

if /i "%CF%"=="cloudflared" (
  cloudflared tunnel --url http://localhost:3000 --no-autoupdate
) else (
  "%CF%" tunnel --url http://localhost:3000 --no-autoupdate
)

echo.
echo 隧道已断开。
echo 免费隧道每次启动网址都会变，这是正常的。
echo.
pause
exit /b 0

REM ==================== 子程序 ====================
:try_download
echo    尝试下载：%~1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%~1' -OutFile '%CF%' -UseBasicParsing -TimeoutSec 600; Write-Host '      成功' -ForegroundColor Green } catch { Write-Host ('      失败：' + $_.Exception.Message) -ForegroundColor Yellow }"
goto :eof

:check_cf
set "DLOK="
if exist "%CF%" (
  for %%A in ("%CF%") do if %%~zA GTR 20000000 set "DLOK=1"
)
if not defined DLOK (
  if exist "%CF%" del /q "%CF%" >nul 2>nul
)
goto :eof
