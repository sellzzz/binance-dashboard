@echo off
setlocal
cd /d "%~dp0"
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1"
