#!/usr/bin/env python3
"""
=============================================================================
  IntoTheClouds: Multi-Signal Bluetooth Distance Radar & Telemetry Dashboard
=============================================================================
A complete, standalone Python application that uses Bluetooth Low Energy (BLE)
to discover all nearby Bluetooth devices, lets you track up to 3 selected
signals simultaneously, and uses high-level mathematical libraries (NumPy, SciPy)
with the ITU-R P.1238 Indoor Path Loss and Log-Normal Shadowing models, combined
with an Adaptive Kinematic Kalman Filter, to estimate distances with 95%
confidence intervals.

Mathematical Telemetry Sites & Standards:
- ITU-R Recommendation P.1238-11:
  "Propagation data and prediction methods for the planning of indoor
   radiocommunication systems and radio local area networks (300 MHz to 450 GHz)"
   URL: https://www.itu.int/rec/R-REC-P.1238/en
- MDPI Sensors Journal / NIST Telemetry Research:
  "Indoor Positioning and Distance Estimation using BLE RSSI & Kalman Filtering"
   URL: https://www.mdpi.com/journal/sensors

Usage:
  python bluetooth_distance_radar.py [--port 8888] [--env office|residential|commercial|industrial|freespace]
=============================================================================
"""

import sys
import os
import time
import math
import json
import asyncio
import threading
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from collections import deque

# High-level mathematical libraries
import numpy as np
import scipy.stats as stats
from scipy.signal import medfilt

# Bluetooth LE Library
try:
    import bleak
    from bleak import BleakScanner
except ImportError:
    print("[ERROR] 'bleak' library is not installed.")
    print("Please run: pip install bleak numpy scipy")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Telemetry References & Model Profiles
# ---------------------------------------------------------------------------
TELEMETRY_REFERENCES = {
    "itu_r_p1238": {
        "name": "ITU-R Recommendation P.1238-11",
        "title": "Propagation data and prediction methods for the planning of indoor radiocommunication systems and radio local area networks in the frequency range 300 MHz to 450 GHz",
        "url": "https://www.itu.int/rec/R-REC-P.1238/en",
        "description": "The global standard for indoor radio wave propagation modeling defined by the International Telecommunication Union (ITU)."
    },
    "mdpi_sensors": {
        "name": "MDPI Sensors / Telemetry Systems",
        "title": "Indoor Positioning Systems using BLE RSSI, Path Loss Exponent Modeling, and Kalman Filtering",
        "url": "https://www.mdpi.com/journal/sensors",
        "description": "Peer-reviewed research and empirical telemetry data on indoor BLE ranging, shadow fading distributions, and filter convergence."
    }
}

# Empirical ITU-R P.1238 Power Loss Coefficients (N) and Path Loss Exponents (n = N/10) for 2.4 GHz
ENVIRONMENT_PRESETS = {
    "office": {
        "name": "ITU-R P.1238: Office Building",
        "n": 3.0,          # Power loss coefficient N = 30
        "ref_rssi_1m": -59.0, # Typical BLE 1m calibrated RSSI (dBm)
        "description": "Standard office with cubicles, drywall partitions, furniture, and human movement."
    },
    "residential": {
        "name": "ITU-R P.1238: Residential / Home",
        "n": 2.8,          # Power loss coefficient N = 28
        "ref_rssi_1m": -59.0,
        "description": "Home interior with open hallways, wooden studs, drywall, and household furniture."
    },
    "commercial": {
        "name": "ITU-R P.1238: Commercial / Large Open",
        "n": 2.2,          # Power loss coefficient N = 22
        "ref_rssi_1m": -57.0,
        "description": "Large retail store, airport terminal, or wide corridor with minimal structural obstruction."
    },
    "industrial": {
        "name": "Industrial / Dense Partition",
        "n": 3.8,          # Power loss coefficient N = 38
        "ref_rssi_1m": -62.0,
        "description": "Factory floor or warehouse with concrete walls, metal racking, machinery, and heavy shadowing."
    },
    "freespace": {
        "name": "Free Space (Direct Line-of-Sight)",
        "n": 2.0,          # Theoretical free-space inverse-square law
        "ref_rssi_1m": -55.0,
        "description": "Unobstructed line-of-sight path outdoors or inside an RF anechoic chamber."
    }
}

# ---------------------------------------------------------------------------
# High-Level Mathematical Estimator (Adaptive Kalman + ITU-R P.1238)
# ---------------------------------------------------------------------------
class SignalDistanceFilter:
    """
    High-level mathematical distance filter combining:
    1. ITU-R P.1238 Path Loss Inversion
    2. 2D Kinematic Kalman Filter (State: [distance, radial_velocity])
    3. Dynamic Measurement Variance based on RSSI sample variance
    4. Log-Normal Shadowing 95% Confidence Interval bounds (using scipy.stats)
    """
    def __init__(self, n_factor: float = 3.0, ref_rssi_1m: float = -59.0):
        self.n = n_factor
        self.A = ref_rssi_1m

        # Kalman State Vector: [distance (meters), velocity (m/s)]
        self.x = np.array([2.0, 0.0], dtype=np.float64)
        # Covariance Matrix P
        self.P = np.diag([4.0, 1.0]).astype(np.float64)

        self.last_timestamp = None
        self.rssi_window = deque(maxlen=24)
        self.distance_history = deque(maxlen=60)
        self.initialized = False

    def update_config(self, n_factor: float, ref_rssi_1m: float):
        self.n = float(n_factor)
        self.A = float(ref_rssi_1m)

    def process_raw_rssi(self, raw_rssi: float, timestamp: float, tx_power_adv=None):
        self.rssi_window.append(raw_rssi)

        # Dynamic calibrated reference power A
        ref_A = self.A
        if tx_power_adv is not None:
            # If the device advertises its Tx Power, calibrate 1-meter RSSI:
            # RSSI_1m ≈ TxPower - 41 dB (empirical free-space path loss at 1m @ 2.44GHz)
            ref_A = float(tx_power_adv) - 41.0

        # Mathematical Raw Distance (Log-Distance Path Loss Inversion)
        # Formula: RSSI = A - 10 * n * log10(d)  =>  d = 10 ^ ((A - RSSI) / (10 * n))
        exponent = (ref_A - raw_rssi) / (10.0 * self.n)
        raw_distance = math.pow(10.0, exponent)
        raw_distance = max(0.15, min(raw_distance, 80.0))

        if not self.initialized:
            self.x = np.array([raw_distance, 0.0], dtype=np.float64)
            self.last_timestamp = timestamp
            self.initialized = True
            ci_low = max(0.1, raw_distance * 0.75)
            ci_high = raw_distance * 1.35
            self.distance_history.append((timestamp, raw_distance))
            return {
                "distance_m": round(raw_distance, 2),
                "distance_ft": round(raw_distance * 3.28084, 2),
                "velocity_mps": 0.0,
                "ci_low_m": round(ci_low, 2),
                "ci_high_m": round(ci_high, 2),
                "raw_distance_m": round(raw_distance, 2),
                "rssi_filtered": raw_rssi,
                "signal_quality": self._compute_quality(raw_rssi)
            }

        # Calculate delta time
        dt = max(0.05, min(timestamp - self.last_timestamp, 3.0))
        self.last_timestamp = timestamp

        # --- 1. Kalman Prediction Step ---
        # State transition: x(k) = x(k-1) + v * dt, v(k) = v(k-1)
        F = np.array([[1.0, dt],
                      [0.0, 1.0]], dtype=np.float64)
        
        # Process noise covariance Q (Continuous white noise acceleration model)
        # q = acceleration spectral density (e.g. 0.6 m^2/s^3 for pedestrian walking)
        q = 0.6
        Q = q * np.array([
            [(dt**3) / 3.0, (dt**2) / 2.0],
            [(dt**2) / 2.0, dt]
        ], dtype=np.float64)

        x_pred = F @ self.x
        # Distance must remain positive
        if x_pred[0] < 0.1:
            x_pred[0] = 0.1
            x_pred[1] = 0.0

        P_pred = F @ self.P @ F.T + Q

        # --- 2. Dynamic Measurement Noise Covariance R ---
        # Signal variance increases with multipath fading and distance
        if len(self.rssi_window) >= 4:
            rssi_arr = np.array(self.rssi_window, dtype=np.float64)
            var_rssi = float(np.var(rssi_arr))
        else:
            var_rssi = 4.0

        # Sensitivity propagation: d = 10^((A - RSSI)/(10n))
        # Derivative: dd / dRSSI = - (d * ln(10)) / (10 * n)
        deriv = abs(raw_distance * math.log(10.0) / (10.0 * self.n))
        # Measurement variance R in distance space (delta method):
        # Var(d) ≈ (dd/dRSSI)^2 * Var(RSSI)
        R_dist = max(0.2, (deriv ** 2) * max(1.0, var_rssi))

        # --- 3. Kalman Update Step ---
        H = np.array([[1.0, 0.0]], dtype=np.float64)
        y = raw_distance - (H @ x_pred)[0]  # Innovation residual
        S = (H @ P_pred @ H.T)[0, 0] + R_dist  # Innovation covariance
        K = (P_pred @ H.T) / S  # Kalman gain

        self.x = x_pred + (K * y).flatten()
        self.x[0] = max(0.1, self.x[0])  # Enforce minimum physical distance
        self.P = (np.eye(2) - K @ H) @ P_pred

        filtered_distance = float(self.x[0])
        velocity = float(self.x[1])

        # --- 4. High-Level Confidence Interval (Log-Normal Shadowing) ---
        # Real-world RF exhibits log-normal shadow fading:
        # sigma_ln_d = (sigma_rssi * ln(10)) / (10 * n)
        sigma_rssi = math.sqrt(max(1.0, var_rssi))
        sigma_ln_d = (sigma_rssi * math.log(10.0)) / (10.0 * self.n)
        
        # 95% Confidence Interval z-score = 1.96
        ci_low = filtered_distance * math.exp(-1.96 * sigma_ln_d)
        ci_high = filtered_distance * math.exp(+1.96 * sigma_ln_d)

        # Filtered RSSI equivalent back-calculated
        eq_rssi = ref_A - 10.0 * self.n * math.log10(max(0.1, filtered_distance))

        self.distance_history.append((timestamp, filtered_distance))

        return {
            "distance_m": round(filtered_distance, 2),
            "distance_ft": round(filtered_distance * 3.28084, 2),
            "velocity_mps": round(velocity, 2),
            "ci_low_m": round(max(0.05, ci_low), 2),
            "ci_high_m": round(ci_high, 2),
            "raw_distance_m": round(raw_distance, 2),
            "rssi_filtered": round(eq_rssi, 1),
            "signal_quality": self._compute_quality(raw_rssi)
        }

    def _compute_quality(self, rssi: float) -> int:
        """Convert RSSI into link quality percentage (0% to 100%)."""
        if rssi >= -50:
            return 100
        elif rssi <= -95:
            return 5
        else:
            return int(max(5, min(100, 2 * (rssi + 100))))

# ---------------------------------------------------------------------------
# Global State Manager (Multi-Signal Hub)
# ---------------------------------------------------------------------------
class BluetoothTelemetryHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.devices = {}           # addr -> dict of metadata & last stats
        self.selected_addrs = []     # List of up to 3 selected addresses
        self.filters = {}           # addr -> SignalDistanceFilter
        self.current_env = "office"
        self.custom_n = 3.0
        self.custom_A = -59.0

    def set_environment(self, env_key: str, custom_n=None, custom_A=None):
        with self.lock:
            if env_key in ENVIRONMENT_PRESETS:
                self.current_env = env_key
                preset = ENVIRONMENT_PRESETS[env_key]
                self.custom_n = preset["n"]
                self.custom_A = preset["ref_rssi_1m"]
            elif env_key == "custom":
                self.current_env = "custom"
                if custom_n is not None:
                    self.custom_n = float(custom_n)
                if custom_A is not None:
                    self.custom_A = float(custom_A)

            # Update all active filters
            for f in self.filters.values():
                f.update_config(self.custom_n, self.custom_A)

    def select_device(self, addr: str) -> bool:
        """Toggle selection of a device (maximum 3)."""
        with self.lock:
            if addr in self.selected_addrs:
                self.selected_addrs.remove(addr)
                return True
            else:
                if len(self.selected_addrs) >= 3:
                    return False  # Max 3 reached
                self.selected_addrs.append(addr)
                if addr not in self.filters:
                    self.filters[addr] = SignalDistanceFilter(self.custom_n, self.custom_A)
                return True

    def clear_selection(self):
        with self.lock:
            self.selected_addrs.clear()

    def select_strongest_three(self):
        with self.lock:
            now = time.time()
            # Only consider active devices seen within last 10 seconds
            active = [d for d in self.devices.values() if (now - d["last_seen"]) < 10.0]
            active.sort(key=lambda d: d["rssi"], reverse=True)
            top_3 = [d["address"] for d in active[:3]]
            self.selected_addrs = top_3
            for addr in top_3:
                if addr not in self.filters:
                    self.filters[addr] = SignalDistanceFilter(self.custom_n, self.custom_A)

    def update_advertisement(self, device, adv_data):
        now = time.time()
        addr = device.address
        name = device.name or adv_data.local_name or "Unknown Device"
        rssi = adv_data.rssi
        tx_power = adv_data.tx_power

        with self.lock:
            # Infer manufacturer/vendor hint
            mfg_name = self._identify_manufacturer(adv_data.manufacturer_data)

            if addr not in self.devices:
                self.devices[addr] = {
                    "address": addr,
                    "name": name,
                    "manufacturer": mfg_name,
                    "rssi": rssi,
                    "tx_power": tx_power,
                    "first_seen": now,
                    "last_seen": now,
                    "packet_count": 1,
                    "is_active": True
                }
            else:
                dev = self.devices[addr]
                if name != "Unknown Device" and dev["name"] == "Unknown Device":
                    dev["name"] = name
                dev["rssi"] = rssi
                if tx_power is not None:
                    dev["tx_power"] = tx_power
                if mfg_name != "BLE Radio" and dev["manufacturer"] == "BLE Radio":
                    dev["manufacturer"] = mfg_name
                dev["last_seen"] = now
                dev["packet_count"] += 1
                dev["is_active"] = True

            # If device is selected, update its high-level mathematical filter
            if addr in self.selected_addrs:
                if addr not in self.filters:
                    self.filters[addr] = SignalDistanceFilter(self.custom_n, self.custom_A)
                self.filters[addr].process_raw_rssi(rssi, now, tx_power)

    def _identify_manufacturer(self, mfg_dict) -> str:
        if not mfg_dict:
            return "BLE Radio"
        # Known Bluetooth SIG Company IDs
        sig_map = {
            0x004C: "Apple Inc.",
            0x0006: "Microsoft",
            0x0075: "Samsung Electronics",
            0x00E0: "Google LLC",
            0x0157: "Anker Innovations",
            0x0059: "Nordic Semiconductor",
            0x000D: "Texas Instruments",
            0x02DF: "Tile, Inc.",
            0x01DA: "Logitech",
            0x0087: "Garmin",
            0x000A: "Qualcomm",
            0x0171: "Amazon",
            0x038F: "Xiaomi",
            0x01B5: "Fitbit"
        }
        for comp_id in mfg_dict.keys():
            if comp_id in sig_map:
                return sig_map[comp_id]
        return "Bluetooth Peripheral"

    def get_dashboard_payload(self) -> dict:
        now = time.time()
        with self.lock:
            # Build device list with activity flags
            device_list = []
            for addr, dev in self.devices.items():
                time_diff = now - dev["last_seen"]
                is_recent = time_diff < 12.0
                device_list.append({
                    "address": addr,
                    "name": dev["name"],
                    "manufacturer": dev["manufacturer"],
                    "rssi": dev["rssi"],
                    "tx_power": dev["tx_power"],
                    "last_seen_sec": round(time_diff, 1),
                    "is_active": is_recent,
                    "selected": addr in self.selected_addrs
                })

            # Sort devices: active first, then highest RSSI
            device_list.sort(key=lambda d: (d["is_active"], d["rssi"]), reverse=True)

            # Build telemetry for up to 3 selected signals
            selected_telemetry = []
            for idx, addr in enumerate(self.selected_addrs):
                if addr in self.devices and addr in self.filters:
                    dev = self.devices[addr]
                    filt = self.filters[addr]
                    # Get latest estimate
                    time_diff = now - dev["last_seen"]
                    # If no fresh packet in last 3 seconds, extrapolate with velocity
                    est = filt.process_raw_rssi(dev["rssi"], dev["last_seen"], dev["tx_power"])
                    
                    # Convert history for sparklines
                    hist = [{"t": round(pt[0] - now, 2), "d": round(pt[1], 2)} for pt in list(filt.distance_history)[-25:]]

                    selected_telemetry.append({
                        "slot": idx + 1,
                        "address": addr,
                        "name": dev["name"],
                        "manufacturer": dev["manufacturer"],
                        "rssi_current": dev["rssi"],
                        "tx_power": dev["tx_power"],
                        "is_active": (time_diff < 8.0),
                        "last_seen_sec": round(time_diff, 1),
                        "telemetry": est,
                        "history": hist
                    })

            return {
                "system": {
                    "server_time": now,
                    "total_devices_discovered": len(self.devices),
                    "active_devices_count": sum(1 for d in device_list if d["is_active"]),
                    "environment_key": self.current_env,
                    "n_factor": round(self.custom_n, 2),
                    "ref_rssi_1m": round(self.custom_A, 1),
                    "selected_count": len(self.selected_addrs),
                    "telemetry_references": TELEMETRY_REFERENCES
                },
                "selected_targets": selected_telemetry,
                "all_devices": device_list
            }

HUB = BluetoothTelemetryHub()

# ---------------------------------------------------------------------------
# High-Tech Cyber Tactical UI (HTML5 / CSS3 / WebGL / Canvas Radar)
# ---------------------------------------------------------------------------
DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntoTheClouds | Bluetooth Multi-Signal Distance Radar</title>
  <style>
    :root {
      --bg: #070913;
      --card: #0f1424;
      --card-border: #1a233d;
      --panel-header: #151c33;
      --accent: #00e5ff;       /* Target 1 Neon Cyan */
      --accent2: #00ff88;      /* Target 2 Emerald Green */
      --accent3: #ffaa00;      /* Target 3 Cyber Amber */
      --hazard: #ff2a5f;
      --text: #f0f4fc;
      --muted: #627299;
      --line: #1c2744;
      --font-mono: "SF Mono", "Fira Code", "Roboto Mono", Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px;
      overflow-x: hidden;
    }

    /* Ambient background grid */
    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: radial-gradient(circle at 50% 20%, rgba(0, 229, 255, 0.05) 0%, transparent 65%),
                  linear-gradient(rgba(15, 20, 36, 0.4) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(15, 20, 36, 0.4) 1px, transparent 1px);
      background-size: 100% 100%, 40px 40px, 40px 40px;
      z-index: -1;
      pointer-events: none;
    }

    .hud-shell {
      width: 100%;
      max-width: 1380px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Top Command Header */
    header {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 14px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 8px 30px rgba(0,0,0,0.6);
      position: relative;
    }

    header::after {
      content: "";
      position: absolute;
      bottom: -1px; left: 24px; right: 24px;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(0,229,255,0.2), rgba(0,255,136,0.1));
      border: 1px solid var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 15px rgba(0,229,255,0.3);
    }

    .brand-icon svg { width: 22px; height: 22px; fill: var(--accent); }

    .brand-title h1 {
      font-size: 1.25rem;
      letter-spacing: 2px;
      font-weight: 800;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-subtitle {
      font-size: 0.75rem;
      color: var(--muted);
      letter-spacing: 1px;
      font-family: var(--font-mono);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .badge-status {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0, 255, 136, 0.1);
      border: 1px solid var(--accent2);
      color: var(--accent2);
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-family: var(--font-mono);
      font-weight: 600;
      text-transform: uppercase;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--accent2);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--accent2);
      animation: pulseAnim 1.4s infinite;
    }

    @keyframes pulseAnim {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.4); opacity: 0.4; }
    }

    .btn-link {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 0.8rem;
      font-family: var(--font-mono);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      text-decoration: none;
    }

    .btn-link:hover {
      background: rgba(0, 229, 255, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Environmental Telemetry Controls Bar */
    .env-toolbar {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .env-group {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 0.85rem;
    }

    .env-label {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 1px;
    }

    .env-select {
      background: #080c16;
      border: 1px solid var(--card-border);
      color: var(--accent);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-family: var(--font-mono);
      font-weight: 600;
      outline: none;
      cursor: pointer;
    }

    .env-select:focus { border-color: var(--accent); box-shadow: 0 0 10px rgba(0,229,255,0.2); }

    .env-pill-val {
      font-family: var(--font-mono);
      background: rgba(0,229,255,0.1);
      border: 1px solid rgba(0,229,255,0.3);
      padding: 4px 10px;
      border-radius: 4px;
      color: var(--accent);
      font-size: 0.8rem;
    }

    .selection-counter {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .chip-counter {
      background: rgba(255, 170, 0, 0.15);
      border: 1px solid var(--accent3);
      color: var(--accent3);
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 700;
    }

    .btn-quick {
      background: #141b2f;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-family: var(--font-mono);
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-quick:hover {
      background: var(--accent);
      color: #000;
      border-color: var(--accent);
    }

    /* Primary HUD Grid: Left Tactical Radar, Right Target Dossiers */
    .hud-grid {
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 16px;
    }

    @media (max-width: 1080px) {
      .hud-grid { grid-template-columns: 1fr; }
    }

    /* Radar HUD Card */
    .card-radar {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .radar-canvas-container {
      width: 100%;
      max-width: 420px;
      aspect-ratio: 1 / 1;
      position: relative;
    }

    #radarCanvas {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle, #080f24 0%, #03060f 100%);
      box-shadow: 0 0 30px rgba(0, 229, 255, 0.15), inset 0 0 20px rgba(0, 0, 0, 0.8);
      border: 1px solid #1c2a4d;
    }

    .radar-overlay-legend {
      width: 100%;
      display: flex;
      justify-content: space-around;
      margin-top: 12px;
      font-size: 0.75rem;
      font-family: var(--font-mono);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .legend-color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    /* Right Column: Selected Target Dossiers */
    .targets-column {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .target-slot-card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px 22px;
      position: relative;
      transition: all 0.3s;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .target-slot-card.slot-1 { border-left: 4px solid var(--accent); }
    .target-slot-card.slot-2 { border-left: 4px solid var(--accent2); }
    .target-slot-card.slot-3 { border-left: 4px solid var(--accent3); }

    .target-slot-card.empty-slot {
      border: 1px dashed var(--card-border);
      background: rgba(15, 20, 36, 0.4);
      border-left: 4px solid #334155;
      min-height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 0.85rem;
    }

    .target-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }

    .target-meta h3 {
      font-size: 1.15rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .target-mac {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 3px;
    }

    .btn-unselect {
      background: transparent;
      border: 1px solid #2d3748;
      color: #a0aec0;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      font-family: var(--font-mono);
      transition: all 0.2s;
    }

    .btn-unselect:hover {
      background: rgba(255, 42, 95, 0.2);
      border-color: var(--hazard);
      color: var(--hazard);
    }

    .target-stats-grid {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 16px;
      align-items: center;
    }

    @media (max-width: 768px) {
      .target-stats-grid { grid-template-columns: 1fr 1fr; }
    }

    .stat-distance-hero {
      display: flex;
      flex-direction: column;
    }

    .distance-num-wrap {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .distance-num {
      font-size: 2.4rem;
      font-weight: 800;
      font-family: var(--font-mono);
      line-height: 1;
    }

    .distance-unit {
      font-size: 1rem;
      color: var(--muted);
      font-weight: 600;
    }

    .distance-secondary {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--muted);
      margin-top: 4px;
    }

    .ci-pill {
      display: inline-block;
      margin-top: 4px;
      font-family: var(--font-mono);
      font-size: 0.72rem;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      color: #94a3b8;
    }

    .stat-metric-block {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .metric-label {
      font-size: 0.7rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .metric-val {
      font-family: var(--font-mono);
      font-size: 1.05rem;
      font-weight: 700;
    }

    .metric-sub {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: var(--muted);
    }

    .quality-meter {
      height: 6px;
      background: #1a233d;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 4px;
    }

    .quality-bar {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }

    .sparkline-canvas {
      width: 100%;
      height: 38px;
      background: rgba(0,0,0,0.2);
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.05);
    }

    /* All Discovered Bluetooth Devices Section */
    .discovery-section {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }

    .discovery-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .discovery-header h2 {
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .search-filter-box {
      background: #080c16;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 6px 14px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 0.85rem;
      width: 260px;
      outline: none;
    }

    .search-filter-box:focus { border-color: var(--accent); }

    .devices-table-wrap {
      max-height: 400px;
      overflow-y: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      text-align: left;
    }

    thead th {
      background: var(--panel-header);
      padding: 10px 14px;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    tbody tr {
      border-bottom: 1px solid var(--line);
      transition: background 0.15s;
    }

    tbody tr:hover { background: rgba(0, 229, 255, 0.04); }

    tbody tr.is-selected {
      background: rgba(0, 229, 255, 0.08);
    }

    td {
      padding: 10px 14px;
      vertical-align: middle;
    }

    .dev-name {
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .badge-dev-mfg {
      font-size: 0.68rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255,255,255,0.06);
      color: #94a3b8;
      font-family: var(--font-mono);
    }

    .dev-addr {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--muted);
    }

    .dev-rssi-cell {
      font-family: var(--font-mono);
      font-weight: 700;
    }

    .btn-select-toggle {
      background: #141b2f;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 5px 12px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-select-toggle:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .btn-select-toggle.active {
      background: var(--accent);
      color: #000;
      font-weight: 700;
      border-color: var(--accent);
    }

    /* Mathematical Telemetry Reference Drawer */
    .telemetry-dossier {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }

    .telemetry-dossier h3 {
      font-size: 1.1rem;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .formula-banner {
      background: #090e1c;
      border: 1px solid #1e2d50;
      border-radius: 8px;
      padding: 14px 18px;
      font-family: var(--font-mono);
      font-size: 0.9rem;
      color: #b8c7e6;
      line-height: 1.6;
    }

    .formula-banner .highlight {
      color: var(--accent2);
      font-weight: 700;
    }

    .citations-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    @media (max-width: 768px) {
      .citations-grid { grid-template-columns: 1fr; }
    }

    .citation-card {
      background: #0b1020;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .citation-title {
      font-weight: 700;
      color: #fff;
      font-size: 0.9rem;
    }

    .citation-desc {
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.4;
    }

    .citation-link {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--accent);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
    }

    .citation-link:hover { text-decoration: underline; }

    /* Toast Notification for Max 3 Alert */
    #toastNotice {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #ff2a5f;
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(255, 42, 95, 0.4);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 999;
    }

    #toastNotice.show {
      transform: translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>

<div class="hud-shell">
  <!-- Header Bar -->
  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 24 24"><path d="M14.88 16.29L13 18.17V13.83L14.88 16.29M13 10.17V5.83L14.88 7.71L13 10.17M17.71 7.71L12 2H11V9.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L11 14.41V22H12L17.71 16.29L13.41 12L17.71 7.71Z"/></svg>
      </div>
      <div class="brand-title">
        <h1>IntoTheClouds <span style="font-size: 0.85rem; color: var(--accent); font-weight: 400;">// BT RADAR</span></h1>
        <div class="brand-subtitle">ITU-R P.1238 Telemetry & Kalman State Estimation Engine</div>
      </div>
    </div>
    <div class="header-actions">
      <div class="badge-status">
        <span class="pulse-dot"></span>
        <span id="activeDeviceCount">Scanning...</span>
      </div>
      <a href="#telemetrySection" class="btn-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07L19.07 4.93"/></svg>
        Telemetry Spec
      </a>
    </div>
  </header>

  <!-- Environment & Preset Controls -->
  <div class="env-toolbar">
    <div class="env-group">
      <span class="env-label">Indoor Profile:</span>
      <select id="envSelect" class="env-select" onchange="onEnvChange()">
        <option value="office">🏢 ITU-R P.1238 Office (N=30, n=3.0)</option>
        <option value="residential">🏠 ITU-R P.1238 Residential (N=28, n=2.8)</option>
        <option value="commercial">🏬 ITU-R Commercial / Open (N=22, n=2.2)</option>
        <option value="industrial">🏭 Industrial / Concrete (N=38, n=3.8)</option>
        <option value="freespace">🪐 Free Space (n=2.0)</option>
      </select>
    </div>

    <div class="env-group">
      <span class="env-label">Model Exponent (n):</span>
      <span id="displayN" class="env-pill-val">3.00</span>
      <span class="env-label" style="margin-left: 8px;">1m Ref (A):</span>
      <span id="displayA" class="env-pill-val">-59.0 dBm</span>
    </div>

    <div class="selection-counter">
      <span>Tracking:</span>
      <span id="selectionCounterBadge" class="chip-counter">0 / 3</span>
      <button class="btn-quick" onclick="selectTop3()">Select Strongest 3</button>
      <button class="btn-quick" onclick="clearSelected()">Clear</button>
    </div>
  </div>

  <!-- Main Radar & Multi-Target Dossiers Grid -->
  <div class="hud-grid">
    <!-- Left: Tactical Radar Canvas -->
    <div class="card-radar">
      <div class="radar-canvas-container">
        <canvas id="radarCanvas" width="420" height="420"></canvas>
      </div>
      <div class="radar-overlay-legend">
        <div class="legend-item">
          <span class="legend-color-dot" style="background: var(--accent);"></span>
          <span id="legendT1">Slot 1: None</span>
        </div>
        <div class="legend-item">
          <span class="legend-color-dot" style="background: var(--accent2);"></span>
          <span id="legendT2">Slot 2: None</span>
        </div>
        <div class="legend-item">
          <span class="legend-color-dot" style="background: var(--accent3);"></span>
          <span id="legendT3">Slot 3: None</span>
        </div>
      </div>
    </div>

    <!-- Right: Up to 3 Target Dossiers -->
    <div class="targets-column" id="targetsContainer">
      <!-- Target Slots rendered dynamically via JS -->
    </div>
  </div>

  <!-- Discovered Devices Table -->
  <div class="discovery-section">
    <div class="discovery-header">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Discovered Bluetooth Signals Around You
        <span id="totalDiscoveredCount" style="color: var(--muted); font-size: 0.85rem; font-weight: 400;">(0 found)</span>
      </h2>
      <input type="text" id="searchFilter" class="search-filter-box" placeholder="Filter by name, vendor, MAC..." oninput="renderDevicesTable()">
    </div>

    <div class="devices-table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 70px;">Track</th>
            <th>Device Name / Hardware MAC</th>
            <th>Manufacturer</th>
            <th>Signal (RSSI)</th>
            <th>Tx Power</th>
            <th>Last Ping</th>
          </tr>
        </thead>
        <tbody id="devicesTableBody">
          <!-- Dynamically populated -->
        </tbody>
      </table>
    </div>
  </div>

  <!-- Mathematical Telemetry Dossier & Citations -->
  <div class="telemetry-dossier" id="telemetrySection">
    <h3>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      Indoor Bluetooth Telemetry & Mathematical Foundation
    </h3>

    <div class="formula-banner">
      <strong>1. ITU-R Recommendation P.1238 Indoor Path Loss Formula:</strong><br>
      $$L_{\\text{total}} = 20 \\log_{10}(f) + N \\log_{10}(d) + P_f(n_{\\text{floor}}) - 28$$<br>
      Where operating frequency $f = 2440\\text{ MHz}$ (BLE), $N$ is the Distance Power Loss Coefficient, and $d$ is 3D distance in meters.<br>
      Solving for distance with calibrated 1-meter reference power $A$ ($P_0$):<br>
      <span class="highlight">$$\\hat{d}_{\\text{raw}} = 10^{\\frac{A - \\text{RSSI}}{10 \\cdot n}}$$</span> 
      &nbsp;&nbsp;[where $n = N / 10$ is the path loss exponent]
      <br><br>
      <strong>2. Adaptive Kinematic Kalman Filter & Log-Normal Shadowing:</strong><br>
      State vector $\\mathbf{x}_k = [d_k, \\dot{d}_k]^T$ (continuous distance and radial velocity). 
      Measurement noise variance $R$ dynamically propagates from sample RSSI variance $\\sigma_{\\text{RSSI}}^2$ via the delta method:
      $$R = \\left(\\frac{\\partial d}{\\partial \\text{RSSI}}\\right)^2 \\sigma_{\\text{RSSI}}^2 = \\left(\\frac{d \\ln 10}{10 n}\\right)^2 \\sigma_{\\text{RSSI}}^2$$
      The 95% Confidence Interval is derived from the log-normal shadow fading distribution $X_\\sigma \\sim \\mathcal{N}(0, \\sigma^2)$:
      <span class="highlight">$$d_{95\\%} = \\left[ \\hat{d} \\cdot e^{-1.96 \\cdot \\sigma_{\\ln d}},\\; \\hat{d} \\cdot e^{+1.96 \\cdot \\sigma_{\\ln d}} \\right]$$</span>
    </div>

    <div class="citations-grid">
      <div class="citation-card">
        <div class="citation-title">ITU-R Recommendation P.1238-11</div>
        <div class="citation-desc">
          The International Telecommunication Union's authoritative standard for indoor radiocommunication planning and propagation loss from 300 MHz to 450 GHz across residential, commercial, and office spaces.
        </div>
        <a href="https://www.itu.int/rec/R-REC-P.1238/en" target="_blank" rel="noopener" class="citation-link">
          Official Telemetry Portal: itu.int/rec/R-REC-P.1238 &rarr;
        </a>
      </div>

      <div class="citation-card">
        <div class="citation-title">MDPI Sensors Journal & NIST Indoor Telemetry</div>
        <div class="citation-desc">
          Peer-reviewed research detailing empirical calibration of BLE path loss exponents, log-normal shadowing models, and Kalman filtering for indoor tracking in multipath environments.
        </div>
        <a href="https://www.mdpi.com/journal/sensors" target="_blank" rel="noopener" class="citation-link">
          MDPI Telemetry Research: mdpi.com/journal/sensors &rarr;
        </a>
      </div>
    </div>
  </div>
</div>

<!-- Toast Notice for Max 3 Signals -->
<div id="toastNotice">⚠️ Maximum 3 signals selected! Uncheck an active signal first.</div>

<script>
  let dashboardData = null;
  let radarAngle = 0;
  const canvas = document.getElementById("radarCanvas");
  const ctx = canvas.getContext("2d");

  const SLOT_COLORS = ["#00e5ff", "#00ff88", "#ffaa00"];

  async function fetchTelemetry() {
    try {
      const res = await fetch("/api/telemetry");
      dashboardData = await res.json();
      updateHUD();
    } catch (e) {
      console.warn("Poll error:", e);
    }
  }

  function updateHUD() {
    if (!dashboardData) return;

    const sys = dashboardData.system;
    document.getElementById("activeDeviceCount").textContent = `${sys.active_devices_count} Signals Active`;
    document.getElementById("totalDiscoveredCount").textContent = `(${sys.total_devices_discovered} total seen)`;
    document.getElementById("selectionCounterBadge").textContent = `${sys.selected_count} / 3`;

    document.getElementById("displayN").textContent = sys.n_factor.toFixed(2);
    document.getElementById("displayA").textContent = `${sys.ref_rssi_1m.toFixed(1)} dBm`;

    renderTargetDossiers();
    renderDevicesTable();
  }

  function renderTargetDossiers() {
    const container = document.getElementById("targetsContainer");
    const targets = dashboardData.selected_targets || [];

    // Update legend
    for (let i = 0; i < 3; i++) {
      const leg = document.getElementById(`legendT${i+1}`);
      if (targets[i]) {
        leg.textContent = `${targets[i].name.substring(0, 14)} (${targets[i].telemetry.distance_m}m)`;
        leg.style.color = SLOT_COLORS[i];
      } else {
        leg.textContent = `Slot ${i+1}: None`;
        leg.style.color = "var(--muted)";
      }
    }

    let html = "";
    for (let slot = 1; slot <= 3; slot++) {
      const target = targets.find(t => t.slot === slot);
      if (target) {
        const tel = target.telemetry;
        const color = SLOT_COLORS[slot - 1];

        let velText = "Stationary";
        let velIcon = "●";
        if (tel.velocity_mps > 0.15) {
          velText = `Receding (+${tel.velocity_mps} m/s)`;
          velIcon = "▲";
        } else if (tel.velocity_mps < -0.15) {
          velText = `Approaching (${tel.velocity_mps} m/s)`;
          velIcon = "▼";
        }

        html += `
          <div class="target-slot-card slot-${slot}">
            <div class="target-header">
              <div class="target-meta">
                <h3 style="color: ${color}">
                  <span style="font-size: 0.8rem; background: ${color}22; padding: 2px 8px; border-radius: 4px; border: 1px solid ${color};">SLOT ${slot}</span>
                  ${escapeHtml(target.name)}
                </h3>
                <div class="target-mac">${target.address} &bull; <span style="color: #94a3b8;">${escapeHtml(target.manufacturer)}</span></div>
              </div>
              <button class="btn-unselect" onclick="toggleSelect('${target.address}')">✕ Release</button>
            </div>

            <div class="target-stats-grid">
              <div class="stat-distance-hero">
                <span class="metric-label">Estimated Distance</span>
                <div class="distance-num-wrap">
                  <span class="distance-num" style="color: ${color};">${tel.distance_m.toFixed(2)}</span>
                  <span class="distance-unit">meters</span>
                </div>
                <div class="distance-secondary">${tel.distance_ft.toFixed(1)} feet</div>
                <div>
                  <span class="ci-pill">95% CI: [${tel.ci_low_m}m &ndash; ${tel.ci_high_m}m]</span>
                </div>
              </div>

              <div class="stat-metric-block">
                <span class="metric-label">Signal (RSSI)</span>
                <span class="metric-val" style="color: ${target.rssi_current >= -70 ? 'var(--accent2)' : 'var(--accent3)'};">
                  ${target.rssi_current} dBm
                </span>
                <div class="quality-meter">
                  <div class="quality-bar" style="width: ${tel.signal_quality}%; background: ${color};"></div>
                </div>
                <span class="metric-sub">${tel.signal_quality}% link quality</span>
              </div>

              <div class="stat-metric-block">
                <span class="metric-label">Radial Velocity</span>
                <span class="metric-val" style="font-size: 0.95rem; color: #fff;">
                  ${velIcon} ${velText}
                </span>
                <span class="metric-sub">Kalman state derivative</span>
              </div>

              <div class="stat-metric-block">
                <span class="metric-label">Recent History</span>
                <canvas id="sparkline_${slot}" class="sparkline-canvas" width="160" height="38"></canvas>
                <span class="metric-sub">Last ping: ${target.last_seen_sec}s ago</span>
              </div>
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="target-slot-card empty-slot">
            <span>+ Slot ${slot} Available &mdash; Check any device from the list below to track</span>
          </div>
        `;
      }
    }
    container.innerHTML = html;

    // Draw sparklines for active targets
    targets.forEach(t => {
      drawSparkline(`sparkline_${t.slot}`, t.history, SLOT_COLORS[t.slot - 1]);
    });
  }

  function drawSparkline(canvasId, history, color) {
    const sc = document.getElementById(canvasId);
    if (!sc || !history || history.length < 2) return;
    const sctx = sc.getContext("2d");
    const w = sc.width;
    const h = sc.height;
    sctx.clearRect(0, 0, w, h);

    const distances = history.map(p => p.d);
    const minD = Math.max(0, Math.min(...distances) * 0.85);
    const maxD = Math.max(...distances) * 1.15;
    const range = (maxD - minD) || 1.0;

    sctx.beginPath();
    sctx.strokeStyle = color;
    sctx.lineWidth = 2;

    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * (w - 8) + 4;
      const y = h - ((history[i].d - minD) / range) * (h - 8) - 4;
      if (i === 0) sctx.moveTo(x, y);
      else sctx.lineTo(x, y);
    }
    sctx.stroke();

    // Fill under curve
    sctx.lineTo(w - 4, h);
    sctx.lineTo(4, h);
    sctx.fillStyle = color + "22";
    sctx.fill();
  }

  function renderDevicesTable() {
    const tbody = document.getElementById("devicesTableBody");
    if (!dashboardData) return;

    const filterText = (document.getElementById("searchFilter").value || "").toLowerCase().trim();
    const devices = dashboardData.all_devices || [];

    const filtered = devices.filter(d => {
      if (!filterText) return true;
      return (d.name && d.name.toLowerCase().includes(filterText)) ||
             (d.address && d.address.toLowerCase().includes(filterText)) ||
             (d.manufacturer && d.manufacturer.toLowerCase().includes(filterText));
    });

    let rowsHtml = "";
    filtered.forEach(d => {
      const isSel = d.selected;
      const rssiColor = d.rssi >= -65 ? "var(--accent2)" : (d.rssi >= -80 ? "var(--accent)" : "var(--accent3)");
      const txDisp = d.tx_power !== null ? `${d.tx_power} dBm` : `<span style="color:var(--muted)">N/A</span>`;

      rowsHtml += `
        <tr class="${isSel ? 'is-selected' : ''}">
          <td>
            <button class="btn-select-toggle ${isSel ? 'active' : ''}" onclick="toggleSelect('${d.address}')">
              ${isSel ? '✓ Track' : '+ Track'}
            </button>
          </td>
          <td>
            <div class="dev-name">
              <span>${escapeHtml(d.name)}</span>
            </div>
            <div class="dev-addr">${d.address}</div>
          </td>
          <td>
            <span class="badge-dev-mfg">${escapeHtml(d.manufacturer)}</span>
          </td>
          <td class="dev-rssi-cell" style="color: ${rssiColor}">
            ${d.rssi} dBm
          </td>
          <td style="font-family: var(--font-mono); font-size: 0.8rem;">
            ${txDisp}
          </td>
          <td style="font-family: var(--font-mono); font-size: 0.8rem; color: ${d.is_active ? 'var(--text)' : 'var(--muted)'};">
            ${d.last_seen_sec <= 2 ? 'Just now' : d.last_seen_sec + 's ago'}
          </td>
        </tr>
      `;
    });

    if (filtered.length === 0) {
      rowsHtml = `<tr><td colspan="6" style="text-align: center; color: var(--muted); padding: 24px;">No devices matching filter.</td></tr>`;
    }

    tbody.innerHTML = rowsHtml;
  }

  // --- 360° Tactical Radar Drawing Loop ---
  function drawRadar() {
    radarAngle = (radarAngle + 0.02) % (Math.PI * 2);
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = cx - 18;

    ctx.clearRect(0, 0, w, h);

    // 1. Concentric Distance Rings: 1m, 2m, 5m, 10m, 20m
    const rings = [
      { d: 1, label: "1m" },
      { d: 2, label: "2m" },
      { d: 5, label: "5m" },
      { d: 10, label: "10m" },
      { d: 20, label: "20m" }
    ];

    ctx.strokeStyle = "rgba(0, 229, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "rgba(0, 229, 255, 0.4)";

    rings.forEach((r, idx) => {
      const rad = ((idx + 1) / rings.length) * maxRadius;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(r.label, cx + 4, cy - rad + 12);
    });

    // 2. Crosshairs
    ctx.strokeStyle = "rgba(0, 229, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
    ctx.stroke();

    // 3. Rotating Radar Sweep Line with Gradient Tail
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(radarAngle);
    
    // Sweep gradient trail
    const trailGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
    trailGrad.addColorStop(0, "rgba(0, 229, 255, 0.2)");
    trailGrad.addColorStop(1, "rgba(0, 229, 255, 0.0)");

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, maxRadius, -Math.PI / 4, 0);
    ctx.closePath();
    ctx.fillStyle = trailGrad;
    ctx.fill();

    // Leading line
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(maxRadius, 0);
    ctx.strokeStyle = "rgba(0, 229, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 4. Center Host Computer Marker
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#00e5ff";
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#627299";
    ctx.fillText("HOST", cx - 13, cy + 16);

    // 5. Render Targets
    if (dashboardData && dashboardData.selected_targets) {
      dashboardData.selected_targets.forEach((tgt, idx) => {
        const color = SLOT_COLORS[idx];
        const dist = tgt.telemetry.distance_m;
        // Map distance to radial distance (clamped to max 22m on display)
        const normDist = Math.min(dist / 20.0, 1.05);
        const rPix = normDist * maxRadius;

        // Position on 3 distinct radial directions (e.g., -60deg, 60deg, 180deg) for clarity
        const fixedAngles = [-Math.PI / 3, Math.PI / 3, Math.PI];
        const angle = fixedAngles[idx % fixedAngles.length];

        const tx = cx + Math.cos(angle) * rPix;
        const ty = cy + Math.sin(angle) * rPix;

        // Target pulsating ring
        const pulse = (Date.now() / 300 + idx) % 2;
        ctx.beginPath();
        ctx.arc(tx, ty, 8 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Target core dot
        ctx.beginPath();
        ctx.arc(tx, ty, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Target Tag
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px monospace";
        ctx.fillText(`T${tgt.slot}: ${dist}m`, tx + 9, ty + 3);
      });
    }

    requestAnimationFrame(drawRadar);
  }

  // --- API Handlers ---
  async function toggleSelect(address) {
    try {
      const res = await fetch(`/api/select?addr=${encodeURIComponent(address)}`, { method: "POST" });
      const data = await res.json();
      if (!data.success && data.reason === "max_reached") {
        showToast();
      }
      fetchTelemetry();
    } catch (e) {
      console.error(e);
    }
  }

  async function clearSelected() {
    await fetch("/api/clear_selection", { method: "POST" });
    fetchTelemetry();
  }

  async function selectTop3() {
    await fetch("/api/select_top3", { method: "POST" });
    fetchTelemetry();
  }

  async function onEnvChange() {
    const val = document.getElementById("envSelect").value;
    await fetch(`/api/config?env=${encodeURIComponent(val)}`, { method: "POST" });
    fetchTelemetry();
  }

  function showToast() {
    const toast = document.getElementById("toastNotice");
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Start polling and radar animation
  fetchTelemetry();
  setInterval(fetchTelemetry, 350);
  requestAnimationFrame(drawRadar);
</script>
</body>
</html>
"""

# ---------------------------------------------------------------------------
# HTTP & REST API Request Handler
# ---------------------------------------------------------------------------
class DashboardRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress noisy standard HTTP access logs
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ["/", "/index.html"]:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(DASHBOARD_HTML.encode("utf-8"))
        elif parsed.path == "/api/telemetry":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            data = HUB.get_dashboard_payload()
            self.wfile.write(json.dumps(data).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/api/select":
            addr = params.get("addr", [None])[0]
            if addr:
                ok = HUB.select_device(addr)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                resp = {"success": ok}
                if not ok:
                    resp["reason"] = "max_reached"
                self.wfile.write(json.dumps(resp).encode("utf-8"))
                return
        elif parsed.path == "/api/select_top3":
            HUB.select_strongest_three()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success": true}')
            return
        elif parsed.path == "/api/clear_selection":
            HUB.clear_selection()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success": true}')
            return
        elif parsed.path == "/api/config":
            env_key = params.get("env", ["office"])[0]
            HUB.set_environment(env_key)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success": true}')
            return

        self.send_response(404)
        self.end_headers()

# ---------------------------------------------------------------------------
# Background Bluetooth Scanner Task
# ---------------------------------------------------------------------------
async def run_ble_scanner():
    """Continuously discovers and streams all Bluetooth advertisement frames."""
    def detection_callback(device, advertisement_data):
        HUB.update_advertisement(device, advertisement_data)

    print("[BLE] Initializing Windows WinRT Bluetooth LE Scanner...")
    scanner = BleakScanner(detection_callback=detection_callback)

    while True:
        try:
            print("[BLE] Actively scanning for all nearby Bluetooth signals...")
            await scanner.start()
            while True:
                await asyncio.sleep(1.0)
        except Exception as e:
            print(f"[BLE Scanner Warning] {e}. Reconnecting radio in 2 seconds...")
            try:
                await scanner.stop()
            except Exception:
                pass
            await asyncio.sleep(2.0)

def start_ble_thread():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_ble_scanner())

# ---------------------------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------------------------
def main():
    port = 8888
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    print("=" * 72)
    print("  IntoTheClouds: Bluetooth Signal Distance Radar & Telemetry UI")
    print("=" * 72)
    print("  Mathematical Framework: ITU-R Recommendation P.1238-11")
    print("  Telemetry Reference:    https://www.itu.int/rec/R-REC-P.1238/en")
    print("  Scientific Journal:     https://www.mdpi.com/journal/sensors")
    print("  Estimation Engine:      Adaptive 2D Kinematic Kalman Filter + Log-Normal CI")
    print("-" * 72)

    # 1. Start Bluetooth LE Scanner in background thread
    ble_thread = threading.Thread(target=start_ble_thread, daemon=True)
    ble_thread.start()

    # 2. Start HTTP & Dashboard Server
    server_address = ("127.0.0.1", port)
    try:
        httpd = HTTPServer(server_address, DashboardRequestHandler)
    except OSError:
        port = 8889
        server_address = ("127.0.0.1", port)
        httpd = HTTPServer(server_address, DashboardRequestHandler)

    url = f"http://127.0.0.1:{port}"
    print(f"[DASHBOARD] Tactical Radar Server running at: {url}")
    print("[DASHBOARD] Opening your browser automatically...")

    def open_browser():
        time.sleep(1.2)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    print("[READY] Dashboard active. Press Ctrl+C to terminate.")
    print("=" * 72)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[STOPPING] Shutting down Bluetooth Distance Radar...")
        httpd.server_close()
        sys.exit(0)

if __name__ == "__main__":
    main()
