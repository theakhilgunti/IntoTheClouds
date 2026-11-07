#!/usr/bin/env python3
"""
Raspberry Pi Telemetry Scanner
Runs on the firefighter wearable rig.
Scans surrounding Wi-Fi beacons via `nmcli` in a loop and streams JSON payloads to central server.
"""

import argparse
import asyncio
import json
import logging
import re
import subprocess
import time
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("PiScanner")


def scan_wifi_nmcli() -> list:
    """
    Executes 'nmcli -t -f BSSID,SIGNAL dev wifi'
    Signal is 0-100%, converted approximately to dBm: dBm = (signal / 2) - 100
    """
    scans = []
    try:
        cmd = ["nmcli", "-t", "-f", "BSSID,SIGNAL", "dev", "wifi", "list", "--rescan", "yes"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=2.0)
        lines = result.stdout.strip().split("\n")
        for line in lines:
            if not line:
                continue
            # Format: 'AA:BB:CC:DD:EE:FF:78'
            # Note nmcli escapes colons with backslashes in BSSID sometimes: 'AA\:BB\:CC...'
            clean_line = line.replace("\\:", "__COLON__")
            parts = clean_line.split(":")
            if len(parts) >= 2:
                bssid = parts[0].replace("__COLON__", ":").lower()
                try:
                    signal_pct = float(parts[1])
                    rssi_dbm = (signal_pct / 2.0) - 100.0
                    scans.append({"bssid": bssid, "rssi_dbm": round(rssi_dbm, 1)})
                except ValueError:
                    continue
    except Exception as e:
        logger.debug(f"nmcli scan warning: {e}")
    return scans


async def telemetry_loop(server_url: str, device_id: str, interval: float, mock_mode: bool):
    logger.info(f"Connecting to telemetry server at {server_url} (mock={mock_mode})...")
    step_count = 0
    heading = 45.0

    while True:
        try:
            async with websockets.connect(server_url) as ws:
                logger.info("Connected to Central Telemetry WebSocket!")
                while True:
                    start_time = time.time()
                    step_count += 1
                    heading = (heading + 3.0) % 360.0

                    if mock_mode:
                        # Simulated RSSI and step detection
                        scans = [
                            {"bssid": "aa:bb:cc:11:22:33", "rssi_dbm": -48.0 - (step_count % 10)},
                            {"bssid": "aa:bb:cc:44:55:66", "rssi_dbm": -62.0 + (step_count % 8)},
                            {"bssid": "aa:bb:cc:77:88:99", "rssi_dbm": -55.0 - (step_count % 5)},
                        ]
                        pdr = {
                            "step_detected": True,
                            "step_length_m": 0.70,
                            "heading_deg": round(heading, 1),
                        }
                    else:
                        scans = scan_wifi_nmcli()
                        pdr = {
                            "step_detected": True,
                            "step_length_m": 0.75,
                            "heading_deg": round(heading, 1),
                        }

                    payload = {
                        "device_id": device_id,
                        "timestamp": round(time.time(), 3),
                        "pdr": pdr,
                        "wifi_scans": scans,
                    }

                    await ws.send(json.dumps(payload))
                    logger.info(f"Streamed telemetry: {len(scans)} BSSIDs, heading={pdr['heading_deg']}°")

                    elapsed = time.time() - start_time
                    sleep_time = max(0.05, interval - elapsed)
                    await asyncio.sleep(sleep_time)

        except (websockets.exceptions.ConnectionClosedError, ConnectionRefusedError, OSError) as e:
            logger.warning(f"Connection error: {e}. Reconnecting in 2 seconds...")
            await asyncio.sleep(2.0)


def main():
    parser = argparse.ArgumentParser(description="Raspberry Pi Telemetry Scanner")
    parser.add_argument("--server", default="ws://127.0.0.1:8000/ws/telemetry", help="Central WebSocket URL")
    parser.add_argument("--device-id", default="FF_Pi_Rig_1", help="Device identifier")
    parser.add_argument("--interval", type=float, default=0.5, help="Scan interval in seconds (default 0.5s)")
    parser.add_argument("--mock", action="store_true", help="Simulate Wi-Fi scans if not on Raspberry Pi Linux")
    args = parser.parse_args()

    asyncio.run(telemetry_loop(args.server, args.device_id, args.interval, args.mock))


if __name__ == "__main__":
    main()

