# IntoTheClouds: Unified Bluetooth & Wi-Fi Distance Radar & Calibration Suite

A tactical dual-radio distance estimation, live radar, and precision calibration application for Windows. Discovers and tracks both **Bluetooth Low Energy (BLE)** devices and **Wi-Fi Access Points / BSSIDs** simultaneously, utilizing the **ITU-R Recommendation P.1238-11** indoor radio propagation standard, **Adaptive Kinematic Kalman Filtering**, and **Independent Multi-Point Calibration** for both radio types.

---

## Quick Launch

### 1. One-Click Launch (Windows)
Double-click `RUN_UNIFIED_RADAR.bat` in the root folder, or run:
```powershell
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" unified_rf_distance_radar.py
```
* Starts the Bluetooth LE background scanner.
* Starts the Windows Native Wi-Fi WLAN active hardware scanner.
* Serves the Tactical Radar Dashboard at `http://127.0.0.1:8888` and opens your default browser.

### 2. Terminal CLI Mode
To monitor dual-radio telemetry directly in PowerShell or cmd:
```powershell
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" unified_rf_distance_radar.py --cli
```

---

## Radio Characteristics: Bluetooth vs. Wi-Fi

| Parameter | Bluetooth Low Energy (BLE) | Wi-Fi (WLAN 2.4 / 5 GHz) |
| :--- | :--- | :--- |
| **Typical Transmit Power** | Low ($0\text{ to } +10\text{ dBm}$) | High ($+17\text{ to } +23\text{ dBm}$) |
| **Default 1m Reference ($A$)** | $-45\text{ to } -60\text{ dBm}$ | $-35\text{ to } -45\text{ dBm}$ |
| **Default Path Loss Exponent ($n$)** | $2.8 - 3.2$ (High human shadowing) | $2.4 - 2.8$ (Broader penetration) |
| **Hardware Source** | Windows WinRT BLE Controller | Native WLAN AutoConfig Service (`wlansvc`) |
| **Device Identification** | MAC Address + Apple Continuity Decoder | BSSID + SSID Network Name + Channel / Band |

---

## Precision Calibration Guide (Bluetooth & Wi-Fi)

Every phone, beacon, and Wi-Fi router has unique antenna transmission levels. Calibrating them ensures accurate distance measurements across your room.

### How to Calibrate:
1. **Select Your Target:**
   * In the dashboard, click **`+ Track`** on any signal (up to 3 signals).
   * You can mix and match (e.g. Target 1: `🍎 Apple iPhone`, Target 2: `🌐 Home Wi-Fi Router`).
2. **Step 1: Calibrate 1-Meter Reference ($A$):**
   * Place your device (or stand with your computer relative to your router) at **1.0 meter** (or 3.3 ft).
   * In the calibration bar at the top, select the target in the dropdown, verify distance is `1.0`, and click **`Record & Calibrate`** (or click **`🎯 Calib 1m`** directly on that target's card).
   * The system computes the true 1-meter reference power $A$ for that specific radio.
3. **Step 2: Multi-Point Exponent Fit ($n$):**
   * Move your device (or step back) to **2.5 or 3.0 meters**.
   * Change the distance input box to `2.5` or `3.0`.
   * Click **`Record & Calibrate`** again.
   * The math engine runs linear regression across both points:
     $$n = \frac{\text{RSSI}_1 - \text{RSSI}_2}{10 \cdot \log_{10}(d_2 / d_1)}$$
   * Both $A$ and room exponent $n$ are now fitted specifically to that device.

---

## Features

* **Choose up to 3 Signals:** Any mix of Bluetooth devices and Wi-Fi networks.
* **360° Tactical Radar:** Live sweeping radar HUD with concentric distance rings (1m, 2m, 5m, 10m, 20m) and color-coded target markers.
* **Radio Filter Tabs:** Toggle between `All Signals`, `📶 Bluetooth Only`, `🌐 Wi-Fi Only`, and `🍎 Apple Devices`.
* **Adaptive Kalman State Filter:** Real-time radial velocity tracking (`Approaching`, `Receding`, `Stationary`).
* **95% Confidence Intervals:** Log-normal error bounds based on real-time sample variance.
* **Audio Sonar Ping:** Web Audio synthesizer with frequency and ping speed modulated by distance.
* **CSV Telemetry Export:** Download full telemetry logs for analysis in Excel or Python.
