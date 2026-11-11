"""Offline tests for radar_bridge.match_devices (no hardware). Run: python3 -m unittest test_radar_bridge"""
import json
import os
import unittest

from radar_bridge import match_devices

HERE = os.path.dirname(os.path.abspath(__file__))


def dev(key, name, rssi, age=0.5, radio="BT"):
    return {"key": key, "radio_type": radio, "name": name, "rssi": rssi, "last_seen_sec": age, "is_active": age < 14}


ANCHORS = [{"id": "A1", "match": "ITC-A1"}, {"id": "A2", "match": "itc-a2"}]


class MatchTests(unittest.TestCase):
    def test_matches_by_name_case_insensitive(self):
        out = match_devices([dev("bt:aa", "itc-a1", -60), dev("bt:bb", "ITC-A2", -70)], ANCHORS)
        self.assertEqual(out["A1"]["key"], "bt:aa")
        self.assertEqual(out["A2"]["key"], "bt:bb")

    def test_rotated_address_picks_fresh_over_stale(self):
        # iPhone rotated its BLE address: old key is stale but louder, new key is fresh.
        devices = [dev("bt:old", "ITC-A1", -40, age=60.0), dev("bt:new", "ITC-A1", -65, age=1.0)]
        self.assertEqual(match_devices(devices, ANCHORS)["A1"]["key"], "bt:new")

    def test_only_stale_device_gives_no_match(self):
        self.assertNotIn("A1", match_devices([dev("bt:old", "ITC-A1", -50, age=30.0)], ANCHORS))

    def test_strongest_of_fresh_duplicates(self):
        devices = [dev("bt:x", "ITC-A1", -80), dev("bt:y", "ITC-A1", -55)]
        self.assertEqual(match_devices(devices, ANCHORS)["A1"]["key"], "bt:y")

    def test_ignores_unrelated_none_name_and_none_rssi(self):
        devices = [dev("bt:1", None, -50), dev("bt:2", "Unknown Device", -50),
                   dev("wifi:cc", "HomeWiFi", -40, radio="WIFI"), dev("bt:3", "ITC-A1", None)]
        self.assertEqual(match_devices(devices, ANCHORS), {})

    def test_key_substring_match(self):
        out = match_devices([dev("bt:12345678-abcd", "Unknown Device", -60)], [{"id": "A1", "match": "12345678"}])
        self.assertEqual(out["A1"]["key"], "bt:12345678-abcd")

    def test_example_anchors_file(self):
        with open(os.path.join(HERE, "anchors.example.json")) as f:
            anchors = json.load(f)
        self.assertEqual([a["id"] for a in anchors], ["A1", "A2", "A3"])
        devices = [dev("bt:%d" % i, "ITC-A%d" % i, -60 - i) for i in (1, 2, 3)]
        self.assertEqual(set(match_devices(devices, anchors)), {"A1", "A2", "A3"})
        for a in anchors:
            self.assertTrue(all(k in a for k in ("x", "y", "z")))


if __name__ == "__main__":
    unittest.main()
