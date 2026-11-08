"""Tests for the mapper calibration (MAP-04). Run: python -m unittest test_wifi_2d_grid_mapper_calib"""
import importlib.util
import json
import math
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mapper", os.path.join(HERE, "wifi_2d_grid_mapper.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def rssi(A, n, d):
    return A - 10 * n * math.log10(d)


class FitMath(unittest.TestCase):
    def test_exact_fit(self):
        pts = [(d, rssi(-45, 2.8, d)) for d in (1, 2, 4, 7)]
        A, n, err = M.fit_path_loss(pts)
        self.assertAlmostEqual(A, -45, places=1)
        self.assertAlmostEqual(n, 2.8, places=2)
        self.assertLess(err, 0.01)

    def test_single_distance_cannot_fit_n(self):
        self.assertEqual(M.fit_path_loss([(1, -45), (1.0, -46)]), (None, None, None))

    def test_stats(self):
        self.assertEqual(M.rssi_stats([-50, -52, -48])["median"], -50.0)
        self.assertEqual(M.rssi_stats([])["n"], 0)


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        M.CONFIG_PATH = os.path.join(cls.tmp, "cfg.json")  # never touch the real anchors_config.json
        cls.srv = M.ThreadingHTTPServer(("127.0.0.1", 0), M.RadarHTTPHandler)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, body, path="/api/calib"):
        req = urllib.request.Request(self.url + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def feed(self, aid, value, n=10):
        with M.STATE.lock:
            M.STATE.anchors[aid]["history"].clear()
            M.STATE.anchors[aid]["history"].extend([value] * n)

    def setUp(self):
        self.post({"action": "reset", "anchor_id": "all"})


class CalibApi(ServerCase):
    def test_capture_two_distances_fits_A_and_n(self):
        self.feed(1, rssi(-47, 3.0, 1))
        s, d = self.post({"action": "capture", "anchor_id": 1, "distance_m": 1})
        self.assertEqual(s, 200)
        self.feed(1, rssi(-47, 3.0, 4))
        s, d = self.post({"action": "capture", "anchor_id": 1, "distance_m": 4})
        self.assertEqual(s, 200)
        self.assertAlmostEqual(d["A_ref"], -47, delta=0.2)
        self.assertAlmostEqual(d["n_exp"], 3.0, delta=0.05)
        self.assertEqual(len(d["points"]), 2)
        self.assertTrue(os.path.exists(M.CONFIG_PATH))

    def test_capture_needs_samples(self):
        with M.STATE.lock:
            M.STATE.anchors[2]["history"].clear()
        s, d = self.post({"action": "capture", "anchor_id": 2, "distance_m": 1})
        self.assertEqual(s, 400)
        self.assertIn("samples", d["detail"])

    def test_manual_set_validates(self):
        s, d = self.post({"action": "set", "anchor_id": 3, "A_ref": -50, "n_exp": 2.2})
        self.assertEqual((s, d["A_ref"], d["n_exp"]), (200, -50.0, 2.2))
        self.assertEqual(self.post({"action": "set", "anchor_id": 3, "n_exp": 9})[0], 400)
        self.assertEqual(self.post({"action": "bogus"})[0], 400)

    def test_verify_reports_true_vs_estimate(self):
        with M.STATE.lock:
            a = M.STATE.anchors[1]
            a["x"], a["y"], a["A_ref"], a["n_exp"] = 0.0, 0.0, -40.0, 2.0
        self.feed(1, rssi(-40, 2.0, 2.0))
        s, d = self.post({"action": "verify", "x": 2.0, "y": 0.0})
        row = next(r for r in d["anchors"] if r["anchor_id"] == 1)
        self.assertEqual(s, 200)
        self.assertAlmostEqual(row["est_m"], 2.0, delta=0.05)
        self.assertAlmostEqual(row["A_that_fits"], -40.0, delta=0.2)

    def test_calibrate_here_recovers_A_and_n_per_anchor(self):
        # Beacons stay at their fixed positions; only the walker moves between known spots.
        truth = {1: (-46, 2.2), 2: (-52, 2.6), 3: (-56, 3.0)}
        with M.STATE.lock:
            for aid, (x, y) in {1: (0, 0), 2: (7.3, 0), 3: (0, 7.3)}.items():
                M.STATE.anchors[aid]["x"], M.STATE.anchors[aid]["y"] = float(x), float(y)
        for sx, sy in [(0.7, 0.7), (3.65, 3.65), (6.3, 1.0), (1.0, 6.3)]:
            now = M.time.time()
            with M.STATE.lock:
                for aid, (A, n) in truth.items():
                    a = M.STATE.anchors[aid]
                    d = max(math.hypot(sx - a["x"], sy - a["y"]), 0.3)
                    a["history"].clear()
                    a["history"].extend([round(rssi(A, n, round(d, 2)), 3)] * 6)
                    a["last_fresh_t"], a["stale"] = now, False
            s, d = self.post({"action": "calibrate_here", "x": sx, "y": sy})
            self.assertEqual(s, 200, d)
        with M.STATE.lock:
            for aid, (A, n) in truth.items():
                self.assertAlmostEqual(M.STATE.anchors[aid]["A_ref"], A, delta=1.0)
                self.assertAlmostEqual(M.STATE.anchors[aid]["n_exp"], n, delta=0.1)
                self.assertEqual(len(M.STATE.calib_points[aid]), 4)

    def test_calibrate_here_skips_stale_anchors(self):
        with M.STATE.lock:
            for a in M.STATE.anchors.values():
                a["stale"] = True
        s, d = self.post({"action": "calibrate_here", "x": 1, "y": 1})
        self.assertEqual(s, 400)


def fresh_anchor():
    return {"x": 0.0, "y": 0.0, "A_ref": -40.0, "n_exp": 2.0, "history": M.deque(maxlen=30), "samples_count": 0,
            "last_fresh_t": 0.0, "ema_rssi": None, "distance_m": None, "dist_ci_low": None, "dist_ci_high": None}


class Freshness(unittest.TestCase):
    def test_duplicate_scan_has_same_fingerprint(self):
        a = [{"signal_id": "wifi:x", "rssi": -50}, {"signal_id": "wifi:y", "rssi": -60}]
        self.assertEqual(M.scan_fingerprint(a), M.scan_fingerprint(list(reversed(a))))
        self.assertNotEqual(M.scan_fingerprint(a), M.scan_fingerprint([{"signal_id": "wifi:x", "rssi": -51}, a[1]]))

    def test_anchor_goes_stale(self):
        a = fresh_anchor()
        M.apply_anchor_reading(a, rssi(-40, 2.0, 2.0), now=100.0)
        self.assertAlmostEqual(a["distance_m"], 2.0, delta=0.05)
        M.expire_stale_anchors({1: a}, now=103.0)
        self.assertFalse(a["stale"])
        self.assertIsNotNone(a["distance_m"])
        M.expire_stale_anchors({1: a}, now=100.0 + M.ANCHOR_STALE_S + 0.1)
        self.assertTrue(a["stale"])
        self.assertIsNone(a["distance_m"])


class Solver(unittest.TestCase):
    def test_noiseless_fix_hits_true_point(self):
        anchors = []
        for i, (x, y) in enumerate([(0.0, 0.0), (7.3, 0.0), (0.0, 7.3)], start=1):
            anchors.append({"id": i, "x": x, "y": y, "fit_rmse": None, "distance_m": math.hypot(2.5 - x, 4.0 - y)})
        x, y, fix, hdop = M.solve_trilateration(anchors, 7.3, 7.3)
        self.assertEqual(fix, "3-ANCHOR FIX")
        self.assertLess(math.hypot(x - 2.5, y - 4.0), 0.3)
        self.assertLess(hdop, 5.0)


def phone_feed(compass, gyro=(0.0, 0.0, 0.0), n=1):
    with M.STATE.lock:
        for _ in range(n):
            M.phone_ingest({"compass": compass, "alpha": 0, "beta": 5, "gamma": -3},
                           dict(zip(("alpha", "beta", "gamma"), gyro)), M.time.time())


class PhoneMath(unittest.TestCase):
    def test_axis_offset_round_trip(self):
        for axis, h in M.AXIS_HEADING.items():
            off = M.offset_for_axis(123.0, axis)
            self.assertAlmostEqual(abs(M.angle_diff(M.compass_to_map_heading(123.0, off), h)), 0.0, places=6)

    def test_multi_axis_fit_wraps_and_reports_interference(self):
        # +x faces compass 350 deg -> +y is 260, -x 170, -y 80; -y disturbed by 10 deg
        fit = M.fit_axis_offset({"+x": 350.0, "+y": 260.0, "-x": 170.0, "-y": 90.0})
        self.assertAlmostEqual(abs(M.angle_diff(fit["offset_deg"], M.offset_for_axis(350.0, "+x") + 2.5)), 0.0, delta=0.6)
        self.assertGreater(fit["max_error_deg"], 6.0)

    def test_gyro_gates_smoothing(self):
        with M.STATE.lock:
            M.STATE.phone_cfg = dict(M.PHONE_CFG_DEFAULTS, gyro_bias=[0.0, 0.0, 0.0])
            M.STATE.phone_smooth = None
        phone_feed(10.0)
        phone_feed(50.0)  # still: moves only `smoothing` of the way
        with M.STATE.lock:
            self.assertAlmostEqual(M.STATE.phone_smooth, 10.0 + 40.0 * M.PHONE_CFG_DEFAULTS["smoothing"], places=3)
            self.assertFalse(M.STATE.phone_turning)
        phone_feed(90.0, gyro=(80.0, 0.0, 0.0))  # turning fast: follows quickly
        with M.STATE.lock:
            self.assertTrue(M.STATE.phone_turning)
            prev = 10.0 + 40.0 * M.PHONE_CFG_DEFAULTS["smoothing"]
            self.assertAlmostEqual(M.STATE.phone_smooth, prev + (90.0 - prev) * M.PHONE_CFG_DEFAULTS["turn_smoothing"], places=3)

    def test_smoothing_wraps_through_north(self):
        with M.STATE.lock:
            M.STATE.phone_smooth = None
        phone_feed(355.0)
        phone_feed(5.0)
        with M.STATE.lock:
            self.assertLess(abs(M.angle_diff(M.STATE.phone_smooth, 357.0)), 0.01)


class PhoneApi(ServerCase):

    def setUp(self):
        self.post({"action": "reset"}, "/api/phone_calib")

    def test_align_any_axis_then_check(self):
        phone_feed(200.0, n=40)
        s, d = self.post({"action": "align", "axis": "+y"}, "/api/phone_calib")
        self.assertEqual(s, 200, d)
        self.assertEqual(d["phone"]["heading_source"], "phone")
        self.assertAlmostEqual(d["phone"]["heading_deg"], 90.0, delta=0.5)
        s, d = self.post({"action": "check", "axis": "+y"}, "/api/phone_calib")
        self.assertAlmostEqual(d["error_deg"], 0.0, delta=0.5)
        s, d = self.post({"action": "nudge", "deg": 5}, "/api/phone_calib")
        s, d = self.post({"action": "check", "axis": "+y"}, "/api/phone_calib")
        self.assertAlmostEqual(d["error_deg"], 5.0, delta=0.5)

    def test_capture_axes_and_persist(self):
        for axis, comp in (("+x", 100.0), ("-x", 280.0)):
            phone_feed(comp, n=60)
            s, d = self.post({"action": "capture_axis", "axis": axis}, "/api/phone_calib")
            self.assertEqual(s, 200, d)
        self.assertLess(d["max_error_deg"], 0.5)
        with open(M.CONFIG_PATH) as f:
            self.assertEqual(set(json.load(f)["phone"]["axis_caps"]), {"+x", "-x"})

    def test_settings_and_validation(self):
        s, d = self.post({"action": "set", "mode": "motion", "smoothing": 0.5}, "/api/phone_calib")
        self.assertEqual((s, d["phone"]["cfg"]["mode"], d["phone"]["heading_source"]), (200, "motion", "motion"))
        self.assertEqual(self.post({"action": "set", "mode": "gps"}, "/api/phone_calib")[0], 400)
        self.assertEqual(self.post({"action": "set", "smoothing": 5}, "/api/phone_calib")[0], 400)
        self.assertEqual(self.post({"action": "align", "axis": "up"}, "/api/phone_calib")[0], 400)

    def test_stale_phone_refuses_align(self):
        with M.STATE.lock:
            M.STATE.phone_t = M.time.time() - 60
        s, d = self.post({"action": "align", "axis": "+x"}, "/api/phone_calib")
        self.assertEqual(s, 400)

    def test_gyro_still_measures_bias(self):
        stop = threading.Event()

        def pump():
            while not stop.is_set():
                phone_feed(45.0, gyro=(1.5, -0.5, 0.2))
                M.time.sleep(0.05)
        t = threading.Thread(target=pump, daemon=True)
        t.start()
        try:
            s, d = self.post({"action": "gyro_still", "seconds": 1}, "/api/phone_calib")
        finally:
            stop.set()
        self.assertEqual(s, 200, d)
        self.assertEqual(d["gyro_bias"], [1.5, -0.5, 0.2])
        self.assertEqual(d["turn_thresh_dps"], 10.0)
        self.assertFalse(d["moved"])


class StepTracking(unittest.TestCase):
    def setUp(self):
        with M.STATE.lock:
            M.STATE.kf_state = M.np.array([1.0, 1.0, 0.0, 0.0])
            M.STATE.kf_cov = M.np.eye(4) * 0.25
            M.STATE.pdr_pending, M.STATE.pdr_last_step_t, M.STATE.pdr_steps_total = [], 1000.0, 0
            M.STATE.phone_cfg["step_source"] = "dashboard"

    def test_step_log_dedup(self):
        log = [{"t": 999.0, "step": True}, {"t": 1001.0, "step": True}, {"t": 1001.5}, {"t": 1002.0, "step": True}]
        with M.STATE.lock:
            M.STATE.phone_cfg["step_source"] = "walker"
            self.assertEqual(M.ingest_step_log(log), 2)
            self.assertEqual(M.ingest_step_log(log), 0)  # same log polled again
            self.assertEqual(M.STATE.pdr_steps_total, 2)

    def test_steps_move_along_heading(self):
        with M.STATE.lock:
            M.pdr_kalman_step(4, 0.7, 90.0, 0.2, None)  # 4 steps facing +y
            self.assertAlmostEqual(M.STATE.pos_x, 1.0, places=6)
            self.assertAlmostEqual(M.STATE.pos_y, 1.0 + 2.8, places=6)
            M.pdr_kalman_step(0, 0.7, 90.0, 0.2, None)  # standing: no movement
            self.assertAlmostEqual(M.STATE.pos_y, 3.8, places=6)

    def test_wifi_fix_pulls_drifted_track(self):
        with M.STATE.lock:
            M.pdr_kalman_step(10, 0.7, 0.0, 0.2, None)        # dead reckoning says x = 8
            M.pdr_kalman_step(0, 0.7, 0.0, 0.2, (6.0, 1.0, 0.5))  # beacons say x = 6
            self.assertTrue(6.0 < M.STATE.pos_x < 8.0)

    def test_wild_fix_is_gated(self):
        with M.STATE.lock:
            M.pdr_kalman_step(0, 0.7, 0.0, 0.2, (25.0, 25.0, 0.5))
            self.assertLess(M.STATE.pos_x, 1.5)

    def test_no_new_wifi_does_not_re_measure(self):
        with M.STATE.lock:
            M.STATE.kf_state = M.np.array([2.0, 2.0, 0.0, 0.0])
            M.update_kalman_filter(5.0, 5.0, 0.2, None)
            self.assertAlmostEqual(M.STATE.pos_x, 2.0, places=6)


class StrideApi(ServerCase):
    def test_stride_calibration_walk(self):
        s, d = self.post({"action": "stride_start"}, "/api/phone_calib")
        self.assertEqual(s, 200, d)
        with M.STATE.lock:
            M.STATE.pdr_steps_total += 10
        s, d = self.post({"action": "stride_finish", "distance_m": 7.3}, "/api/phone_calib")
        self.assertEqual(s, 200, d)
        self.assertAlmostEqual(d["stride_m"], 0.73, places=3)
        self.assertEqual(self.post({"action": "stride_finish", "distance_m": 7.3}, "/api/phone_calib")[0], 400)
        self.assertEqual(self.post({"action": "set", "stride_m": 3}, "/api/phone_calib")[0], 400)


def walking_samples(n_steps, hz=10.0, step_hz=1.8, amp=2.5, t0=1000.0, noise=0.0):
    """|accelerationIncludingGravity| of someone walking: gravity + one bump per step."""
    import random
    rnd = random.Random(1)
    n = int(n_steps / step_hz * hz)
    out = []
    for i in range(n):
        t = t0 + i / hz
        a = 9.81 + amp * math.sin(2 * math.pi * step_hz * (t - t0)) + rnd.gauss(0, noise)
        out.append((round(t, 3), a))
    return out


class Accelerometer(unittest.TestCase):
    def test_walking_counts_steps_and_standing_counts_none(self):
        walk = walking_samples(20)
        self.assertAlmostEqual(M.count_steps(walk, 1.4, 0.4, 0.05), 20, delta=2)
        still = [(1000.0 + i * 0.1, 9.81) for i in range(200)]
        self.assertEqual(M.count_steps(still, 1.4, 0.4, 0.05), 0)
        jitter = walking_samples(0, noise=0.2) + [(1000.0 + i * 0.1, 9.81 + (0.3 if i % 2 else -0.3)) for i in range(200)]
        self.assertEqual(M.count_steps(jitter, 1.4, 0.4, 0.05), 0)

    def test_stream_gap_does_not_fake_a_step(self):
        a = [(1000.0 + i * 0.1, 9.81) for i in range(30)]
        b = [(1020.0 + i * 0.1, 15.0) for i in range(30)]   # phone paused 17 s, resumes at a different |a|
        self.assertEqual(M.count_steps(a + b, 1.4, 0.4, 0.05), 0)

    def test_min_gap_limits_rate(self):
        fast = walking_samples(30, step_hz=4.0)
        self.assertLessEqual(M.count_steps(fast, 1.4, 0.5, 0.05), 30 / 4.0 * 2.0 + 1)

    def test_fit_threshold_finds_working_value(self):
        # soft first steps then strong ones: only a lowish threshold counts all 12
        samples = walking_samples(12, amp=2.0)
        fit = M.fit_step_threshold(samples, 12, 0.4, 0.05)
        self.assertTrue(fit["exact"], fit)
        self.assertEqual(M.count_steps(samples, fit["threshold"], 0.4, 0.05), 12)
        self.assertGreaterEqual(fit["threshold"], fit["range"][0])
        self.assertLessEqual(fit["threshold"], fit["range"][1])

    def test_ingest_runs_detector_and_only_drives_chosen_source(self):
        t0 = M.time.time() + 1.0
        with M.STATE.lock:
            M.STATE.accel_t_last = t0 - 1
            M.STATE.step_det.reset()
            M.STATE.phone_cfg.update(step_source="dashboard", step_thresh=1.4, step_gap_s=0.4, step_tau_lp=0.05)
            M.STATE.pdr_pending, M.STATE.pdr_steps_total, M.STATE.dashboard_steps_total = [], 0, 0
            entries = [{"t": t, "accel_g": {"x": 0.0, "y": a, "z": 0.0}} for t, a in walking_samples(8, t0=t0)]
            self.assertEqual(M.ingest_phone_log(entries), len(entries))
            self.assertEqual(M.ingest_phone_log(entries), 0)   # same log again: no double counting
            self.assertAlmostEqual(M.STATE.dashboard_steps_total, 8, delta=2)
            self.assertEqual(M.STATE.pdr_steps_total, M.STATE.dashboard_steps_total)
            # now let the phone page drive instead: dashboard keeps counting for display but does not move the dot
            M.STATE.phone_cfg["step_source"] = "walker"
            before = M.STATE.pdr_steps_total
            more = [{"t": t, "accel_g": {"x": 0.0, "y": a, "z": 0.0}} for t, a in walking_samples(8, t0=t0 + 30)]
            M.ingest_phone_log(more)
            self.assertEqual(M.STATE.pdr_steps_total, before)
            M.STATE.phone_cfg["step_source"] = "dashboard"


class AccelApi(ServerCase):
    def setUp(self):
        self.post({"action": "reset"}, "/api/phone_calib")

    def test_settings_validation_and_status(self):
        s, d = self.post({"action": "set", "step_thresh": 2.0, "step_gap_s": 0.5, "step_source": "walker"}, "/api/phone_calib")
        self.assertEqual((s, d["phone"]["cfg"]["step_thresh"], d["phone"]["cfg"]["step_source"]), (200, 2.0, "walker"))
        self.assertEqual(self.post({"action": "set", "step_thresh": 9}, "/api/phone_calib")[0], 400)
        self.assertEqual(self.post({"action": "set", "step_source": "gps"}, "/api/phone_calib")[0], 400)
        with urllib.request.urlopen(self.url + "/api/accel_status", timeout=5) as r:
            st = json.load(r)
        self.assertEqual(st["source"], "walker")
        self.assertIn("trace", st)

    def test_walk_fit_needs_recording_and_enough_samples(self):
        self.assertEqual(self.post({"action": "accel_rec_fit", "steps": 10}, "/api/phone_calib")[0], 400)
        self.assertEqual(self.post({"action": "accel_rec_start"}, "/api/phone_calib")[0], 200)
        self.assertEqual(self.post({"action": "accel_rec_fit", "steps": 1}, "/api/phone_calib")[0], 400)
        s, d = self.post({"action": "accel_rec_fit", "steps": 10}, "/api/phone_calib")
        self.assertEqual(s, 400)   # nothing recorded yet

    def test_walk_fit_sets_threshold(self):
        samples = walking_samples(10)
        self.post({"action": "accel_rec_start"}, "/api/phone_calib")
        with M.STATE.lock:
            M.STATE.accel_rec.extend(samples)
        s, d = self.post({"action": "accel_rec_fit", "steps": 10}, "/api/phone_calib")
        self.assertEqual(s, 200, d)
        self.assertEqual(d["detected"], 10)
        self.assertEqual(d["phone"]["cfg"]["step_thresh"], d["threshold"])

    def test_still_measures_gravity_and_noise(self):
        stop = threading.Event()
        base = M.time.time()

        def pump():
            i = 0
            while not stop.is_set():
                with M.STATE.lock:
                    if M.STATE.accel_rec is not None:
                        M.STATE.accel_rec.append((base + i * 0.1, 9.81 + (0.02 if i % 2 else -0.02)))
                i += 1
                M.time.sleep(0.03)
        t = threading.Thread(target=pump, daemon=True)
        t.start()
        try:
            s, d = self.post({"action": "accel_still", "seconds": 1}, "/api/phone_calib")
        finally:
            stop.set()
        self.assertEqual(s, 200, d)
        self.assertAlmostEqual(d["gravity"], 9.81, delta=0.05)
        self.assertTrue(d["gravity_ok"])
        self.assertFalse(d["moved"])


if __name__ == "__main__":
    unittest.main()
