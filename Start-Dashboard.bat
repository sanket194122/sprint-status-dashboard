@echo off
title Sprint Status Dashboard
cd /d "%~dp0scripts"

echo.
echo   Sprint Status Dashboard
echo   =======================
echo.

:: Check if tokens are set (set them via environment variables)
if defined GITHUB_TOKEN (echo   AI Risk Analysis: Enabled) else (echo   AI Risk Analysis: Disabled - set GITHUB_TOKEN env var)
if defined TEAMS_WEBHOOK_URL (echo   Teams Alerts: Enabled) else (echo   Teams Alerts: Disabled - set TEAMS_WEBHOOK_URL env var)
echo.

timeout /t 2 /nobreak >nul
start http://localhost:8501
node server.js
pause
