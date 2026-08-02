@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"
start "Alpha Wallet Radar" /min "%PYTHON%" "%~dp0app.py" --host 127.0.0.1 --port 8810
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8810/"
endlocal

