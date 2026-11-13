$state = "F:\sql\workbench-runtime"
Get-ChildItem -LiteralPath $state -Filter "*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
  $processId = [int](Get-Content $_.FullName -Raw).Trim()
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $processId /T /F | Out-Null }
  Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
}
Write-Host "Workbench background services stopped."
