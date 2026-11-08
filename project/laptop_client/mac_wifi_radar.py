#!/usr/bin/env python3
"""Mac Wi-Fi scanner that serves the radar's /api/telemetry format (LC-04).

Mac stand-in for the Windows-only Wi-Fi scanner in unified_rf_distance_radar.py (PR #43, not merged here; it uses `netsh`).
Replaces `netsh` on a Mac walker: scans with CoreWLAN (through mac_wifi_scan.swift, compiled once
into ~/.cache/itc) and serves the same JSON that radar_bridge.py and `spot_survey.py collect
--wifi radar` already read. Unlike netsh it returns real dBm.

  python3 mac_wifi_radar.py --list                      # one scan, print what it sees
  python3 mac_wifi_radar.py [--ssid ITC-A1 --ssid ...]  # serve http://127.0.0.1:8888/api/telemetry

Needs Xcode command line tools (swiftc). IMPORTANT: macOS hides network names (SSID/BSSID) from
apps without Location Services permission. Allow your terminal app in System Settings > Privacy &
Security > Location Services. If names still come back blank, pass --ssid to scan for each beacon
by exact name. Untested against real ITC- hotspots.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SWIFT_SRC = os.path.join(HERE, "mac_wifi_scan.swift")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "itc")
BIN = os.path.join(CACHE, "mac_wifi_scan")
ACTIVE_S = 14  # same freshness the bridge expects


def parse_scan(text):
    """Tab-separated helper output -> ([{ssid, bssid, rssi_dbm, channel}], hidden_count).
    Rows with neither SSID nor BSSID are counted as hidden (no Location permission) and dropped."""
    nets, hidden = [], 0
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ssid, bssid = parts[0].strip(), parts[1].strip().lower()
        try:
            rssi = float(parts[2])
            channel = int(parts[3]) if len(parts) > 3 and parts[3].strip() else 0
        except ValueError:
            continue
        if not (-110 < rssi < 0):  # CoreWLAN reports 0 when it has no value
            continue
        if not ssid and not bssid:
            hidden += 1
            continue
        nets.append({"ssid": ssid, "bssid": bssid, "rssi_dbm": rssi, "channel": channel})
    return nets, hidden


class Radar:
    """Keeps the latest reading per network and renders the radar telemetry JSON."""

    def __init__(self, clock=time.time):
        self.clock, self.devices, self.lock = clock, {}, threading.Lock()
        self.last_scan, self.last_hidden, self.error = None, 0, None

    def update(self, nets, hidden=0):
        now = self.clock()
        with self.lock:
            for n in nets:
                key = "wifi:" + (n["bssid"] or n["ssid"].lower())  # same key format as unified_rf_distance_radar.py
                self.devices[key] = {"key": key, "radio_type": "wifi", "name": n["ssid"] or key,
                                     "rssi": n["rssi_dbm"], "channel": n["channel"], "seen": now}
            self.last_scan, self.last_hidden, self.error = now, hidden, None

    def telemetry(self):
        now = self.clock()
        with self.lock:
            devs = []
            for d in self.devices.values():
                age = round(now - d["seen"], 1)
                devs.append({"key": d["key"], "radio_type": "wifi", "name": d["name"], "rssi": d["rssi"],
                             "channel": d["channel"], "last_seen_sec": age, "is_active": age < ACTIVE_S})
            return {"all_devices": devs, "hidden_in_last_scan": self.last_hidden, "error": self.error}


def build_helper():
    if os.path.exists(BIN) and os.path.getmtime(BIN) >= os.path.getmtime(SWIFT_SRC):
        return BIN
    os.makedirs(CACHE, exist_ok=True)
    r = subprocess.run(["swiftc", "-O", SWIFT_SRC, "-o", BIN], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("swiftc failed (install Xcode command line tools: xcode-select --install): " + r.stderr.strip())
    return BIN


def scan_once(ssids=()):
    r = subprocess.run([build_helper(), *ssids], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"scan exit {r.returncode}")
    return parse_scan(r.stdout)


def scan_loop(radar, ssids, period):
    while True:
        try:
            radar.update(*scan_once(ssids))
        except Exception as e:
            with radar.lock:
                radar.error = str(e)
            print(f"[scan] {e}", file=sys.stderr)
        time.sleep(period)


def make_handler(radar):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?")[0] != "/api/telemetry":
                self.send_error(404)
                return
            body = json.dumps(radar.telemetry()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    return H


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ssid", action="append", default=[], help="scan for this exact SSID (repeatable); default scans all")
    p.add_argument("--port", type=int, default=8888)
    p.add_argument("--period", type=float, default=1.0, help="seconds between scans")
    p.add_argument("--list", action="store_true", help="scan once, print networks, exit")
    a = p.parse_args()
    if sys.platform != "darwin":
        sys.exit("mac_wifi_radar.py needs macOS (CoreWLAN). On Windows use win_scan_benchmark.py / spot_survey --wifi netsh.")
    if a.list:
        nets, hidden = scan_once(a.ssid)
        for n in sorted(nets, key=lambda n: -n["rssi_dbm"]):
            print(f'{n["rssi_dbm"]:>6.0f} dBm  ch{n["channel"]:<3} {n["ssid"]!r:<28} {n["bssid"]}')
        print(f"{len(nets)} named networks, {hidden} hidden." + (
            " Hidden = no Location Services permission for this terminal (System Settings > Privacy & Security)." if hidden else ""))
        return
    radar = Radar()
    threading.Thread(target=scan_loop, args=(radar, a.ssid, a.period), daemon=True).start()
    print(f"serving http://127.0.0.1:{a.port}/api/telemetry (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(radar)).serve_forever()


if __name__ == "__main__":
    main()
