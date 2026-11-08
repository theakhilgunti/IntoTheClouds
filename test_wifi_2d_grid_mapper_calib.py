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


class CalibApi(unittest.TestCase):
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

    def post(self, body):
        req = urllib.request.Request(self.url + "/api/calib", json.dumps(body).encode(), {"Content-Type": "application/json"})
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


if __name__ == "__main__":
    unittest.main()
