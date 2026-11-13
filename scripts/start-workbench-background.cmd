@echo off
start "工作台后台服务" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0workbench-supervisor.ps1"
