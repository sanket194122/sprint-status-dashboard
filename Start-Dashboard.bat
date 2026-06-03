@echo off
title Sprint Status Dashboard
cd /d "%~dp0scripts"

echo.
echo   Sprint Status Dashboard
echo   =======================
echo.

:: Check if GITHUB_TOKEN is set for AI features
if defined GITHUB_TOKEN (
    echo   AI Risk Analysis: Enabled
) else (
    echo   AI Risk Analysis: Disabled (set GITHUB_TOKEN env var to enable)
)
echo.

timeout /t 2 /nobreak >nul
start http://localhost:8501
node server.js
pause
