#!/usr/bin/env python3
"""
=============================================================================
IntoTheClouds: Raspberry Pi Wi-Fi RSSI Tactical Radar & Distance Estimator
=============================================================================
Designed for Raspberry Pi (Pi Zero 2W, Pi 3, Pi 4, Pi 5) running Raspberry Pi OS.

How it works:
1. Performs sub-second scans of 802.11 beacons via Linux `iw` or `nmcli`.
2. Filters for target perimeter beacon anchors (or scans all visible APs).
3. Applies Exponential Moving Average (EMA) filtering to smooth multipath noise.
4. Converts measured RSSI (dBm) into real-time physical distance (meters) using:
       d = 10 ** ((P0 - RSSI) / (10 * n))
5. Displays a live ASCII tactical signal radar in the terminal and streams JSON.
=============================================================================
"""

import sys
import os
import time
import re
import math
import json
import argparse
import subprocess

# ---------------------------------------------------------------------------
# RF Calibration Defaults (From Hackathon PRD)
# ---------------------------------------------------------------------------
DEFAULT_P0 = -40.0        # Reference RSSI at 1.0 meter (calibrated in room)
DEFAULT_PATH_LOSS_N = 2.5 # Path loss exponent (2.0 = free space, 2.5-3.0 = indoor smoke/walls)
EMA_ALPHA = 0.35          # Smoothing factor (0.0 to 1.0) to filter multipath jitter

class PiRssiDetector:
    def __init__(self, interface="wlan0", p0=DEFAULT_P0, n=DEFAULT_PATH_LOSS_N, 
                 target_ssids=None, target_bssids=None, simulate=False):
        self.interface = interface
        self.p0 = p0
        self.n = n
        self.target_ssids = [s.lower() for s in target_ssids] if target_ssids else []
        self.target_bssids = [b.lower() for b in target_bssids] if target_bssids else []
        self.simulate = simulate or (sys.platform != "linux")
        
        # Signal tracking cache: {bssid: {"rssi_smoothed": float, "last_seen": float, "ssid": str}}
        self.signal_cache = {}
        
        # Simulated walk positions for testing without physical Pi
        self.sim_tick = 0

    def rssi_to_distance(self, rssi_dbm: float) -> float:
        """
        Log-Distance Path Loss Formula:
        d = 10 ^ ((P0 - RSSI) / (10 * n))
        """
        exponent = (self.p0 - rssi_dbm) / (10.0 * self.n)
        dist_m = math.pow(10.0, exponent)
        return max(0.1, min(dist_m, 45.0)) # Clamped between 10cm and 45m

    def scan_linux_iw(self):
        """
        Scans using Linux `iw dev <iface> scan dump` or `sudo iw dev <iface> scan`.
        Provides high-precision sub-second raw dBm RSSI readings.
        """
        results = []
        try:
            # Trigger background scan (fast)
            subprocess.run(["sudo", "iw", "dev", self.interface, "scan", "trigger"], 
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=0.8)
            time.sleep(0.15)
            
            # Read dump results
            raw = subprocess.check_output(
                ["sudo", "iw", "dev", self.interface, "scan", "dump"],
                text=True, stderr=subprocess.DEVNULL, timeout=0.8
            )
            
            current_bssid = None
            current_rssi = None
            current_ssid = "UNKNOWN"

            for line in raw.splitlines():
                line = line.strip()
                if line.startswith("BSS "):
                    if current_bssid and current_rssi is not None:
                        results.append({"bssid": current_bssid, "ssid": current_ssid, "rssi": current_rssi})
                    parts = line.split("(")
                    current_bssid = parts[0].replace("BSS", "").strip().lower()
                    current_rssi = None
                    current_ssid = "HIDDEN"
                elif line.startswith("signal:"):
                    # Example: "signal: -58.00 dBm"
                    m = re.search(r"(-?\d+\.?\d*)\s*dBm", line)
                    if m:
                        current_rssi = float(m.group(1))
                elif line.startswith("SSID:"):
                    current_ssid = line.replace("SSID:", "").strip()

            if current_bssid and current_rssi is not None:
                results.append({"bssid": current_bssid, "ssid": current_ssid, "rssi": current_rssi})

            return results
        except Exception:
            # Fall back to nmcli if iw scan is unavailable
            return self.scan_linux_nmcli()

    def scan_linux_nmcli(self):
        """Fallback scanner using `nmcli`."""
        results = []
        try:
            raw = subprocess.check_output(
                ["nmcli", "-t", "-f", "BSSID,SSID,SIGNAL", "dev", "wifi"],
                text=True, stderr=subprocess.DEVNULL, timeout=1.0
            )
            for line in raw.strip().splitlines():
                parts = line.split(":")
                if len(parts) >= 8:
                    bssid = ":".join(parts[:6]).lower()
                    ssid = parts[6]
                    sig_pct = float(parts[7])
                    # Windows/Linux nmcli formula: dBm ~ (sig_pct / 2) - 100
                    rssi_dbm = (sig_pct / 2.0) - 100.0
                    results.append({"bssid": bssid, "ssid": ssid, "rssi": rssi_dbm})
            return results
        except Exception:
            return self.scan_simulated()

    def scan_simulated(self):
        """Simulates realistic fireground beacon signals with multipath fading."""
        self.sim_tick += 1
        t = self.sim_tick * 0.4
        
        # Firefighter walking in a circle in the room
        ff_x = 5.0 + 3.0 * math.cos(t * 0.5)
        ff_y = 5.0 + 3.0 * math.sin(t * 0.5)

        mock_anchors = [
            {"bssid": "aa:bb:cc:11:22:33", "ssid": "ANCHOR_NORTH", "x": 5.0,  "y": 1.0,  "p0": -38.0},
            {"bssid": "aa:bb:cc:44:55:66", "ssid": "ANCHOR_EAST",  "x": 10.0, "y": 5.0,  "p0": -40.0},
            {"bssid": "aa:bb:cc:77:88:99", "ssid": "ANCHOR_SOUTH", "x": 5.0,  "y": 10.0, "p0": -39.0},
            {"bssid": "aa:bb:cc:aa:bb:cc", "ssid": "VICTIM_PHONE", "x": 8.0,  "y": 8.0,  "p0": -42.0}
        ]

        scans = []
        for a in mock_anchors:
            dist = math.hypot(ff_x - a['x'], ff_y - a['y'])
            # RSSI = P0 - 10 * n * log10(d) + multipath noise
            noise = math.sin(t * 2.0) * 1.5
            rssi = a['p0'] - (10.0 * self.n * math.log10(max(0.3, dist))) + noise
            scans.append({
                "bssid": a["bssid"],
                "ssid": a["ssid"],
                "rssi": round(rssi, 1)
            })
        return scans

    def filter_and_process(self, raw_scans):
        """Filters targets, updates exponential moving average, and computes distance."""
        now = time.time()
        processed = []

        for item in raw_scans:
            bssid = item["bssid"].lower()
            ssid = item["ssid"]
            raw_rssi = item["rssi"]

            # Filter targets if specified
            if self.target_bssids and bssid not in self.target_bssids:
                continue
            if self.target_ssids and not any(target in ssid.lower() for target in self.target_ssids):
                continue

            # Exponential Moving Average (EMA) to smooth out RF noise
            if bssid in self.signal_cache:
                old_rssi = self.signal_cache[bssid]["rssi_smoothed"]
                smoothed_rssi = (EMA_ALPHA * raw_rssi) + ((1.0 - EMA_ALPHA) * old_rssi)
            else:
                smoothed_rssi = raw_rssi

            self.signal_cache[bssid] = {
                "rssi_smoothed": smoothed_rssi,
                "raw_rssi": raw_rssi,
                "ssid": ssid,
                "last_seen": now
            }

            distance = self.rssi_to_distance(smoothed_rssi)

            processed.append({
                "bssid": bssid,
                "ssid": ssid,
                "raw_rssi_dbm": round(raw_rssi, 1),
                "smoothed_rssi_dbm": round(smoothed_rssi, 1),
                "est_distance_m": round(distance, 2)
            })

        # Sort by signal strength (closest first)
        processed.sort(key=lambda x: x["smoothed_rssi_dbm"], reverse=True)
        return processed

    def get_signal_bar(self, rssi_dbm, max_width=16):
        """Draws visual ASCII RSSI signal bar: [||||||||        ]."""
        # Range: -95 dBm (0%) to -30 dBm (100%)
        pct = max(0.0, min(1.0, (rssi_dbm - (-95.0)) / ((-30.0) - (-95.0))))
        bars = int(pct * max_width)
        return "[" + ("█" * bars) + ("-" * (max_width - bars)) + f"] {int(pct*100)}%"

    def print_tactical_dashboard(self, targets):
        """Prints high-visibility firefighter HUD table directly in terminal."""
        # ANSI Clear screen
        print("\033[2J\033[H", end="")
        print("=" * 78)
        print("  INTO THE CLOUDS | RASPBERRY PI TACTICAL RSSI RADAR (HACKATHON POC)")
        print(f"  Interface: {self.interface} | Model: d = 10^((P0 - RSSI)/(10*n)) | P0: {self.p0}dBm | n: {self.n}")
        print("=" * 78)
        print(f"{'BEACON SSID':<20} {'BSSID':<18} {'RSSI (dBm)':<12} {'EST DIST':<10} {'SIGNAL METER'}")
        print("-" * 78)

        if not targets:
            print("  [!] Scanning for perimeter beacons... No matching signals detected.")
        else:
            for t in targets:
                bar = self.get_signal_bar(t["smoothed_rssi_dbm"])
                print(f"{t['ssid'][:19]:<20} {t['bssid']:<18} {t['smoothed_rssi_dbm']:>6.1f} dBm   {t['est_distance_m']:>5.2f}m    {bar}")

        print("-" * 78)
        print("  [PRO-TIP] Walk toward any beacon: RSSI climbs & Est Dist decreases.")
        print("  Press Ctrl+C to stop scanning.")


def main():
    parser = argparse.ArgumentParser(description="Raspberry Pi Wi-Fi RSSI Distance Radar")
    parser.add_argument("-i", "--interface", default="wlan0", help="Wi-Fi interface (default: wlan0)")
    parser.add_argument("--p0", type=float, default=DEFAULT_P0, help="Calibrated RSSI at 1m (default: -40 dBm)")
    parser.add_argument("-n", type=float, default=DEFAULT_PATH_LOSS_N, help="Path loss exponent (default: 2.5)")
    parser.add_argument("--ssid", nargs="*", help="Filter specific SSIDs (e.g. --ssid ANCHOR HOTSPOT)")
    parser.add_argument("--bssid", nargs="*", help="Filter specific BSSIDs")
    parser.add_argument("--interval", type=float, default=0.5, help="Scan loop interval in seconds (default: 0.5s)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of terminal HUD")
    parser.add_argument("--simulate", action="store_true", help="Force simulation mode")
    args = parser.parse_args()

    detector = PiRssiDetector(
        interface=args.interface,
        p0=args.p0,
        n=args.n,
        target_ssids=args.ssid,
        target_bssids=args.bssid,
        simulate=args.simulate
    )

    try:
        while True:
            raw = detector.scan_simulated() if detector.simulate else detector.scan_linux_iw()
            targets = detector.filter_and_process(raw)

            if args.json:
                print(json.dumps({
                    "timestamp": round(time.time(), 3),
                    "beacons": targets
                }))
            else:
                detector.print_tactical_dashboard(targets)

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n\n[+] Radar scan stopped.")

if __name__ == "__main__":
    main()

