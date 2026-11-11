import unittest

from spot_survey import match_bt

ANCHORS = [{"id": "A1", "match": "8b0e81fd"}, {"id": "A2", "match": "720b6598"}, {"id": "A3", "match": "firebeacon"}]


class MatchBt(unittest.TestCase):
    def test_matches_address_case_insensitively(self):
        self.assertEqual(match_bt("8B0E81FD-C8CF-6659-E832-3D8911B018C9", "ITC-A1", ANCHORS), ["A1"])

    def test_name_flip_does_not_matter(self):
        self.assertEqual(match_bt("720B6598-12C2-6433-27FD-3E10779838A6", "GB's Pad", ANCHORS), ["A2"])
        self.assertEqual(match_bt("720B6598-12C2-6433-27FD-3E10779838A6", "ITC-A2", ANCHORS), ["A2"])

    def test_unrelated_and_nameless(self):
        self.assertEqual(match_bt("AAAA-BBBB", None, ANCHORS), [])


if __name__ == "__main__":
    unittest.main()


class TestBaseline(unittest.TestCase):
    def test_baseline_used_when_spot_matches(self):
        import spot_survey as ss
        anchors = [{"id": "A1", "match": "a1", "x": 0, "y": 0, "p0": -55}]
        base = [{"xy": [4, 0], "readings": {"A1": {"rssi": -80.0}}}]
        now = [{"xy": [4.05, 0], "readings": {"A1": {"rssi": -92.0}}},
               {"xy": [4, 2], "readings": {"A1": {"rssi": -70.0}}}]
        m = ss.build_map(anchors, now, baseline=base)
        self.assertEqual([r["short_db"] for r in m.rays][0], 12.0)
        self.assertTrue(m.rays[0]["baseline"])
        self.assertFalse(m.rays[1]["baseline"])  # no baseline spot there: model fallback


class TestWifiNetsh(unittest.TestCase):
    ANCH = [{"id": "A1", "match": "ITC-A1"}, {"id": "A2", "match": "itc-a2"}, {"id": "A3", "match": "ITC-A3"}]

    def test_match_by_ssid_case_insensitive_strongest_bssid(self):
        import spot_survey as ss
        nets = [{"ssid": "ITC-A1", "bssid": "aa:aa:aa:aa:aa:01", "rssi_dbm": -70.0},
                {"ssid": "ITC-A1", "bssid": "aa:aa:aa:aa:aa:02", "rssi_dbm": -60.0},
                {"ssid": "ITC-A2", "bssid": "bb:bb:bb:bb:bb:01", "rssi_dbm": -80.0},
                {"ssid": "Home", "bssid": "cc:cc:cc:cc:cc:01", "rssi_dbm": -40.0}]
        got = ss.match_wifi(nets, self.ANCH)
        self.assertEqual(got["A1"]["rssi_dbm"], -60.0)
        self.assertEqual(got["A2"]["rssi_dbm"], -80.0)
        self.assertNotIn("A3", got)

    def test_scan_collects_samples_and_survives_failure(self):
        import spot_survey as ss
        calls = {"n": 0}

        def scan():
            calls["n"] += 1
            return [{"ssid": "ITC-A1", "bssid": "x", "rssi_dbm": -65.0 - calls["n"]}]
        out = ss.scan_wifi_netsh(self.ANCH, 0, scan=scan, sleep=lambda s: None)
        self.assertEqual(out["A1"], [-66.0])
        self.assertEqual(out["A3"], [])

        def boom():
            raise RuntimeError("netsh not found")
        self.assertEqual(ss.scan_wifi_netsh(self.ANCH, 5, scan=boom, sleep=lambda s: None)["A1"], [])
