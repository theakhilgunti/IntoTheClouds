#!/usr/bin/env python3
"""
LC-02: Laptop Scanner (Wi-Fi + Bluetooth) for Handheld Windows Client

Listens to 3 phone anchors (Wi-Fi hotspots and/or BLE beacons),
applies a rolling median filter per anchor to smooth multipath noise,
and streams live telemetry to the backend over WebSocket.

Key Features:
  - Decoupled asyncio workers: Slow Wi-Fi scans (via netsh in background thread)
    never block fast Bluetooth LE advertisement ingestion.
  - Rolling median filter: Keeps the last N readings (default: 5) per anchor.
  - Anchor ID resolution: Dynamically fetches registered anchors from GET /api/anchors
    and maps BLE Complete Local Name (e.g. ITC-A1) and Wi-Fi BSSID to canonical anchor keys.
  - Auto-reconnecting WebSocket: Streams to ws://localhost:8000/ws/telemetry with backoff.
  - Realistic mock mode (--mock): Generates simulated anchor RSSI and walker telemetry
    for testing without physical anchors.
"""

import argparse
import asyncio
import collections
import json
import math
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Set, Tuple

try:
    import websockets
except ImportError:
    websockets = None  # Handled gracefully if mock or offline testing without ws


# ---------------------------------------------------------------------------
# Wi-Fi Parsing (reused from LC-01 win_scan_benchmark.py)
# ---------------------------------------------------------------------------

def parse_netsh(output: str) -> List[dict]:
    """Parse `netsh wlan show networks mode=bssid` into list of scan dicts."""
    results: List[dict] = []
    ssid = ""
    cur = None
    for raw in output.splitlines():
        line = raw.strip()
        m = re.match(r"^SSID\s+\d+\s*:\s*(.*)$", line)
        if m:
            ssid = m.group(1).strip()
            cur = None
            continue
        m = re.match(r"^BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})", line)
        if m:
            cur = {
                "ssid": ssid,
                "bssid": m.group(1).lower(),
                "quality": None,
                "rssi_dbm": None,
                "channel": None,
            }
            results.append(cur)
            continue
        if cur is None:
            continue
        m = re.match(r"^Signal\s*:\s*(\d+)\s*%", line)
        if m:
            cur["quality"] = float(m.group(1))
            # Rough conversion: 100% -> -50 dBm, 0% -> -100 dBm
            cur["rssi_dbm"] = round(cur["quality"] / 2.0 - 100.0, 1)
            continue
        m = re.match(r"^Channel\s*:\s*(\d+)", line)
        if m:
            cur["channel"] = int(m.group(1))
    return [r for r in results if r["rssi_dbm"] is not None]


def execute_netsh_scan(timeout: float = 10.0) -> List[dict]:
    """Run `netsh wlan show networks mode=bssid` synchronously."""
    try:
        proc = subprocess.run(
            ["netsh", "wlan", "show", "networks", "mode=bssid"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            return []
        return parse_netsh(proc.stdout)
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Anchor Resolution & Mapping
# ---------------------------------------------------------------------------

class AnchorResolver:
    """Maintains mapping between observed identifiers (BSSIDs, BLE names) and canonical anchor IDs."""

    DEFAULT_ANCHORS = [
        {"id": "A1", "bssid": "aa:bb:cc:11:22:33", "ble_name": "itc-a1", "x": 0.0, "y": 0.0, "z": 1.5, "p0": -40.0},
        {"id": "A2", "bssid": "aa:bb:cc:44:55:66", "ble_name": "itc-a2", "x": 10.0, "y": 0.0, "z": 1.5, "p0": -40.0},
        {"id": "A3", "bssid": "aa:bb:cc:77:88:99", "ble_name": "itc-a3", "x": 5.0, "y": 10.0, "z": 1.5, "p0": -40.0},
    ]

    def __init__(self, backend_url: str = "http://localhost:8000"):
        self.backend_url = backend_url.rstrip("/")
        # Maps lowercase identifier (bssid, name, alias) -> canonical bssid used by backend
        self.id_to_canonical: Dict[str, str] = {}
        self.canonical_anchors: Dict[str, dict] = {}
        self._load_defaults()

    def _load_defaults(self):
        for a in self.DEFAULT_ANCHORS:
            canon = a["bssid"].lower()
            self.canonical_anchors[canon] = a
            self.id_to_canonical[canon] = canon
            self.id_to_canonical[a["id"].lower()] = canon
            if a.get("ble_name"):
                self.id_to_canonical[a["ble_name"].lower()] = canon
            # Also map e.g. "itc-a1" -> canon
            self.id_to_canonical[f"itc-{a['id'].lower()}"] = canon

    def fetch_from_backend(self) -> bool:
        """Fetch registered anchors from GET /api/anchors."""
        url = f"{self.backend_url}/api/anchors"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "IntoTheClouds-LaptopScanner/1.0"})
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    if isinstance(data, list) and data:
                        self.id_to_canonical.clear()
                        self.canonical_anchors.clear()
                        for a in data:
                            canon = a.get("bssid", "").lower()
                            if not canon:
                                continue
                            self.canonical_anchors[canon] = a
                            self.id_to_canonical[canon] = canon
                            aid = a.get("id", "").lower()
                            if aid:
                                self.id_to_canonical[aid] = canon
                                self.id_to_canonical[f"itc-{aid}"] = canon
                            ble_name = a.get("ble_name", "").lower()
                            if ble_name:
                                self.id_to_canonical[ble_name] = canon
                        return True
        except Exception:
            pass
        return False

    def resolve(self, identifier: str) -> Optional[str]:
        """Resolve a raw Wi-Fi BSSID, SSID, or BLE name to its canonical anchor BSSID."""
        key = identifier.strip().lower()
        if key in self.id_to_canonical:
            return self.id_to_canonical[key]
        # Match prefix like "ITC-A1" -> check "a1"
        if key.startswith("itc-"):
            suffix = key[4:]
            if suffix in self.id_to_canonical:
                return self.id_to_canonical[suffix]
        return None


# ---------------------------------------------------------------------------
# Anchor Sample Buffer & Median Filter
# ---------------------------------------------------------------------------

class AnchorBuffer:
    """Thread-safe rolling median filter per anchor."""

    def __init__(self, window_size: int = 5):
        self.window_size = max(1, window_size)
        self.history: Dict[str, collections.deque] = collections.defaultdict(
            lambda: collections.deque(maxlen=self.window_size)
        )
        self.last_timestamps: Dict[str, float] = {}
        self.last_sent_medians: Dict[str, float] = {}
        self._new_data_flag: bool = False

    def add_sample(self, canonical_id: str, rssi_dbm: float, timestamp: Optional[float] = None):
        """Append a raw RSSI reading for an anchor."""
        ts = timestamp or time.time()
        self.history[canonical_id].append(float(rssi_dbm))
        self.last_timestamps[canonical_id] = ts
        self._new_data_flag = True

    def get_filtered_scans(self, max_age_s: float = 6.0) -> List[dict]:
        """Compute the median RSSI for all non-stale anchors."""
        now = time.time()
        results = []
        for anchor_id, deq in list(self.history.items()):
            if not deq:
                continue
            last_seen = self.last_timestamps.get(anchor_id, 0.0)
            if now - last_seen > max_age_s:
                continue  # Stale anchor
            med_rssi = round(float(statistics.median(deq)), 1)
            results.append({"bssid": anchor_id, "rssi_dbm": med_rssi})
        # Sort for consistency
        results.sort(key=lambda x: x["bssid"])
        return results

    def has_new_data(self) -> bool:
        """Check if any new readings have arrived since last clear."""
        return self._new_data_flag

    def clear_new_data_flag(self):
        self._new_data_flag = False


# ---------------------------------------------------------------------------
# Scanner Engine
# ---------------------------------------------------------------------------

class LaptopScanner:
    """Orchestrates asynchronous Wi-Fi scanning, BLE scanning, and WebSocket telemetry dispatch."""

    def __init__(
        self,
        backend_url: str = "http://localhost:8000",
        ws_url: str = "ws://localhost:8000/ws/telemetry",
        device_id: str = "LAPTOP_1",
        interval: float = 0.5,
        window: int = 5,
        mode: str = "hybrid",
        name_prefix: str = "ITC-",
        mock: bool = False,
        quiet: bool = False,
    ):
        self.backend_url = backend_url
        self.ws_url = ws_url
        self.device_id = device_id
        self.interval = interval
        self.mode = mode.lower()
        self.name_prefix = name_prefix
        self.mock = mock or (self.mode == "mock")
        self.quiet = quiet

        self.resolver = AnchorResolver(backend_url)
        self.buffer = AnchorBuffer(window_size=window)
        self.running = False

        # Motion simulation state for mock / PDR
        self.pos_x = 5.0
        self.pos_y = 5.0
        self.step_detected = False
        self.step_length_m = 0.7
        self.heading_deg = 0.0

    def log(self, msg: str):
        if not self.quiet:
            print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    # -----------------------------------------------------------------------
    # Wi-Fi Worker (netsh in thread)
    # -----------------------------------------------------------------------
    async def wifi_worker(self):
        """Periodically runs native Windows Wi-Fi scan in background thread."""
        self.log("Wi-Fi worker started (netsh mode=bssid).")
        while self.running:
            try:
                # Decoupled via asyncio.to_thread so netsh never blocks BLE or WS
                scans = await asyncio.to_thread(execute_netsh_scan, 8.0)
                matched_count = 0
                for s in scans:
                    canon = self.resolver.resolve(s["bssid"]) or self.resolver.resolve(s["ssid"])
                    if canon:
                        self.buffer.add_sample(canon, s["rssi_dbm"])
                        matched_count += 1
                if matched_count > 0:
                    self.log(f"Wi-Fi scan matched {matched_count} anchor(s).")
            except Exception as e:
                self.log(f"Wi-Fi scan error: {e}")
            await asyncio.sleep(1.0)

    # -----------------------------------------------------------------------
    # Bluetooth LE Worker (bleak)
    # -----------------------------------------------------------------------
    async def ble_worker(self):
        """Listens to Bluetooth Low Energy advertisements via bleak."""
        try:
            from bleak import BleakScanner
        except ImportError:
            self.log("BLE worker disabled: `bleak` not installed. Run `pip install bleak`.")
            return

        self.log("BLE worker started (bleak advertisement callback).")

        def on_advertisement(device, adv):
            name = adv.local_name or device.name or ""
            # Match by advertised local name prefix e.g. "ITC-A1" or directly via resolver
            if self.name_prefix and not name.startswith(self.name_prefix):
                canon = self.resolver.resolve(name) or self.resolver.resolve(device.address)
            else:
                canon = self.resolver.resolve(name)
            if canon:
                self.buffer.add_sample(canon, float(adv.rssi))

        try:
            async with BleakScanner(detection_callback=on_advertisement):
                while self.running:
                    await asyncio.sleep(0.5)
        except Exception as e:
            self.log(f"BLE scanner stopped/unavailable: {e}. Continuing with Wi-Fi only.")

    # -----------------------------------------------------------------------
    # Mock Worker (Simulated walking and RF path loss)
    # -----------------------------------------------------------------------
    async def mock_worker(self):
        """Simulates realistic walker motion and anchor RSSI path loss."""
        self.log("Mock worker started (synthetic RF & walker simulation).")
        waypoints = [(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]
        target_idx = 0
        speed_mps = 1.0

        while self.running:
            now = time.time()
            tx, ty = waypoints[target_idx]
            dx = tx - self.pos_x
            dy = ty - self.pos_y
            dist_to_target = math.hypot(dx, dy)

            if dist_to_target < 0.3:
                target_idx = (target_idx + 1) % len(waypoints)
                self.step_detected = False
            else:
                self.heading_deg = round((math.degrees(math.atan2(dy, dx)) + 360.0) % 360.0, 1)
                step_dist = min(dist_to_target, speed_mps * self.interval)
                self.pos_x += (dx / dist_to_target) * step_dist
                self.pos_y += (dy / dist_to_target) * step_dist
                self.step_detected = True

            # Calculate synthetic RSSI to all known anchors: P(d) = P0 - 10*n*log10(d) + noise
            for canon_id, anchor in self.resolver.canonical_anchors.items():
                ax = anchor.get("x", 0.0)
                ay = anchor.get("y", 0.0)
                d = max(0.5, math.hypot(self.pos_x - ax, self.pos_y - ay))
                p0 = anchor.get("p0", -40.0)
                n = 2.4
                rssi = p0 - 10.0 * n * math.log10(d) + random.gauss(0, 1.2)
                self.buffer.add_sample(canon_id, round(rssi, 1), timestamp=now)

            await asyncio.sleep(self.interval)

    # -----------------------------------------------------------------------
    # Telemetry Streaming & WebSocket Loop
    # -----------------------------------------------------------------------
    def build_telemetry_payload(self) -> Optional[dict]:
        """Construct the standard telemetry payload if new data is present."""
        scans = self.buffer.get_filtered_scans()
        if not scans and not self.mock:
            return None

        payload = {
            "device_id": self.device_id,
            "timestamp": round(time.time(), 3),
            "pdr": {
                "step_detected": self.step_detected,
                "step_length_m": round(self.step_length_m, 2),
                "heading_deg": round(self.heading_deg, 1),
            },
            "wifi_scans": scans,
        }
        return payload

    async def telemetry_stream_worker(self):
        """Main WebSocket loop that streams smoothed telemetry to the backend."""
        self.log(f"Telemetry stream connecting to {self.ws_url}...")
        backoff = 1.0

        while self.running:
            if websockets is None:
                self.log("`websockets` package missing. Running in local dry-run loop.")
                while self.running:
                    payload = self.build_telemetry_payload()
                    if payload and self.buffer.has_new_data():
                        self.buffer.clear_new_data_flag()
                        self.log(f"[Dry-run] Payload: {json.dumps(payload)}")
                    await asyncio.sleep(self.interval)
                return

            try:
                async with websockets.connect(self.ws_url) as ws:
                    self.log(f"Connected to backend WebSocket at {self.ws_url}!")
                    backoff = 1.0

                    while self.running:
                        payload = self.build_telemetry_payload()
                        if payload is not None:
                            # Send only when there is fresh data or periodic heartbeat
                            if self.buffer.has_new_data() or self.mock:
                                self.buffer.clear_new_data_flag()
                                await ws.send(json.dumps(payload))
                                scans_summary = ", ".join(f"{s['bssid']}={s['rssi_dbm']}dBm" for s in payload["wifi_scans"])
                                self.log(f"Sent telemetry: [{scans_summary}]")
                        await asyncio.sleep(self.interval)

            except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
                self.log(f"WebSocket disconnected ({e}). Reconnecting in {backoff:.1f}s...")
                await asyncio.sleep(backoff)
                backoff = min(8.0, backoff * 1.5)
            except Exception as e:
                self.log(f"Unexpected WebSocket error: {e}. Retrying in 2.0s...")
                await asyncio.sleep(2.0)

    # -----------------------------------------------------------------------
    # Main Runner
    # -----------------------------------------------------------------------
    async def start(self):
        """Start all workers concurrently."""
        self.running = True

        # Initial anchor fetch from backend
        if not self.mock:
            if self.resolver.fetch_from_backend():
                self.log(f"Loaded {len(self.resolver.canonical_anchors)} anchor(s) from {self.backend_url}/api/anchors.")
            else:
                self.log(f"Could not reach {self.backend_url}/api/anchors; using default anchor mapping.")

        tasks = []
        if self.mock:
            tasks.append(asyncio.create_task(self.mock_worker()))
        else:
            if self.mode in ("hybrid", "wifi"):
                tasks.append(asyncio.create_task(self.wifi_worker()))
            if self.mode in ("hybrid", "ble"):
                tasks.append(asyncio.create_task(self.ble_worker()))

        tasks.append(asyncio.create_task(self.telemetry_stream_worker()))

        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False

    def stop(self):
        self.running = False


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="LC-02: Laptop Scanner (Wi-Fi + BLE) for Windows Handheld")
    parser.add_argument("--backend-url", default="http://localhost:8000", help="Backend API URL (GET /api/anchors)")
    parser.add_argument("--ws-url", default="ws://localhost:8000/ws/telemetry", help="WebSocket telemetry URL")
    parser.add_argument("--device-id", default="LAPTOP_1", help="Device ID in telemetry payload")
    parser.add_argument("--interval", type=float, default=0.5, help="Telemetry send interval in seconds (default 0.5)")
    parser.add_argument("--window", type=int, default=5, help="Rolling median filter window size (default 5)")
    parser.add_argument("--mode", choices=["hybrid", "wifi", "ble", "mock"], default="hybrid", help="Scan radio mode")
    parser.add_argument("--name-prefix", default="ITC-", help="BLE name / Wi-Fi SSID prefix to match")
    parser.add_argument("--mock", action="store_true", help="Generate synthetic walker telemetry and anchor RSSI")
    parser.add_argument("--quiet", action="store_true", help="Suppress verbose logging")

    args = parser.parse_args()

    scanner = LaptopScanner(
        backend_url=args.backend_url,
        ws_url=args.ws_url,
        device_id=args.device_id,
        interval=args.interval,
        window=args.window,
        mode=args.mode,
        name_prefix=args.name_prefix,
        mock=args.mock,
        quiet=args.quiet,
    )

    print("=================================================================")
    print(" IntoTheClouds: LC-02 Laptop Scanner (Handheld Windows Client)")
    print(f" Mode: {args.mode.upper()} {'(MOCK)' if args.mock else ''} | Window: {args.window} | Interval: {args.interval}s")
    print(f" Target: {args.ws_url}")
    print("=================================================================", flush=True)

    try:
        asyncio.run(scanner.start())
    except KeyboardInterrupt:
        print("\nStopping scanner...")
        scanner.stop()


if __name__ == "__main__":
    main()
