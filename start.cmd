@echo off
rem Desktop stock ticker launcher (keep this file ASCII-only: cmd decodes it as GBK)
setlocal
cd /d "%~dp0"

rem Must clear ELECTRON_RUN_AS_NODE, otherwise Electron starts as plain Node
set "ELECTRON_RUN_AS_NODE="

set "EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo [ERROR] Electron not found:
  echo         %EXE%
  echo Run "npm install" in %~dp0 first.
  pause
  exit /b 1
)

rem Transparent frameless window: software rendering is more stable and lighter.
rem Set TICKER_GPU=1 before running to force GPU rendering.
rem Extra args are passed through (start-auto.cmd adds --scheduled).
rem Output goes to logs\electron.log: the scheduled task has no console,
rem so a crash would otherwise leave no trace.
if not exist "%~dp0logs" mkdir "%~dp0logs"
if defined TICKER_GPU (
  start "" "%EXE%" "%~dp0." --no-sandbox %* >> "%~dp0logs\electron.log" 2>&1
) else (
  start "" "%EXE%" "%~dp0." --disable-gpu --disable-gpu-compositing --disable-software-rasterizer --no-sandbox %* >> "%~dp0logs\electron.log" 2>&1
)

exit /b 0
