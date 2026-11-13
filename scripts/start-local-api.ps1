param([ValidateSet('master','test')][string]$Environment = 'test')
$projectRoot = Split-Path -Parent $PSScriptRoot
$passwordFile = 'F:\sql\postgres-admin-password.txt'
if (!(Test-Path -LiteralPath $passwordFile)) { throw "找不到 PostgreSQL 密码文件：$passwordFile" }
$env:PGPASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
$env:WB_ENV = $Environment
$env:PGDATABASE = if ($Environment -eq 'master') { 'workbench_master' } else { 'workbench_test' }
$env:PORT = if ($Environment -eq 'master') { '8787' } else { '8788' }
Write-Host "启动 $Environment 本地 API，数据库=$env:PGDATABASE，端口=$env:PORT"
& node (Join-Path $projectRoot 'server\local-api.mjs')
