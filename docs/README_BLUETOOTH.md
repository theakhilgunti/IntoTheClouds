# IntoTheClouds: Multi-Signal Bluetooth Distance Radar & Indoor Telemetry

A real-time Bluetooth Low Energy (BLE) distance estimation and tactical radar dashboard for Windows. Tracks up to 3 selected signals simultaneously, featuring mathematical telemetry based on **ITU-R Recommendation P.1238-11**, an **Adaptive Kinematic Kalman Filter**, and an **Interactive 2-Point Calibration Wizard** tailored for Apple devices, beacons, and BLE peripherals.

---

## Quick Start

### 1. One-Click Launch (Windows)
Double-click `RUN_BLUETOOTH_RADAR.bat` in the root folder, or run:
```powershell
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" bluetooth_distance_radar.py
```
* The background scanner will immediately begin listening for all nearby BLE advertisement frames.
* The local dashboard server will start at `http://127.0.0.1:8888` and automatically open your default browser.

### 2. Terminal CLI Mode
To monitor signals directly in the command prompt or PowerShell without opening a web browser:
```powershell
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" bluetooth_distance_radar.py --cli
```

---

## Mathematical Telemetry Standards & Sites

### 1. ITU-R Recommendation P.1238-11
* **Title:** *"Propagation data and prediction methods for the planning of indoor radiocommunication systems and radio local area networks in the frequency range 300 MHz to 450 GHz"*
* **Official Portal:** [https://www.itu.int/rec/R-REC-P.1238/en](https://www.itu.int/rec/R-REC-P.1238/en)
* **Indoor Site-General Path Loss Model:**
  $$L_{\text{total}} = 20 \log_{10}(f) + N \log_{10}(d) + P_f(n_{\text{floor}}) - 28$$
  For BLE ($f = 2440\text{ MHz}$), this yields:
  $$d = 10^{\left(\frac{A - \text{RSSI}}{10 \cdot n}\right)}$$
  Where $N$ is the Distance Power Loss Coefficient and $n = N / 10$ is the path loss exponent:
  * **Office Building (cubicles, drywall, humans):** $N = 30 \implies n = 3.0$
  * **Residential / Home (open rooms, wooden studs):** $N = 28 \implies n = 2.8$
  * **Commercial / Large Open Hall:** $N = 22 \implies n = 2.2$
  * **Industrial / Dense Concrete:** $N = 38 \implies n = 3.8$
  * **Free Space Line-of-Sight:** $n = 2.0$

### 2. MDPI Sensors & NIST Indoor Telemetry Research
* **Title:** *"Indoor Positioning and Distance Estimation using BLE RSSI, Path Loss Modeling, and Kalman Filtering"*
* **Official Journal:** [https://www.mdpi.com/journal/sensors](https://www.mdpi.com/journal/sensors)
* **Log-Normal Shadow Fading ($X_\sigma \sim \mathcal{N}(0, \sigma^2)$):**
  Because indoor RF channel error is Gaussian in decibels ($\sigma_{\text{RSSI}}$), distance error follows a **Log-Normal distribution**. The 95% Confidence Interval is:
  $$\sigma_{\ln d} = \frac{\sigma_{\text{RSSI}} \cdot \ln(10)}{10 \cdot n}$$
  $$\text{CI}_{95\%} = \left[ d_{\text{filtered}} \cdot e^{-1.96 \cdot \sigma_{\ln d}},\; d_{\text{filtered}} \cdot e^{+1.96 \cdot \sigma_{\ln d}} \right]$$

---

## Adaptive 2D Kinematic Kalman Filter

Raw Bluetooth RSSI suffers from severe multipath interference and human body shadowing. The software filters raw distance measurements using a state-space formulation:

* **State Vector:**
  $$\mathbf{x}_k = \begin{bmatrix} d_k \\ v_k \end{bmatrix} \quad (\text{continuous distance in meters, radial velocity in m/s})$$
* **Kinematic Prediction:**
  $$\mathbf{x}_{k|k-1} = \begin{bmatrix} 1 & \Delta t \\ 0 & 1 \end{bmatrix} \mathbf{x}_{k-1}, \quad \mathbf{Q} = q \begin{bmatrix} \frac{\Delta t^3}{3} & \frac{\Delta t^2}{2} \\ \frac{\Delta t^2}{2} & \Delta t \end{bmatrix}$$
* **Measurement Covariance Propagation (Delta Method):**
  $$R = \left(\frac{\partial d}{\partial \text{RSSI}}\right)^2 \sigma_{\text{RSSI}}^2 = \left(\frac{d \cdot \ln 10}{10 \cdot n}\right)^2 \sigma_{\text{RSSI}}^2$$
  This allows the filter to dynamically reject noise spikes and calculate real-time movement velocity (`Approaching`, `Receding`, or `Stationary`).

---

## Precision Calibration Guide

Every phone and BLE device has unique antenna geometry and transmit power. An iPhone typically broadcasts at **$-42\text{ dBm}$ to $-46\text{ dBm}$** at 1 meter, whereas generic BLE tags broadcast at **$-59\text{ dBm}$**.

### Step-by-Step 2-Point Calibration:
1. **Identify Your Device:**
   * Click **`🍎 Apple Devices Only`** in the dashboard search bar.
   * Pick the device with the strongest signal (typically $-42$ to $-48$ dBm when nearby).
   * Click **`+ Track`**.
2. **Point 1 (1.0 meter):**
   * Place your device exactly **1.0 meter** (or 3.3 ft) from your computer.
   * In the purple calibration bar, verify the distance input is set to `1.0`.
   * Click **`Record Point & Calibrate`**. The system computes your phone's true 1m reference $A$ (e.g. $A = -47.2\text{ dBm}$).
3. **Point 2 (2.5 meters):**
   * Move your device to **2.5 meters** (or 3.0 meters).
   * Set the distance input to `2.5`.
   * Click **`Record Point & Calibrate`** again.
   * The system runs linear regression across both points:
     $$n = \frac{\text{RSSI}_1 - \text{RSSI}_2}{10 \cdot \log_{10}(d_2 / d_1)}$$
   * Both $A$ and room exponent $n$ are now calibrated to your room layout.

---

## Dashboard Features

* **360° Tactical Radar:** Concentric distance rings (1m, 2m, 5m, 10m, 20m) with live animated blips and sweeps.
* **Multi-Signal Tracking:** Track up to 3 chosen signals with independent color channels (Cyan, Emerald, Amber).
* **Audio Sonar Ping:** Native Web Audio synthesizer with frequency and ping interval modulated by the nearest target's distance.
* **Apple Continuity Decoder:** Automatically identifies iPhones, iPads, AirPods, AirTags, and AirPlay devices.
* **Telemetry CSV Export:** Instant download of all recorded timestamps, raw RSSI, filtered distance, velocity, and confidence intervals.
