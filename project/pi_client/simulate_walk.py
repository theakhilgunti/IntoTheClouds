#!/usr/bin/env python3
"""
Simulate Firefighter Walk
Simulates walking a search-and-rescue path in an indoor room, generating
realistic RSSI values to the 3 anchor beacons and PDR step events.
"""

import asyncio
import json
import math
import random
import time
import websockets

ANCHORS = {
    "aa:bb:cc:11:22:33": {"x": 0.0, "y": 0.0, "p0": -40.0},
    "aa:bb:cc:44:55:66": {"x": 10.0, "y": 0.0, "p0": -40.0},
    "aa:bb:cc:77:88:99": {"x": 5.0, "y": 10.0, "p0": -40.0},
}


def compute_synthetic_rssi(px: float, py: float, ax: float, ay: float, p0: float = -40.0, n: float = 2.5) -> float:
    dist = max(0.5, math.sqrt((px - ax) ** 2 + (py - ay) ** 2))
    # RSSI = P0 - 10 * n * log10(d) + Gaussian noise
    rssi = p0 - 10.0 * n * math.log10(dist) + random.gauss(0, 1.5)
    return round(rssi, 1)


async def run_simulation(server_url: str = "ws://127.0.0.1:8000/ws/telemetry"):
    print(f"Connecting walk simulator to {server_url}...")
    
    # Define waypoint route for firefighter SAR search
    waypoints = [
        (1.0, 1.0),
        (8.5, 1.5),
        (8.0, 8.5),
        (2.0, 8.0),
        (5.0, 5.0),
        (1.0, 1.0),
    ]
    
    curr_x, curr_y = waypoints[0]
    wp_idx = 1
    step_len = 0.65
    
    while True:
        try:
            async with websockets.connect(server_url) as ws:
                print("Connected! Simulating live tactical walk...")
                while True:
                    target_x, target_y = waypoints[wp_idx]
                    dx = target_x - curr_x
                    dy = target_y - curr_y
                    dist_to_target = math.sqrt(dx ** 2 + dy ** 2)
                    
                    if dist_to_target < step_len:
                        curr_x, curr_y = target_x, target_y
                        wp_idx = (wp_idx + 1) % len(waypoints)
                    else:
                        heading_rad = math.atan2(dy, dx)
                        heading_deg = (math.degrees(heading_rad) + 360.0) % 360.0
                        curr_x += step_len * math.cos(heading_rad)
                        curr_y += step_len * math.sin(heading_rad)
                        
                        # Generate RSSI to all anchors
                        scans = []
                        for bssid, anchor in ANCHORS.items():
                            rssi = compute_synthetic_rssi(curr_x, curr_y, anchor["x"], anchor["y"], anchor["p0"])
                            scans.append({"bssid": bssid, "rssi_dbm": rssi})
                            
                        payload = {
                            "device_id": "FF_Pi_Rig_1",
                            "timestamp": round(time.time(), 3),
                            "pdr": {
                                "step_detected": True,
                                "step_length_m": step_len,
                                "heading_deg": round(heading_deg, 1),
                            },
                            "wifi_scans": scans,
                        }
                        
                        await ws.send(json.dumps(payload))
                        print(f"Position: ({curr_x:.2f}, {curr_y:.2f}) -> Heading: {heading_deg:.1f}° | Scans: {len(scans)}")
                    
                    await asyncio.sleep(0.5)
        except Exception as e:
            print(f"Connection failed: {e}. Retrying in 2 seconds...")
            await asyncio.sleep(2.0)


if __name__ == "__main__":
    asyncio.run(run_simulation())

