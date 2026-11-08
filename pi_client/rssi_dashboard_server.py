#!/usr/bin/env python3
"""
=============================================================================
  IntoTheClouds: Live Wi-Fi Tactical UI & Dashboard Server
=============================================================================
Zero external dependencies required (uses standard library http.server).
1. Forces active hardware Wi-Fi scans so Windows doesn't get stuck on 1 signal.
2. Tracks ALL individual radio signals (BSSIDs).
3. Serves a high-tech visual dashboard at http://127.0.0.1:8080.
4. Automatically opens your web browser to the dashboard!
=============================================================================
"""

import sys
import os
import time
import math
import subprocess
import re
import json
import webbrowser
import threading
import ctypes
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, BaseHTTPRequestHandler
from collections import deque

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_FILE = os.path.join(BASE_DIR, "web", "rssi_live.html")

P0 = -40.0
N_FACTOR = 2.4
WINDOW_SIZE = 5
EMA_ALPHA = 0.35
MAX_WALK_SPEED_MPS = 1.4

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

class PrecisionDistanceFilter:
    def __init__(self):
        self.raw_history = deque(maxlen=WINDOW_SIZE)
        self.smoothed_rssi = None
        self.last_distance = None
        self.last_update_time = time.time()

    def update(self, raw_rssi: float) -> tuple:
        now = time.time()
        dt = max(0.2, now - self.last_update_time)
        self.last_update_time = now

        self.raw_history.append(raw_rssi)
        sorted_window = sorted(self.raw_history)
        median_rssi = sorted_window[len(sorted_window) // 2]

        if self.smoothed_rssi is None:
            self.smoothed_rssi = median_rssi
        else:
            self.smoothed_rssi = (EMA_ALPHA * median_rssi) + ((1.0 - EMA_ALPHA) * self.smoothed_rssi)

        exponent = (P0 - self.smoothed_rssi) / (10.0 * N_FACTOR)
        calculated_m = math.pow(10.0, exponent)

        if self.last_distance is None:
            filtered_m = calculated_m
        else:
            max_change = MAX_WALK_SPEED_MPS * dt * 1.5
            delta = calculated_m - self.last_distance
            clamped_delta = max(-max_change, min(max_change, delta))
            filtered_m = self.last_distance + clamped_delta

        self.last_distance = max(0.2, filtered_m)
        filtered_ft = self.last_distance * 3.28084
        return self.smoothed_rssi, self.last_distance, filtered_ft

active_signals = []
filter_instances = {}
cache_lock = threading.Lock()

def scan_wifi_loop():
    global active_signals
    is_windows = sys.platform.startswith("win")

    while True:
        nets = []
        try:
            if is_windows:
                trigger_hardware_scan_windows()
                time.sleep(0.3)
                out = subprocess.check_output(
                    "netsh wlan show networks mode=bssid",
                    shell=True, text=True, stderr=subprocess.DEVNULL
                )
                cur_ssid = ""
                cur_bssid = ""
                for line in out.splitlines():
                    l = line.strip()
                    if l.startswith("SSID ") and ":" in l:
                        cur_ssid = l.split(":", 1)[1].strip()
                    elif l.startswith("BSSID ") and ":" in l:
                        cur_bssid = l.split(":", 1)[1].strip().lower()
                    elif l.startswith("Signal"):
                        m = re.search(r"(\d+)%", l)
                        if m:
                            pct = int(m.group(1))
                            rssi = round((pct / 2.0) - 100.0, 1)
                            disp = cur_ssid if cur_ssid else f"[Hidden Beacon]"
                            nets.append({"ssid": disp, "bssid": cur_bssid, "pct": pct, "rssi": rssi})
            else:
                out = subprocess.check_output(
                    ["nmcli", "-t", "-f", "SSID,BSSID,SIGNAL", "dev", "wifi"],
                    text=True, stderr=subprocess.DEVNULL
                )
                for line in out.strip().splitlines():
                    p = line.split(":")
                    if len(p) >= 8:
                        ssid = p[0].strip()
                        bssid = ":".join(p[1:7]).strip().lower()
                        pct = int(p[7].strip())
                        rssi = round((pct / 2.0) - 100.0, 1)
                        disp = ssid if ssid else f"[Hidden Beacon]"
                        nets.append({"ssid": disp, "bssid": bssid, "pct": pct, "rssi": rssi})
        except Exception:
            pass

        nets.sort(key=lambda x: x["pct"], reverse=True)

        with cache_lock:
            active_signals = nets

        time.sleep(1.2)


class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            with open(HTML_FILE, "rb") as f:
                self.wfile.write(f.read())

        elif path == "/api/networks":
            with cache_lock:
                data = list(active_signals)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode("utf-8"))

        elif path == "/api/track":
            params = parse_qs(parsed.query)
            target = params.get("target", [""])[0].strip()
            target_bssid = params.get("bssid", [""])[0].strip()

            found_match = None
            with cache_lock:
                for s in active_signals:
                    if target_bssid and s["bssid"] == target_bssid:
                        found_match = s
                        break
                    elif s["ssid"].lower() == target.lower():
                        found_match = s
                        break

            if found_match:
                key = found_match["bssid"] if found_match.get("bssid") else found_match["ssid"]
                if key not in filter_instances:
                    filter_instances[key] = PrecisionDistanceFilter()
                filt = filter_instances[key]

                sm_rssi, dist_m, dist_ft = filt.update(found_match["rssi"])
                response_payload = {
                    "found": True,
                    "ssid": found_match["ssid"],
                    "bssid": found_match["bssid"],
                    "raw_rssi": found_match["rssi"],
                    "smoothed_rssi": round(sm_rssi, 1),
                    "distance_m": round(dist_m, 2),
                    "distance_ft": round(dist_ft, 1)
                }
            else:
                response_payload = {"found": False, "target": target}

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response_payload).encode("utf-8"))

        else:
            self.send_response(404)
            self.end_headers()

def main():
    port = 8080
    print("\n" + "=" * 65)
    print("  INTO THE CLOUDS | LIVE WI-FI RADAR UI SERVER")
    print("=" * 65)
    print(f"  [+] Starting active hardware Wi-Fi scanner thread...")
    scanner_thread = threading.Thread(target=scan_wifi_loop, daemon=True)
    scanner_thread.start()

    time.sleep(1.0)
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, DashboardHandler)
    url = f"http://127.0.0.1:{port}"

    print(f"  [+] Dashboard UI live at: {url}")
    print(f"  [+] Opening in your web browser...")
    print(f"  (Press Ctrl + C in this terminal when you want to stop)\n")
    print("=" * 65 + "\n")

    webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[+] Dashboard stopped.\n")

if __name__ == "__main__":
    main()
