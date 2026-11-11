import unittest

from mac_wifi_radar import Radar, parse_scan
from radar_bridge import match_devices

SAMPLE = "ITC-A1\taa:bb:cc:00:00:01\t-61\t6\nITC-A2\tAA:BB:CC:00:00:02\t-72\t36\n\t\t-50\t1\nHome\tdd:00:00:00:00:03\t0\t11\nbad line\n"


class Parse(unittest.TestCase):
    def test_parse_drops_hidden_and_invalid(self):
        nets, hidden = parse_scan(SAMPLE)
        self.assertEqual([n["ssid"] for n in nets], ["ITC-A1", "ITC-A2"])
        self.assertEqual(hidden, 1)
        self.assertEqual(nets[1]["bssid"], "aa:bb:cc:00:00:02")  # lower-cased
        self.assertEqual(nets[0]["channel"], 6)

    def test_ssid_only_row_kept(self):
        nets, hidden = parse_scan("ITC-A3\t\t-66\t11\n")
        self.assertEqual((len(nets), hidden), (1, 0))


class RadarFormat(unittest.TestCase):
    def test_bridge_matches_ssid_and_ages(self):
        t = [100.0]
        r = Radar(clock=lambda: t[0])
        r.update(parse_scan(SAMPLE)[0], 1)
        t[0] = 103.0
        tel = r.telemetry()
        devs = tel["all_devices"]
        self.assertTrue(all(d["radio_type"] == "wifi" and d["is_active"] for d in devs))
        got = match_devices(devs, [{"id": "A1", "match": "ITC-A1"}, {"id": "A3", "match": "ITC-A3"}])
        self.assertEqual(got["A1"]["rssi"], -61.0)
        self.assertNotIn("A3", got)
        self.assertEqual(tel["hidden_in_last_scan"], 1)
        t[0] = 130.0
        self.assertFalse(r.telemetry()["all_devices"][0]["is_active"])  # stale


if __name__ == "__main__":
    unittest.main()
