#!/usr/bin/env python3
"""Spot survey -> 2D RF obstacle map (BE-09). Position is typed in, not estimated.

1) Stand on a taped spot whose x,y (metres) you measured, then record it:
     python spot_survey.py collect --anchors anchors.json --spot 2,1.5 --seconds 10 --out survey.json
   Averages the radar's RSSI for each anchor over the time and appends a spot to survey.json.
   Needs the radar dashboard running (unified_rf_distance_radar.py).
2) Build the map once you have spots on both sides of the wall:
     python spot_survey.py map --anchors anchors.json --survey survey.json --png map.png \
         [--p0 -55] [--n 2.5] [--blocked-db 6] [--wall 2,-2,2,6]
   Prints an ASCII map and writes a PNG. Red = rays through that cell were mostly weaker than
   the model predicts (possible obstacle), blue = mostly clear, grey = no rays.
   --wall draws the real wall (x1,y1,x2,y2) so you can compare. Obstacle HINT, not a floor plan.
anchors.json: [{"id":"A1","match":"8b0e81fd","x":4,"y":0,"p0":-55}, ...] (same file as radar_bridge.py)
"""
import argparse
import json
import math
import os
import struct
import sys
import time
import zlib

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
from app.fusion.spot_map import SpotMap2D  # noqa: E402
from radar_bridge import get_json, match_devices  # noqa: E402


def xy(text):
    return [float(v) for v in text.split(",")]


def cmd_collect(a):
    anchors = json.load(open(a.anchors))
    samples = {x["id"]: [] for x in anchors}
    end = time.time() + a.seconds
    while time.time() < end:
        matched = match_devices(get_json(a.radar + "/api/telemetry")["all_devices"], anchors)
        for aid, d in matched.items():
            samples[aid].append(d["rssi"])
        time.sleep(0.5)
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


def build_map(anchors, survey, p0=None, n=2.5, blocked_db=6.0, margin=2.0, cell_m=0.25):
    pts = [s["xy"] for s in survey] + [[x["x"], x["y"]] for x in anchors]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    m = SpotMap2D((min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin),
                  cell_m=cell_m, blocked_db=blocked_db)
    by_id = {x["id"]: x for x in anchors}
    for s in survey:
        for aid, r in s["readings"].items():
            if aid in by_id:
                an = by_id[aid]
                m.add((an["x"], an["y"]), s["xy"], r["rssi"], p0 if p0 is not None else an.get("p0", -55.0), n)
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
    m = build_map(anchors, survey, a.p0, a.n, a.blocked_db)
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
    d.add_argument("--wall", help="true wall x1,y1,x2,y2 to draw for comparison")
    d.set_defaults(fn=cmd_map)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
