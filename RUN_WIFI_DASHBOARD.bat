@echo off
title IntoTheClouds - Tactical Wi-Fi Radar UI
color 0b
echo =================================================================
echo   INTO THE CLOUDS - ONE-CLICK TACTICAL RADAR DASHBOARD
echo =================================================================
echo.
echo Starting dashboard server and opening your browser...
echo.
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%~dp0pi_client\rssi_dashboard_server.py"
pause

