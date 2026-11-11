#!/usr/bin/env python3
"""Bridge: unified RF radar (laptop beacons) -> IntoTheClouds backend (3D obstacle hints).

The radar dashboard (unified_rf_distance_radar.py) scans nearby BLE/Wi-Fi beacons.
This script polls its /api/telemetry, keeps only the beacons you list in an anchor
file (each with a surveyed x/y/z in metres), registers them as backend anchors, and
streams their RSSI to the backend's /ws/telemetry so it can localize this laptop
and build the obstacle voxel grid (GET /api/mesh).

Anchor file (JSON list). `match` is a case-insensitive substring of the radar's
device name or key (see the dashboard / `--list`):
  [{"id": "L1", "match": "macbook-john", "x": 0,  "y": 0,  "z": 0.8},
   {"id": "L2", "match": "ITC-A2",       "x": 10, "y": 0,  "z": 0.8, "p0": -45}]

Usage (needs `websockets`; the backend venv has it):
  python radar_bridge.py --list
  python radar_bridge.py --anchors anchors.json [--radar http://127.0.0.1:8888]
                         [--backend http://127.0.0.1:8000] [--hz 2]
"""
import argparse
import asyncio
import json
import sys
import time
import urllib.request


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.load(r)


def insecure_ctx():
    """TLS context that accepts the backend's self-signed certificate (local demo only)."""
    import ssl
    c = ssl.create_default_context()
    c.check_hostname, c.verify_mode = False, ssl.CERT_NONE
    return c


TLS_CTX = None  # set by --insecure


def post_json(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5, context=TLS_CTX if url.startswith("https") else None) as r:
        return json.load(r)


def match_devices(devices, anchors, max_age_s=15.0):
    """-> {anchor_id: device} choosing the strongest fresh device matching each anchor."""
    out = {}
    for a in anchors:
        needle = a["match"].lower()
        hits = [d for d in devices
                if d.get("rssi") is not None and d.get("last_seen_sec", 0) <= max_age_s
                and (needle in (d.get("name") or "").lower() or needle in d["key"].lower())]
        if hits:
            out[a["id"]] = max(hits, key=lambda d: d["rssi"])
    return out


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--anchors")
    p.add_argument("--radar", default="http://127.0.0.1:8888")
    p.add_argument("--backend", default="http://127.0.0.1:8000")
    p.add_argument("--hz", type=float, default=2.0)
    p.add_argument("--insecure", action="store_true", help="accept the backend's self-signed https certificate")
    p.add_argument("--list", action="store_true", help="print the beacons the radar sees, then exit")
    args = p.parse_args()
    global TLS_CTX
    if args.insecure:
        TLS_CTX = insecure_ctx()

    devices = get_json(args.radar + "/api/telemetry")["all_devices"]
    if args.list:
        for d in sorted((d for d in devices if d.get("is_active")), key=lambda d: -(d["rssi"] or -999)):
            print(f'{d["rssi"]:>6}  {d["radio_type"]:<5} {d["name"]!r:<28} {d["key"]}')
        return
    if not args.anchors:
        p.error("--anchors is required (or use --list)")
    anchors = json.load(open(args.anchors))

    import websockets  # imported late so --list works without it
    ws_url = args.backend.replace("http", "ws", 1) + "/ws/telemetry"
    registered = {}
    async with websockets.connect(ws_url, ssl=TLS_CTX if ws_url.startswith("wss") else None) as ws:
        print(f"[bridge] streaming to {ws_url}")
        while True:
            matched = match_devices(get_json(args.radar + "/api/telemetry")["all_devices"], anchors)
            scans = []
            for a in anchors:
                d = matched.get(a["id"])
                if d is None:
                    continue
                if registered.get(a["id"]) != d["key"]:  # (re)register when the device key changes
                    post_json(args.backend + "/api/anchors", {
                        "id": a["id"], "bssid": d["key"], "x": a["x"], "y": a["y"],
                        "z": a.get("z", 1.0), "p0": a.get("p0", -40.0)})
                    registered[a["id"]] = d["key"]
                    print(f'[bridge] anchor {a["id"]} <- {d["name"]!r} ({d["key"]})')
                scans.append({"bssid": d["key"], "rssi_dbm": d["rssi"]})
            if scans:
                await ws.send(json.dumps({"device_id": "laptop_walker", "timestamp": time.time(),
                                          "pdr": {"step_detected": False}, "wifi_scans": scans}))
            else:
                print("[bridge] no anchors visible", file=sys.stderr)
            await asyncio.sleep(1.0 / args.hz)


if __name__ == "__main__":
    asyncio.run(main())
