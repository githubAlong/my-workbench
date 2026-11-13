$ErrorActionPreference = "Continue"
$project = Get-ChildItem -LiteralPath "C:\Users\51679\Documents\ChatGPT" -Directory |
  ForEach-Object {
    $candidate = Join-Path $_.FullName "mywork-master"
    if (Test-Path (Join-Path $candidate "scripts\start-local-api.ps1")) { $candidate }
  } | Select-Object -First 1
$root = "F:\sql"
$state = Join-Path $root "workbench-runtime"
New-Item -ItemType Directory -Force -Path $state | Out-Null

function Start-Managed($key, $file, [string[]]$argList) {
  $pidFile = Join-Path $state "$key.pid"
  $stdout = Join-Path $state "$key.out.log"
  $stderr = Join-Path $state "$key.err.log"
  $existing = $null
  if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw) { $existing = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue }
  }
  if ($existing) { return $existing }
  $p = Start-Process -FilePath $file -ArgumentList $argList -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Set-Content -LiteralPath $pidFile -Value $p.Id -Encoding ascii
  return $p
}

Write-Output "Workbench background supervisor started $(Get-Date -Format o)"
while ($true) {
  Start-Managed "api-test" "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $project "scripts\start-local-api.ps1"), "-Environment", "test") | Out-Null
  Start-Managed "api-master" "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $project "scripts\start-local-api.ps1"), "-Environment", "master") | Out-Null
  Start-Managed "tunnel-test" (Join-Path $root "cloudflared.exe") @("tunnel", "--url", "http://127.0.0.1:8788", "--no-autoupdate") | Out-Null
  Start-Managed "tunnel-master" (Join-Path $root "cloudflared.exe") @("tunnel", "--url", "http://127.0.0.1:8787", "--no-autoupdate") | Out-Null
  # Quick Tunnel 重启会换域名：把新地址同步到线上配置并触发重新发布
  try { & (Join-Path $project "scripts\publish-tunnel-url.ps1") | Out-Null } catch { }
  Start-Sleep -Seconds 10
}
