import os
import sys
import time
import unittest

# Add project root to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from scanner import AnchorBuffer, AnchorResolver, LaptopScanner, parse_netsh


class TestNetshParsing(unittest.TestCase):
    def test_parse_netsh_output(self):
        sample_output = """
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : ITC-A1
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 6a:10:31:9e:b3:93
         Signal             : 80%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 149

SSID 2 : ITC-A2
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : a0:93:51:81:99:4f
         Signal             : 50%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 36
"""
        parsed = parse_netsh(sample_output)
        self.assertEqual(len(parsed), 2)

        # Check anchor 1
        self.assertEqual(parsed[0]["ssid"], "ITC-A1")
        self.assertEqual(parsed[0]["bssid"], "6a:10:31:9e:b3:93")
        self.assertEqual(parsed[0]["quality"], 80.0)
        # 80/2 - 100 = -60.0 dBm
        self.assertEqual(parsed[0]["rssi_dbm"], -60.0)
        self.assertEqual(parsed[0]["channel"], 149)

        # Check anchor 2
        self.assertEqual(parsed[1]["ssid"], "ITC-A2")
        self.assertEqual(parsed[1]["bssid"], "a0:93:51:81:99:4f")
        self.assertEqual(parsed[1]["quality"], 50.0)
        # 50/2 - 100 = -75.0 dBm
        self.assertEqual(parsed[1]["rssi_dbm"], -75.0)

    def test_parse_netsh_empty(self):
        self.assertEqual(parse_netsh(""), [])
        self.assertEqual(parse_netsh("No networks visible"), [])


class TestAnchorResolver(unittest.TestCase):
    def setUp(self):
        self.resolver = AnchorResolver()

    def test_default_resolution_by_bssid(self):
        # Default A1 BSSID is aa:bb:cc:11:22:33
        canon = self.resolver.resolve("AA:BB:CC:11:22:33")
        self.assertEqual(canon, "aa:bb:cc:11:22:33")

    def test_resolution_by_ble_name(self):
        canon = self.resolver.resolve("ITC-A1")
        self.assertEqual(canon, "aa:bb:cc:11:22:33")

        canon2 = self.resolver.resolve("ITC-A2")
        self.assertEqual(canon2, "aa:bb:cc:44:55:66")

    def test_resolution_by_anchor_id(self):
        canon = self.resolver.resolve("A3")
        self.assertEqual(canon, "aa:bb:cc:77:88:99")

    def test_unrecognized_returns_none(self):
        self.assertIsNone(self.resolver.resolve("Unknown_SSID_123"))


class TestAnchorBuffer(unittest.TestCase):
    def test_rolling_median_filter(self):
        buf = AnchorBuffer(window_size=5)
        # Feed noisy RSSI readings: -60, -70, -50, -65, -55 -> sorted: -70, -65, -60, -55, -50 -> median = -60
        for rssi in [-60.0, -70.0, -50.0, -65.0, -55.0]:
            buf.add_sample("anchor_1", rssi)

        scans = buf.get_filtered_scans()
        self.assertEqual(len(scans), 1)
        self.assertEqual(scans[0]["bssid"], "anchor_1")
        self.assertEqual(scans[0]["rssi_dbm"], -60.0)

    def test_window_overflow(self):
        buf = AnchorBuffer(window_size=3)
        # Feed 4 samples: -80, -80, -80, -40
        for rssi in [-80.0, -80.0, -80.0, -40.0]:
            buf.add_sample("anchor_1", rssi)

        # Deque size 3 holds [-80, -80, -40] -> median is -80
        scans = buf.get_filtered_scans()
        self.assertEqual(scans[0]["rssi_dbm"], -80.0)

    def test_stale_anchor_filtered_out(self):
        buf = AnchorBuffer(window_size=5)
        old_time = time.time() - 10.0
        buf.add_sample("stale_anchor", -60.0, timestamp=old_time)

        # Stale anchor should be omitted
        scans = buf.get_filtered_scans(max_age_s=5.0)
        self.assertEqual(scans, [])


class TestTelemetryPayload(unittest.TestCase):
    def test_payload_structure(self):
        scanner = LaptopScanner(device_id="TEST_RIG", mock=True)
        scanner.buffer.add_sample("aa:bb:cc:11:22:33", -55.4)

        payload = scanner.build_telemetry_payload()
        self.assertIsNotNone(payload)
        self.assertEqual(payload["device_id"], "TEST_RIG")
        self.assertIn("timestamp", payload)
        self.assertIn("pdr", payload)
        self.assertIn("step_detected", payload["pdr"])
        self.assertIn("heading_deg", payload["pdr"])
        self.assertIn("wifi_scans", payload)
        self.assertEqual(len(payload["wifi_scans"]), 1)
        self.assertEqual(payload["wifi_scans"][0]["bssid"], "aa:bb:cc:11:22:33")
        self.assertEqual(payload["wifi_scans"][0]["rssi_dbm"], -55.4)


if __name__ == "__main__":
    unittest.main()
