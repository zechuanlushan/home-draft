@echo off
chcp 65001 >nul
title home-draft launcher

echo ============================================================
 echo  home-draft 一键启动
 echo ============================================================

echo [1/3] 检查 Python ...
where python >nul 2>nul
if errorlevel 1 (
    echo [!] 没找到 python，请先安装 Python 3.9+ 并勾选 Add to PATH
    pause
    exit /b 1
)
python --version

echo [2/3] 启动本地 MCP server (127.0.0.1:8766) ...
start "home-draft MCP" cmd /k python "%~dp0mcp_server\server.py"

timeout /t 2 /nobreak >nul

echo [3/3] 打开前端 ...
start "" "%~dp0frontend\index.html"

echo.
echo 完成。MCP 窗口别关，关掉前端就用不了文件工具了。
timeout /t 3 >nul
exit /b 0
