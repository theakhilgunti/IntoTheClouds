import os
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_DIR = os.path.dirname(BASE_DIR)
BACKEND_DIR = os.path.join(PROJECT_DIR, "backend")

if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.fusion.math_engine import ParticleFilterLocalizer
from app.models import BeaconAnchor
from scanner import AnchorBuffer, AnchorResolver, LaptopScanner


class TestBackendScannerIntegration(unittest.TestCase):
    def setUp(self):
        self.localizer = ParticleFilterLocalizer(num_particles=200, room_bounds=(-2, 12, -2, 12))
        self.anchors = {
            "aa:bb:cc:11:22:33": BeaconAnchor(id="A1", bssid="aa:bb:cc:11:22:33", x=0.0, y=0.0, z=1.5, p0=-40.0),
            "aa:bb:cc:44:55:66": BeaconAnchor(id="A2", bssid="aa:bb:cc:44:55:66", x=10.0, y=0.0, z=1.5, p0=-40.0),
            "aa:bb:cc:77:88:99": BeaconAnchor(id="A3", bssid="aa:bb:cc:77:88:99", x=5.0, y=10.0, z=1.5, p0=-40.0),
        }

    def test_mock_telemetry_consumed_by_backend_localizer(self):
        scanner = LaptopScanner(device_id="LAPTOP_1", mock=True)
        # Add mock samples for the 3 anchors
        scanner.buffer.add_sample("aa:bb:cc:11:22:33", -50.0)
        scanner.buffer.add_sample("aa:bb:cc:44:55:66", -65.0)
        scanner.buffer.add_sample("aa:bb:cc:77:88:99", -58.0)

        payload = scanner.build_telemetry_payload()
        self.assertIsNotNone(payload)
        self.assertIn("wifi_scans", payload)
        self.assertEqual(len(payload["wifi_scans"]), 3)

        # Feed into localizer
        init_state = self.localizer.get_state("LAPTOP_1", heading_deg=0.0, timestamp=1.0)
        self.localizer.update_rssi(payload["wifi_scans"], self.anchors, path_loss_n=2.4)
        updated_state = self.localizer.get_state("LAPTOP_1", heading_deg=0.0, timestamp=2.0)

        # Position estimate should be finite and inside bounds
        self.assertTrue(-2.0 <= updated_state.x <= 12.0)
        self.assertTrue(-2.0 <= updated_state.y <= 12.0)


if __name__ == "__main__":
    unittest.main()
