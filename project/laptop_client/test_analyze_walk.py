"""Tests for analyze_walk.py using a synthetic recorded walk whose true settings are known."""
import json
import math
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_walk as W  # noqa: E402

ANCHORS = {1: (0.0, 0.0), 2: (7.32, 0.0), 3: (0.0, 7.32)}
TRUE = {1: (-46.0, 2.2), 2: (-52.0, 2.8), 3: (-56.0, 3.0)}       # A, n per beacon
TRUE_STRIDE, TRUE_OFFSET, OFFSET_ERR = 0.66, 200.0, 12.0          # the mapper starts with the offset wrong by 12 deg


def synth(path, rounds=2, dwell=14.0, speed=0.9, seed=3, rssi_sd=1.0):
    rnd = random.Random(seed)
    route = ["A2", "A1", "A3"]
    for _ in range(rounds - 1):
        route += ["A1", "A2", "A1", "A3"]
    pos = {f"A{i}": p for i, p in ANCHORS.items()}
    ev = [{"k": "meta", "t": 1000.0, "version": "walk-rec-1", "grid": [7.32, 7.32], "route": route, "rounds": rounds,
           "anchors": {str(i): {"name": f"b{i}", "signal_id": f"wifi:b{i}", "x": p[0], "y": p[1], "A_ref": -42.0, "n_exp": 2.4}
                       for i, p in ANCHORS.items()},
           "phone": {"offset_deg": TRUE_OFFSET + OFFSET_ERR, "aligned": True, "mode": "auto", "stride_m": 0.7,
                     "step_source": "dashboard", "step_thresh": 1.4, "step_gap_s": 0.4, "step_tau_lp": 0.05,
                     "gyro_bias": [0, 0, 0], "smoothing": 0.2}}]
    t = 1001.0
    ev.append({"k": "mark", "t": t, "type": "arrive", "label": route[0], "x": pos[route[0]][0], "y": pos[route[0]][1]})
    legs = list(zip(route, route[1:]))
    for a, b in legs:
        p0, p1 = pos[a], pos[b]
        t_dep = t + dwell
        ev.append({"k": "mark", "t": t_dep, "type": "depart", "label": a, "x": p0[0], "y": p0[1]})
        length = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        T = length / speed
        t_arr = t_dep + T
        n_steps = int(round(length / TRUE_STRIDE))
        for i in range(n_steps):
            ev.append({"k": "step", "t": round(t_dep + (i + 0.5) * T / n_steps, 3), "src": "dashboard"})
        true_h = math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0])) % 360.0
        tt = t_dep
        while tt < t_arr:                                           # compass at ~7 Hz, heading true + noise
            comp = (90.0 + TRUE_OFFSET - true_h + rnd.gauss(0, 3.0)) % 360.0
            ev.append({"k": "phone", "t": round(tt, 3), "c": comp, "cs": comp, "g": [0, 0, 0], "turn": False, "tilt": 5.0})
            tt += 0.15
        ev.append({"k": "mark", "t": t_arr, "type": "arrive", "label": b, "x": p1[0], "y": p1[1]})
        t = t_arr
        # dwell phase: still compass, nothing else
    t_end = t + dwell
    ev.append({"k": "pos", "t": t_end, "x": 0, "y": 0, "h": 0, "fix": "x", "hdop": 1, "pdr": True, "meas": None})
    marks = [e for e in ev if isinstance(e, dict) and e["k"] == "mark"]
    T = W.Truth(marks, t_end)
    out = list(ev)
    ts = 1003.0
    while ts < t_end:                                               # one Wi-Fi scan table every ~9 s (macOS), all beacons
        tr = T.at(ts)
        if tr is not None:
            for i, (ax, ay) in ANCHORS.items():
                d = max(math.hypot(tr[0] - ax, tr[1] - ay), W.STAND_OFF_M)
                A, n = TRUE[i]
                out.append({"k": "scan", "t": round(ts, 3), "a": i, "rssi": round(A - 10 * n * math.log10(d) + rnd.gauss(0, rssi_sd)),
                            "ema": 0, "d": 0})
        ts += 9.0 + rnd.uniform(-1, 1)
    tp = 1001.0
    while tp < t_end:                                               # live-filter position samples at 2 Hz
        tr = T.at(tp)
        if tr:
            out.append({"k": "pos", "t": round(tp, 3), "x": tr[0] + rnd.gauss(0, 1.5), "y": tr[1] + rnd.gauss(0, 1.5), "h": 0,
                        "fix": "3-ANCHOR FIX", "hdop": 1.0, "pdr": True, "meas": None})
        tp += 0.5
    out.sort(key=lambda e: e["t"])
    with open(path, "w") as f:
        for e in out:
            f.write(json.dumps(e) + "\n")
    return route


class AnalyzeWalk(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.path = os.path.join(cls.tmp, "walk.jsonl")
        cls.route = synth(cls.path)
        cls.r = W.analyse(cls.path)

    def test_route_shape(self):
        self.assertEqual(self.route[0], "A2")
        self.assertEqual(self.route[-1], "A3")

    def test_path_loss_recovered(self):
        for a, (A, n) in TRUE.items():
            c = self.r["calibration"][a]
            self.assertAlmostEqual(c["A_ref"], A, delta=2.0, msg=f"A{a}")
            self.assertAlmostEqual(c["n_exp"], n, delta=0.4, msg=f"A{a}")
            self.assertLess(c["range_err_fitted_m"], c["range_err_current_m"])

    def test_stride_recovered(self):
        s = self.r["stride"]
        self.assertAlmostEqual(s["recommended_stride_m"], TRUE_STRIDE, delta=0.04)
        self.assertGreaterEqual(len(s["legs"]), 4)

    def test_heading_offset_error_found_and_corrected(self):
        h = self.r["heading"]
        self.assertAlmostEqual(h["mean_error_deg"], OFFSET_ERR, delta=2.5)
        self.assertLess(abs(W.angle_diff(h["recommended_offset_deg"], TRUE_OFFSET)), 3.0)

    def test_replay_with_fitted_settings_beats_recorded_settings(self):
        p = self.r["replay"]
        self.assertLess(p["best"]["mean_err_m"], p["as_recorded_mean_err_m"])
        self.assertLess(p["best"]["mean_err_m"], 1.5)

    def test_recommended_stride_stays_near_measured_stride(self):
        rec = self.r["recommended"]["stride_m"]
        self.assertAlmostEqual(rec, self.r["stride"]["recommended_stride_m"], delta=0.09 * TRUE_STRIDE)

    def test_undo_is_applied(self):
        ev, _ = W.load(self.path)
        marks = [e for e in ev if e["k"] == "mark"]
        ev2 = ev + [{"k": "undo", "t": marks[-1]["t"] + 0.1, "removed": 1}]
        self.assertEqual(len(W.final_marks(ev2)), len(marks) - 1)

    def test_apply_refuses_remote_mapper(self):
        with self.assertRaises(SystemExit):
            W.apply_to_mapper(self.r["recommended"], "http://example.com:8899")

    def test_report_prints(self):
        text = W.fmt(self.r)
        for word in ("PATH LOSS", "STRIDE", "HEADING", "POSITION ERROR", "RECOMMENDED"):
            self.assertIn(word, text)
        self.assertNotIn("gps", text.lower())


if __name__ == "__main__":
    unittest.main()
