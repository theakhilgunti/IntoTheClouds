#!/usr/bin/env python3
"""
=============================================================================
  IntoTheClouds: 2D Tactical Grid Mapper & Hotspot Trilateration Suite
  (30m x 30m Coordinate Space with 3 Windows 11 Laptop Hotspot Anchors)
=============================================================================
Designed for real-time 2D indoor positioning using 3 Wi-Fi Hotspots:
- Anchor 1 at Origin (0m, 0m)
- Anchor 2 at X-Axis (30m, 0m)
- Anchor 3 at Y-Axis (0m, 30m)

Features:
- Sub-second update rate (<1s) powered by native Windows wlanapi.dll C API (<10ms query).
- Concurrent Bleak BLE scanner for dual-radio support (Wi-Fi + BLE).
- Assign any discovered Wi-Fi Hotspot (SSID/BSSID) or BLE beacon to each anchor.
- Closed-form orthogonal trilateration + Weighted Non-Linear Least Squares (WNLS).
- 2D Kinematic Kalman Filter (continuous-time white noise acceleration) for butter-smooth tracking.
- Independent 1-click calibration for each anchor (1m reference A and room exponent n).
- Real-time 60 FPS HTML5 Canvas HUD with metric grid, proximity rings, motion trail,
  pan/zoom controls, live speed/heading telemetry, and Web Audio sonar ping.
- Real-time Server-Sent Events (SSE) streaming updates at 5 Hz with latency monitor.

Usage:
  python wifi_2d_grid_mapper.py [--port 8899] [--mock]
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
from ctypes import wintypes
import subprocess
import asyncio
import threading
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from collections import deque

# High-level mathematical libraries
import numpy as np
import scipy.optimize as opt
import scipy.stats as stats

# Bluetooth LE Library (optional fallback)
try:
    import bleak
    from bleak import BleakScanner
    HAS_BLEAK = True
except ImportError:
    HAS_BLEAK = False

# =============================================================================
# Windows Native WLAN API (wlanapi.dll) Structures & Bindings
# =============================================================================

class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', ctypes.c_byte * 8)
    ]

class WLAN_INTERFACE_INFO(ctypes.Structure):
    _fields_ = [
        ('InterfaceGuid', GUID),
        ('strInterfaceDescription', wintypes.WCHAR * 256),
        ('isState', wintypes.DWORD)
    ]

class WLAN_INTERFACE_INFO_LIST(ctypes.Structure):
    _fields_ = [
        ('dwNumberOfItems', wintypes.DWORD),
        ('dwIndex', wintypes.DWORD),
        ('InterfaceInfo', WLAN_INTERFACE_INFO * 1)
    ]

class DOT11_SSID(ctypes.Structure):
    _fields_ = [
        ('uSSIDLength', wintypes.ULONG),
        ('ucSSID', ctypes.c_char * 32)
    ]

class WLAN_RATE_SET(ctypes.Structure):
    _fields_ = [
        ('uRateSetLength', wintypes.ULONG),
        ('usRateSet', wintypes.USHORT * 126)
    ]

class WLAN_BSS_ENTRY(ctypes.Structure):
    _fields_ = [
        ('dot11Ssid', DOT11_SSID),
        ('uPhyId', wintypes.ULONG),
        ('dot11Bssid', ctypes.c_ubyte * 6),
        ('dot11BssType', wintypes.DWORD),
        ('dot11BssPhyType', wintypes.DWORD),
        ('lRssi', ctypes.c_long),
        ('uLinkQuality', wintypes.ULONG),
        ('bInRegDomain', wintypes.BOOLEAN),
        ('usBeaconPeriod', wintypes.USHORT),
        ('ullTimestamp', ctypes.c_ulonglong),
        ('ullHostTimestamp', ctypes.c_ulonglong),
        ('usCapabilityInformation', wintypes.USHORT),
        ('ulChCenterFrequency', wintypes.ULONG),
        ('wlanRateSet', WLAN_RATE_SET),
        ('ulIeOffset', wintypes.ULONG),
        ('ulIeSize', wintypes.ULONG),
    ]

# =============================================================================
# Global State & Configuration Persistence
# =============================================================================

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anchors_config.json")

def detect_lan_ip() -> str:
    """Detect LAN IPv4 address for multi-device/phone access."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

class GlobalState:
    def __init__(self):
        self.lock = threading.Lock()
        self.lan_ip = detect_lan_ip()
        
        # Grid parameters (meters)
        self.grid_width = 30.0   # X-axis extent (meters)
        self.grid_height = 30.0  # Y-axis extent (meters)
        
        # 3 Anchor configurations
        self.anchors = {
            1: {
                "id": 1,
                "name": "Anchor 1 (Origin)",
                "x": 0.0,
                "y": 0.0,
                "signal_id": None,    # e.g. "wifi:a0:93:51:81:99:4f"
                "signal_name": "Unassigned",
                "A_ref": -42.0,       # 1-meter reference RSSI (dBm)
                "n_exp": 2.40,        # Path loss exponent
                "color": "#00f0ff",   # Neon Cyan
                "last_rssi": None,
                "distance_m": None,
                "dist_ci_low": None,
                "dist_ci_high": None,
                "samples_count": 0,
                "history": deque(maxlen=30)
            },
            2: {
                "id": 2,
                "name": "Anchor 2 (X-Axis)",
                "x": 30.0,
                "y": 0.0,
                "signal_id": None,
                "signal_name": "Unassigned",
                "A_ref": -42.0,
                "n_exp": 2.40,
                "color": "#00ff9d",   # Emerald Green
                "last_rssi": None,
                "distance_m": None,
                "dist_ci_low": None,
                "dist_ci_high": None,
                "samples_count": 0,
                "history": deque(maxlen=30)
            },
            3: {
                "id": 3,
                "name": "Anchor 3 (Y-Axis)",
                "x": 0.0,
                "y": 30.0,
                "signal_id": None,
                "signal_name": "Unassigned",
                "A_ref": -42.0,
                "n_exp": 2.40,
                "color": "#ffb800",   # Golden Amber
                "last_rssi": None,
                "distance_m": None,
                "dist_ci_low": None,
                "dist_ci_high": None,
                "samples_count": 0,
                "history": deque(maxlen=30)
            }
        }
        
        # All discovered signals: signal_id -> info dict
        self.signals = {}
        
        # Trilateration and Kalman Filter state
        self.kf_state = np.array([15.0, 15.0, 0.0, 0.0], dtype=float) # [x, y, vx, vy]
        self.kf_cov = np.eye(4, dtype=float) * 4.0
        self.last_kf_time = time.time()
        
        # Position results
        self.pos_x = 15.0
        self.pos_y = 15.0
        self.vel_x = 0.0
        self.vel_y = 0.0
        self.speed = 0.0
        self.heading_deg = 0.0
        self.hdop = 1.0
        self.fix_type = "INITIALIZING" # "3-ANCHOR FIX", "2-ANCHOR FIX", "DEAD RECKONING"
        self.last_update_time = time.time()
        self.update_interval_ms = 250.0
        self.update_rate_hz = 4.0
        
        # Movement Breadcrumb Trail: list of [x, y, timestamp]
        self.breadcrumb_trail = deque(maxlen=150)
        
        # CSV Export Log: list of dicts
        self.telemetry_log = deque(maxlen=5000)
        
        # Active SSE client queues
        self.sse_queues = []
        
        # Simulation / Mock mode
        self.mock_mode = False
        self.mock_phase = 0.0
        
        # Automatically load saved configuration if available
        self.load_config()

    def save_config(self):
        """Persist current anchor assignments and calibration to JSON file."""
        try:
            cfg = {
                "grid_width": self.grid_width,
                "grid_height": self.grid_height,
                "anchors": {
                    str(aid): {
                        "signal_id": a["signal_id"],
                        "signal_name": a["signal_name"],
                        "A_ref": a["A_ref"],
                        "n_exp": a["n_exp"],
                        "x": a["x"],
                        "y": a["y"]
                    } for aid, a in self.anchors.items()
                }
            }
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
            print(f"[CONFIG] Saved anchor settings to {CONFIG_PATH}")
        except Exception as e:
            print(f"[CONFIG] Save error: {e}")

    def load_config(self):
        """Restore anchor assignments and calibration from JSON file."""
        if not os.path.exists(CONFIG_PATH):
            return
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if "grid_width" in cfg:
                self.grid_width = float(cfg["grid_width"])
            if "grid_height" in cfg:
                self.grid_height = float(cfg["grid_height"])
            if "anchors" in cfg:
                for aid_str, a_cfg in cfg["anchors"].items():
                    aid = int(aid_str)
                    if aid in self.anchors:
                        self.anchors[aid]["signal_id"] = a_cfg.get("signal_id")
                        self.anchors[aid]["signal_name"] = a_cfg.get("signal_name", "Unassigned")
                        self.anchors[aid]["A_ref"] = float(a_cfg.get("A_ref", -42.0))
                        self.anchors[aid]["n_exp"] = float(a_cfg.get("n_exp", 2.40))
                        self.anchors[aid]["x"] = float(a_cfg.get("x", self.anchors[aid]["x"]))
                        self.anchors[aid]["y"] = float(a_cfg.get("y", self.anchors[aid]["y"]))
            print(f"[CONFIG] Loaded saved anchor settings from {CONFIG_PATH}")
        except Exception as e:
            print(f"[CONFIG] Load error: {e}")

STATE = GlobalState()

# =============================================================================
# High-Level Mathematical Models: ITU-R P.1238, Trilateration & Kalman Filter
# =============================================================================

def rssi_to_distance(rssi_dbm: float, A_ref: float, n_exp: float) -> tuple[float, float, float]:
    """
    Invert the Log-Distance Path Loss model (ITU-R Recommendation P.1238):
      RSSI = A - 10 * n * log10(d) + X_sigma
      d = 10 ^ ((A - RSSI) / (10 * n))
    
    Returns:
      (distance_m, ci_95_low, ci_95_high)
    """
    if rssi_dbm >= 0 or n_exp <= 0:
        return 0.5, 0.3, 0.8
    
    # Path loss exponent inversion
    exponent = (A_ref - rssi_dbm) / (10.0 * n_exp)
    d = float(np.power(10.0, exponent))
    d = max(0.1, min(d, 80.0)) # Sensible bounds
    
    # Log-Normal shadow fading standard deviation (sigma ~ 2.5 dB in indoor Wi-Fi)
    sigma_rssi = 2.5
    # Variance of ln(d): sigma_ln_d = (ln(10) / (10 * n)) * sigma_rssi
    sigma_ln_d = (np.log(10.0) / (10.0 * n_exp)) * sigma_rssi
    
    # 95% Confidence Interval bounds (Z = 1.96)
    ci_low = float(d * np.exp(-1.96 * sigma_ln_d))
    ci_high = float(d * np.exp(1.96 * sigma_ln_d))
    
    return d, max(0.05, ci_low), ci_high

def solve_trilateration(anchors_data: list[dict], grid_w: float, grid_h: float) -> tuple[float, float, str, float]:
    """
    Compute 2D receiver position (x, y) from 3 anchors.
    Uses closed-form orthogonal trilateration + Weighted Non-Linear Least Squares.
    
    Returns:
      (x, y, fix_type, hdop)
    """
    valid = [a for a in anchors_data if a["distance_m"] is not None and a["distance_m"] > 0]
    
    if len(valid) < 2:
        return STATE.pos_x, STATE.pos_y, "INSUFFICIENT SIGNALS", 9.9
    
    # Map valid anchors
    pts = np.array([[a["x"], a["y"]] for a in valid], dtype=float)
    dists = np.array([a["distance_m"] for a in valid], dtype=float)
    
    # Check if we have the standard 3-anchor setup: (0,0), (Lx, 0), (0, Ly)
    if len(valid) >= 3:
        # Sort by anchor ID
        a1 = next((a for a in valid if a["id"] == 1), None)
        a2 = next((a for a in valid if a["id"] == 2), None)
        a3 = next((a for a in valid if a["id"] == 3), None)
        
        if a1 and a2 and a3 and a1["x"] == 0 and a1["y"] == 0 and a2["y"] == 0 and a3["x"] == 0:
            # Clean closed-form solution for orthogonal anchors:
            # x = (Lx^2 + d1^2 - d2^2) / (2 * Lx)
            # y = (Ly^2 + d1^2 - d3^2) / (2 * Ly)
            Lx = a2["x"] if a2["x"] != 0 else grid_w
            Ly = a3["y"] if a3["y"] != 0 else grid_h
            d1, d2, d3 = a1["distance_m"], a2["distance_m"], a3["distance_m"]
            
            x_closed = (Lx**2 + d1**2 - d2**2) / (2.0 * Lx)
            y_closed = (Ly**2 + d1**2 - d3**2) / (2.0 * Ly)
            
            # Non-Linear Refinement with Scipy
            def cost_fun(p):
                residuals = np.linalg.norm(pts - p, axis=1) - dists
                # Weight by inverse distance to balance far anchors
                weights = 1.0 / (dists + 0.1)
                return residuals * weights
            
            x_init = np.clip(x_closed, 0.0, grid_w)
            y_init = np.clip(y_closed, 0.0, grid_h)
            
            try:
                res = opt.least_squares(
                    cost_fun,
                    [x_init, y_init],
                    bounds=([-3.0, -3.0], [grid_w + 3.0, grid_h + 3.0]),
                    loss='cauchy', # Robust to multipath outlier spikes
                    max_nfev=30
                )
                x_est, y_est = float(res.x[0]), float(res.x[1])
            except Exception:
                x_est, y_est = float(x_init), float(y_init)
            
            # Calculate HDOP (Horizontal Dilution of Precision)
            # Matrix H_i = [(x - xi)/di, (y - yi)/di]
            H = np.zeros((3, 2))
            for i in range(3):
                denom = max(0.1, dists[i])
                H[i, 0] = (x_est - pts[i, 0]) / denom
                H[i, 1] = (y_est - pts[i, 1]) / denom
            try:
                cov_geom = np.linalg.pinv(H.T @ H)
                hdop = float(np.sqrt(np.trace(cov_geom)))
            except Exception:
                hdop = 1.2
                
            return x_est, y_est, "3-ANCHOR FIX", min(hdop, 5.0)

    # 2-Anchor Fallback (positive quadrant)
    if len(valid) == 2:
        p1, p2 = pts[0], pts[1]
        r1, r2 = dists[0], dists[1]
        d = np.linalg.norm(p2 - p1)
        if d < 0.1:
            return STATE.pos_x, STATE.pos_y, "2-ANCHOR DEGENERATE", 8.0
        
        # Intersection of two circles
        a = (r1**2 - r2**2 + d**2) / (2.0 * d)
        h_sq = r1**2 - a**2
        h = np.sqrt(max(0.0, h_sq))
        
        p_mid = p1 + a * (p2 - p1) / d
        # Orthogonal offset
        offset = h * np.array([-(p2[1] - p1[1]), p2[0] - p1[0]]) / d
        cand1 = p_mid + offset
        cand2 = p_mid - offset
        
        # Pick the candidate inside or closest to the grid [0, grid_w] x [0, grid_h]
        score1 = max(0, -cand1[0]) + max(0, cand1[0] - grid_w) + max(0, -cand1[1]) + max(0, cand1[1] - grid_h)
        score2 = max(0, -cand2[0]) + max(0, cand2[0] - grid_w) + max(0, -cand2[1]) + max(0, cand2[1] - grid_h)
        best = cand1 if score1 <= score2 else cand2
        return float(best[0]), float(best[1]), "2-ANCHOR FIX", 2.8

    return STATE.pos_x, STATE.pos_y, "SEARCHING", 9.9

def update_kalman_filter(z_x: float, z_y: float, dt: float, hdop: float):
    """
    Continuous White Noise Acceleration 2D Kinematic Kalman Filter.
    State x = [x, y, vx, vy]^T
    """
    dt = max(0.05, min(dt, 1.0))
    
    # State Transition F
    F = np.array([
        [1.0, 0.0, dt,  0.0],
        [0.0, 1.0, 0.0, dt ],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0]
    ], dtype=float)
    
    # Continuous Acceleration Process Noise Q
    q_var = 0.8 # m^2/s^3 acceleration variance for walking human
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    Q = q_var * np.array([
        [dt4 / 4.0, 0.0,       dt3 / 2.0, 0.0      ],
        [0.0,       dt4 / 4.0, 0.0,       dt3 / 2.0],
        [dt3 / 2.0, 0.0,       dt2,       0.0      ],
        [0.0,       dt3 / 2.0, 0.0,       dt2      ]
    ], dtype=float)
    
    # Predict Step
    x_pred = F @ STATE.kf_state
    P_pred = F @ STATE.kf_cov @ F.T + Q
    
    # Measurement Matrix H (we observe x, y)
    H = np.array([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0]
    ], dtype=float)
    
    # Measurement Noise R scaled by HDOP
    r_base = max(0.3, hdop * 0.4)
    R = np.eye(2, dtype=float) * (r_base ** 2)
    
    # Innovation
    z = np.array([z_x, z_y], dtype=float)
    y = z - H @ x_pred
    
    # Outlier Gating: reject wild multi-path reflections > 12m sudden jump
    if np.linalg.norm(y) > 14.0:
        # Degrade innovation to prevent wild leaps
        y = y * (14.0 / np.linalg.norm(y))
    
    # Innovation Covariance S
    S = H @ P_pred @ H.T + R
    K = P_pred @ H.T @ np.linalg.inv(S)
    
    # Update State and Covariance
    x_new = x_pred + K @ y
    P_new = (np.eye(4) - K @ H) @ P_pred
    
    STATE.kf_state = x_new
    STATE.kf_cov = P_new
    
    # Update global outputs
    STATE.pos_x = float(np.clip(x_new[0], -2.0, STATE.grid_width + 2.0))
    STATE.pos_y = float(np.clip(x_new[1], -2.0, STATE.grid_height + 2.0))
    STATE.vel_x = float(x_new[2])
    STATE.vel_y = float(x_new[3])
    STATE.speed = float(np.hypot(STATE.vel_x, STATE.vel_y))
    if STATE.speed > 0.08:
        STATE.heading_deg = float((math.degrees(math.atan2(STATE.vel_y, STATE.vel_x)) + 360) % 360)

# =============================================================================
# Native Windows Wi-Fi Hotspot Scanning Driver (wlanapi.dll C API)
# =============================================================================

class WindowsWlanDriver:
    def __init__(self):
        self.wlan = None
        self.handle = None
        self.interface_guid = None
        self.is_ready = False
        self._init_wlan()
        
    def _init_wlan(self):
        try:
            self.wlan = ctypes.windll.wlanapi
            self.handle = wintypes.HANDLE()
            neg_ver = wintypes.DWORD()
            res = self.wlan.WlanOpenHandle(2, None, ctypes.byref(neg_ver), ctypes.byref(self.handle))
            if res != 0:
                print(f"[WLAN] WlanOpenHandle failed: error {res}")
                return
            
            pList = ctypes.POINTER(WLAN_INTERFACE_INFO_LIST)()
            res = self.wlan.WlanEnumInterfaces(self.handle, None, ctypes.byref(pList))
            if res == 0 and pList.contents.dwNumberOfItems > 0:
                self.interface_guid = pList.contents.InterfaceInfo[0].InterfaceGuid
                desc = pList.contents.InterfaceInfo[0].strInterfaceDescription
                print(f"[WLAN] Native WLAN Adapter Connected: {desc}")
                self.is_ready = True
            else:
                print("[WLAN] No active Wi-Fi interface found.")
        except Exception as e:
            print(f"[WLAN] Init exception: {e}")
            self.is_ready = False

    def trigger_scan(self):
        """Send asynchronous scan probe request to hardware adapter."""
        if not self.is_ready or not self.handle or not self.interface_guid:
            return
        try:
            # WlanScan runs in hardware in background
            self.wlan.WlanScan(self.handle, ctypes.byref(self.interface_guid), None, None, None)
        except Exception:
            pass

    def get_bss_list(self) -> list[dict]:
        """Query in-memory BSS network list in <10ms."""
        if not self.is_ready or not self.handle or not self.interface_guid:
            return []
        
        results = []
        ppBssList = ctypes.c_void_p()
        try:
            res = self.wlan.WlanGetNetworkBssList(
                self.handle,
                ctypes.byref(self.interface_guid),
                None, # All SSIDs
                3,    # dot11_BSS_type_any
                False,# Security not required to read beacon
                None,
                ctypes.byref(ppBssList)
            )
            if res == 0 and ppBssList.value:
                num_items = ctypes.c_uint32.from_address(ppBssList.value + 4).value
                entry_size = ctypes.sizeof(WLAN_BSS_ENTRY)
                offset = ppBssList.value + 8
                
                for i in range(num_items):
                    entry = WLAN_BSS_ENTRY.from_address(offset + i * entry_size)
                    raw_ssid = entry.dot11Ssid.ucSSID[:entry.dot11Ssid.uSSIDLength]
                    ssid = raw_ssid.decode('utf-8', errors='ignore').strip()
                    if not ssid:
                        ssid = "<Hidden Hotspot>"
                    
                    bssid = ':'.join(f'{b:02x}' for b in entry.dot11Bssid)
                    freq_mhz = entry.ulChCenterFrequency / 1000.0
                    band = "5 GHz" if freq_mhz >= 4900 else "2.4 GHz"
                    rssi_dbm = int(entry.lRssi)
                    quality = int(entry.uLinkQuality)
                    
                    results.append({
                        "signal_id": f"wifi:{bssid}",
                        "name": ssid,
                        "bssid_mac": bssid,
                        "radio_type": f"Wi-Fi {band}",
                        "rssi": rssi_dbm,
                        "quality": quality,
                        "freq_mhz": freq_mhz,
                        "timestamp": time.time()
                    })
                
                self.wlan.WlanFreeMemory(ppBssList)
        except Exception as e:
            pass
            
        return results

# =============================================================================
# Background Scanning Loop (High-Speed <1s updates)
# =============================================================================

def background_wifi_scanner_thread():
    """Continuously polls native Windows WLAN API every 250-350ms."""
    driver = WindowsWlanDriver()
    scan_tick = 0
    
    while True:
        try:
            t0 = time.time()
            
            # Periodically issue hardware scan request
            if scan_tick % 2 == 0:
                driver.trigger_scan()
            scan_tick += 1
            
            # Read fresh BSS table directly from driver memory
            bss_items = driver.get_bss_list()
            now = time.time()
            
            with STATE.lock:
                # Update discovered signals registry
                for item in bss_items:
                    sig_id = item["signal_id"]
                    if sig_id not in STATE.signals:
                        STATE.signals[sig_id] = {
                            "signal_id": sig_id,
                            "name": item["name"],
                            "bssid_mac": item["bssid_mac"],
                            "radio_type": item["radio_type"],
                            "rssi": item["rssi"],
                            "quality": item["quality"],
                            "last_seen": now,
                            "recent_rssi": deque(maxlen=20)
                        }
                    else:
                        sig = STATE.signals[sig_id]
                        sig["name"] = item["name"] # Update SSID if changed
                        sig["rssi"] = item["rssi"]
                        sig["quality"] = item["quality"]
                        sig["last_seen"] = now
                        sig["recent_rssi"].append(item["rssi"])
                
                # Update the 3 Anchors if their assigned signal matches
                for a_id, anchor in STATE.anchors.items():
                    target_sig_id = anchor["signal_id"]
                    if not target_sig_id:
                        continue
                    
                    matched_item = next((b for b in bss_items if b["signal_id"] == target_sig_id), None)
                    if matched_item:
                        rssi = matched_item["rssi"]
                        anchor["last_rssi"] = rssi
                        anchor["signal_name"] = matched_item["name"]
                        anchor["samples_count"] += 1
                        anchor["history"].append(rssi)
                        
                        # Moving median of recent readings for multipath noise reduction
                        recent_vals = list(anchor["history"])[-7:]
                        filtered_rssi = float(np.median(recent_vals)) if recent_vals else rssi
                        
                        # Compute distance via ITU-R P.1238 inversion
                        d_m, ci_low, ci_high = rssi_to_distance(filtered_rssi, anchor["A_ref"], anchor["n_exp"])
                        anchor["distance_m"] = round(d_m, 2)
                        anchor["dist_ci_low"] = round(ci_low, 2)
                        anchor["dist_ci_high"] = round(ci_high, 2)
            
            # Sleep remainder of 250ms cycle
            elapsed = time.time() - t0
            time.sleep(max(0.05, 0.25 - elapsed))
            
        except Exception as e:
            time.sleep(0.5)

# Optional BLE Scanner Thread
def background_ble_scanner_thread():
    """Runs Bleak BLE scanner concurrently if available."""
    if not HAS_BLEAK:
        return
        
    async def run_ble():
        def detection_cb(device, adv_data):
            now = time.time()
            mac = device.address.lower()
            sig_id = f"ble:{mac}"
            name = adv_data.local_name or device.name or "BLE Beacon"
            rssi = adv_data.rssi
            
            with STATE.lock:
                if sig_id not in STATE.signals:
                    STATE.signals[sig_id] = {
                        "signal_id": sig_id,
                        "name": name,
                        "bssid_mac": mac,
                        "radio_type": "BLE 2.4 GHz",
                        "rssi": rssi,
                        "quality": max(0, min(100, int((rssi + 100) * 2))),
                        "last_seen": now,
                        "recent_rssi": deque(maxlen=20)
                    }
                else:
                    sig = STATE.signals[sig_id]
                    sig["rssi"] = rssi
                    sig["last_seen"] = now
                    sig["recent_rssi"].append(rssi)
                
                # Check assigned anchors
                for a_id, anchor in STATE.anchors.items():
                    if anchor["signal_id"] == sig_id:
                        anchor["last_rssi"] = rssi
                        anchor["samples_count"] += 1
                        anchor["history"].append(rssi)
                        recent_vals = list(anchor["history"])[-7:]
                        filtered_rssi = float(np.median(recent_vals)) if recent_vals else rssi
                        d_m, ci_low, ci_high = rssi_to_distance(filtered_rssi, anchor["A_ref"], anchor["n_exp"])
                        anchor["distance_m"] = round(d_m, 2)
                        anchor["dist_ci_low"] = round(ci_low, 2)
                        anchor["dist_ci_high"] = round(ci_high, 2)

        try:
            scanner = BleakScanner(detection_callback=detection_cb)
            await scanner.start()
            while True:
                await asyncio.sleep(1.0)
        except Exception:
            pass

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(run_ble())
    except Exception:
        pass

# =============================================================================
# Main Positioning Engine & Stream Broadcaster
# =============================================================================

def positioning_engine_thread():
    """
    Runs at 5 Hz (every 200ms) to compute trilateration, update Kalman filter,
    log telemetry, and stream SSE packets to client browsers.
    """
    last_t = time.time()
    
    while True:
        try:
            t_now = time.time()
            dt = t_now - last_t
            last_t = t_now
            
            with STATE.lock:
                # Handle simulation / mock mode if enabled
                if STATE.mock_mode:
                    STATE.mock_phase += dt * 0.45
                    # Walk figure-8 pattern inside 30m x 30m room
                    center_x = STATE.grid_width * 0.5
                    center_y = STATE.grid_height * 0.5
                    radius_x = STATE.grid_width * 0.35
                    radius_y = STATE.grid_height * 0.35
                    true_x = center_x + radius_x * math.sin(STATE.mock_phase)
                    true_y = center_y + radius_y * math.sin(STATE.mock_phase * 2.0) * 0.7
                    
                    for a_id, anchor in STATE.anchors.items():
                        true_d = math.hypot(true_x - anchor["x"], true_y - anchor["y"])
                        # Synthetic path loss + Gaussian noise
                        synth_rssi = anchor["A_ref"] - 10.0 * anchor["n_exp"] * math.log10(max(0.5, true_d))
                        noise = np.random.normal(0, 1.2)
                        anchor["last_rssi"] = int(synth_rssi + noise)
                        d_m, ci_low, ci_high = rssi_to_distance(synth_rssi + noise, anchor["A_ref"], anchor["n_exp"])
                        anchor["distance_m"] = round(d_m, 2)
                        anchor["dist_ci_low"] = round(ci_low, 2)
                        anchor["dist_ci_high"] = round(ci_high, 2)
                
                # Run Trilateration
                anchors_list = list(STATE.anchors.values())
                meas_x, meas_y, fix_type, hdop = solve_trilateration(
                    anchors_list, STATE.grid_width, STATE.grid_height
                )
                
                # Update Kalman Filter
                update_kalman_filter(meas_x, meas_y, dt, hdop)
                STATE.fix_type = fix_type
                STATE.hdop = round(hdop, 2)
                
                # Update Breadcrumb Trail (every ~400ms or 0.3m displacement)
                trail = STATE.breadcrumb_trail
                if not trail or math.hypot(STATE.pos_x - trail[-1]["x"], STATE.pos_y - trail[-1]["y"]) > 0.25:
                    trail.append({
                        "x": round(STATE.pos_x, 2),
                        "y": round(STATE.pos_y, 2),
                        "t": round(t_now, 2)
                    })
                
                # Telemetry rate calculation
                STATE.update_interval_ms = round(dt * 1000.0, 1)
                STATE.update_rate_hz = round(1.0 / max(0.01, dt), 1)
                STATE.last_update_time = t_now
                
                # Build real-time telemetry payload
                packet = {
                    "type": "telemetry",
                    "timestamp": t_now,
                    "pos_x": round(STATE.pos_x, 2),
                    "pos_y": round(STATE.pos_y, 2),
                    "pos_x_ft": round(STATE.pos_x * 3.28084, 1),
                    "pos_y_ft": round(STATE.pos_y * 3.28084, 1),
                    "vel_x": round(STATE.vel_x, 2),
                    "vel_y": round(STATE.vel_y, 2),
                    "speed_mps": round(STATE.speed, 2),
                    "speed_mph": round(STATE.speed * 2.23694, 1),
                    "heading_deg": round(STATE.heading_deg, 1),
                    "hdop": STATE.hdop,
                    "fix_type": STATE.fix_type,
                    "update_hz": STATE.update_rate_hz,
                    "latency_ms": STATE.update_interval_ms,
                    "grid_w": STATE.grid_width,
                    "grid_h": STATE.grid_height,
                    "anchors": {
                        aid: {
                            "id": a["id"],
                            "name": a["name"],
                            "x": a["x"],
                            "y": a["y"],
                            "signal_id": a["signal_id"],
                            "signal_name": a["signal_name"],
                            "rssi": a["last_rssi"],
                            "dist_m": a["distance_m"],
                            "ci_low": a["dist_ci_low"],
                            "ci_high": a["dist_ci_high"],
                            "A_ref": a["A_ref"],
                            "n_exp": a["n_exp"],
                            "color": a["color"]
                        } for aid, a in STATE.anchors.items()
                    },
                    "trail": list(STATE.breadcrumb_trail)
                }
                
                # Append to CSV logger
                STATE.telemetry_log.append({
                    "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t_now)),
                    "x_m": round(STATE.pos_x, 3),
                    "y_m": round(STATE.pos_y, 3),
                    "speed_mps": round(STATE.speed, 2),
                    "a1_dist": STATE.anchors[1]["distance_m"],
                    "a2_dist": STATE.anchors[2]["distance_m"],
                    "a3_dist": STATE.anchors[3]["distance_m"],
                    "a1_rssi": STATE.anchors[1]["last_rssi"],
                    "a2_rssi": STATE.anchors[2]["last_rssi"],
                    "a3_rssi": STATE.anchors[3]["last_rssi"],
                    "hdop": STATE.hdop
                })
            
            # Broadcast to active SSE clients
            msg_str = f"data: {json.dumps(packet)}\n\n"
            dead_queues = []
            for q in STATE.sse_queues:
                try:
                    q.put_nowait(msg_str)
                except Exception:
                    dead_queues.append(q)
            for dq in dead_queues:
                if dq in STATE.sse_queues:
                    STATE.sse_queues.remove(dq)
            
            # Sleep 200ms (5 Hz update rate)
            time.sleep(0.20)
            
        except Exception as e:
            time.sleep(0.25)

# =============================================================================
# Embedded Tactical 2D Grid Web UI (HTML5 Canvas + CSS + JS)
# =============================================================================

HTML_DASHBOARD = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IntoTheClouds // 2D Tactical Grid Mapper (30m x 30m)</title>
  <style>
    :root {
      --bg-dark: #070a13;
      --bg-panel: #0d1322;
      --bg-card: #131b2e;
      --border-glow: #1a2744;
      --cyan: #00f0ff;
      --emerald: #00ff9d;
      --amber: #ffb800;
      --rose: #ff2e63;
      --text-main: #e2e8f0;
      --text-dim: #798da3;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: var(--text-main);
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    /* Header Bar */
    header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border-glow);
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .radar-icon {
      width: 28px;
      height: 28px;
      border: 2px solid var(--cyan);
      border-radius: 50%;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 10px var(--cyan);
    }
    .radar-icon::after {
      content: '';
      width: 6px;
      height: 6px;
      background: var(--cyan);
      border-radius: 50%;
    }
    .brand-title {
      font-size: 1.15rem;
      font-weight: 800;
      letter-spacing: 2px;
      color: #fff;
    }
    .brand-title span { color: var(--cyan); }
    .status-badges {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 4px;
      letter-spacing: 1px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge-live {
      background: rgba(0, 255, 157, 0.12);
      color: var(--emerald);
      border: 1px solid rgba(0, 255, 157, 0.3);
    }
    .badge-live .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--emerald);
      border-radius: 50%;
      animation: pulse 1.2s infinite;
    }
    @keyframes pulse { 0% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.3); } 100% { opacity: 0.3; transform: scale(0.8); } }
    .badge-rate {
      background: rgba(0, 240, 255, 0.1);
      color: var(--cyan);
      border: 1px solid rgba(0, 240, 255, 0.3);
    }
    .header-actions {
      display: flex;
      gap: 10px;
    }
    button {
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border-glow);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    button:hover {
      border-color: var(--cyan);
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
      color: #fff;
    }
    button.primary {
      background: linear-gradient(135deg, rgba(0,240,255,0.2), rgba(0,255,157,0.2));
      border-color: var(--cyan);
    }

    /* Main Grid & Workspace */
    .workspace {
      flex: 1;
      display: flex;
      position: relative;
      overflow: hidden;
    }
    /* Canvas Area */
    .canvas-container {
      flex: 1;
      position: relative;
      background: radial-gradient(circle at center, #0b1120 0%, #05080e 100%);
      overflow: hidden;
      cursor: crosshair;
    }
    canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    /* Floating HUD telemetry overlay */
    .hud-overlay {
      position: absolute;
      top: 16px;
      left: 16px;
      background: rgba(13, 19, 34, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border-glow);
      border-radius: 8px;
      padding: 12px 18px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.6);
      pointer-events: none;
      z-index: 5;
    }
    .hud-coord-main {
      font-family: 'Consolas', monospace;
      font-size: 1.4rem;
      font-weight: 800;
      color: #fff;
      display: flex;
      gap: 16px;
    }
    .hud-coord-main span { color: var(--cyan); }
    .hud-sub-stats {
      margin-top: 6px;
      display: flex;
      gap: 16px;
      font-size: 0.8rem;
      color: var(--text-dim);
    }
    .hud-sub-stats strong { color: var(--text-main); }
    /* Zoom & Pan Overlay */
    .canvas-tools {
      position: absolute;
      bottom: 20px;
      left: 20px;
      display: flex;
      gap: 8px;
      z-index: 5;
    }

    /* Right Sidebar: Anchor Assignments & Calibration */
    .sidebar {
      width: 380px;
      background: var(--bg-panel);
      border-left: 1px solid var(--border-glow);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      z-index: 8;
    }
    .sidebar-section {
      padding: 16px;
      border-bottom: 1px solid var(--border-glow);
    }
    .section-title {
      font-size: 0.85rem;
      font-weight: 800;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--cyan);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Anchor Cards */
    .anchor-card {
      background: var(--bg-card);
      border: 1px solid var(--border-glow);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      position: relative;
      transition: border-color 0.2s;
    }
    .anchor-card:hover {
      border-color: rgba(255, 255, 255, 0.2);
    }
    .anchor-card.a1 { border-left: 4px solid var(--cyan); }
    .anchor-card.a2 { border-left: 4px solid var(--emerald); }
    .anchor-card.a3 { border-left: 4px solid var(--amber); }

    .anchor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .anchor-title {
      font-size: 0.9rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .anchor-pos-pill {
      font-size: 0.75rem;
      font-family: monospace;
      padding: 2px 6px;
      background: rgba(255,255,255,0.06);
      border-radius: 4px;
      color: var(--text-dim);
    }
    .anchor-select-group {
      margin-bottom: 10px;
    }
    .anchor-select-group label {
      display: block;
      font-size: 0.7rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    select {
      width: 100%;
      background: #090e1a;
      border: 1px solid var(--border-glow);
      color: #fff;
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 0.8rem;
      outline: none;
    }
    select:focus { border-color: var(--cyan); }

    .anchor-metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 10px;
      background: rgba(0,0,0,0.25);
      padding: 8px;
      border-radius: 6px;
    }
    .metric-item {
      display: flex;
      flex-direction: column;
    }
    .metric-label {
      font-size: 0.65rem;
      color: var(--text-dim);
      text-transform: uppercase;
    }
    .metric-value {
      font-family: 'Consolas', monospace;
      font-size: 1.05rem;
      font-weight: 700;
      color: #fff;
    }
    .calib-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .btn-calib {
      flex: 1;
      padding: 6px 10px;
      font-size: 0.75rem;
      justify-content: center;
      background: rgba(0, 240, 255, 0.1);
      border-color: rgba(0, 240, 255, 0.3);
      color: var(--cyan);
    }
    .btn-calib:hover {
      background: var(--cyan);
      color: #000;
    }

    /* Advanced Settings Modal / Drawer */
    .settings-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-size: 0.8rem;
    }
    .settings-row input[type="number"] {
      width: 70px;
      background: #090e1a;
      border: 1px solid var(--border-glow);
      color: #fff;
      padding: 4px 6px;
      border-radius: 4px;
      text-align: right;
      font-family: monospace;
    }

    /* Signal Search Box */
    .search-box {
      width: 100%;
      background: #090e1a;
      border: 1px solid var(--border-glow);
      color: #fff;
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 0.8rem;
      margin-bottom: 12px;
      outline: none;
    }
    .search-box:focus { border-color: var(--cyan); }

    /* Grid Presets & Dimension Sliders */
    .preset-label {
      font-size: 0.65rem;
      color: var(--text-dim);
      letter-spacing: 1px;
      margin-bottom: 6px;
      text-transform: uppercase;
      font-weight: 700;
    }
    .preset-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 5px;
      margin-bottom: 14px;
    }
    .pill-btn {
      background: var(--bg-card);
      border: 1px solid var(--border-glow);
      color: var(--text-dim);
      padding: 6px 2px;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 700;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s;
    }
    .pill-btn:hover {
      border-color: var(--cyan);
      color: #fff;
    }
    .pill-btn.active {
      background: rgba(0, 240, 255, 0.18);
      border-color: var(--cyan);
      color: var(--cyan);
      box-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
    }
    .dim-control-group {
      margin-bottom: 12px;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--border-glow);
      border-radius: 6px;
      padding: 10px;
    }
    .dim-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      font-size: 0.75rem;
    }
    .dim-val {
      font-family: 'Consolas', monospace;
      color: #fff;
    }
    .dim-val strong {
      color: var(--cyan);
      font-size: 0.95rem;
    }
    .dim-slider {
      width: 100%;
      height: 6px;
      -webkit-appearance: none;
      background: #1a2744;
      border-radius: 3px;
      outline: none;
      margin: 8px 0;
    }
    .dim-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--cyan);
      cursor: pointer;
      box-shadow: 0 0 8px var(--cyan);
      transition: transform 0.1s;
    }
    .dim-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }
    .steppers-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }
    .step-btn {
      padding: 3px 0;
      font-size: 0.7rem;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border-glow);
      border-radius: 4px;
      color: var(--text-dim);
      cursor: pointer;
      text-align: center;
    }
    .step-btn:hover {
      color: #fff;
      border-color: var(--cyan);
    }
    .dim-options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.75rem;
      color: var(--text-dim);
      cursor: pointer;
      user-select: none;
    }
    .checkbox-label input {
      accent-color: var(--cyan);
    }

    /* Modal Backdrop & Card */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-card {
      background: var(--bg-panel);
      border: 1px solid var(--cyan);
      box-shadow: 0 0 30px rgba(0, 240, 255, 0.25);
      border-radius: 10px;
      width: 520px;
      max-width: 90vw;
      overflow: hidden;
      animation: modalFadeIn 0.2s ease-out;
    }
    @keyframes modalFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
    .modal-header {
      padding: 14px 18px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border-glow);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-title {
      font-size: 0.95rem;
      font-weight: 800;
      letter-spacing: 1.5px;
      color: var(--cyan);
    }
    .close-btn {
      background: none;
      border: none;
      font-size: 1.3rem;
      color: var(--text-dim);
      cursor: pointer;
      padding: 0 6px;
    }
    .close-btn:hover { color: #fff; }
    .modal-body {
      padding: 18px;
    }
    .modal-inputs-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 12px;
    }
    .input-block label {
      display: block;
      font-size: 0.7rem;
      color: var(--text-dim);
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .input-block input {
      width: 100%;
      background: #090e1a;
      border: 1px solid var(--border-glow);
      color: #fff;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 0.95rem;
      font-family: monospace;
      outline: none;
    }
    .input-block input:focus { border-color: var(--cyan); }
    .modal-footer {
      padding: 12px 18px;
      background: var(--bg-card);
      border-top: 1px solid var(--border-glow);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
  </style>
</head>
<body>

  <!-- Top Header Bar -->
  <header>
    <div class="brand">
      <div class="radar-icon"></div>
      <div class="brand-title">INTO THE CLOUDS <span>// 2D GRID MAPPER</span></div>
    </div>
    
    <div class="status-badges">
      <div class="badge badge-live">
        <div class="pulse-dot"></div>
        <span id="badgeScanMode">WLAN + BLE SCANNING</span>
      </div>
      <div class="badge badge-rate">
        <span id="badgeRate">4.5 Hz (220 ms)</span>
      </div>
      <div class="badge" style="background: rgba(255,255,255,0.06); color: #fff;">
        <span id="badgeFix">3-ANCHOR FIX</span>
      </div>
    </div>

    <div class="header-actions">
      <button class="primary" onclick="openGridModal()">📐 Dimensions: <span id="headerGridDim">30m × 30m</span></button>
      <button id="btnToggleMock" onclick="toggleMock()">🎭 Simulate Walk</button>
      <button id="btnClearTrail" onclick="clearTrail()">🧹 Clear Trail</button>
      <button onclick="exportCSV()">📥 Export CSV</button>
    </div>
  </header>

  <!-- Workspace: Canvas & Control Sidebar -->
  <div class="workspace">
    
    <!-- 2D Canvas Viewport -->
    <div class="canvas-container" id="canvasContainer">
      <canvas id="gridCanvas"></canvas>
      
      <!-- Real-time HUD Coordinate Overlay -->
      <div class="hud-overlay">
        <div class="hud-coord-main">
          <div>X: <span id="hudX">15.00</span> m (<span id="hudXFt">49.2</span> ft)</div>
          <div>Y: <span id="hudY">15.00</span> m (<span id="hudYFt">49.2</span> ft)</div>
        </div>
        <div class="hud-sub-stats">
          <div>Speed: <strong id="hudSpeed">0.0 m/s</strong></div>
          <div>Heading: <strong id="hudHeading">0°</strong></div>
          <div>HDOP: <strong id="hudHdop">1.0</strong></div>
          <div>Latency: <strong id="hudLatency">210 ms</strong> (< 1s)</div>
        </div>
      </div>

      <!-- Canvas Pan/Zoom Controls -->
      <div class="canvas-tools">
        <button onclick="zoomCanvas(1.2)">🔍 + Zoom In</button>
        <button onclick="zoomCanvas(0.8)">🔍 - Zoom Out</button>
        <button onclick="fitGrid()">📐 Fit <span id="btnFitDim">30m</span> Grid</button>
        <button onclick="centerOnTarget()">🎯 Center Target</button>
      </div>
    </div>

    <!-- Right Sidebar: Anchor Assignments & Signal Discovery -->
    <div class="sidebar">
      
      <!-- Anchor 1 Card (Origin [0, 0]) -->
      <div class="sidebar-section">
        <div class="section-title">
          <span>ANCHOR BEACONS (30m GRID)</span>
          <button style="font-size:0.7rem; padding: 3px 8px;" onclick="autoAssignStrongest()">Auto-Assign</button>
        </div>

        <!-- Anchor 1 -->
        <div class="anchor-card a1">
          <div class="anchor-header">
            <div class="anchor-title" style="color: var(--cyan);">
              <span>🔵</span> Anchor 1 (Origin)
            </div>
            <div class="anchor-pos-pill" id="posPill1">(0.0m, 0.0m)</div>
          </div>
          <div class="anchor-select-group">
            <label>Assigned Wi-Fi Hotspot / Beacon:</label>
            <select id="selectAnchor1" onchange="assignAnchor(1, this.value)">
              <option value="">-- Choose Signal --</option>
            </select>
          </div>
          <div class="anchor-metrics">
            <div class="metric-item">
              <span class="metric-label">Live RSSI</span>
              <span class="metric-value" id="rssi1">-- dBm</span>
            </div>
            <div class="metric-item">
              <span class="metric-label">Estimated Dist</span>
              <span class="metric-value" id="dist1">-- m</span>
            </div>
          </div>
          <div class="calib-row">
            <button class="btn-calib" onclick="calibrateAnchor(1, 1.0)">🎯 Calibrate 1.0m (Set A)</button>
          </div>
        </div>

        <!-- Anchor 2 (X-Axis [30, 0]) -->
        <div class="anchor-card a2">
          <div class="anchor-header">
            <div class="anchor-title" style="color: var(--emerald);">
              <span>🟢</span> Anchor 2 (X-Axis)
            </div>
            <div class="anchor-pos-pill" id="posPill2">(30.0m, 0.0m)</div>
          </div>
          <div class="anchor-select-group">
            <label>Assigned Wi-Fi Hotspot / Beacon:</label>
            <select id="selectAnchor2" onchange="assignAnchor(2, this.value)">
              <option value="">-- Choose Signal --</option>
            </select>
          </div>
          <div class="anchor-metrics">
            <div class="metric-item">
              <span class="metric-label">Live RSSI</span>
              <span class="metric-value" id="rssi2">-- dBm</span>
            </div>
            <div class="metric-item">
              <span class="metric-label">Estimated Dist</span>
              <span class="metric-value" id="dist2">-- m</span>
            </div>
          </div>
          <div class="calib-row">
            <button class="btn-calib" onclick="calibrateAnchor(2, 1.0)">🎯 Calibrate 1.0m (Set A)</button>
          </div>
        </div>

        <!-- Anchor 3 (Y-Axis [0, 30]) -->
        <div class="anchor-card a3">
          <div class="anchor-header">
            <div class="anchor-title" style="color: var(--amber);">
              <span>🟡</span> Anchor 3 (Y-Axis)
            </div>
            <div class="anchor-pos-pill" id="posPill3">(0.0m, 30.0m)</div>
          </div>
          <div class="anchor-select-group">
            <label>Assigned Wi-Fi Hotspot / Beacon:</label>
            <select id="selectAnchor3" onchange="assignAnchor(3, this.value)">
              <option value="">-- Choose Signal --</option>
            </select>
          </div>
          <div class="anchor-metrics">
            <div class="metric-item">
              <span class="metric-label">Live RSSI</span>
              <span class="metric-value" id="rssi3">-- dBm</span>
            </div>
            <div class="metric-item">
              <span class="metric-label">Estimated Dist</span>
              <span class="metric-value" id="dist3">-- m</span>
            </div>
          </div>
          <div class="calib-row">
            <button class="btn-calib" onclick="calibrateAnchor(3, 1.0)">🎯 Calibrate 1.0m (Set A)</button>
          </div>
        </div>
      </div>

      <!-- Environment & Grid Configuration -->
      <div class="sidebar-section">
        <div class="section-title">
          <span>GRID DIMENSIONS</span>
          <button style="font-size:0.7rem; padding: 2px 7px;" onclick="openGridModal()">⚙️ Custom</button>
        </div>
        
        <!-- Room Presets -->
        <div class="preset-label">QUICK ROOM PRESETS:</div>
        <div class="preset-grid">
          <button class="pill-btn" onclick="applyPreset(10, 10)">10×10m</button>
          <button class="pill-btn" onclick="applyPreset(15, 15)">15×15m</button>
          <button class="pill-btn" onclick="applyPreset(20, 20)">20×20m</button>
          <button class="pill-btn active" id="btnPreset30" onclick="applyPreset(30, 30)">30×30m</button>
          <button class="pill-btn" onclick="applyPreset(50, 50)">50×50m</button>
        </div>

        <!-- Width (X) Slider & Steppers -->
        <div class="dim-control-group">
          <div class="dim-header">
            <span>Width (X-Axis):</span>
            <span class="dim-val"><strong id="dispGridW">30.0</strong> m (<span id="dispGridWFt">98.4</span> ft)</span>
          </div>
          <input type="range" class="dim-slider" id="rangeGridW" min="3" max="100" step="0.5" value="30.0" oninput="onSliderDimChange('w', this.value)">
          <div class="steppers-row">
            <button class="step-btn" onclick="stepDim('w', -5)">-5m</button>
            <button class="step-btn" onclick="stepDim('w', -1)">-1m</button>
            <button class="step-btn" onclick="stepDim('w', 1)">+1m</button>
            <button class="step-btn" onclick="stepDim('w', 5)">+5m</button>
          </div>
        </div>

        <!-- Height (Y) Slider & Steppers -->
        <div class="dim-control-group">
          <div class="dim-header">
            <span>Height (Y-Axis):</span>
            <span class="dim-val"><strong id="dispGridH">30.0</strong> m (<span id="dispGridHFt">98.4</span> ft)</span>
          </div>
          <input type="range" class="dim-slider" id="rangeGridH" min="3" max="100" step="0.5" value="30.0" oninput="onSliderDimChange('h', this.value)">
          <div class="steppers-row">
            <button class="step-btn" onclick="stepDim('h', -5)">-5m</button>
            <button class="step-btn" onclick="stepDim('h', -1)">-1m</button>
            <button class="step-btn" onclick="stepDim('h', 1)">+1m</button>
            <button class="step-btn" onclick="stepDim('h', 5)">+5m</button>
          </div>
        </div>

        <!-- Dimension Options -->
        <div class="dim-options">
          <label class="checkbox-label">
            <input type="checkbox" id="chkLockAspect" checked onchange="toggleLockAspect(this.checked)">
            <span>🔒 Lock Square (1:1 Ratio)</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" id="chkAutoSnap" checked>
            <span>📍 Auto-Snap Anchors to Ends</span>
          </label>
        </div>

        <div class="settings-row" style="margin-top:12px;">
          <span>Path Loss Exponent (n):</span>
          <input type="number" id="inpExpN" value="2.4" step="0.1" min="1.5" max="4.5" onchange="updateExponent(this.value)">
        </div>
        <div class="settings-row">
          <span>Audio Proximity Sonar:</span>
          <button style="padding: 3px 8px; font-size: 0.75rem;" id="btnAudioToggle" onclick="toggleAudio()">🔊 Sound OFF</button>
        </div>
      </div>

      <!-- Quick Search Signals List -->
      <div class="sidebar-section" style="flex:1;">
        <div class="section-title">ALL DISCOVERED SIGNALS (<span id="sigCount">0</span>)</div>
        <input type="text" class="search-box" id="inpSearch" placeholder="🔍 Search SSIDs or MACs..." oninput="renderSignalSelects()">
        <div id="signalsList" style="font-size: 0.75rem; color: var(--text-dim); max-height: 250px; overflow-y: auto;">
          <!-- Live discovered signals populated via JS -->
        </div>
      </div>

    </div>

  </div>

  <!-- Grid Dimensions Modal -->
  <div class="modal-backdrop" id="gridModal" style="display:none;" onclick="if(event.target===this) closeGridModal()">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">📐 ADJUST GRID DIMENSIONS & ANCHOR POSITIONS</div>
        <button class="close-btn" onclick="closeGridModal()">×</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.8rem; color:var(--text-dim); margin-bottom:14px;">
          Configure the exact room dimensions for the 2D trilateration space. Anchors will automatically adjust to the coordinate boundaries.
        </p>
        
        <div class="modal-inputs-grid">
          <div class="input-block">
            <label>X-Axis Width (Meters):</label>
            <input type="number" id="modalInputW" value="30.0" step="0.5" min="3" max="150" oninput="syncModalFromMeters('w', this.value)">
          </div>
          <div class="input-block">
            <label>X-Axis Width (Feet):</label>
            <input type="number" id="modalInputWFt" value="98.4" step="1.0" min="10" max="500" oninput="syncModalFromFeet('w', this.value)">
          </div>
          <div class="input-block">
            <label>Y-Axis Height (Meters):</label>
            <input type="number" id="modalInputH" value="30.0" step="0.5" min="3" max="150" oninput="syncModalFromMeters('h', this.value)">
          </div>
          <div class="input-block">
            <label>Y-Axis Height (Feet):</label>
            <input type="number" id="modalInputHFt" value="98.4" step="1.0" min="10" max="500" oninput="syncModalFromFeet('h', this.value)">
          </div>
        </div>

        <div style="margin-top:14px;">
          <span style="font-size:0.75rem; color:var(--text-dim); text-transform:uppercase;">Quick Presets:</span>
          <div class="preset-grid" style="margin-top:6px;">
            <button class="pill-btn" onclick="applyPreset(10, 10)">10×10m (33×33ft)</button>
            <button class="pill-btn" onclick="applyPreset(15, 15)">15×15m (49×49ft)</button>
            <button class="pill-btn" onclick="applyPreset(20, 20)">20×20m (66×66ft)</button>
            <button class="pill-btn" onclick="applyPreset(30, 30)">30×30m (98×98ft)</button>
            <button class="pill-btn" onclick="applyPreset(50, 50)">50×50m (164×164ft)</button>
          </div>
        </div>

        <div style="margin-top:16px; background:rgba(0,0,0,0.3); border-radius:6px; padding:10px;">
          <div style="font-size:0.75rem; color:var(--cyan); font-weight:700; margin-bottom:6px;">ANCHOR COORDINATES:</div>
          <div style="display:flex; justify-content:space-between; font-size:0.75rem; font-family:monospace;">
            <span style="color:var(--cyan);">🔵 Anchor 1 (Origin): (0.0m, 0.0m)</span>
            <span style="color:var(--emerald);" id="modalA2Preview">🟢 Anchor 2: (30.0m, 0.0m)</span>
            <span style="color:var(--amber);" id="modalA3Preview">🟡 Anchor 3: (0.0m, 30.0m)</span>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button onclick="closeGridModal()">Cancel</button>
        <button class="primary" onclick="saveModalGrid()">💾 Apply Dimensions</button>
      </div>
    </div>
  </div>

  <script>
    // =========================================================================
    // Client-Side Canvas & Telemetry Engine
    // =========================================================================
    const canvas = document.getElementById('gridCanvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvasContainer');

    // Canvas Transform State (World to Screen)
    let zoom = 1.0;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;

    // Local State
    let telemetry = {
      pos_x: 15.0,
      pos_y: 15.0,
      vel_x: 0.0,
      vel_y: 0.0,
      speed_mps: 0.0,
      heading_deg: 0.0,
      hdop: 1.0,
      fix_type: "INITIALIZING",
      update_hz: 4.0,
      latency_ms: 220,
      grid_w: 30.0,
      grid_h: 30.0,
      anchors: {},
      trail: []
    };
    
    // Smooth Interpolated Position
    let renderPos = { x: 15.0, y: 15.0 };
    let discoveredSignals = [];
    let audioEnabled = false;
    let audioCtx = null;
    let lastSonarPing = 0;

    // Resize Canvas to parent
    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      ctx.scale(dpr, dpr);
    }
    window.addEventListener('resize', () => { resizeCanvas(); fitGrid(); });
    resizeCanvas();

    // World to Screen Conversion
    function worldToScreen(wx, wy) {
      // In 2D grid, (0, 0) is bottom-left, X goes right, Y goes up
      const sx = panX + wx * zoom;
      const sy = panY - wy * zoom; // Invert Y for standard math orientation
      return { x: sx, y: sy };
    }

    function screenToWorld(sx, sy) {
      const wx = (sx - panX) / zoom;
      const wy = (panY - sy) / zoom;
      return { x: wx, y: wy };
    }

    // Fit 30m x 30m grid perfectly in view
    function fitGrid() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const gw = telemetry.grid_w || 30.0;
      const gh = telemetry.grid_h || 30.0;
      
      const padding = 80;
      const scaleX = (w - padding * 2) / gw;
      const scaleY = (h - padding * 2) / gh;
      zoom = Math.min(scaleX, scaleY);
      
      // Center the grid
      panX = (w - gw * zoom) / 2;
      panY = h - (h - gh * zoom) / 2;
    }
    setTimeout(fitGrid, 100);

    function zoomCanvas(factor) {
      const centerX = container.clientWidth / 2;
      const centerY = container.clientHeight / 2;
      const worldCenter = screenToWorld(centerX, centerY);
      zoom *= factor;
      panX = centerX - worldCenter.x * zoom;
      panY = centerY + worldCenter.y * zoom;
    }

    function centerOnTarget() {
      const centerX = container.clientWidth / 2;
      const centerY = container.clientHeight / 2;
      panX = centerX - renderPos.x * zoom;
      panY = centerY + renderPos.y * zoom;
    }

    // Mouse Controls for Pan & Zoom
    container.addEventListener('mousedown', e => {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
    });
    window.addEventListener('mousemove', e => {
      if (!isDragging) return;
      panX = e.clientX - dragStartX;
      panY = e.clientY - dragStartY;
    });
    window.addEventListener('mouseup', () => isDragging = false);
    container.addEventListener('wheel', e => {
      e.preventDefault();
      const mouseWorld = screenToWorld(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      zoom *= factor;
      panX = e.clientX - mouseWorld.x * zoom;
      panY = e.clientY + mouseWorld.y * zoom;
    }, { passive: false });

    // =========================================================================
    // 60 FPS Render Loop
    // =========================================================================
    let pulseAngle = 0;
    function render() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      ctx.clearRect(0, 0, w, h);
      
      pulseAngle += 0.04;

      // Smooth Position Interpolation (LERP)
      renderPos.x += (telemetry.pos_x - renderPos.x) * 0.22;
      renderPos.y += (telemetry.pos_y - renderPos.y) * 0.22;

      const gw = telemetry.grid_w || 30.0;
      const gh = telemetry.grid_h || 30.0;

      // Draw Grid Lines & Metric Scale
      drawGrid(gw, gh);

      // Draw Anchor Radii & Proximity Rings
      drawAnchorCircles();

      // Draw Breadcrumb Motion Trail
      drawTrail();

      // Draw Anchor Icons
      drawAnchors();

      // Draw Target Crosshair & Blip
      drawTarget();

      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);

    function drawGrid(gw, gh) {
      // Minor Grid (1 meter)
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(26, 39, 68, 0.4)";
      for (let x = 0; x <= gw; x += 1) {
        if (x % 5 === 0) continue;
        const p1 = worldToScreen(x, 0);
        const p2 = worldToScreen(x, gh);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      for (let y = 0; y <= gh; y += 1) {
        if (y % 5 === 0) continue;
        const p1 = worldToScreen(0, y);
        const p2 = worldToScreen(gw, y);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // Major Grid (5 meters) with Labels
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 240, 255, 0.15)";
      ctx.font = "11px Consolas, monospace";
      ctx.fillStyle = "rgba(121, 141, 163, 0.8)";
      ctx.textAlign = "center";

      for (let x = 0; x <= gw; x += 5) {
        const p1 = worldToScreen(x, 0);
        const p2 = worldToScreen(x, gh);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // X coordinate label
        ctx.fillText(`${x}m`, p1.x, p1.y + 18);
      }

      ctx.textAlign = "right";
      for (let y = 0; y <= gh; y += 5) {
        const p1 = worldToScreen(0, y);
        const p2 = worldToScreen(gw, y);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // Y coordinate label
        ctx.fillText(`${y}m`, p1.x - 8, p1.y + 4);
      }

      // Room Boundary Box (30m x 30m)
      const b0 = worldToScreen(0, 0);
      const b1 = worldToScreen(gw, 0);
      const b2 = worldToScreen(gw, gh);
      const b3 = worldToScreen(0, gh);

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(0, 240, 255, 0.5)";
      ctx.strokeRect(b0.x, b2.y, b1.x - b0.x, b0.y - b2.y);

      // Corner Brackets
      drawCornerBracket(b0.x, b0.y, 1, -1);
      drawCornerBracket(b1.x, b1.y, -1, -1);
      drawCornerBracket(b2.x, b2.y, -1, 1);
      drawCornerBracket(b3.x, b3.y, 1, 1);
    }

    function drawCornerBracket(x, y, dirX, dirY) {
      const len = 14;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "var(--cyan)";
      ctx.beginPath();
      ctx.moveTo(x + dirX * len, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dirY * len);
      ctx.stroke();
    }

    function drawAnchorCircles() {
      if (!telemetry.anchors) return;
      
      Object.values(telemetry.anchors).forEach(a => {
        if (!a.dist_m || a.dist_m <= 0) return;
        const p = worldToScreen(a.x, a.y);
        const rPix = a.dist_m * zoom;
        const rLowPix = (a.ci_low || a.dist_m * 0.8) * zoom;
        const rHighPix = (a.ci_high || a.dist_m * 1.2) * zoom;

        // 95% Confidence Band (transparent ring)
        ctx.fillStyle = a.color === "#00f0ff" ? "rgba(0, 240, 255, 0.04)" :
                        a.color === "#00ff9d" ? "rgba(0, 255, 157, 0.04)" :
                        "rgba(255, 184, 0, 0.04)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, rHighPix, 0, Math.PI * 2);
        ctx.arc(p.y, p.y, rLowPix, 0, Math.PI * 2, true);
        ctx.fill();

        // Main Estimated Distance Circle
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = a.color;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rPix, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    function drawTrail() {
      if (!telemetry.trail || telemetry.trail.length < 2) return;
      ctx.lineWidth = 3;
      for (let i = 1; i < telemetry.trail.length; i++) {
        const pt0 = worldToScreen(telemetry.trail[i-1].x, telemetry.trail[i-1].y);
        const pt1 = worldToScreen(telemetry.trail[i].x, telemetry.trail[i].y);
        const alpha = (i / telemetry.trail.length) * 0.7;
        ctx.strokeStyle = `rgba(0, 240, 255, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(pt0.x, pt0.y);
        ctx.lineTo(pt1.x, pt1.y);
        ctx.stroke();
      }
    }

    function drawAnchors() {
      if (!telemetry.anchors) return;
      
      Object.values(telemetry.anchors).forEach(a => {
        const p = worldToScreen(a.x, a.y);
        
        // Pulsing radio wave ring
        const waveR = (pulseAngle * 18) % 35 + 8;
        const waveAlpha = Math.max(0, 1 - (waveR / 35));
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = a.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, waveR, 0, Math.PI * 2);
        ctx.stroke();

        // Solid hexagonal anchor icon
        ctx.fillStyle = a.color;
        ctx.shadowColor = a.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Label
        ctx.font = "bold 12px Consolas, monospace";
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        const labelText = a.id === 1 ? `A1: ORIGIN (0,0m)` :
                          a.id === 2 ? `A2: X-AXIS (${telemetry.grid_w}m,0)` :
                                       `A3: Y-AXIS (0,${telemetry.grid_h}m)`;
        ctx.fillText(labelText, p.x + 12, p.y + 4);
      });
    }

    function drawTarget() {
      const p = worldToScreen(renderPos.x, renderPos.y);

      // Radar Pulse Wave
      const pingR = (pulseAngle * 25) % 45 + 10;
      const pingAlpha = Math.max(0, 1 - (pingR / 45));
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(0, 240, 255, ${pingAlpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pingR, 0, Math.PI * 2);
      ctx.stroke();

      // Glowing Center Blip
      ctx.fillStyle = "var(--cyan)";
      ctx.shadowColor = "var(--cyan)";
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Tactical Crosshair Lines
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 240, 255, 0.8)";
      ctx.beginPath();
      // Horizontal crosshair
      ctx.moveTo(p.x - 18, p.y); ctx.lineTo(p.x - 9, p.y);
      ctx.moveTo(p.x + 9, p.y);  ctx.lineTo(p.x + 18, p.y);
      // Vertical crosshair
      ctx.moveTo(p.x, p.y - 18); ctx.lineTo(p.x, p.y - 9);
      ctx.moveTo(p.x, p.y + 9);  ctx.lineTo(p.x, p.y + 18);
      ctx.stroke();

      // Heading Velocity Arrow (if moving)
      if (telemetry.speed_mps > 0.15) {
        const arrowLen = Math.min(50, telemetry.speed_mps * 25);
        const rad = -telemetry.heading_deg * Math.PI / 180; // Invert for canvas Y
        const ax = p.x + arrowLen * Math.cos(rad);
        const ay = p.y + arrowLen * Math.sin(rad);

        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "var(--emerald)";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
      }

      // Coordinate Tag Badge
      ctx.font = "bold 11px Consolas, monospace";
      ctx.fillStyle = "rgba(13, 19, 34, 0.9)";
      const tagText = `[${renderPos.x.toFixed(1)}m, ${renderPos.y.toFixed(1)}m]`;
      const textW = ctx.measureText(tagText).width;
      ctx.fillRect(p.x + 12, p.y - 20, textW + 10, 18);
      ctx.strokeStyle = "var(--cyan)";
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x + 12, p.y - 20, textW + 10, 18);

      ctx.fillStyle = "#fff";
      ctx.fillText(tagText, p.x + 17, p.y - 7);
    }

    // =========================================================================
    // Real-Time Server-Sent Events (SSE) Stream Receiver (<1s latency)
    // =========================================================================
    let isAdjustingGrid = false;
    let gridDebounceTimer = null;

    function startSSE() {
      const evtSource = new EventSource('/api/stream');
      
      evtSource.onmessage = function(e) {
        try {
          const data = JSON.parse(e.data);
          if (isAdjustingGrid) {
            delete data.grid_w;
            delete data.grid_h;
          }
          telemetry = { ...telemetry, ...data };
          updateHUD();
        } catch (err) { }
      };

      evtSource.onerror = function() {
        console.warn("SSE disconnected, retrying...");
        evtSource.close();
        setTimeout(startSSE, 1000);
      };
    }
    startSSE();

    function updateHUD() {
      document.getElementById('hudX').innerText = telemetry.pos_x.toFixed(2);
      document.getElementById('hudY').innerText = telemetry.pos_y.toFixed(2);
      document.getElementById('hudXFt').innerText = telemetry.pos_x_ft.toFixed(1);
      document.getElementById('hudYFt').innerText = telemetry.pos_y_ft.toFixed(1);
      document.getElementById('hudSpeed').innerText = `${telemetry.speed_mps.toFixed(2)} m/s (${telemetry.speed_mph.toFixed(1)} mph)`;
      document.getElementById('hudHeading').innerText = `${telemetry.heading_deg.toFixed(0)}°`;
      document.getElementById('hudHdop').innerText = telemetry.hdop.toFixed(2);
      document.getElementById('hudLatency').innerText = `${telemetry.latency_ms.toFixed(0)} ms`;
      document.getElementById('badgeRate').innerText = `${telemetry.update_hz.toFixed(1)} Hz (${telemetry.latency_ms.toFixed(0)} ms)`;
      document.getElementById('badgeFix').innerText = telemetry.fix_type;

      // Update Header Dimension badge and Canvas fit button
      if (document.getElementById('headerGridDim')) {
        document.getElementById('headerGridDim').innerText = `${telemetry.grid_w.toFixed(0)}m × ${telemetry.grid_h.toFixed(0)}m`;
      }
      if (document.getElementById('btnFitDim')) {
        document.getElementById('btnFitDim').innerText = `${telemetry.grid_w.toFixed(0)}m`;
      }

      // Update Anchor Cards
      if (telemetry.anchors) {
        for (let i = 1; i <= 3; i++) {
          const a = telemetry.anchors[i];
          if (a) {
            document.getElementById(`rssi${i}`).innerText = a.rssi ? `${a.rssi} dBm` : `-- dBm`;
            document.getElementById(`dist${i}`).innerText = a.dist_m ? `${a.dist_m.toFixed(2)} m` : `-- m`;
          }
        }
      }

      // Audio Sonar Ping
      if (audioEnabled) {
        const now = Date.now();
        const minAnchorDist = Math.min(
          telemetry.anchors[1]?.dist_m || 99,
          telemetry.anchors[2]?.dist_m || 99,
          telemetry.anchors[3]?.dist_m || 99
        );
        const interval = Math.max(200, Math.min(1200, minAnchorDist * 70));
        if (now - lastSonarPing > interval) {
          playSonarPing(minAnchorDist);
          lastSonarPing = now;
        }
      }
    }

    // =========================================================================
    // REST API Actions: Signal Discovery, Assignment & Calibration
    // =========================================================================
    async function refreshSignals() {
      try {
        const res = await fetch('/api/signals');
        discoveredSignals = await res.json();
        document.getElementById('sigCount').innerText = discoveredSignals.length;
        renderSignalSelects();
      } catch (err) { }
    }
    setInterval(refreshSignals, 1500);
    refreshSignals();

    function renderSignalSelects() {
      const search = document.getElementById('inpSearch').value.toLowerCase();
      const filtered = discoveredSignals.filter(s => 
        s.name.toLowerCase().includes(search) || s.bssid_mac.toLowerCase().includes(search)
      );

      // Populate 3 select dropdowns
      for (let i = 1; i <= 3; i++) {
        const select = document.getElementById(`selectAnchor${i}`);
        const currentVal = telemetry.anchors?.[i]?.signal_id || "";
        
        let html = '<option value="">-- Choose Signal --</option>';
        filtered.forEach(s => {
          const sel = s.signal_id === currentVal ? 'selected' : '';
          html += `<option value="${s.signal_id}" ${sel}>${s.name} (${s.bssid_mac}) [${s.rssi} dBm] - ${s.radio_type}</option>`;
        });
        select.innerHTML = html;
      }

      // Populate Sidebar Signal List
      const listDiv = document.getElementById('signalsList');
      let listHtml = '';
      filtered.forEach(s => {
        listHtml += `
          <div style="padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong style="color:#fff;">${s.name}</strong><br>
              <span style="font-family:monospace; color:var(--text-dim);">${s.bssid_mac}</span>
            </div>
            <div style="text-align:right;">
              <span style="color:var(--cyan); font-weight:700;">${s.rssi} dBm</span><br>
              <span style="color:var(--text-dim);">${s.radio_type}</span>
            </div>
          </div>
        `;
      });
      listDiv.innerHTML = listHtml;
    }

    async function assignAnchor(anchorId, signalId) {
      if (!signalId) return;
      await fetch('/api/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor_id: anchorId, signal_id: signalId })
      });
    }

    async function autoAssignStrongest() {
      await fetch('/api/auto_assign', { method: 'POST' });
      refreshSignals();
    }

    async function calibrateAnchor(anchorId, distM) {
      const res = await fetch('/api/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor_id: anchorId, distance_m: distM })
      });
      const data = await res.json();
      alert(`Anchor ${anchorId} Calibrated!\nNew 1m Reference RSSI (A): ${data.new_A} dBm`);
    }

    // =========================================================================
    // Grid Dimension Management (Interactive Sliders, Presets & Modal)
    // =========================================================================
    let lockAspect = true;

    function applyPreset(w, h) {
      document.querySelectorAll('.preset-grid .pill-btn').forEach(btn => {
        if (btn.innerText.startsWith(`${w}×${h}`) || btn.innerText.startsWith(`${w}m`)) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
      syncDimensions(w, h, true);
      fitGrid();
    }

    function onSliderDimChange(dim, val) {
      val = parseFloat(val);
      let w = telemetry.grid_w;
      let h = telemetry.grid_h;

      if (dim === 'w') {
        w = val;
        if (lockAspect) h = val;
      } else {
        h = val;
        if (lockAspect) w = val;
      }

      syncDimensions(w, h, false);
    }

    function stepDim(dim, delta) {
      let w = telemetry.grid_w;
      let h = telemetry.grid_h;

      if (dim === 'w') {
        w = Math.max(3, Math.min(150, w + delta));
        if (lockAspect) h = w;
      } else {
        h = Math.max(3, Math.min(150, h + delta));
        if (lockAspect) w = h;
      }

      syncDimensions(w, h, true);
    }

    function toggleLockAspect(checked) {
      lockAspect = checked;
      if (lockAspect) {
        syncDimensions(telemetry.grid_w, telemetry.grid_w, true);
      }
    }

    function syncDimensions(w, h, updateSliders) {
      w = parseFloat(w);
      h = parseFloat(h);

      telemetry.grid_w = w;
      telemetry.grid_h = h;

      // Update Slider and Numeric Displays
      if (updateSliders) {
        const sw = document.getElementById('rangeGridW');
        const sh = document.getElementById('rangeGridH');
        if (sw) sw.value = w;
        if (sh) sh.value = h;
      }
      
      const dw = document.getElementById('dispGridW');
      const dh = document.getElementById('dispGridH');
      const dwft = document.getElementById('dispGridWFt');
      const dhft = document.getElementById('dispGridHFt');
      const hdim = document.getElementById('headerGridDim');
      const fitdim = document.getElementById('btnFitDim');
      
      if (dw) dw.innerText = w.toFixed(1);
      if (dh) dh.innerText = h.toFixed(1);
      if (dwft) dwft.innerText = (w * 3.28084).toFixed(1);
      if (dhft) dhft.innerText = (h * 3.28084).toFixed(1);
      if (hdim) hdim.innerText = `${w.toFixed(0)}m × ${h.toFixed(0)}m`;
      if (fitdim) fitdim.innerText = `${w.toFixed(0)}m`;

      // Update Anchor Position Badges in Sidebar
      const p2 = document.getElementById('posPill2');
      const p3 = document.getElementById('posPill3');
      if (p2) p2.innerText = `(${w.toFixed(1)}m, 0.0m)`;
      if (p3) p3.innerText = `(0.0m, ${h.toFixed(1)}m)`;

      // Update Modal Inputs if open
      const miw = document.getElementById('modalInputW');
      const mih = document.getElementById('modalInputH');
      const miwft = document.getElementById('modalInputWFt');
      const mihft = document.getElementById('modalInputHFt');
      if (miw) miw.value = w;
      if (mih) mih.value = h;
      if (miwft) miwft.value = (w * 3.28084).toFixed(1);
      if (mihft) mihft.value = (h * 3.28084).toFixed(1);

      const ma2 = document.getElementById('modalA2Preview');
      const ma3 = document.getElementById('modalA3Preview');
      if (ma2) ma2.innerText = `🟢 Anchor 2: (${w.toFixed(1)}m, 0.0m)`;
      if (ma3) ma3.innerText = `🟡 Anchor 3: (0.0m, ${h.toFixed(1)}m)`;

      // Flag adjusting to prevent SSE overwrite
      isAdjustingGrid = true;
      clearTimeout(gridDebounceTimer);
      gridDebounceTimer = setTimeout(() => {
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grid_w: w,
            grid_h: h,
            snap_anchors: document.getElementById('chkAutoSnap')?.checked ?? true
          })
        }).then(() => {
          setTimeout(() => { isAdjustingGrid = false; }, 400);
        });
      }, 150);
    }

    function openGridModal() {
      const modal = document.getElementById('gridModal');
      if (!modal) return;
      modal.style.display = 'flex';
      syncDimensions(telemetry.grid_w, telemetry.grid_h, true);
    }

    function closeGridModal() {
      const modal = document.getElementById('gridModal');
      if (modal) modal.style.display = 'none';
    }

    function saveModalGrid() {
      const w = parseFloat(document.getElementById('modalInputW').value);
      const h = parseFloat(document.getElementById('modalInputH').value);
      syncDimensions(w, h, true);
      fitGrid();
      closeGridModal();
    }

    function syncModalFromMeters(dim, val) {
      val = parseFloat(val) || 0;
      if (dim === 'w') {
        document.getElementById('modalInputWFt').value = (val * 3.28084).toFixed(1);
        if (lockAspect) {
          document.getElementById('modalInputH').value = val;
          document.getElementById('modalInputHFt').value = (val * 3.28084).toFixed(1);
        }
      } else {
        document.getElementById('modalInputHFt').value = (val * 3.28084).toFixed(1);
        if (lockAspect) {
          document.getElementById('modalInputW').value = val;
          document.getElementById('modalInputWFt').value = (val * 3.28084).toFixed(1);
        }
      }
      const w = parseFloat(document.getElementById('modalInputW').value);
      const h = parseFloat(document.getElementById('modalInputH').value);
      syncDimensions(w, h, true);
    }

    function syncModalFromFeet(dim, val) {
      val = parseFloat(val) || 0;
      const meters = val / 3.28084;
      if (dim === 'w') {
        document.getElementById('modalInputW').value = meters.toFixed(1);
        if (lockAspect) {
          document.getElementById('modalInputH').value = meters.toFixed(1);
          document.getElementById('modalInputHFt').value = val.toFixed(1);
        }
      } else {
        document.getElementById('modalInputH').value = meters.toFixed(1);
        if (lockAspect) {
          document.getElementById('modalInputW').value = meters.toFixed(1);
          document.getElementById('modalInputWFt').value = val.toFixed(1);
        }
      }
      const w = parseFloat(document.getElementById('modalInputW').value);
      const h = parseFloat(document.getElementById('modalInputH').value);
      syncDimensions(w, h, true);
    }

    async function updateExponent(val) {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ n_exp: parseFloat(val) })
      });
    }

    async function toggleMock() {
      const res = await fetch('/api/toggle_mock', { method: 'POST' });
      const data = await res.json();
      document.getElementById('btnToggleMock').innerText = data.mock_mode ? '🛑 Stop Mock' : '🎭 Simulate Walk';
    }

    async function clearTrail() {
      await fetch('/api/reset_trail', { method: 'POST' });
    }

    function exportCSV() {
      window.location.href = '/api/export_csv';
    }

    // Web Audio Proximity Sonar
    function toggleAudio() {
      audioEnabled = !audioEnabled;
      const btn = document.getElementById('btnAudioToggle');
      if (audioEnabled) {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        btn.innerText = '🔊 Sound ON';
        btn.style.color = 'var(--emerald)';
      } else {
        btn.innerText = '🔇 Sound OFF';
        btn.style.color = '';
      }
    }

    function playSonarPing(dist) {
      if (!audioCtx) return;
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        // Pitch increases as you get closer to origin / anchor
        const freq = Math.max(300, Math.min(1800, 1600 - dist * 40));
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.12);
      } catch (e) { }
    }
  </script>
</body>
</html>
"""

# =============================================================================
# Embedded HTTP Server & REST API Handlers
# =============================================================================

class RadarHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Silence standard HTTP access logging to keep console clean

    def do_GET(self):
        url = urlparse(self.path)
        
        # 1. Main Dashboard HTML
        if url.path in ["/", "/index.html"]:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_DASHBOARD.encode('utf-8'))
            return

        # 2. Server-Sent Events (SSE) Stream
        if url.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            import queue
            client_q = queue.Queue(maxsize=15)
            with STATE.lock:
                STATE.sse_queues.append(client_q)
            
            try:
                while True:
                    msg = client_q.get()
                    self.wfile.write(msg.encode('utf-8'))
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with STATE.lock:
                    if client_q in STATE.sse_queues:
                        STATE.sse_queues.remove(client_q)
            return

        # 3. Discovered Signals List
        if url.path == "/api/signals":
            with STATE.lock:
                now = time.time()
                # Return signals seen in last 30 seconds, clean for JSON serialization
                active_signals = [
                    {
                        "signal_id": s["signal_id"],
                        "name": s["name"],
                        "bssid_mac": s["bssid_mac"],
                        "radio_type": s["radio_type"],
                        "rssi": s["rssi"],
                        "quality": s.get("quality", 50),
                        "last_seen": s["last_seen"]
                    }
                    for s in STATE.signals.values()
                    if (now - s.get("last_seen", 0)) < 30.0
                ]
                active_signals.sort(key=lambda x: x.get("rssi", -100), reverse=True)
                
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(active_signals).encode('utf-8'))
            return

        # 4. CSV Telemetry Export
        if url.path == "/api/export_csv":
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow([
                "Timestamp", "X_m", "Y_m", "Speed_mps",
                "Anchor1_Dist_m", "Anchor2_Dist_m", "Anchor3_Dist_m",
                "Anchor1_RSSI", "Anchor2_RSSI", "Anchor3_RSSI", "HDOP"
            ])
            with STATE.lock:
                for row in STATE.telemetry_log:
                    writer.writerow([
                        row["time"], row["x_m"], row["y_m"], row["speed_mps"],
                        row["a1_dist"], row["a2_dist"], row["a3_dist"],
                        row["a1_rssi"], row["a2_rssi"], row["a3_rssi"], row["hdop"]
                    ])
            
            csv_bytes = output.getvalue().encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            self.send_header("Content-Disposition", "attachment; filename=tactical_2d_grid_telemetry.csv")
            self.end_headers()
            self.wfile.write(csv_bytes)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        url = urlparse(self.path)
        content_len = int(self.headers.get('Content-Length', 0))
        post_body = self.rfile.read(content_len).decode('utf-8') if content_len > 0 else "{}"
        
        try:
            req_data = json.loads(post_body)
        except Exception:
            req_data = {}

        # 1. Assign Signal to Anchor
        if url.path == "/api/assign":
            a_id = int(req_data.get("anchor_id", 1))
            sig_id = req_data.get("signal_id")
            with STATE.lock:
                if a_id in STATE.anchors and sig_id in STATE.signals:
                    sig = STATE.signals[sig_id]
                    anchor = STATE.anchors[a_id]
                    anchor["signal_id"] = sig_id
                    anchor["signal_name"] = sig["name"]
                    anchor["last_rssi"] = sig["rssi"]
                    anchor["history"].clear()
                    print(f"[ASSIGN] Anchor {a_id} assigned to {sig['name']} ({sig['bssid_mac']})")
                STATE.save_config()
                    
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
            return

        # 2. Auto-Assign 3 Strongest Signals
        if url.path == "/api/auto_assign":
            with STATE.lock:
                active_signals = sorted(
                    STATE.signals.values(),
                    key=lambda s: s.get("rssi", -100),
                    reverse=True
                )
                for i in range(min(3, len(active_signals))):
                    sig = active_signals[i]
                    a_id = i + 1
                    anchor = STATE.anchors[a_id]
                    anchor["signal_id"] = sig["signal_id"]
                    anchor["signal_name"] = sig["name"]
                    anchor["last_rssi"] = sig["rssi"]
                    anchor["history"].clear()
                    print(f"[AUTO-ASSIGN] Anchor {a_id} -> {sig['name']} ({sig['rssi']} dBm)")
                STATE.save_config()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
            return

        # 3. Calibrate Anchor 1-Meter Reference RSSI
        if url.path == "/api/calibrate":
            a_id = int(req_data.get("anchor_id", 1))
            calib_dist = float(req_data.get("distance_m", 1.0))
            
            with STATE.lock:
                anchor = STATE.anchors.get(a_id)
                if anchor and anchor["history"]:
                    # Compute mean/median of recent RSSI readings
                    recent_rssi = float(np.median(list(anchor["history"])[-10:]))
                    # A = RSSI + 10 * n * log10(d)
                    new_A = recent_rssi + 10.0 * anchor["n_exp"] * math.log10(max(0.1, calib_dist))
                    anchor["A_ref"] = round(new_A, 1)
                    print(f"[CALIB] Anchor {a_id} calibrated at {calib_dist}m: New A_ref = {anchor['A_ref']} dBm")
                else:
                    new_A = -42.0
                STATE.save_config()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "new_A": new_A}).encode('utf-8'))
            return

        # 4. Update Grid Config
        if url.path == "/api/config":
            with STATE.lock:
                snap = req_data.get("snap_anchors", True)
                if "grid_w" in req_data:
                    gw = float(req_data["grid_w"])
                    STATE.grid_width = gw
                    if snap:
                        STATE.anchors[2]["x"] = gw # Move Anchor 2 to end of X axis
                if "grid_h" in req_data:
                    gh = float(req_data["grid_h"])
                    STATE.grid_height = gh
                    if snap:
                        STATE.anchors[3]["y"] = gh # Move Anchor 3 to end of Y axis
                if "n_exp" in req_data:
                    n = float(req_data["n_exp"])
                    for a in STATE.anchors.values():
                        a["n_exp"] = n
                STATE.save_config()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
            return

        # 5. Clear Breadcrumb Trail
        if url.path == "/api/reset_trail":
            with STATE.lock:
                STATE.breadcrumb_trail.clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode('utf-8'))
            return

        # 6. Toggle Mock Mode
        if url.path == "/api/toggle_mock":
            with STATE.lock:
                STATE.mock_mode = not STATE.mock_mode
                mode = STATE.mock_mode
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "mock_mode": mode}).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

# =============================================================================
# CLI & Application Entry Point
# =============================================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(description="IntoTheClouds: 2D Tactical Grid Mapper")
    parser.add_argument("--port", type=int, default=8899, help="HTTP Server Port (default: 8899)")
    parser.add_argument("--mock", action="store_true", help="Start immediately in simulation/mock mode")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open web browser")
    args = parser.parse_args()

    if args.mock:
        STATE.mock_mode = True

    print("=" * 72)
    print("   INTO THE CLOUDS // 2D TACTICAL GRID MAPPER")
    print("   (30m x 30m Hotspot Beacon Trilateration & Calibration Suite)")
    print("=" * 72)
    print(f"[*] Grid Dimensions: {STATE.grid_width}m x {STATE.grid_height}m")
    print(f"[*] Anchor 1: Origin (0.0m, 0.0m)")
    print(f"[*] Anchor 2: X-Axis End ({STATE.grid_width}m, 0.0m)")
    print(f"[*] Anchor 3: Y-Axis End (0.0m, {STATE.grid_height}m)")
    print(f"[*] Target Latency: < 1.0s (Native wlanapi query cycle: 200-250ms)")
    print("=" * 72)

    # Start Native Wi-Fi Scanner thread
    t_wifi = threading.Thread(target=background_wifi_scanner_thread, daemon=True, name="WlanScanner")
    t_wifi.start()
    print("[+] Background Wi-Fi Driver: ACTIVE (Native wlanapi.dll C API)")

    # Start BLE Scanner thread if available
    if HAS_BLEAK:
        t_ble = threading.Thread(target=background_ble_scanner_thread, daemon=True, name="BleScanner")
        t_ble.start()
        print("[+] Background BLE Scanner: ACTIVE (Bleak Asynchronous)")
    else:
        print("[-] Bleak not found; running Wi-Fi mode only.")

    # Start Positioning & Kalman Filter Engine
    t_pos = threading.Thread(target=positioning_engine_thread, daemon=True, name="TrilaterationKalmanEngine")
    t_pos.start()
    print("[+] Trilateration & 2D Kalman Engine: ACTIVE (5 Hz update rate)")

    # Start HTTP Web Server
    server_addr = ("0.0.0.0", args.port)
    try:
        httpd = HTTPServer(server_addr, RadarHTTPHandler)
    except OSError as e:
        print(f"[!] Port {args.port} in use, trying {args.port + 1}...")
        args.port += 1
        httpd = HTTPServer(("0.0.0.0", args.port), RadarHTTPHandler)

    hud_url = f"http://127.0.0.1:{args.port}"
    lan_url = f"http://{STATE.lan_ip}:{args.port}"
    print(f"[+] Local Web HUD:    {hud_url}")
    print(f"[+] Mobile / Network: {lan_url}  (Open on phone/tablet while walking)")
    print("[*] Press Ctrl+C in this terminal to stop.")
    print("=" * 72)

    # Automatically launch browser HUD
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(hud_url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down radar server...")
        httpd.server_close()
        sys.exit(0)

if __name__ == "__main__":
    main()
