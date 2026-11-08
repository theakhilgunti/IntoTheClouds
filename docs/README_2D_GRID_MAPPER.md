# 🌐 2D Tactical Grid Mapper (30m x 30m Space)

> **Real-Time 2D Indoor Positioning & Hotspot Trilateration Suite**  
> Tracks your computer's 2D $(X, Y)$ location in a $30\text{m} \times 30\text{m}$ room using 3 Windows 11 laptop Wi-Fi hotspots as anchors.

---

## 🧭 Coordinate Frame & Anchor Layout

The coordinate system is a standard metric 2D Cartesian plane where $(0, 0)$ represents the origin corner:

```
Y-Axis (30m)
   ▲
30 ┼─── [Anchor 3: Y-Axis] ──────────────────────────────────────┐
   │    (0m, 30m)                                                │
   │                                                             │
   │                                                             │
   │                  🎯 Target Receiver (You)                   │
   │                     (X: 14.8m, Y: 12.3m)                    │
   │                                                             │
   │                                                             │
 0 ┼─── [Anchor 1: Origin] ───────────── [Anchor 2: X-Axis] ─────┘
   │    (0m, 0m)                          (30m, 0m)
───┴────┼───────────────────────────────────┼─────────────────────► X-Axis (30m)
        0                                   30
```

| Anchor | Description | Default Position $(X, Y)$ | Default 1m Ref ($A$) | Exponent ($n$) |
| :--- | :--- | :--- | :--- | :--- |
| **Anchor 1** | Laptop Hotspot 1 (Origin) | $(0.0\text{ m}, 0.0\text{ m})$ | $-42.0\text{ dBm}$ | $2.40$ |
| **Anchor 2** | Laptop Hotspot 2 (X-Axis) | $(30.0\text{ m}, 0.0\text{ m})$ | $-42.0\text{ dBm}$ | $2.40$ |
| **Anchor 3** | Laptop Hotspot 3 (Y-Axis) | $(0.0\text{ m}, 30.0\text{ m})$ | $-42.0\text{ dBm}$ | $2.40$ |

---

## ⚡ Fast Update Engine (< 1s Latency)

Traditional Windows `netsh.exe` subprocess calls introduce $300\text{ms} - 800\text{ms}$ process spawning latency and heavy CPU overhead. This suite replaces `netsh` with **direct C/C++ memory bindings to Windows `wlanapi.dll`**:
- **Hardware Scan Trigger**: `wlanapi.WlanScan` sends non-blocking 802.11 beacon probes directly to the Wi-Fi NIC.
- **In-Memory Query**: `wlanapi.WlanGetNetworkBssList` reads the network table directly from driver memory in **$< 10\text{ms}$**.
- **Real-Time Streaming**: Server-Sent Events (SSE) push continuous updates to the browser at **$5\text{ Hz}$ ($200\text{ms}$ refresh)**.
- **60 FPS Rendering**: Smooth linear interpolation (`lerp`) ensures the target crosshair glides without stutter.

---

## 📐 Mathematical Formulation

### 1. Distance Estimation (ITU-R Recommendation P.1238)
Each anchor's distance $\hat{d}_i$ is estimated by inverting the log-distance path loss model:
$$\hat{d}_i = 10^{\left( \frac{A_i - \text{RSSI}_i}{10 \cdot n_i} \right)}$$
- $\text{RSSI}_i$: Received Signal Strength Indicator (filtered with a 7-sample moving median window to reject multipath noise).
- $A_i$: Calibrated reference RSSI at $1.0\text{ m}$ (typically $-38$ to $-46\text{ dBm}$ on Windows 11 laptop hotspots).
- $n_i$: Path loss exponent ($2.0$ for free-space, $2.4 - 2.8$ for indoor office / residential).

### 2. Closed-Form Orthogonal Trilateration
Because Anchors 1, 2, and 3 form an orthogonal coordinate basis:
$$\begin{cases} x^2 + y^2 = d_1^2 \\ (x - L_x)^2 + y^2 = d_2^2 \\ x^2 + (y - L_y)^2 = d_3^2 \end{cases}$$

Expanding and subtracting yields exact closed-form solutions:
$$x = \frac{L_x^2 + d_1^2 - d_2^2}{2 L_x} = 15 + \frac{d_1^2 - d_2^2}{60}$$
$$y = \frac{L_y^2 + d_1^2 - d_3^2}{2 L_y} = 15 + \frac{d_1^2 - d_3^2}{60}$$

### 3. Weighted Non-Linear Optimization (WNLS)
To accommodate shadow fading and multipath noise, the closed-form estimate is refined using `scipy.optimize.least_squares` with a Cauchy robust loss function:
$$\min_{x, y} \sum_{i=1}^3 \rho\left( \frac{\sqrt{(x - x_i)^2 + (y - y_i)^2} - d_i}{\sigma_{d_i}} \right)$$

### 4. 2D Kinematic Kalman Filter
State vector $\mathbf{x} = [x, y, v_x, v_y]^T$ modeled with Continuous White Noise Acceleration:
$$\mathbf{F}(\Delta t) = \begin{bmatrix} 1 & 0 & \Delta t & 0 \\ 0 & 1 & 0 & \Delta t \\ 0 & 0 & 1 & 0 \\ 0 & 0 & 0 & 1 \end{bmatrix}, \quad \mathbf{H} = \begin{bmatrix} 1 & 0 & 0 & 0 \\ 0 & 1 & 0 & 0 \end{bmatrix}$$
Measurement noise covariance $\mathbf{R}$ dynamically scales with the Geometric Dilution of Precision (HDOP).

---

## 🛠️ Step-by-Step Setup Guide

### Step 1: Configure the 3 Laptop Hotspots
On each of the 3 Windows 11 laptops:
1. Open **Settings** $\to$ **Network & internet** $\to$ **Mobile hotspot**.
2. Click **Edit** and set a unique network name:
   - Laptop 1: `HOTSPOT-ORIGIN` (or your choice)
   - Laptop 2: `HOTSPOT-X-AXIS`
   - Laptop 3: `HOTSPOT-Y-AXIS`
3. Toggle Mobile hotspot to **On**.
4. Place Laptop 1 at $(0, 0)\text{m}$, Laptop 2 at $(30, 0)\text{m}$, and Laptop 3 at $(0, 30)\text{m}$.

### Step 2: Launch the 2D Tactical HUD
On your tracking computer, run the launcher:
```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" "c:\Users\caleb\.gemini\antigravity\scratch\IntoTheClouds\wifi_2d_grid_mapper.py"
```
Or double-click [RUN_2D_GRID_MAPPER.bat](file:///c:/Users/caleb/.gemini/antigravity/scratch/IntoTheClouds/RUN_2D_GRID_MAPPER.bat). The HUD opens automatically at `http://127.0.0.1:8899`.

### Step 3: Assign the Hotspots to Anchors
1. In the right sidebar, use the dropdown menus:
   - **Anchor 1 (Origin)**: Select `HOTSPOT-ORIGIN`.
   - **Anchor 2 (X-Axis)**: Select `HOTSPOT-X-AXIS`.
   - **Anchor 3 (Y-Axis)**: Select `HOTSPOT-Y-AXIS`.
2. Or click **Auto-Assign** to automatically map the 3 strongest signals.

### Step 4: Rapid 1-Meter Calibration
1. Walk to **$1.0\text{ meter}$** directly in front of Laptop 1. Click **🎯 Calibrate 1.0m (Set A)** on Anchor 1.
2. Repeat for Laptop 2 and Laptop 3.
3. Your coordinates are now calibrated to the exact transmit power of your specific laptops!

---

## 📊 Features & Controls
- **Interactive Canvas**: Drag to pan, scroll wheel to zoom, or use the **Fit 30m Grid** / **Center Target** buttons.
- **Audio Sonar**: Toggle **🔊 Sound ON** to hear proximity sonar pings whose frequency increases as you approach the origin or anchors.
- **CSV Logging**: Click **📥 Export CSV** anytime to download timestamped $X, Y$, speed, and RSSI logs.
- **Simulation Mode**: Click **🎭 Simulate Walk** to run a virtual walk through the room even without physical hotspots active.

