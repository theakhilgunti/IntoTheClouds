#!/usr/bin/env python3
"""
=============================================================================
  IntoTheClouds: Unified Dual-Radio Distance Radar & Telemetry Suite
  (Bluetooth Low Energy + Wi-Fi BSSID Tracking & Calibration)
=============================================================================
Combines real-time Bluetooth LE scanning and Windows Native Wi-Fi WLAN scanning
into a single high-tech tactical dashboard.

Features:
- Live Dual-Radio Scanner: Bluetooth LE + Wi-Fi (BSSID / SSID).
- Choose any 3 signals (mix and match Bluetooth and Wi-Fi).
- Mathematical Distance Estimation (ITU-R P.1238 + Adaptive Kalman Filter).
- Independent Live Calibration for BOTH Bluetooth and Wi-Fi:
  * Calibrate 1-meter reference A for BLE devices (e.g. iPhones, beacons).
  * Calibrate 1-meter reference A for Wi-Fi routers/anchors.
  * 2-Point linear regression fit to calculate exact room exponent n.
- 360° Tactical Radar Canvas, Web Audio Sonar Ping, and CSV Telemetry export.

Usage:
  python unified_rf_distance_radar.py [--port 8888] [--cli]
=============================================================================
"""

import sys
import os
import time
import math
import json
import csv
import io
import re
import ctypes
import subprocess
import asyncio
import threading
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from collections import deque

# High-level mathematical libraries
import numpy as np
import scipy.stats as stats

# Bluetooth LE Library
try:
    import bleak
    from bleak import BleakScanner
except ImportError:
    print("[ERROR] 'bleak' is required. Run: pip install bleak numpy scipy")
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
        "title": "Indoor Positioning Systems using BLE/Wi-Fi RSSI, Path Loss Modeling, and Kalman Filtering",
        "url": "https://www.mdpi.com/journal/sensors",
        "description": "Peer-reviewed research and empirical telemetry data on indoor BLE & Wi-Fi ranging, shadow fading distributions, and filter convergence."
    }
}

ENVIRONMENT_PRESETS = {
    "office": {
        "name": "ITU-R P.1238: Office Building",
        "n_bt": 3.0, "a_bt": -59.0,
        "n_wifi": 2.8, "a_wifi": -40.0,
        "description": "Office with cubicles, drywall, furniture, and human movement."
    },
    "residential": {
        "name": "ITU-R P.1238: Residential / Home",
        "n_bt": 2.8, "a_bt": -59.0,
        "n_wifi": 2.6, "a_wifi": -40.0,
        "description": "Home interior with wooden studs, drywall, and furniture."
    },
    "commercial": {
        "name": "ITU-R P.1238: Commercial / Large Open",
        "n_bt": 2.2, "a_bt": -57.0,
        "n_wifi": 2.2, "a_wifi": -38.0,
        "description": "Large retail store or open corridor with low obstruction."
    },
    "industrial": {
        "name": "Industrial / Concrete & Metal",
        "n_bt": 3.8, "a_bt": -62.0,
        "n_wifi": 3.4, "a_wifi": -44.0,
        "description": "Concrete walls, metal racking, machinery, and heavy shadowing."
    },
    "freespace": {
        "name": "Free Space (Direct Line-of-Sight)",
        "n_bt": 2.0, "a_bt": -55.0,
        "n_wifi": 2.0, "a_wifi": -35.0,
        "description": "Direct unobstructed line-of-sight path."
    }
}

# ---------------------------------------------------------------------------
# Apple Continuity Protocol Decoder
# ---------------------------------------------------------------------------
def decode_apple_continuity(mfg_bytes: bytes) -> tuple:
    if not mfg_bytes or len(mfg_bytes) < 1:
        return "Apple Device", "Apple Inc."
    subtype = mfg_bytes[0]
    if subtype == 0x10:
        return "Apple iPhone / iPad", "Apple Continuity"
    elif subtype == 0x07:
        return "Apple AirPods / Beats", "Apple Audio"
    elif subtype == 0x12:
        return "Apple AirTag / Find My", "Apple FindMy"
    elif subtype == 0x09:
        return "Apple AirPlay Device", "Apple Media"
    elif subtype == 0x05:
        return "Apple AirDrop Service", "Apple AirDrop"
    elif subtype == 0x0B:
        return "Apple Watch", "Apple Watch"
    elif subtype in (0x0C, 0x0F, 0x16):
        return "Apple Proximity Device", "Apple Inc."
    return "Apple Device", "Apple Inc."

# ---------------------------------------------------------------------------
# High-Level Mathematical Estimator (Adaptive Kalman + ITU-R P.1238)
# ---------------------------------------------------------------------------
class RadioDistanceFilter:
    def __init__(self, n_factor: float = 3.0, ref_rssi_1m: float = -50.0, radio_type: str = "bt"):
        self.n = float(n_factor)
        self.A = float(ref_rssi_1m)
        self.radio_type = radio_type  # "bt" or "wifi"

        # State: [distance (meters), radial_velocity (m/s)]
        self.x = np.array([1.5, 0.0], dtype=np.float64)
        self.P = np.diag([4.0, 1.0]).astype(np.float64)

        self.last_timestamp = None
        self.rssi_window = deque(maxlen=25)
        self.distance_history = deque(maxlen=60)
        self.initialized = False

    def update_config(self, n_factor: float, ref_rssi_1m: float):
        self.n = float(n_factor)
        self.A = float(ref_rssi_1m)

    def process_raw_rssi(self, raw_rssi: float, timestamp: float, tx_power_adv=None):
        self.rssi_window.append(raw_rssi)

        ref_A = self.A
        if tx_power_adv is not None:
            ref_A = float(tx_power_adv) - 41.0

        # Log-Distance Path Loss Inversion
        exponent = (ref_A - raw_rssi) / (10.0 * self.n)
        raw_distance = math.pow(10.0, exponent)
        raw_distance = max(0.1, min(raw_distance, 90.0))

        if not self.initialized:
            self.x = np.array([raw_distance, 0.0], dtype=np.float64)
            self.last_timestamp = timestamp
            self.initialized = True
            ci_low = max(0.08, raw_distance * 0.8)
            ci_high = raw_distance * 1.25
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

        dt = max(0.05, min(timestamp - self.last_timestamp, 3.5))
        self.last_timestamp = timestamp

        # 1. Kalman Prediction Step
        F = np.array([[1.0, dt],
                      [0.0, 1.0]], dtype=np.float64)
        
        q = 0.5  # acceleration spectral density
        Q = q * np.array([
            [(dt**3) / 3.0, (dt**2) / 2.0],
            [(dt**2) / 2.0, dt]
        ], dtype=np.float64)

        x_pred = F @ self.x
        if x_pred[0] < 0.1:
            x_pred[0] = 0.1
            x_pred[1] = 0.0

        P_pred = F @ self.P @ F.T + Q

        # 2. Dynamic Measurement Noise Covariance R via Delta Method
        if len(self.rssi_window) >= 3:
            rssi_arr = np.array(self.rssi_window, dtype=np.float64)
            var_rssi = float(np.var(rssi_arr))
        else:
            var_rssi = 3.5

        deriv = abs(raw_distance * math.log(10.0) / (10.0 * self.n))
        R_dist = max(0.15, (deriv ** 2) * max(0.8, var_rssi))

        # 3. Kalman Update Step
        H = np.array([[1.0, 0.0]], dtype=np.float64)
        y = raw_distance - (H @ x_pred)[0]
        S = (H @ P_pred @ H.T)[0, 0] + R_dist
        K = (P_pred @ H.T) / S

        self.x = x_pred + (K * y).flatten()
        self.x[0] = max(0.08, self.x[0])
        self.P = (np.eye(2) - K @ H) @ P_pred

        filtered_distance = float(self.x[0])
        velocity = float(self.x[1])

        # 4. Log-Normal Confidence Interval
        sigma_rssi = math.sqrt(max(0.8, var_rssi))
        sigma_ln_d = (sigma_rssi * math.log(10.0)) / (10.0 * self.n)
        
        ci_low = filtered_distance * math.exp(-1.96 * sigma_ln_d)
        ci_high = filtered_distance * math.exp(+1.96 * sigma_ln_d)

        eq_rssi = ref_A - 10.0 * self.n * math.log10(max(0.08, filtered_distance))
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
        if rssi >= -50:
            return 100
        elif rssi <= -95:
            return 5
        else:
            return int(max(5, min(100, 2 * (rssi + 100))))

# ---------------------------------------------------------------------------
# Global State Manager (Dual-Radio Hub)
# ---------------------------------------------------------------------------
class DualRadioTelemetryHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.devices = {}             # key -> metadata & live stats (key = 'bt:<mac>' or 'wifi:<bssid>')
        self.selected_keys = []       # List of up to 3 selected keys
        self.filters = {}             # key -> RadioDistanceFilter
        self.current_env = "office"

        # Default parameters
        self.custom_n_bt = 3.0
        self.custom_a_bt = -59.0
        self.custom_n_wifi = 2.8
        self.custom_a_wifi = -40.0

        self.telemetry_log = deque(maxlen=3000)
        self.calibration_points = {}  # key -> list of (distance_m, mean_rssi)

    def set_environment(self, env_key: str):
        with self.lock:
            if env_key in ENVIRONMENT_PRESETS:
                self.current_env = env_key
                preset = ENVIRONMENT_PRESETS[env_key]
                self.custom_n_bt = preset["n_bt"]
                self.custom_a_bt = preset["a_bt"]
                self.custom_n_wifi = preset["n_wifi"]
                self.custom_a_wifi = preset["a_wifi"]

                for key, f in self.filters.items():
                    if f.radio_type == "bt":
                        f.update_config(self.custom_n_bt, self.custom_a_bt)
                    else:
                        f.update_config(self.custom_n_wifi, self.custom_a_wifi)

    def calibrate_step(self, key: str, known_distance_m: float) -> dict:
        """Records a calibration point for a specific Bluetooth OR Wi-Fi target."""
        with self.lock:
            if key not in self.filters:
                return {"success": False, "reason": "Target not selected yet. Please select it first."}

            samples = list(self.filters[key].rssi_window)
            if len(samples) == 0:
                if key in self.devices and self.devices[key]["rssi"] is not None:
                    samples = [self.devices[key]["rssi"]]
                else:
                    return {"success": False, "reason": "No signal packets recorded for this target yet."}

            mean_rssi = float(np.mean(samples))
            std_rssi = float(np.std(samples)) if len(samples) > 1 else 0.5
            f = self.filters[key]

            if key not in self.calibration_points:
                self.calibration_points[key] = []
            self.calibration_points[key].append((float(known_distance_m), mean_rssi))
            pts = self.calibration_points[key]

            if len(pts) == 1:
                # 1-Point: Solve for A at known distance: A = RSSI + 10 * n * log10(d)
                d_val, rssi_val = pts[0]
                calibrated_A = rssi_val + 10.0 * f.n * math.log10(max(0.1, d_val))
                calibrated_A = round(calibrated_A, 1)

                f.A = calibrated_A
                if f.radio_type == "bt":
                    self.custom_a_bt = calibrated_A
                else:
                    self.custom_a_wifi = calibrated_A
                self.current_env = "custom"

                return {
                    "success": True,
                    "points_count": 1,
                    "radio_type": f.radio_type.upper(),
                    "calibrated_A": calibrated_A,
                    "calibrated_n": round(f.n, 2),
                    "mean_rssi": round(mean_rssi, 1),
                    "std_rssi": round(std_rssi, 2),
                    "sample_count": len(samples),
                    "message": f"Point 1 ({f.radio_type.upper()}) at {known_distance_m}m. Calibrated 1m Ref A = {calibrated_A} dBm."
                }
            else:
                # Multi-Point Fit: Solve for both A and n using linear regression
                d_arr = np.array([p[0] for p in pts])
                rssi_arr = np.array([p[1] for p in pts])
                x_arr = 10.0 * np.log10(d_arr)

                p = np.polyfit(x_arr, rssi_arr, 1)
                slope, intercept = p[0], p[1]

                fitted_n = max(1.5, min(-slope, 5.0))
                fitted_A = float(intercept)

                f.n = round(fitted_n, 2)
                f.A = round(fitted_A, 1)
                if f.radio_type == "bt":
                    self.custom_n_bt = f.n
                    self.custom_a_bt = f.A
                else:
                    self.custom_n_wifi = f.n
                    self.custom_a_wifi = f.A
                self.current_env = "custom"

                return {
                    "success": True,
                    "points_count": len(pts),
                    "radio_type": f.radio_type.upper(),
                    "calibrated_A": f.A,
                    "calibrated_n": f.n,
                    "mean_rssi": round(mean_rssi, 1),
                    "std_rssi": round(std_rssi, 2),
                    "sample_count": len(samples),
                    "message": f"Multi-point fit complete ({f.radio_type.upper()})! Calibrated A = {f.A} dBm, n = {f.n}."
                }

    def reset_calibration(self, key: str = None):
        with self.lock:
            if key and key in self.calibration_points:
                self.calibration_points[key].clear()
            else:
                self.calibration_points.clear()

    def select_device(self, key: str) -> bool:
        with self.lock:
            if key in self.selected_keys:
                self.selected_keys.remove(key)
                return True
            else:
                if len(self.selected_keys) >= 3:
                    return False
                self.selected_keys.append(key)
                if key not in self.filters:
                    is_wifi = key.startswith("wifi:")
                    n_val = self.custom_n_wifi if is_wifi else self.custom_n_bt
                    a_val = self.custom_a_wifi if is_wifi else self.custom_a_bt
                    self.filters[key] = RadioDistanceFilter(n_val, a_val, "wifi" if is_wifi else "bt")
                return True

    def clear_selection(self):
        with self.lock:
            self.selected_keys.clear()

    def select_strongest_three(self):
        with self.lock:
            now = time.time()
            active = [d for d in self.devices.values() if (now - d["last_seen"]) < 12.0]
            active.sort(key=lambda d: d["rssi"], reverse=True)
            top_3 = [d["key"] for d in active[:3]]
            self.selected_keys = top_3
            for key in top_3:
                if key not in self.filters:
                    is_wifi = key.startswith("wifi:")
                    n_val = self.custom_n_wifi if is_wifi else self.custom_n_bt
                    a_val = self.custom_a_wifi if is_wifi else self.custom_a_bt
                    self.filters[key] = RadioDistanceFilter(n_val, a_val, "wifi" if is_wifi else "bt")

    def update_bluetooth_advertisement(self, device, adv_data):
        now = time.time()
        addr = device.address
        key = f"bt:{addr.lower()}"
        name = device.name or adv_data.local_name or "Unknown Device"
        rssi = adv_data.rssi
        tx_power = adv_data.tx_power

        with self.lock:
            mfg_name = self._identify_bt_manufacturer(adv_data.manufacturer_data)
            if (name == "Unknown Device" or not name) and (adv_data.manufacturer_data and 0x004C in adv_data.manufacturer_data):
                apple_name, apple_tag = decode_apple_continuity(adv_data.manufacturer_data[0x004C])
                name = apple_name
                mfg_name = apple_tag

            if key not in self.devices:
                self.devices[key] = {
                    "key": key,
                    "radio_type": "bt",
                    "address": addr,
                    "name": name,
                    "vendor": mfg_name,
                    "band": "2.4 GHz BLE",
                    "channel": None,
                    "rssi": rssi,
                    "tx_power": tx_power,
                    "first_seen": now,
                    "last_seen": now,
                    "packet_count": 1,
                    "is_active": True
                }
            else:
                dev = self.devices[key]
                if (dev["name"] == "Unknown Device" or "Apple Device" in dev["name"]) and name != "Unknown Device":
                    dev["name"] = name
                dev["rssi"] = rssi
                if tx_power is not None:
                    dev["tx_power"] = tx_power
                if mfg_name != "BLE Radio" and dev["vendor"] == "BLE Radio":
                    dev["vendor"] = mfg_name
                dev["last_seen"] = now
                dev["packet_count"] += 1
                dev["is_active"] = True

            if key in self.selected_keys:
                if key not in self.filters:
                    self.filters[key] = RadioDistanceFilter(self.custom_n_bt, self.custom_a_bt, "bt")
                est = self.filters[key].process_raw_rssi(rssi, now, tx_power)
                slot_idx = self.selected_keys.index(key) + 1
                self.telemetry_log.append({
                    "timestamp": round(now, 3),
                    "slot": slot_idx,
                    "radio": "BLUETOOTH",
                    "key": key,
                    "address": addr,
                    "name": name,
                    "raw_rssi": rssi,
                    "filtered_rssi": est["rssi_filtered"],
                    "distance_m": est["distance_m"],
                    "distance_ft": est["distance_ft"],
                    "velocity_mps": est["velocity_mps"],
                    "ci_low_m": est["ci_low_m"],
                    "ci_high_m": est["ci_high_m"],
                    "quality_pct": est["signal_quality"]
                })

    def update_wifi_network(self, ssid: str, bssid: str, pct: int, rssi: float, band: str = "Wi-Fi", channel: str = None):
        now = time.time()
        key = f"wifi:{bssid.lower()}"
        disp_name = ssid if ssid else "[Hidden Network]"

        with self.lock:
            if key not in self.devices:
                self.devices[key] = {
                    "key": key,
                    "radio_type": "wifi",
                    "address": bssid.upper(),
                    "name": disp_name,
                    "vendor": "Wi-Fi AP",
                    "band": band,
                    "channel": channel,
                    "rssi": rssi,
                    "tx_power": None,
                    "first_seen": now,
                    "last_seen": now,
                    "packet_count": 1,
                    "is_active": True
                }
            else:
                dev = self.devices[key]
                if dev["name"].startswith("[Hidden") and not disp_name.startswith("[Hidden"):
                    dev["name"] = disp_name
                dev["rssi"] = rssi
                dev["band"] = band
                if channel:
                    dev["channel"] = channel
                dev["last_seen"] = now
                dev["packet_count"] += 1
                dev["is_active"] = True

            if key in self.selected_keys:
                if key not in self.filters:
                    self.filters[key] = RadioDistanceFilter(self.custom_n_wifi, self.custom_a_wifi, "wifi")
                est = self.filters[key].process_raw_rssi(rssi, now)
                slot_idx = self.selected_keys.index(key) + 1
                self.telemetry_log.append({
                    "timestamp": round(now, 3),
                    "slot": slot_idx,
                    "radio": "WIFI",
                    "key": key,
                    "address": bssid.upper(),
                    "name": disp_name,
                    "raw_rssi": rssi,
                    "filtered_rssi": est["rssi_filtered"],
                    "distance_m": est["distance_m"],
                    "distance_ft": est["distance_ft"],
                    "velocity_mps": est["velocity_mps"],
                    "ci_low_m": est["ci_low_m"],
                    "ci_high_m": est["ci_high_m"],
                    "quality_pct": est["signal_quality"]
                })

    def _identify_bt_manufacturer(self, mfg_dict) -> str:
        if not mfg_dict:
            return "BLE Radio"
        sig_map = {
            0x004C: "Apple Inc.",
            0x0006: "Microsoft",
            0x0075: "Samsung Electronics",
            0x00E0: "Google LLC",
            0x0157: "Anker Innovations",
            0x0059: "Nordic Semi",
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
            device_list = []
            for key, dev in self.devices.items():
                time_diff = now - dev["last_seen"]
                is_recent = time_diff < 14.0
                device_list.append({
                    "key": key,
                    "radio_type": dev["radio_type"],
                    "address": dev["address"],
                    "name": dev["name"],
                    "vendor": dev["vendor"],
                    "band": dev["band"],
                    "channel": dev["channel"],
                    "rssi": dev["rssi"],
                    "tx_power": dev["tx_power"],
                    "last_seen_sec": round(time_diff, 1),
                    "is_active": is_recent,
                    "selected": key in self.selected_keys
                })

            device_list.sort(key=lambda d: (d["is_active"], d["rssi"]), reverse=True)

            selected_telemetry = []
            for idx, key in enumerate(self.selected_keys):
                if key in self.devices and key in self.filters:
                    dev = self.devices[key]
                    filt = self.filters[key]
                    time_diff = now - dev["last_seen"]
                    est = filt.process_raw_rssi(dev["rssi"], dev["last_seen"], dev["tx_power"])
                    hist = [{"t": round(pt[0] - now, 2), "d": round(pt[1], 2)} for pt in list(filt.distance_history)[-25:]]

                    pts_count = len(self.calibration_points.get(key, []))
                    selected_telemetry.append({
                        "slot": idx + 1,
                        "key": key,
                        "radio_type": dev["radio_type"],
                        "address": dev["address"],
                        "name": dev["name"],
                        "vendor": dev["vendor"],
                        "band": dev["band"],
                        "rssi_current": dev["rssi"],
                        "tx_power": dev["tx_power"],
                        "calibrated_pts": pts_count,
                        "model_n": round(filt.n, 2),
                        "model_a": round(filt.A, 1),
                        "is_active": (time_diff < 10.0),
                        "last_seen_sec": round(time_diff, 1),
                        "telemetry": est,
                        "history": hist
                    })

            bt_count = sum(1 for d in device_list if d["radio_type"] == "bt" and d["is_active"])
            wifi_count = sum(1 for d in device_list if d["radio_type"] == "wifi" and d["is_active"])

            return {
                "system": {
                    "server_time": now,
                    "total_devices_discovered": len(self.devices),
                    "active_devices_count": len([d for d in device_list if d["is_active"]]),
                    "active_bt_count": bt_count,
                    "active_wifi_count": wifi_count,
                    "environment_key": self.current_env,
                    "n_bt": round(self.custom_n_bt, 2),
                    "a_bt": round(self.custom_a_bt, 1),
                    "n_wifi": round(self.custom_n_wifi, 2),
                    "a_wifi": round(self.custom_a_wifi, 1),
                    "selected_count": len(self.selected_keys),
                    "telemetry_references": TELEMETRY_REFERENCES
                },
                "selected_targets": selected_telemetry,
                "all_devices": device_list
            }

    def generate_csv(self) -> str:
        with self.lock:
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow([
                "Timestamp_Epoch", "Target_Slot", "Radio_Type", "Signal_Key",
                "Hardware_Address", "Device_SSID_Name", "Raw_RSSI_dBm", "Filtered_RSSI_dBm",
                "Distance_Meters", "Distance_Feet", "Radial_Velocity_mps",
                "95CI_Low_Meters", "95CI_High_Meters", "Quality_Percent"
            ])
            for row in self.telemetry_log:
                writer.writerow([
                    row["timestamp"], row["slot"], row["radio"], row["key"],
                    row["address"], row["name"], row["raw_rssi"], row["filtered_rssi"],
                    row["distance_m"], row["distance_ft"], row["velocity_mps"],
                    row["ci_low_m"], row["ci_high_m"], row["quality_pct"]
                ])
            return output.getvalue()

HUB = DualRadioTelemetryHub()

# ---------------------------------------------------------------------------
# Background Windows Wi-Fi Hardware Scanner
# ---------------------------------------------------------------------------
def trigger_hardware_scan_windows():
    try:
        from ctypes import wintypes
        wlan = ctypes.windll.wlanapi
        handle = wintypes.HANDLE()
        neg_version = wintypes.DWORD()
        res = wlan.WlanOpenHandle(2, None, ctypes.byref(neg_version), ctypes.byref(handle))
        if res == 0:
            class WLAN_INTERFACE_INFO(ctypes.Structure):
                _fields_ = [
                    ('InterfaceGuid', ctypes.c_ubyte * 16),
                    ('strInterfaceDescription', ctypes.c_wchar * 256),
                    ('isState', ctypes.c_int)
                ]
            class WLAN_INTERFACE_INFO_LIST(ctypes.Structure):
                _fields_ = [
                    ('dwNumberOfItems', wintypes.DWORD),
                    ('dwIndex', wintypes.DWORD),
                    ('InterfaceInfo', WLAN_INTERFACE_INFO * 1)
                ]
            pList = ctypes.POINTER(WLAN_INTERFACE_INFO_LIST)()
            if wlan.WlanEnumInterfaces(handle, None, ctypes.byref(pList)) == 0:
                if pList.contents.dwNumberOfItems > 0:
                    guid = pList.contents.InterfaceInfo[0].InterfaceGuid
                    wlan.WlanScan(handle, ctypes.byref(guid), None, None, None)
            wlan.WlanCloseHandle(handle, None)
    except Exception:
        pass

def wifi_scanner_loop():
    print("[WI-FI] Starting Windows Wi-Fi Hardware Scanner Thread...")
    while True:
        try:
            trigger_hardware_scan_windows()
            time.sleep(0.3)
            out = subprocess.check_output(
                "netsh wlan show networks mode=bssid",
                shell=True, text=True, stderr=subprocess.DEVNULL
            )
            cur_ssid = ""
            cur_bssid = ""
            cur_band = "Wi-Fi"
            cur_channel = None

            for line in out.splitlines():
                l = line.strip()
                if l.startswith("SSID ") and ":" in l:
                    cur_ssid = l.split(":", 1)[1].strip()
                elif l.startswith("BSSID ") and ":" in l:
                    cur_bssid = l.split(":", 1)[1].strip().lower()
                elif l.startswith("Band") and ":" in l:
                    cur_band = l.split(":", 1)[1].strip()
                elif l.startswith("Channel") and ":" in l:
                    cur_channel = l.split(":", 1)[1].strip()
                elif l.startswith("Signal"):
                    m = re.search(r"(\d+)%", l)
                    if m and cur_bssid:
                        pct = int(m.group(1))
                        # Standard Windows RSSI conversion: dBm = (pct / 2) - 100
                        rssi = round((pct / 2.0) - 100.0, 1)
                        HUB.update_wifi_network(cur_ssid, cur_bssid, pct, rssi, cur_band, cur_channel)
        except Exception:
            pass
        time.sleep(1.2)

# ---------------------------------------------------------------------------
# Background Bluetooth Scanner Task
# ---------------------------------------------------------------------------
async def run_ble_scanner():
    def detection_callback(device, advertisement_data):
        HUB.update_bluetooth_advertisement(device, advertisement_data)

    print("[BLE] Starting Windows Bluetooth LE Scanner Thread...")
    scanner = BleakScanner(detection_callback=detection_callback)

    while True:
        try:
            await scanner.start()
            while True:
                await asyncio.sleep(1.0)
        except Exception:
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
# High-Tech Cyber Tactical UI (Unified Dual-Radio Dashboard)
# ---------------------------------------------------------------------------
DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntoTheClouds | Unified Bluetooth & Wi-Fi Distance Radar & Calibration</title>
  <style>
    :root {
      --bg: #070913;
      --card: #0f1424;
      --card-border: #1a233d;
      --panel-header: #151c33;
      --accent: #00e5ff;       /* Target 1 Neon Cyan */
      --accent2: #00ff88;      /* Target 2 Emerald Green */
      --accent3: #ffaa00;      /* Target 3 Cyber Amber */
      --apple: #a855f7;        /* Apple Purple Accent */
      --wifi: #38bdf8;         /* Wi-Fi Sky Blue */
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
      gap: 10px;
      flex-wrap: wrap;
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

    .btn-action {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 12px;
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

    .btn-action:hover {
      background: rgba(0, 229, 255, 0.15);
      border-color: var(--accent);
      color: var(--accent);
    }

    .btn-action.active {
      background: rgba(0, 255, 136, 0.15);
      border-color: var(--accent2);
      color: var(--accent2);
    }

    /* Environmental & RF Controls Bar */
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

    .env-pill-val {
      font-family: var(--font-mono);
      background: rgba(0,229,255,0.1);
      border: 1px solid rgba(0,229,255,0.3);
      padding: 4px 8px;
      border-radius: 4px;
      color: var(--accent);
      font-size: 0.78rem;
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

    /* Dual Calibration Banner Card */
    .calibration-banner {
      background: linear-gradient(135deg, rgba(168, 85, 247, 0.12), rgba(56, 189, 248, 0.12));
      border: 1px solid rgba(168, 85, 247, 0.4);
      border-radius: 12px;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .calib-info h4 {
      color: #e9d5ff;
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
    }

    .calib-info p {
      font-size: 0.8rem;
      color: #c084fc;
      margin-top: 3px;
    }

    .calib-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .select-calib-target {
      background: #090d18;
      border: 1px solid #7e22ce;
      color: #fff;
      padding: 6px 10px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      outline: none;
    }

    .input-dist {
      background: #090d18;
      border: 1px solid #7e22ce;
      color: #fff;
      padding: 6px 10px;
      border-radius: 6px;
      width: 75px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      text-align: center;
      outline: none;
    }

    .btn-calib-action {
      background: #7e22ce;
      border: 1px solid #a855f7;
      color: #fff;
      padding: 6px 14px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-calib-action:hover {
      background: #9333ea;
      box-shadow: 0 0 12px rgba(168, 85, 247, 0.4);
    }

    /* Primary HUD Grid: Left Radar, Right Target Dossiers */
    .hud-grid {
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 16px;
    }

    @media (max-width: 1080px) {
      .hud-grid { grid-template-columns: 1fr; }
    }

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

    /* Right Column: Target Dossiers */
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

    .target-header-buttons {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .badge-radio-tag {
      font-size: 0.72rem;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-weight: 700;
      text-transform: uppercase;
    }

    .badge-radio-bt {
      background: rgba(168, 85, 247, 0.2);
      border: 1px solid var(--apple);
      color: #e9d5ff;
    }

    .badge-radio-wifi {
      background: rgba(56, 189, 248, 0.2);
      border: 1px solid var(--wifi);
      color: #38bdf8;
    }

    .btn-target-calib {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid var(--apple);
      color: #e9d5ff;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      transition: all 0.2s;
    }

    .btn-target-calib:hover {
      background: var(--apple);
      color: #fff;
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

    /* All Discovered Signals Section */
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

    .discovery-filter-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .btn-filter-pill {
      background: #141b2f;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-filter-pill:hover, .btn-filter-pill.active {
      background: var(--accent);
      color: #000;
      font-weight: 700;
      border-color: var(--accent);
    }

    .btn-filter-apple {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid var(--apple);
      color: #e9d5ff;
      padding: 6px 12px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      cursor: pointer;
    }

    .btn-filter-apple:hover { background: var(--apple); color: #fff; }

    .search-filter-box {
      background: #080c16;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 6px 14px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 0.85rem;
      width: 200px;
      outline: none;
    }

    .search-filter-box:focus { border-color: var(--accent); }

    .devices-table-wrap {
      max-height: 420px;
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
    tbody tr.is-selected { background: rgba(0, 229, 255, 0.08); }
    tbody tr.is-apple { border-left: 3px solid var(--apple); }
    tbody tr.is-wifi { border-left: 3px solid var(--wifi); }

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

    .badge-apple-tag {
      font-size: 0.68rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(168, 85, 247, 0.2);
      color: #e9d5ff;
      border: 1px solid rgba(168, 85, 247, 0.4);
      font-family: var(--font-mono);
    }

    .badge-wifi-tag {
      font-size: 0.68rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.2);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.4);
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
        <h1>IntoTheClouds <span style="font-size: 0.85rem; color: var(--accent); font-weight: 400;">// DUAL RF RADAR</span></h1>
        <div class="brand-subtitle">Unified Bluetooth & Wi-Fi Telemetry, Kalman State Filter & Calibrator</div>
      </div>
    </div>
    <div class="header-actions">
      <div class="badge-status">
        <span class="pulse-dot"></span>
        <span id="activeDeviceCount">Scanning...</span>
      </div>
      <button id="btnSonar" class="btn-action" onclick="toggleSonar()">
        🔊 Sonar: OFF
      </button>
      <a href="/api/export_csv" class="btn-action" download="rf_telemetry.csv">
        📥 Export CSV
      </a>
      <a href="#telemetrySection" class="btn-action">
        Spec
      </a>
    </div>
  </header>

  <!-- Interactive Dual Calibration Banner -->
  <div class="calibration-banner">
    <div class="calib-info">
      <h4>🎯 Dual Radio Precision Calibration (Bluetooth & Wi-Fi)</h4>
      <p id="calibSubtext">Place your target (iPhone or Wi-Fi router) at a known distance, select it below, and click Calibrate!</p>
    </div>
    <div class="calib-controls">
      <span class="env-label" style="color: #e9d5ff;">Target:</span>
      <select id="calibTargetSelect" class="select-calib-target">
        <option value="">(Select from Active Targets)</option>
      </select>
      <span class="env-label" style="color: #e9d5ff; margin-left: 6px;">Dist:</span>
      <input type="number" id="calibDistInput" class="input-dist" value="1.0" step="0.5" min="0.3" max="15.0">
      <span style="font-size: 0.8rem; color: #c084fc; font-family: var(--font-mono);">meters</span>
      <button class="btn-calib-action" onclick="calibrateSelectedTarget()">Record & Calibrate</button>
      <button class="btn-quick" style="border-color: #7e22ce;" onclick="resetCalib()">Reset</button>
    </div>
  </div>

  <!-- Environment & Preset Controls -->
  <div class="env-toolbar">
    <div class="env-group">
      <span class="env-label">Profile:</span>
      <select id="envSelect" class="env-select" onchange="onEnvChange()">
        <option value="office">🏢 ITU-R P.1238 Office (n=3.0 / 2.8)</option>
        <option value="residential">🏠 ITU-R P.1238 Residential (n=2.8 / 2.6)</option>
        <option value="commercial">🏬 ITU-R Commercial / Open (n=2.2 / 2.2)</option>
        <option value="industrial">🏭 Industrial / Concrete (n=3.8 / 3.4)</option>
        <option value="freespace">🪐 Free Space (n=2.0 / 2.0)</option>
        <option value="custom">⚙️ Custom Calibrated Profile</option>
      </select>
    </div>

    <div class="env-group">
      <span class="env-label">BLE (n / A):</span>
      <span id="displayBt" class="env-pill-val">n=3.00, A=-59.0</span>
      <span class="env-label" style="margin-left: 8px;">Wi-Fi (n / A):</span>
      <span id="displayWifi" class="env-pill-val">n=2.80, A=-40.0</span>
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

    <div class="targets-column" id="targetsContainer"></div>
  </div>

  <!-- Discovered Signals Section -->
  <div class="discovery-section">
    <div class="discovery-header">
      <h2>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Discovered Bluetooth & Wi-Fi Signals Around You
        <span id="totalDiscoveredCount" style="color: var(--muted); font-size: 0.85rem; font-weight: 400;">(0 found)</span>
      </h2>
      <div class="discovery-filter-actions">
        <button id="pillFilterAll" class="btn-filter-pill active" onclick="setRadioFilter('all')">All Signals</button>
        <button id="pillFilterBt" class="btn-filter-pill" onclick="setRadioFilter('bt')">📶 Bluetooth Only</button>
        <button id="pillFilterWifi" class="btn-filter-pill" onclick="setRadioFilter('wifi')">🌐 Wi-Fi Only</button>
        <button class="btn-filter-apple" onclick="setRadioFilter('apple')">🍎 Apple Devices</button>
        <input type="text" id="searchFilter" class="search-filter-box" placeholder="Filter name, MAC, SSID..." oninput="renderDevicesTable()">
      </div>
    </div>

    <div class="devices-table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 70px;">Track</th>
            <th style="width: 80px;">Type</th>
            <th>Signal Name / Identifier</th>
            <th>Band / Channel</th>
            <th>Vendor / Security</th>
            <th>Signal (RSSI)</th>
            <th>Last Ping</th>
          </tr>
        </thead>
        <tbody id="devicesTableBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Mathematical Telemetry Dossier & Citations -->
  <div class="telemetry-dossier" id="telemetrySection">
    <h3>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
      Dual-Radio Telemetry & Mathematical Foundation
    </h3>

    <div class="formula-banner">
      <strong>1. ITU-R Recommendation P.1238 Indoor Path Loss Formula:</strong><br>
      $$L_{\\text{total}} = 20 \\log_{10}(f) + N \\log_{10}(d) + P_f(n_{\\text{floor}}) - 28$$<br>
      Solving for distance with calibrated 1-meter reference power $A$ ($P_0$):<br>
      <span class="highlight">$$\\hat{d}_{\\text{raw}} = 10^{\\frac{A - \\text{RSSI}}{10 \\cdot n}}$$</span>
      <br><br>
      <strong>2. Differences Between Bluetooth & Wi-Fi Indoor Telemetry:</strong><br>
      &bull; <strong>Bluetooth LE:</strong> Operates at lower transmit powers (+0 dBm to +10 dBm). Reference $A_{\\text{BT}} \\approx -45\\text{ to } -60\\text{ dBm}$. Highly sensitive to human body shadowing ($n \\approx 2.8 - 3.2$).<br>
      &bull; <strong>Wi-Fi (WLAN):</strong> Access points transmit at higher power (+17 dBm to +23 dBm). Reference $A_{\\text{WiFi}} \\approx -35\\text{ to } -42\\text{ dBm}$. Lower path loss ($n \\approx 2.4 - 2.8$).<br>
      &bull; <strong>Linear Regression Calibration:</strong> Multi-point measurements fit $\\text{RSSI}_i = A - 10 \\cdot n \\cdot \\log_{10}(d_i)$ to calibrate $A$ and $n$ independently for every device.
    </div>

    <div class="citations-grid">
      <div class="citation-card">
        <div class="citation-title">ITU-R Recommendation P.1238-11</div>
        <div class="citation-desc">
          The International Telecommunication Union's authoritative standard for indoor radiocommunication planning and propagation loss across residential, commercial, and office spaces.
        </div>
        <a href="https://www.itu.int/rec/R-REC-P.1238/en" target="_blank" rel="noopener" class="citation-link">
          Official Telemetry Portal: itu.int/rec/R-REC-P.1238 &rarr;
        </a>
      </div>

      <div class="citation-card">
        <div class="citation-title">MDPI Sensors Journal & NIST Indoor Telemetry</div>
        <div class="citation-desc">
          Peer-reviewed research detailing empirical calibration of BLE & Wi-Fi path loss exponents, log-normal shadowing models, and Kalman filtering for indoor tracking in multipath environments.
        </div>
        <a href="https://www.mdpi.com/journal/sensors" target="_blank" rel="noopener" class="citation-link">
          MDPI Telemetry Research: mdpi.com/journal/sensors &rarr;
        </a>
      </div>
    </div>
  </div>
</div>

<div id="toastNotice">⚠️ Maximum 3 signals selected! Uncheck an active signal first.</div>

<script>
  let dashboardData = null;
  let radarAngle = 0;
  let currentRadioFilter = "all";
  const canvas = document.getElementById("radarCanvas");
  const ctx = canvas.getContext("2d");

  const SLOT_COLORS = ["#00e5ff", "#00ff88", "#ffaa00"];

  let audioCtx = null;
  let sonarEnabled = false;
  let lastSonarTime = 0;

  function toggleSonar() {
    sonarEnabled = !sonarEnabled;
    const btn = document.getElementById("btnSonar");
    if (sonarEnabled) {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      btn.textContent = "🔊 Sonar: ON";
      btn.classList.add("active");
    } else {
      btn.textContent = "🔊 Sonar: OFF";
      btn.classList.remove("active");
    }
  }

  function playSonarPing(distance) {
    if (!sonarEnabled || !audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const clampedD = Math.max(0.3, Math.min(distance, 15.0));
      const freq = 880 - (clampedD / 15.0) * 500;
      
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.08);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.09);
    } catch (e) {}
  }

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
    document.getElementById("activeDeviceCount").textContent = `${sys.active_bt_count} BLE | ${sys.active_wifi_count} Wi-Fi`;
    document.getElementById("totalDiscoveredCount").textContent = `(${sys.total_devices_discovered} total signals)`;
    document.getElementById("selectionCounterBadge").textContent = `${sys.selected_count} / 3`;

    document.getElementById("displayBt").textContent = `n=${sys.n_bt.toFixed(2)}, A=${sys.a_bt.toFixed(1)} dBm`;
    document.getElementById("displayWifi").textContent = `n=${sys.n_wifi.toFixed(2)}, A=${sys.a_wifi.toFixed(1)} dBm`;

    if (sys.environment_key === "custom") {
      document.getElementById("envSelect").value = "custom";
    }

    updateCalibDropdown();
    renderTargetDossiers();
    renderDevicesTable();

    const targets = dashboardData.selected_targets || [];
    if (targets.length > 0 && sonarEnabled) {
      const closest = Math.min(...targets.map(t => t.telemetry.distance_m));
      const now = Date.now();
      const intervalMs = Math.max(350, Math.min(2000, closest * 180));
      if (now - lastSonarTime > intervalMs) {
        lastSonarTime = now;
        playSonarPing(closest);
      }
    }
  }

  function updateCalibDropdown() {
    const sel = document.getElementById("calibTargetSelect");
    const targets = dashboardData ? dashboardData.selected_targets : [];
    const prevVal = sel.value;

    let optHtml = `<option value="">(Select Target)</option>`;
    targets.forEach(t => {
      const rTag = t.radio_type === "wifi" ? "🌐 Wi-Fi" : "📶 BLE";
      optHtml += `<option value="${t.key}">${rTag} [Slot ${t.slot}] ${t.name.substring(0, 18)}</option>`;
    });
    sel.innerHTML = optHtml;
    if (prevVal && targets.some(t => t.key === prevVal)) {
      sel.value = prevVal;
    } else if (targets.length > 0) {
      sel.value = targets[0].key;
    }
  }

  function renderTargetDossiers() {
    const container = document.getElementById("targetsContainer");
    const targets = dashboardData.selected_targets || [];

    for (let i = 0; i < 3; i++) {
      const leg = document.getElementById(`legendT${i+1}`);
      if (targets[i]) {
        const rIcon = targets[i].radio_type === "wifi" ? "🌐" : "📶";
        leg.textContent = `${rIcon} T${i+1}: ${targets[i].name.substring(0, 12)} (${targets[i].telemetry.distance_m}m)`;
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
        const isWifi = target.radio_type === "wifi";
        const rBadgeClass = isWifi ? "badge-radio-wifi" : "badge-radio-bt";
        const rIcon = isWifi ? "🌐 WI-FI" : "📶 BLE";

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
                  <span class="badge-radio-tag ${rBadgeClass}">${rIcon}</span>
                  <span style="font-size: 0.8rem; background: ${color}22; padding: 2px 8px; border-radius: 4px; border: 1px solid ${color};">SLOT ${slot}</span>
                  ${escapeHtml(target.name)}
                </h3>
                <div class="target-mac">${target.address} &bull; <span style="color: #94a3b8;">${escapeHtml(target.vendor)} (${target.band})</span></div>
              </div>
              <div class="target-header-buttons">
                <button class="btn-target-calib" onclick="quickCalibrateKey('${target.key}', 1.0)">🎯 Calib 1m</button>
                <button class="btn-unselect" onclick="toggleSelect('${target.key}')">✕ Release</button>
              </div>
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
                  <span class="ci-pill">95% CI: [${tel.ci_low_m}m &ndash; ${tel.ci_high_m}m] &bull; A=${target.model_a}dBm, n=${target.model_n}</span>
                </div>
              </div>

              <div class="stat-metric-block">
                <span class="metric-label">Signal (RSSI)</span>
                <span class="metric-val" style="color: ${target.rssi_current >= -65 ? 'var(--accent2)' : 'var(--accent3)'};">
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
            <span>+ Slot ${slot} Available &mdash; Check any Bluetooth device or Wi-Fi signal below to track</span>
          </div>
        `;
      }
    }
    container.innerHTML = html;

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

    sctx.lineTo(w - 4, h);
    sctx.lineTo(4, h);
    sctx.fillStyle = color + "22";
    sctx.fill();
  }

  function setRadioFilter(type) {
    currentRadioFilter = type;
    document.querySelectorAll(".btn-filter-pill").forEach(p => p.classList.remove("active"));
    if (type === "all") document.getElementById("pillFilterAll").classList.add("active");
    if (type === "bt") document.getElementById("pillFilterBt").classList.add("active");
    if (type === "wifi") document.getElementById("pillFilterWifi").classList.add("active");
    renderDevicesTable();
  }

  function renderDevicesTable() {
    const tbody = document.getElementById("devicesTableBody");
    if (!dashboardData) return;

    const filterText = (document.getElementById("searchFilter").value || "").toLowerCase().trim();
    const devices = dashboardData.all_devices || [];

    const filtered = devices.filter(d => {
      if (currentRadioFilter === "bt" && d.radio_type !== "bt") return false;
      if (currentRadioFilter === "wifi" && d.radio_type !== "wifi") return false;
      if (currentRadioFilter === "apple") {
        const isApple = (d.vendor && d.vendor.toLowerCase().includes("apple")) ||
                        (d.name && d.name.toLowerCase().includes("apple"));
        if (!isApple) return false;
      }

      if (!filterText) return true;
      return (d.name && d.name.toLowerCase().includes(filterText)) ||
             (d.address && d.address.toLowerCase().includes(filterText)) ||
             (d.vendor && d.vendor.toLowerCase().includes(filterText)) ||
             (d.band && d.band.toLowerCase().includes(filterText));
    });

    let rowsHtml = "";
    filtered.forEach(d => {
      const isSel = d.selected;
      const isWifi = d.radio_type === "wifi";
      const isApple = (d.vendor && d.vendor.toLowerCase().includes("apple")) ||
                      (d.name && d.name.toLowerCase().includes("apple"));
      const rssiColor = d.rssi >= -60 ? "var(--accent2)" : (d.rssi >= -75 ? "var(--accent)" : "var(--accent3)");
      const rBadge = isWifi ? `<span class="badge-radio-tag badge-radio-wifi">Wi-Fi</span>` : `<span class="badge-radio-tag badge-radio-bt">BLE</span>`;

      rowsHtml += `
        <tr class="${isSel ? 'is-selected' : ''} ${isApple ? 'is-apple' : ''} ${isWifi ? 'is-wifi' : ''}">
          <td>
            <button class="btn-select-toggle ${isSel ? 'active' : ''}" onclick="toggleSelect('${d.key}')">
              ${isSel ? '✓ Track' : '+ Track'}
            </button>
          </td>
          <td>${rBadge}</td>
          <td>
            <div class="dev-name">
              <span>${isApple ? '🍎 ' : (isWifi ? '🌐 ' : '📶 ')}${escapeHtml(d.name)}</span>
            </div>
            <div class="dev-addr">${d.address}</div>
          </td>
          <td style="font-family: var(--font-mono); font-size: 0.8rem; color: #94a3b8;">
            ${escapeHtml(d.band)}${d.channel ? ` (Ch ${d.channel})` : ''}
          </td>
          <td>
            <span class="${isApple ? 'badge-apple-tag' : (isWifi ? 'badge-wifi-tag' : 'badge-dev-mfg')}">${escapeHtml(d.vendor)}</span>
          </td>
          <td class="dev-rssi-cell" style="color: ${rssiColor}">
            ${d.rssi} dBm
          </td>
          <td style="font-family: var(--font-mono); font-size: 0.8rem; color: ${d.is_active ? 'var(--text)' : 'var(--muted)'};">
            ${d.last_seen_sec <= 2 ? 'Just now' : d.last_seen_sec + 's ago'}
          </td>
        </tr>
      `;
    });

    if (filtered.length === 0) {
      rowsHtml = `<tr><td colspan="7" style="text-align: center; color: var(--muted); padding: 24px;">No signals matching filter.</td></tr>`;
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

    ctx.strokeStyle = "rgba(0, 229, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy);
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(radarAngle);
    
    const trailGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
    trailGrad.addColorStop(0, "rgba(0, 229, 255, 0.2)");
    trailGrad.addColorStop(1, "rgba(0, 229, 255, 0.0)");

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, maxRadius, -Math.PI / 4, 0);
    ctx.closePath();
    ctx.fillStyle = trailGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(maxRadius, 0);
    ctx.strokeStyle = "rgba(0, 229, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#00e5ff";
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#627299";
    ctx.fillText("HOST", cx - 13, cy + 16);

    if (dashboardData && dashboardData.selected_targets) {
      dashboardData.selected_targets.forEach((tgt, idx) => {
        const color = SLOT_COLORS[idx];
        const dist = tgt.telemetry.distance_m;
        const normDist = Math.min(dist / 20.0, 1.05);
        const rPix = normDist * maxRadius;

        const fixedAngles = [-Math.PI / 3, Math.PI / 3, Math.PI];
        const angle = fixedAngles[idx % fixedAngles.length];

        const tx = cx + Math.cos(angle) * rPix;
        const ty = cy + Math.sin(angle) * rPix;

        const pulse = (Date.now() / 300 + idx) % 2;
        ctx.beginPath();
        ctx.arc(tx, ty, 8 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(tx, ty, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;

        const rIcon = tgt.radio_type === "wifi" ? "WIFI" : "BT";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px monospace";
        ctx.fillText(`T${tgt.slot} [${rIcon}]: ${dist}m`, tx + 9, ty + 3);
      });
    }

    requestAnimationFrame(drawRadar);
  }

  // --- API Handlers ---
  async function toggleSelect(key) {
    try {
      const res = await fetch(`/api/select?key=${encodeURIComponent(key)}`, { method: "POST" });
      const data = await res.json();
      if (!data.success && data.reason === "max_reached") {
        showToast();
      }
      fetchTelemetry();
    } catch (e) {
      console.error(e);
    }
  }

  async function quickCalibrateKey(key, dist) {
    await performCalibration(key, dist);
  }

  async function calibrateSelectedTarget() {
    const key = document.getElementById("calibTargetSelect").value;
    if (!key) {
      alert("Please select an active target from the calibration dropdown first!");
      return;
    }
    const dist = parseFloat(document.getElementById("calibDistInput").value) || 1.0;
    await performCalibration(key, dist);
  }

  async function performCalibration(key, dist) {
    try {
      const res = await fetch(`/api/calibrate?key=${encodeURIComponent(key)}&dist=${dist}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        alert(`🎯 Calibration Success (${data.radio_type})!\n${data.message}\nMeasured RSSI: ${data.mean_rssi} dBm (±${data.std_rssi} dB)\nSampled: ${data.sample_count} packets`);
      } else {
        alert(`Notice: ${data.reason}`);
      }
      fetchTelemetry();
    } catch (e) {
      console.error(e);
    }
  }

  async function resetCalib() {
    await fetch("/api/reset_calib", { method: "POST" });
    alert("Calibration points cleared. Reset to default environment.");
    fetchTelemetry();
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
        elif parsed.path == "/api/export_csv":
            csv_data = HUB.generate_csv()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Disposition", "attachment; filename=rf_telemetry.csv")
            self.end_headers()
            self.wfile.write(csv_data.encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/api/select":
            key = params.get("key", [None])[0]
            if key:
                ok = HUB.select_device(key)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                resp = {"success": ok}
                if not ok:
                    resp["reason"] = "max_reached"
                self.wfile.write(json.dumps(resp).encode("utf-8"))
                return
        elif parsed.path == "/api/calibrate":
            key = params.get("key", [None])[0]
            dist = float(params.get("dist", [1.0])[0])
            res = HUB.calibrate_step(key, dist)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return
        elif parsed.path == "/api/reset_calib":
            key = params.get("key", [None])[0]
            HUB.reset_calibration(key)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success": true}')
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
# Terminal CLI Monitor Mode
# ---------------------------------------------------------------------------
def run_cli_loop():
    print("[CLI] Entering Live Terminal Dual-RF Telemetry Mode (Ctrl+C to stop)...")
    time.sleep(2.0)
    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            payload = HUB.get_dashboard_payload()
            sys_info = payload["system"]
            targets = payload["selected_targets"]

            print("=" * 76)
            print(f"  IntoTheClouds: Unified Dual-Radio Distance Radar (CLI)")
            print(f"  Active Signals: {sys_info['active_bt_count']} BLE | {sys_info['active_wifi_count']} Wi-Fi (Total: {sys_info['total_devices_discovered']})")
            print(f"  BLE Profile:   n={sys_info['n_bt']:.2f}, A={sys_info['a_bt']:.1f} dBm")
            print(f"  Wi-Fi Profile: n={sys_info['n_wifi']:.2f}, A={sys_info['a_wifi']:.1f} dBm")
            print("=" * 76)

            if not targets:
                print("\n  [No targets selected. Tracking strongest 3 signals...]")
                HUB.select_strongest_three()
            else:
                for t in targets:
                    tel = t["telemetry"]
                    r_tag = "WI-FI" if t["radio_type"] == "wifi" else "BLE  "
                    bars = "#" * max(1, min(18, int((t["rssi_current"] + 100) / 2.5)))
                    vel_str = f"{tel['velocity_mps']:+.2f} m/s"
                    print(f"\n  [SLOT {t['slot']} | {r_tag}] {t['name'][:22]} ({t['address']}) [{t['vendor']}]")
                    print(f"    Distance: {tel['distance_m']:.2f} m  ({tel['distance_ft']:.1f} ft) | 95% CI: [{tel['ci_low_m']:.2f}m - {tel['ci_high_m']:.2f}m]")
                    print(f"    Signal:   {t['rssi_current']} dBm  [{bars:<18}]  (Quality: {tel['signal_quality']}%)")
                    print(f"    Velocity: {vel_str} | Model: A={t['model_a']}dBm, n={t['model_n']}")

            print("\n" + "-" * 76)
            print("  Dashboard UI active at: http://127.0.0.1:8888")
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nExiting CLI...")

# ---------------------------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------------------------
def main():
    port = 8888
    cli_mode = "--cli" in sys.argv

    for arg in sys.argv[1:]:
        if arg.isdigit():
            port = int(arg)

    print("=" * 74)
    print("  IntoTheClouds: Unified Bluetooth & Wi-Fi Distance Radar & Calibration")
    print("=" * 74)
    print("  Mathematical Framework: ITU-R Recommendation P.1238-11")
    print("  Radio Scanners:         Windows Bluetooth LE + Native WLAN Wi-Fi")
    print("  Estimation Engine:      Adaptive 2D Kinematic Kalman Filter")
    print("  Precision Calibrator:   Independent Multi-Point Calibration (BLE + Wi-Fi)")
    print("-" * 74)

    # 1. Start Bluetooth LE Scanner Thread
    ble_thread = threading.Thread(target=start_ble_thread, daemon=True)
    ble_thread.start()

    # 2. Start Wi-Fi Scanner Thread
    wifi_thread = threading.Thread(target=wifi_scanner_loop, daemon=True)
    wifi_thread.start()

    # 3. Start HTTP & Dashboard Server
    server_address = ("127.0.0.1", port)
    try:
        httpd = HTTPServer(server_address, DashboardRequestHandler)
    except OSError:
        port = 8889
        server_address = ("127.0.0.1", port)
        httpd = HTTPServer(server_address, DashboardRequestHandler)

    url = f"http://127.0.0.1:{port}"
    print(f"[DASHBOARD] Tactical Radar Server running at: {url}")

    if not cli_mode:
        print("[DASHBOARD] Opening your default web browser...")
        def open_browser():
            time.sleep(1.2)
            webbrowser.open(url)
        threading.Thread(target=open_browser, daemon=True).start()

    http_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    http_thread.start()

    if cli_mode:
        run_cli_loop()
    else:
        print("[READY] Dashboard live. Press Ctrl+C to terminate.")
        print("=" * 74)
        try:
            while True:
                time.sleep(1.0)
        except KeyboardInterrupt:
            print("\n[STOPPING] Shutting down Dual-Radio Radar...")
            httpd.server_close()
            sys.exit(0)

if __name__ == "__main__":
    main()
