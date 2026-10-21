@echo off
rem Entry point for the Windows scheduled task (opening bell auto-start).
rem Keep this file ASCII-only. The --scheduled flag tells the app it was
rem launched by the task, so it can skip non-trading days by itself.
setlocal
call "%~dp0start.cmd" --scheduled
exit /b 0
