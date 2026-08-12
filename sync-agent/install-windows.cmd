@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
set "INSTALL_STATUS=%ERRORLEVEL%"

echo.
pause
exit /b %INSTALL_STATUS%
