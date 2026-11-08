#!/usr/bin/env python3
"""Offline analysis of a walk recorded by the mapper (REC-01 / MAP-12).

    python analyze_walk.py recordings/walk_<id>.jsonl [--apply] [--write-fit fit.json]

Ground truth comes from your taps on /walker: you stood at a beacon (arrive ... leave), then walked a straight
leg to the next one. From that this script works out, with no hardware:

  1. Per-beacon path loss (A = RSSI at 1 m, n = exponent), fitted on the true distances at every scan.
  2. Stride length: leg length / steps counted on that leg.
  3. Compass heading offset: phone heading vs the true direction of each straight leg (plus drift per minute).
  4. How far the live filter was from the truth, and the best stride / offset / fix-noise found by replaying
     the recorded scans, steps and headings through a dead-reckoning filter.

It prints recommended settings and optionally writes them (--write-fit) or sends them to the running mapper on
localhost (--apply). No location data is read or needed: only beacon RSSI, compass, gyro, accelerometer and taps.
"""
import argparse
import json
import math
import sys
import urllib.request
from collections import deque
from urllib.parse import urlparse

import numpy as np
from scipy.optimize import least_squares

N_MIN, N_MAX = 1.6, 4.0          # same clamp as the mapper
STAND_OFF_M = 0.5                # you stand about this far from a laptop when "at" a beacon
FRESH_S = 30.0                   # a scan older than this no longer counts (macOS scans take ~8 s)
MED_N = 3                        # median over the last N scans per beacon, as the mapper does


# ------------------------------------------------------------------ loading and ground truth
def load(path):
    ev = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                ev.append(json.loads(line))
    ev.sort(key=lambda e: e["t"])
    meta = next((e for e in ev if e["k"] == "meta"), None)
    if meta is None:
        raise SystemExit("not a walk recording: no meta line")
    return ev, meta


def final_marks(ev):
    """Taps after applying every Undo."""
    marks = []
    for e in ev:
        if e["k"] == "mark":
            marks.append(e)
        elif e["k"] == "undo":
            del marks[len(marks) - int(e.get("removed", 1)):]
    return marks


def anchor_xy(meta):
    return {int(k): (float(a["x"]), float(a["y"])) for k, a in meta["anchors"].items()}


class Truth:
    """Where you really were, from the taps: still at a beacon while dwelling, straight line while walking."""

    def __init__(self, marks, t_end):
        self.segs = []   # (kind, t0, t1, p0, p1, label0, label1)
        cur = None
        for m in marks:
            p = (float(m["x"]), float(m["y"]))
            if m["type"] == "arrive":
                if cur and cur[0] == "walk":
                    self.segs.append(("walk", cur[1], m["t"], cur[2], p, cur[3], m["label"]))
                cur = ("dwell", m["t"], p, m["label"])
            elif m["type"] == "depart" and cur and cur[0] == "dwell":
                self.segs.append(("dwell", cur[1], m["t"], cur[2], cur[2], cur[3], cur[3]))
                cur = ("walk", m["t"], cur[2], cur[3])
        if cur and cur[0] == "dwell":
            self.segs.append(("dwell", cur[1], max(t_end, cur[1]), cur[2], cur[2], cur[3], cur[3]))
        self.t_start = self.segs[0][1] if self.segs else None

    def at(self, t):
        """(x, y, kind) or None when outside the tapped part of the walk."""
        for kind, t0, t1, p0, p1, _, _ in self.segs:
            if t0 <= t <= t1:
                f = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
                return p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1]), kind
        return None

    def walks(self):
        return [s for s in self.segs if s[0] == "walk"]


# ------------------------------------------------------------------ small math helpers
def angle_diff(a, b):
    return (a - b + 180.0) % 360.0 - 180.0


def circ_mean(angles):
    r = np.radians(list(angles))
    return math.degrees(math.atan2(np.sin(r).sum(), np.cos(r).sum())) % 360.0


def circ_std(angles):
    m = circ_mean(angles)
    return float(np.sqrt(np.mean([angle_diff(a, m) ** 2 for a in angles])))


def map_heading(compass, offset):
    return (90.0 - compass + offset) % 360.0


def pct(values, q):
    return float(np.percentile(values, q)) if len(values) else float("nan")


def stats(values):
    v = np.asarray(values, dtype=float)
    return {"n": int(v.size), "mean": float(v.mean()) if v.size else float("nan"),
            "median": pct(v, 50), "p95": pct(v, 95)}


# ------------------------------------------------------------------ 1. path loss per beacon
def fit_path_loss(dist, rssi, n_fallback=2.4):
    """rssi = A - 10 n log10(d). Needs two clearly different distances to fit n; otherwise A only."""
    d = np.maximum(np.asarray(dist, float), STAND_OFF_M)
    r = np.asarray(rssi, float)
    x = np.log10(d)
    n, spread = n_fallback, float(x.max() - x.min()) if x.size else 0.0
    if x.size >= 4 and spread > 0.15:                      # distances differ by at least ~1.4x
        slope, _ = np.polyfit(x, r, 1)
        n = float(np.clip(-slope / 10.0, N_MIN, N_MAX))
    A = float(np.mean(r + 10.0 * n * x))
    rmse = float(np.sqrt(np.mean((A - 10.0 * n * x - r) ** 2)))
    return {"A_ref": round(A, 1), "n_exp": round(n, 2), "rmse_db": round(rmse, 2), "points": int(x.size),
            "d_range": [round(float(d.min()), 1), round(float(d.max()), 1)], "n_fitted": bool(n != n_fallback or spread > 0.15)}


def range_est(rssi, A, n):
    return 10.0 ** ((A - rssi) / (10.0 * n))


def calibration(ev, meta, truth):
    axy = anchor_xy(meta)
    per = {}
    for e in ev:
        if e["k"] != "scan" or e.get("a") not in axy:
            continue
        tr = truth.at(e["t"])
        if tr is None:
            continue
        d = math.hypot(tr[0] - axy[e["a"]][0], tr[1] - axy[e["a"]][1])
        per.setdefault(e["a"], []).append((d, e["rssi"], tr[2]))
    out = {}
    for a, rows in sorted(per.items()):
        use = [r for r in rows if r[2] == "dwell"] or rows        # dwell truth is exact; moving truth is approximate
        cur = meta["anchors"][str(a)]
        fit = fit_path_loss([r[0] for r in use], [r[1] for r in use], cur["n_exp"])
        err_cur = [abs(range_est(r[1], cur["A_ref"], cur["n_exp"]) - max(r[0], STAND_OFF_M)) for r in rows]
        err_fit = [abs(range_est(r[1], fit["A_ref"], fit["n_exp"]) - max(r[0], STAND_OFF_M)) for r in rows]
        fit.update(scans=len(rows), current={"A_ref": cur["A_ref"], "n_exp": cur["n_exp"]},
                   range_err_current_m=round(float(np.mean(err_cur)), 2), range_err_fitted_m=round(float(np.mean(err_fit)), 2))
        out[a] = fit
    return out


# ------------------------------------------------------------------ 2. stride and 3. heading
def count_in(ev, kind, t0, t1):
    return sum(1 for e in ev if e["k"] == kind and t0 <= e["t"] <= t1)


def stride_report(ev, truth, meta):
    legs = []
    for _, t0, t1, p0, p1, l0, l1 in truth.walks():
        length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        steps, wsteps = count_in(ev, "step", t0, t1), count_in(ev, "wstep", t0, t1)
        legs.append({"leg": f"{l0}->{l1}", "length_m": round(length, 2), "seconds": round(t1 - t0, 1), "steps": steps,
                     "phone_page_steps": wsteps, "stride_m": round(length / steps, 3) if steps >= 3 else None})
    vals = [l["stride_m"] for l in legs if l["stride_m"]]
    rec = round(float(np.median(vals)), 3) if vals else None
    return {"legs": legs, "recommended_stride_m": rec, "current_stride_m": meta["phone"]["stride_m"],
            "spread_pct": round(100 * float(np.std(vals) / np.mean(vals)), 1) if len(vals) > 1 else None}


def heading_report(ev, truth, meta):
    off = float(meta["phone"]["offset_deg"])
    phone = [e for e in ev if e["k"] == "phone"]
    legs, all_err = [], []
    for _, t0, t1, p0, p1, l0, l1 in truth.walks():
        true_h = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0])) % 360.0
        lo, hi = t0 + 0.2 * (t1 - t0), t0 + 0.8 * (t1 - t0)          # skip the turn-around at both ends
        errs = [angle_diff(map_heading(e["cs"], off), true_h) for e in phone if lo <= e["t"] <= hi and not e.get("turn")]
        if len(errs) >= 5:
            legs.append({"leg": f"{l0}->{l1}", "true_heading": round(true_h), "err_deg": round(float(np.mean(errs)), 1),
                         "t_mid": (t0 + t1) / 2, "samples": len(errs)})
            all_err += errs
    if not legs:
        return {"legs": [], "note": "no usable phone heading samples on the walking legs (is the phone streaming and aligned?)"}
    bias = float(np.mean(all_err))
    mean_leg = [l["err_deg"] for l in legs]
    drift = None
    if len(legs) >= 3:
        t = np.array([l["t_mid"] for l in legs]) / 60.0
        drift = round(float(np.polyfit(t - t.mean(), mean_leg, 1)[0]), 2)
    for l in legs:
        l.pop("t_mid")
    return {"legs": legs, "current_offset_deg": round(off, 2), "mean_error_deg": round(bias, 1),
            "recommended_offset_deg": round((off - bias) % 360.0, 2), "leg_spread_deg": round(float(np.std(mean_leg)), 1),
            "drift_deg_per_min": drift}


# ------------------------------------------------------------------ 4. live error and replay
def live_error(ev, truth):
    live, fixes = {"dwell": [], "walk": []}, []
    for e in ev:
        if e["k"] != "pos":
            continue
        tr = truth.at(e["t"])
        if tr is None:
            continue
        live[tr[2]].append(math.hypot(e["x"] - tr[0], e["y"] - tr[1]))
        if e.get("meas"):
            fixes.append(math.hypot(e["meas"][0] - tr[0], e["meas"][1] - tr[1]))
    return {"live_dwell": stats(live["dwell"]), "live_walking": stats(live["walk"]), "live_all": stats(live["dwell"] + live["walk"]),
            "raw_wifi_fixes": stats(fixes)}


def trilaterate(pts, d, start):
    res = least_squares(lambda p: np.linalg.norm(pts - p, axis=1) - d, start, loss="soft_l1")
    return res.x


def replay(ev, meta, truth, calib, stride, offset, sigma_fix):
    """Dead-reckon with steps along the phone heading; each fresh trilaterated Wi-Fi fix pulls the position."""
    axy = anchor_xy(meta)
    ids = sorted(axy)
    pts = np.array([axy[i] for i in ids])
    hist = {i: deque(maxlen=MED_N) for i in ids}
    last_t = {i: -1e9 for i in ids}
    first = truth.at(truth.t_start)
    pos, var = np.array([first[0], first[1]], float), 0.25
    comp, errs = None, []
    q_step = (0.15 * stride) ** 2 + (stride * math.radians(10)) ** 2
    for e in ev:
        k, t = e["k"], e["t"]
        if truth.t_start is None or t < truth.t_start:
            continue
        if k == "phone":
            comp = e["cs"]
        elif k == "step" and comp is not None:
            h = math.radians(map_heading(comp, offset))
            pos = pos + stride * np.array([math.cos(h), math.sin(h)])
            var += q_step
        elif k == "scan" and e.get("a") in hist:
            hist[e["a"]].append(e["rssi"])
            last_t[e["a"]] = t
            fresh = [i for i in ids if t - last_t[i] < FRESH_S and hist[i]]
            if len(fresh) >= 3:
                d = np.array([range_est(float(np.median(hist[i])), calib[i]["A_ref"], calib[i]["n_exp"]) for i in fresh])
                fix = trilaterate(np.array([axy[i] for i in fresh]), d, pos)
                R = sigma_fix ** 2
                innov = fix - pos
                if float(innov @ innov) / (var + R) < 25.0:                 # drop wild multipath fixes
                    pos = pos + (var / (var + R)) * innov
                    var = var * R / (var + R)
        elif k == "pos":
            tr = truth.at(t)
            if tr is not None:
                errs.append(math.hypot(pos[0] - tr[0], pos[1] - tr[1]))
        var = min(var, 25.0)
    return float(np.mean(errs)) if errs else float("nan"), errs


def optimise(ev, meta, truth, calib_fit, calib_cur, stride_rec, offset_rec, offset_cur):
    cur = replay(ev, meta, truth, calib_cur, meta["phone"]["stride_m"], offset_cur, 1.5)[0]
    best = best_at_centre = None
    # The stride measured leg by leg against known distances is real data; the replay may only fine-tune around it
    # (a free search overfits: it trades stride against fix noise to hide other errors).
    centre = stride_rec or meta["phone"]["stride_m"]
    strides = sorted({round(centre * f, 3) for f in (0.92, 0.96, 1.0, 1.04, 1.08)})
    for st in strides:
        for dd in range(-10, 11, 5):
            for sg in (1.0, 1.5, 2.0, 3.0, 4.0):
                m, _ = replay(ev, meta, truth, calib_fit, st, (offset_rec + dd) % 360.0, sg)
                cand = {"stride_m": st, "offset_deg": round((offset_rec + dd) % 360.0, 2), "fix_sigma_m": sg, "mean_err_m": m}
                if best is None or m < best["mean_err_m"]:
                    best = cand
                if st == round(centre, 3) and (best_at_centre is None or m < best_at_centre["mean_err_m"]):
                    best_at_centre = cand
    if best_at_centre and best_at_centre["mean_err_m"] - best["mean_err_m"] < 0.05:
        best = best_at_centre                      # a tiny replay gain is not worth overriding the measured stride
    seeded = replay(ev, meta, truth, calib_fit, stride_rec or meta["phone"]["stride_m"], offset_rec, 1.5)[0]
    return {"as_recorded_mean_err_m": cur, "fitted_seed_mean_err_m": seeded, "best": best}


# ------------------------------------------------------------------ report
def analyse(path):
    ev, meta = load(path)
    marks = final_marks(ev)
    if len(marks) < 3:
        raise SystemExit("need at least start + leave + arrive taps")
    truth = Truth(marks, ev[-1]["t"])
    cal = calibration(ev, meta, truth)
    stride = stride_report(ev, truth, meta)
    head = heading_report(ev, truth, meta)
    live = live_error(ev, truth)
    calib_cur = {int(k): {"A_ref": a["A_ref"], "n_exp": a["n_exp"]} for k, a in meta["anchors"].items()}
    calib_fit = {a: {"A_ref": c["A_ref"], "n_exp": c["n_exp"]} for a, c in cal.items()}
    for a, c in calib_cur.items():
        calib_fit.setdefault(a, c)
    rep = optimise(ev, meta, truth, calib_fit, calib_cur, stride["recommended_stride_m"],
                   head.get("recommended_offset_deg", float(meta["phone"]["offset_deg"])), float(meta["phone"]["offset_deg"]))
    rec = {"anchors": {str(a): {"A_ref": c["A_ref"], "n_exp": c["n_exp"]} for a, c in calib_fit.items()},
           "stride_m": rep["best"]["stride_m"] if rep["best"] else stride["recommended_stride_m"],
           "phone_offset_deg": rep["best"]["offset_deg"] if rep["best"] else head.get("recommended_offset_deg"),
           "fix_sigma_m": rep["best"]["fix_sigma_m"] if rep["best"] else None}
    return {"file": path, "duration_s": round(ev[-1]["t"] - ev[0]["t"], 1), "taps": len(marks),
            "counts": {k: sum(1 for e in ev if e["k"] == k) for k in ("scan", "phone", "acc", "step", "wstep", "pos")},
            "calibration": cal, "stride": stride, "heading": head, "live_error": live, "replay": rep, "recommended": rec}


def fmt(r):
    L = [f"Walk {r['file']}: {r['duration_s']} s, {r['taps']} taps, events {r['counts']}", ""]
    L.append("1. PATH LOSS per beacon (fitted on true distances)")
    for a, c in r["calibration"].items():
        warn = "" if c["n_fitted"] else "  (one distance only: n kept, A fitted)"
        L.append(f"   A{a}: A {c['current']['A_ref']} -> {c['A_ref']}   n {c['current']['n_exp']} -> {c['n_exp']}   fit {c['rmse_db']} dB over {c['points']} scans "
                 f"({c['d_range'][0]}-{c['d_range'][1]} m){warn}")
        L.append(f"       mean range error {c['range_err_current_m']} m now -> {c['range_err_fitted_m']} m fitted ({c['scans']} scans)")
    s = r["stride"]
    L += ["", f"2. STRIDE  now {s['current_stride_m']} m -> recommended {s['recommended_stride_m']} m   (leg-to-leg spread {s['spread_pct']} %)"]
    for l in s["legs"]:
        L.append(f"   {l['leg']:<8} {l['length_m']} m in {l['seconds']} s: {l['steps']} steps (phone page {l['phone_page_steps']}) -> {l['stride_m']} m/step")
    h = r["heading"]
    L += ["", "3. HEADING"]
    if h["legs"]:
        L.append(f"   offset {h['current_offset_deg']} deg -> recommended {h['recommended_offset_deg']} deg   (mean error {h['mean_error_deg']} deg, leg-to-leg spread {h['leg_spread_deg']} deg, drift {h['drift_deg_per_min']} deg/min)")
        for l in h["legs"]:
            L.append(f"   {l['leg']:<8} true {l['true_heading']:>3} deg   phone heading error {l['err_deg']:>6} deg  ({l['samples']} samples)")
    else:
        L.append("   " + h["note"])
    e = r["live_error"]
    L += ["", "4. POSITION ERROR vs truth (m)"]
    for name in ("live_dwell", "live_walking", "live_all", "raw_wifi_fixes"):
        v = e[name]
        L.append(f"   {name:<15} n {v['n']:>4}  mean {v['mean']:.2f}  median {v['median']:.2f}  p95 {v['p95']:.2f}")
    p = r["replay"]
    L.append(f"   replay with recorded settings: mean {p['as_recorded_mean_err_m']:.2f} m;  with fitted calibration/stride/offset: {p['fitted_seed_mean_err_m']:.2f} m;  best found: {p['best']['mean_err_m']:.2f} m")
    rc = r["recommended"]
    L += ["", "RECOMMENDED (replay-tested on this walk; verify with a second walk):",
          f"   stride {rc['stride_m']} m" + (f" (measured on the legs: {s['recommended_stride_m']} m; the replay prefers a slightly different value because Wi-Fi fixes also pull the position)"
                                           if s["recommended_stride_m"] and abs(rc["stride_m"] - s["recommended_stride_m"]) > 0.005 else " (matches the legs)")
          + f"\n   phone offset {rc['phone_offset_deg']} deg   wifi fix noise {rc['fix_sigma_m']} m",
          "   " + "   ".join(f"A{a}: A {c['A_ref']}, n {c['n_exp']}" for a, c in rc["anchors"].items())]
    return "\n".join(L)


def apply_to_mapper(rec, base):
    host = urlparse(base).hostname
    if host not in ("localhost", "127.0.0.1", "::1"):
        raise SystemExit("--apply only talks to a mapper on this machine")

    def post(path, body):
        req = urllib.request.Request(base.rstrip("/") + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    for a, c in rec["anchors"].items():
        post("/api/calib", {"action": "set", "anchor_id": int(a), "A_ref": c["A_ref"], "n_exp": c["n_exp"]})
    post("/api/phone_calib", {"action": "set", "stride_m": rec["stride_m"], "offset_deg": rec["phone_offset_deg"]})
    print("applied calibration, stride and heading offset to", base)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording")
    ap.add_argument("--write-fit", metavar="FILE", help="write the full result and recommended settings as JSON")
    ap.add_argument("--apply", action="store_true", help="send the recommended settings to the running mapper (localhost only)")
    ap.add_argument("--mapper-url", default="http://127.0.0.1:8899")
    a = ap.parse_args(argv)
    r = analyse(a.recording)
    print(fmt(r))
    if a.write_fit:
        with open(a.write_fit, "w") as f:
            json.dump(r, f, indent=2, default=float)
        print("wrote", a.write_fit)
    if a.apply:
        apply_to_mapper(r["recommended"], a.mapper_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
