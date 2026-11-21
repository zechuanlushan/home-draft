@echo off
setlocal
title home-draft launcher
set "ROOT=%~dp0"
set "LOG=%ROOT%start.log"
echo ============================================
echo  home-draft launcher
echo ============================================
echo.
echo [1/4] Checking python...
where python >nul 2>nul
if errorlevel 1 goto NOPY
python --version >> "%LOG%" 2>&1
if errorlevel 1 goto BADPY
echo       OK
echo.
echo [2/4] Checking files...
if not exist "%ROOT%mcp_server\server.py" goto NOSERVER
if not exist "%ROOT%frontend\index.html" goto NOFRONT
echo       OK
echo.
echo [3/4] Starting MCP hub on 127.0.0.1:8766 ...
start "home-draft MCP" /D "%ROOT%" cmd /k python mcp_server\server.py
timeout /t 3 /nobreak >nul
echo [4/4] Opening frontend...
start "" "%ROOT%frontend\index.html"
echo.
echo Done. Keep the MCP window open.
echo.
pause
exit /b 0
:NOPY
echo [ERROR] python not found in PATH.
echo         Install Python 3.9+ from python.org, tick "Add to PATH".
pause
exit /b 1
:BADPY
echo [ERROR] python exists but fails to run. Check installation.
pause
exit /b 1
:NOSERVER
echo [ERROR] missing mcp_server\server.py
pause
exit /b 1
:NOFRONT
echo [ERROR] missing frontend\index.html
pause
exit /b 1