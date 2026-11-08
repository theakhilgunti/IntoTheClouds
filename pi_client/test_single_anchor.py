#!/usr/bin/env python3
"""
=============================================================================
  IntoTheClouds: Universal Wi-Fi Signal Selector & Precision Tracker
=============================================================================
- Hardware Active Scanning: Forces active radio sweeps every cycle.
- Searches & Displays ALL available RSSI radio signals (all physical BSSIDs).
- Select any signal by number to lock on with mathematical smoothing.
=============================================================================
"""

import sys
import os
import time
import math
import subprocess
import re
import ctypes
from collections import deque

P0 = -40.0                   # Expected signal at 1 meter (-40 dBm)
N_FACTOR = 2.4               # Path loss exponent (indoor)
WINDOW_SIZE = 5              # 5-point median window
EMA_ALPHA = 0.35             # Smoothing weight
MAX_WALK_SPEED_MPS = 1.4     # Max human walking rate limit (1.4 m/s)

def trigger_hardware_scan_windows():
    """Forces Windows to actively scan all Wi-Fi channels."""
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


def scan_all_wifi_windows():
    trigger_hardware_scan_windows()
    time.sleep(0.3)
    networks = []
    try:
        output = subprocess.check_output(
            "netsh wlan show networks mode=bssid",
            shell=True, text=True, stderr=subprocess.DEVNULL
        )
        current_ssid = ""
        current_bssid = ""
        for line in output.splitlines():
            line = line.strip()
            if line.startswith("SSID ") and ":" in line:
                current_ssid = line.split(":", 1)[1].strip()
            elif line.startswith("BSSID ") and ":" in line:
                current_bssid = line.split(":", 1)[1].strip().lower()
            elif line.startswith("Signal"):
                m = re.search(r"(\d+)%", line)
                if m:
                    pct = int(m.group(1))
                    rssi_dbm = round((pct / 2.0) - 100.0, 1)
                    disp_name = current_ssid if current_ssid else f"[Hidden Beacon]"
                    networks.append({
                        "ssid": disp_name,
                        "bssid": current_bssid,
                        "rssi": rssi_dbm,
                        "pct": pct
                    })
    except Exception:
        pass
    return networks


def scan_all_wifi_linux():
    networks = []
    try:
        output = subprocess.check_output(
            ["nmcli", "-t", "-f", "SSID,BSSID,SIGNAL", "dev", "wifi"],
            text=True, stderr=subprocess.DEVNULL
        )
        for line in output.strip().splitlines():
            parts = line.split(":")
            if len(parts) >= 8:
                ssid = parts[0].strip()
                bssid = ":".join(parts[1:7]).strip().lower()
                try:
                    pct = int(parts[7].strip())
                    rssi_dbm = round((pct / 2.0) - 100.0, 1)
                    disp_name = ssid if ssid else f"[Hidden Beacon]"
                    networks.append({
                        "ssid": disp_name,
                        "bssid": bssid,
                        "rssi": rssi_dbm,
                        "pct": pct
                    })
                except ValueError:
                    continue
    except Exception:
        pass
    return networks


def get_all_signals():
    """Returns all available radio signals sorted by strongest first."""
    is_windows = sys.platform.startswith("win")
    raw = scan_all_wifi_windows() if is_windows else scan_all_wifi_linux()
    raw.sort(key=lambda x: x["pct"], reverse=True)
    return raw


def draw_visual_meter(distance_m):
    max_range = 10.0
    ratio = max(0.0, min(1.0, 1.0 - (distance_m / max_range)))
    bars = int(ratio * 20)
    bar_str = "[" + ("█" * bars) + ("-" * (20 - bars)) + "]"
    
    if distance_m <= 1.5:
        zone = "🎯 IMMEDIATE PROXIMITY (< 5 ft)"
    elif distance_m <= 4.0:
        zone = "🟢 CLOSE RANGE (Same Room)"
    elif distance_m <= 8.0:
        zone = "🟡 MEDIUM RANGE (Across Room / Hallway)"
    else:
        zone = "🔴 FAR RANGE"
    return f"{bar_str} {zone}"


def main():
    print("\n" + "=" * 78)
    print("  INTO THE CLOUDS | ALL AVAILABLE WI-FI RSSI SIGNALS")
    print("=" * 78)
    print("  Triggering active radio sweep across all 2.4 GHz & 5 GHz channels...\n")

    signals = []
    retry_count = 0
    while not signals:
        signals = get_all_signals()
        if not signals:
            retry_count += 1
            print(f"  [Scan {retry_count}] Refreshing radio channels... please wait.")
            time.sleep(1.0)

    # Show list of all available signals
    print(f"FOUND {len(signals)} AVAILABLE RADIO SIGNALS:")
    print("-" * 78)
    print(f"{'#':<4} {'NETWORK NAME (SSID)':<28} {'BSSID (MAC)':<20} {'SIGNAL (RSSI)':<12} {'ROUGH DIST'}")
    print("-" * 78)

    display_limit = min(25, len(signals))
    for i in range(display_limit):
        s = signals[i]
        rough_m = math.pow(10.0, (P0 - s["rssi"]) / (10.0 * N_FACTOR))
        rough_ft = rough_m * 3.28084
        highlight = " 📱 [HOTSPOT]" if any(k in s["ssid"].lower() for k in ["prem", "iphone", "hotspot"]) else ""
        print(f"[{i+1:<2}] {s['ssid'][:26]:<28} {s['bssid']:<20} {s['pct']:>3}% ({s['rssi']:>5.1f} dBm) ~{rough_m:>4.1f}m ({rough_ft:>4.1f}ft){highlight}")
    print("-" * 78)

    # Choose
    chosen = None
    while chosen is None:
        try:
            choice_str = input(f"\n👉 Enter the NUMBER you want to track (1 to {display_limit}): ").strip()
            if not choice_str:
                continue
            choice_idx = int(choice_str) - 1
            if 0 <= choice_idx < display_limit:
                chosen = signals[choice_idx]
            else:
                print("Invalid number. Please try again.")
        except ValueError:
            print("Please enter a valid number (e.g. 1).")
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            return

    target_ssid = chosen["ssid"]
    target_bssid = chosen["bssid"]
    print(f"\n[+] LOCKED ONTO: '{target_ssid}' [{target_bssid}] ({chosen['pct']}%)")
    print(f"[+] Starting precision distance tracking (Press Ctrl + C to stop)...\n")
    time.sleep(0.5)

    filter_engine = PrecisionDistanceFilter()
    last_reported_dist = None

    try:
        while True:
            current_signals = get_all_signals()

            # Find target by BSSID or SSID
            match = None
            for s in current_signals:
                if s["bssid"] == target_bssid:
                    match = s
                    break
            if not match:
                for s in current_signals:
                    if s["ssid"] == target_ssid:
                        match = s
                        break

            now = time.strftime("%H:%M:%S")

            if match:
                raw_rssi = match["rssi"]
                smoothed_rssi, dist_m, dist_ft = filter_engine.update(raw_rssi)

                if last_reported_dist is not None:
                    diff = dist_m - last_reported_dist
                    if diff < -0.15:
                        trend = "🚶 Approaching (Getting Closer)"
                    elif diff > 0.15:
                        trend = "🏃 Moving Away"
                    else:
                        trend = "⏸ Holding Steady"
                else:
                    trend = "📍 Target Acquired"
                last_reported_dist = dist_m

                meter = draw_visual_meter(dist_m)

                print(f"[{now}] TARGET: {target_ssid} [{target_bssid}]")
                print(f"       Signal (RSSI) : {match['pct']}% | Raw: {raw_rssi} dBm --> Filtered: {smoothed_rssi:.1f} dBm")
                print(f"       Est. Distance : {dist_m:.1f} meters ({dist_ft:.1f} feet)")
                print(f"       Movement      : {trend}")
                print(f"       Proximity     : {meter}\n")

            else:
                print(f"[{now}] Refreshing signal for '{target_ssid}' [{target_bssid}]...")

            time.sleep(1.0)

    except KeyboardInterrupt:
        print(f"\n[+] Tracking stopped for '{target_ssid}'.\n")


if __name__ == "__main__":
    main()
