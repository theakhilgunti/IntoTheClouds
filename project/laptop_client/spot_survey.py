#!/usr/bin/env python3
"""Spot survey -> 2D RF obstacle map (BE-09). Position is typed in, not estimated.

1) Stand on a taped spot whose x,y (metres) you measured, then record it:
     python spot_survey.py collect --anchors anchors.json --spot 2,1.5 --seconds 10 --out survey.json
   Averages each anchor's RSSI over the time and appends a spot to survey.json.
   Bluetooth anchors are scanned directly with bleak (the radar's BLE feed stalls after a few
   minutes), matched by address or name. Wi-Fi anchors come from the radar dashboard
   (unified_rf_distance_radar.py must be running). Needs numpy + bleak, e.g. the radar venv.
2) Build the map once you have spots on both sides of the wall:
     python spot_survey.py map --anchors anchors.json --survey survey.json --png map.png \
         [--p0 -55] [--n 2.5] [--blocked-db 6] [--wall 2,-2,2,6]
   Prints an ASCII map and writes a PNG. Red = rays through that cell were mostly weaker than
   the model predicts (possible obstacle), blue = mostly clear, grey = no rays.
   --baseline empty.json: use a survey of the SAME spots taken first without the obstacle, so the
   shortfall is (baseline - now) in dB instead of (model - now). Spots within 0.2 m are matched.
   --wall draws the real wall (x1,y1,x2,y2) so you can compare. Obstacle HINT, not a floor plan.
anchors.json: [{"id":"A1","match":"8b0e81fd","x":4,"y":0,"p0":-55}, ...] (same file as radar_bridge.py)
"""
import argparse
import asyncio
import json
import math
import os
import struct
import sys
import threading
import time
import zlib

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
from app.fusion.spot_map import SpotMap2D  # noqa: E402
from radar_bridge import get_json, match_devices  # noqa: E402


def xy(text):
    return [float(v) for v in text.split(",")]


def match_bt(address, name, anchors):
    """Anchor ids whose `match` is a case-insensitive substring of a BLE address or name."""
    hay = f"{address} {name or ''}".lower()
    return [x["id"] for x in anchors if x["match"].lower() in hay]


async def scan_bt(anchors, seconds):
    from bleak import BleakScanner  # imported late so `map` works without bleak
    out = {x["id"]: [] for x in anchors}

    def cb(device, adv):
        if adv.rssi is None:
            return
        for aid in match_bt(device.address, adv.local_name or device.name, anchors):
            out[aid].append(adv.rssi)

    async with BleakScanner(detection_callback=cb):
        await asyncio.sleep(seconds)
    return out


def cmd_collect(a):
    anchors = json.load(open(a.anchors))
    samples = {x["id"]: [] for x in anchors}
    # Wi-Fi comes from the radar, polled while the Bluetooth scan runs. Only Wi-Fi devices count
    # here, so a stale radar Bluetooth entry can never match a Bluetooth anchor.
    stop = threading.Event()

    def poll_wifi():
        while not stop.is_set():
            try:
                devs = [d for d in get_json(a.radar + "/api/telemetry")["all_devices"] if d["radio_type"] == "wifi"]
                for aid, d in match_devices(devs, anchors).items():
                    samples[aid].append(d["rssi"])
            except Exception as e:  # radar not running: Wi-Fi anchors just get no readings
                print(f"[wifi] radar unavailable: {e}", file=sys.stderr)
                return
            stop.wait(1.0)

    t = threading.Thread(target=poll_wifi, daemon=True)
    t.start()
    for aid, vals in asyncio.run(scan_bt(anchors, a.seconds)).items():
        samples[aid].extend(vals)
    stop.set()
    t.join(timeout=2)
    spot = {"xy": xy(a.spot), "readings": {}}
    for aid, vals in samples.items():
        if len(vals) >= 3:
            spot["readings"][aid] = {"rssi": round(float(np.mean(vals)), 1),
                                     "std": round(float(np.std(vals)), 1), "n": len(vals)}
    survey = json.load(open(a.out)) if os.path.exists(a.out) else []
    survey.append(spot)
    json.dump(survey, open(a.out, "w"), indent=1)
    print(f"spot {spot['xy']}: " + (", ".join(f"{k}={v['rssi']} dBm (sd {v['std']}, n={v['n']})"
          for k, v in spot["readings"].items()) or "NO readings (anchors not seen)"))


def baseline_lookup(baseline, tol=0.2):
    """Function (spot xy, anchor id) -> baseline RSSI of the baseline spot within tol metres, or None."""
    def look(xy_, aid):
        for b in baseline or []:
            if math.dist(b["xy"], xy_) <= tol and aid in b["readings"]:
                return b["readings"][aid]["rssi"]
        return None
    return look


def build_map(anchors, survey, p0=None, n=2.5, blocked_db=6.0, margin=2.0, cell_m=0.25, baseline=None):
    """baseline: survey of the same spots taken first with nothing in the way (the empty scene).
    Spots/anchors found there use shortfall = baseline - now; others fall back to the path-loss model."""
    look = baseline_lookup(baseline)
    pts = [s["xy"] for s in survey] + [[x["x"], x["y"]] for x in anchors]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    m = SpotMap2D((min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin),
                  cell_m=cell_m, blocked_db=blocked_db)
    by_id = {x["id"]: x for x in anchors}
    for s in survey:
        for aid, r in s["readings"].items():
            if aid in by_id:
                an = by_id[aid]
                m.add((an["x"], an["y"]), s["xy"], r["rssi"], p0 if p0 is not None else an.get("p0", -55.0), n,
                      baseline_rssi=look(s["xy"], aid))
    return m


def color(v):
    if math.isnan(v):
        return (40, 44, 52)
    v = max(-1.0, min(1.0, v))
    return (int(60 + 195 * v), int(70 - 30 * v), int(200 - 150 * v)) if v >= 0 else \
           (int(60 + 40 * v), int(110 + 40 * v), int(200))


def write_png(path, pix):
    h, w = len(pix), len(pix[0])
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pix)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def render(m, anchors, survey, path, wall=None, px=14):
    s = m.score()
    pix = [[color(s[m.ny - 1 - r, c]) for c in range(m.nx) for _ in range(px)] for r in range(m.ny) for _ in range(px)]

    def put(x, y, col, rad):
        cx, cy = int((x - m.min_x) / m.cell_m * px), int((m.ny - (y - m.min_y) / m.cell_m) * px)
        for dy in range(-rad, rad + 1):
            for dx in range(-rad, rad + 1):
                if 0 <= cy + dy < len(pix) and 0 <= cx + dx < len(pix[0]):
                    pix[cy + dy][cx + dx] = col
    if wall:
        for t in np.linspace(0, 1, 400):
            put(wall[0] + (wall[2] - wall[0]) * t, wall[1] + (wall[3] - wall[1]) * t, (255, 255, 255), 1)
    for sp in survey:
        put(sp["xy"][0], sp["xy"][1], (60, 220, 90), 3)
    for an in anchors:
        put(an["x"], an["y"], (255, 215, 0), 5)
    write_png(path, pix)


def ascii_map(m):
    s = m.score()
    rows = []
    for r in range(m.ny - 1, -1, -1):
        rows.append("".join(" " if math.isnan(v) else "#" if v > 0.5 else "+" if v > 0 else "." for v in s[r]))
    return "\n".join(rows)


def cmd_map(a):
    anchors, survey = json.load(open(a.anchors)), json.load(open(a.survey))
    baseline = json.load(open(a.baseline)) if a.baseline else None
    m = build_map(anchors, survey, a.p0, a.n, a.blocked_db, baseline=baseline)
    render(m, anchors, survey, a.png, xy(a.wall) if a.wall else None)
    blocked = int((m.blocked > 0).sum())
    print(ascii_map(m))
    print(f"\n{len(m.rays)} rays ({sum(1 for r in m.rays if r['short_db'] >= a.blocked_db)} blocked), "
          f"{blocked} cells ever blocked. '#' mostly blocked, '+' leaning blocked, '.' clear. PNG: {a.png}")
    print("Shortfall per ray (dB, positive = weaker than model):",
          ", ".join(f"{r['short_db']:+.0f}" for r in m.rays))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--anchors", required=True)
    c.add_argument("--spot", required=True, help="x,y metres of where you stand")
    c.add_argument("--seconds", type=float, default=10)
    c.add_argument("--out", default="survey.json")
    c.add_argument("--radar", default="http://127.0.0.1:8888")
    c.set_defaults(fn=cmd_collect)
    d = sub.add_parser("map")
    d.add_argument("--anchors", required=True)
    d.add_argument("--survey", default="survey.json")
    d.add_argument("--png", default="map.png")
    d.add_argument("--p0", type=float, help="override every anchor's 1 m RSSI")
    d.add_argument("--n", type=float, default=2.5, help="path-loss exponent")
    d.add_argument("--blocked-db", type=float, default=6.0)
    d.add_argument("--baseline", help="survey.json of the same spots taken with nothing in the way")
    d.add_argument("--wall", help="true wall x1,y1,x2,y2 to draw for comparison")
    d.set_defaults(fn=cmd_map)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
