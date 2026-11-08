@echo off
title IntoTheClouds - Unified Bluetooth & Wi-Fi Distance Radar
color 0b
echo =================================================================
echo   INTO THE CLOUDS - UNIFIED DUAL-RADIO DISTANCE RADAR
echo   (Bluetooth Low Energy + Wi-Fi BSSID Tracking & Calibration)
echo =================================================================
echo.
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%~dp0unified_rf_distance_radar.py"
pause

