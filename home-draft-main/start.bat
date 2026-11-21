@echo off
setlocal
title home-draft launcher

rem ============================================================
rem  ASCII-only on purpose.
rem  Chinese in .bat + chcp 65001 makes cmd misparse lines on
rem  some Windows builds. Do not add non-ASCII text here.
rem ============================================================

set "ROOT=%~dp0"

cls
echo ============================================
echo   home-draft launcher
echo ============================================
echo.

echo [1/4] Checking Python ...
where python >nul 2>nul
if errorlevel 1 goto NOPY
echo         found:
where python
echo.

echo [2/4] Checking files ...
if not exist "%ROOT%mcp_server\server.py" goto NOSERVER
if not exist "%ROOT%frontend\index.html" goto NOFRONT
echo         OK
echo.

echo [3/4] Starting MCP server on 127.0.0.1:8766 ...
rem /D sets working dir, avoids messy cd quoting
start "home-draft MCP" /D "%ROOT%" cmd /k python mcp_server\server.py

timeout /t 3 /nobreak >nul

echo.
echo [4/4] Opening frontend ...
start "" "%ROOT%frontend\index.html"

echo.
echo ============================================
echo   Done.
echo.
echo   Keep the "home-draft MCP" window open.
echo   Close it and file tools stop working.
echo.
echo   If the frontend shows "MCP not connected",
echo   that window was closed - just rerun this file.
echo ============================================
echo.
pause
exit /b 0

:NOPY
echo.
echo [ERROR] python not found in PATH.
echo         Install Python 3.9+ from python.org
echo         and tick "Add Python to PATH".
echo.
pause
exit /b 1

:NOSERVER
echo.
echo [ERROR] mcp_server\server.py not found.
echo         Current folder: %ROOT%
echo         The archive was probably not fully extracted.
echo.
pause
exit /b 1

:NOFRONT
echo.
echo [ERROR] frontend\index.html not found.
echo         Current folder: %ROOT%
echo         The archive was probably not fully extracted.
echo.
pause
exit /b 1
