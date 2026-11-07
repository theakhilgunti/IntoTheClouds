@echo off
title IntoTheClouds - Bluetooth Signal Distance Radar HUD
color 0b
echo =================================================================
echo   INTO THE CLOUDS - MULTI-SIGNAL BLUETOOTH DISTANCE RADAR
echo =================================================================
echo.
echo Launching ITU-R P.1238 Telemetry & Adaptive Kalman Engine...
echo Opening Tactical Radar Dashboard in your default browser...
echo.
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%~dp0bluetooth_distance_radar.py"
if errorlevel 1 (
    echo.
    echo Python finished with an error. Attempting with system python...
    python "%~dp0bluetooth_distance_radar.py"
)
pause
