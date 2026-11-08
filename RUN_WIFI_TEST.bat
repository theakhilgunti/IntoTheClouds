@echo off
title IntoTheClouds - Wi-Fi RSSI Distance Test
color 0b
echo =================================================================
echo   INTO THE CLOUDS - ONE-CLICK WI-FI RSSI DISTANCE TESTER
echo =================================================================
echo.
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%~dp0pi_client\test_single_anchor.py"
pause

