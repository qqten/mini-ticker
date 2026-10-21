@echo off
rem Debug launcher: keeps the console window open so any startup error is visible.
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo [ERROR] Electron not found: %EXE%
  pause
  exit /b 1
)

echo Starting ticker with software rendering...
"%EXE%" "%~dp0." --disable-gpu --disable-gpu-compositing --disable-software-rasterizer --no-sandbox
echo.
echo [process exited with code %ERRORLEVEL%]
pause
