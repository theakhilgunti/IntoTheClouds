# Rig setup: 3 laptop beacons + 1 walker laptop + iPhone

> **Status:** written from the design, **not yet tested on hardware**. The risks below are real; run the checks in section 5 before relying on it.

| Role | Device | Job |
| :-- | :-- | :-- |
| Beacons | 3 stationary laptops | Each broadcasts a Wi-Fi hotspot named `ITC-A1`, `ITC-A2`, `ITC-A3` |
| Walker | Mac (carried) | Scans the beacons' signal strength, runs the backend and dashboard |
| Heading and steps | iPhone carried with the walker | Compass + gyro heading and step count, sent to the backend |

## 1. Beacon laptops (x3)
1. Settings > Network & internet > **Mobile hotspot**. Edit the network name to `ITC-A1` (then `ITC-A2`, `ITC-A3`) and set a password.
2. Turn the hotspot on, plug the laptop in, and disable sleep (Power settings > Never).
3. Place each laptop about 1 m high (table or shelf) and do not move it after measuring.
4. **Known risk:** Windows Mobile hotspot often refuses to start without an Ethernet, Wi-Fi or cellular connection to share ("can't set up mobile hotspot"). If it won't start, connect that laptop to any Wi-Fi first, or try installing the Microsoft KM-TEST Loopback Adapter. If neither works, that laptop cannot be a beacon.
5. Hotspot band may be 2.4 GHz or 5 GHz. Use the same band on all three if the setting is available, so their readings are comparable.

## 2. Positions
Pick one corner as origin (0, 0). For each beacon laptop measure **x** and **y** in metres along two perpendicular walls, and **z** (height, about 1.0). Use the same axes for all three. Write them into `anchors.json` (copy `anchors.example.json`).

## 3. Walker Mac
The walker is a **Mac**, so `netsh` / `win_scan_benchmark.py` do not apply to it (they are only for the Windows beacon laptops). Use `mac_wifi_radar.py` (LC-04), which scans with CoreWLAN and gives real dBm.
1. Allow your terminal app in System Settings > Privacy & Security > **Location Services**. Without it macOS hides all network names and nothing can be matched to `ITC-A1`.
2. See what it sees: `python3 mac_wifi_radar.py --list` (needs Xcode command line tools for `swiftc`). If it reports hidden networks, grant permission and retry, or add `--ssid ITC-A1 --ssid ITC-A2 --ssid ITC-A3` to scan for each beacon by name.
3. Serve readings for the other tools: `python3 mac_wifi_radar.py --ssid ITC-A1 --ssid ITC-A2 --ssid ITC-A3` (http://127.0.0.1:8888/api/telemetry), then `spot_survey.py collect --wifi radar ...` or `radar_bridge.py` work unchanged.
4. Old steps below that say "walker laptop" / Windows mean this Mac, except Location services (Windows only).

### (old Windows walker notes)
1. Turn on Windows **Location services** (needed to see Wi-Fi networks) and keep Wi-Fi on.
2. Check it sees all three: `python win_scan_benchmark.py --ssid-prefix ITC- --duration 60 --label check`.
3. Hotspot BSSIDs can be virtual MAC addresses that differ from what the beacon laptop shows. Read BSSIDs from a scan **on the walker laptop** when registering anchors by BSSID, or match by SSID name in `anchors.json` (`"match": "ITC-A1"`).
4. Beacons are Wi-Fi only. Laptop Bluetooth advertising is not used.

## 4. iPhone: heading and steps
The phone page is `/walker` (served by the backend). It streams compass heading (blended gyro + magnetometer via Safari's `webkitCompassHeading`) and steps to `/ws/pdr`. Alignment and step logic are in `backend/app/fusion/heading.py` and `main.py` (BE-10).

**Link between phone and walker laptop (no router):** turn on the iPhone's **Personal Hotspot** and join the walker laptop to it. The laptop can still scan the `ITC-` beacon hotspots while connected. Find the laptop's IP with `ipconfig` (usually `172.20.10.x`).

**HTTPS is required.** iOS Safari only gives motion and compass access on secure pages. Make a self-signed certificate on the walker laptop and run the backend with it:
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 7 -subj "/CN=itc" -addext "subjectAltName=IP:<laptop-ip>"
cd project/backend
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem
```
On the iPhone open `https://<laptop-ip>:8000/walker`, accept the certificate warning, then:
1. **Start sensors** and allow Motion & Orientation.
2. Hold the phone flat, top edge pointing the way you walk, and point it along the map's **+X** axis. Tap **Set this direction as +X**.
3. Stand on your start spot, enter its x/y in metres, tap **Set start position**.

Keep the page open and the screen on. Keep the iPhone away from laptops and metal: magnets and metal bend the compass, and indoors this is the main source of heading error. Re-align if the heading drifts.

**Untested:** whether Safari accepts the secure WebSocket (`wss`) to a self-signed certificate. If the link stays "disconnected", use a trusted certificate (for example from `mkcert`, installed on the iPhone) or an HTTPS tunnel.

## 5. Go / no-go checks before the demo
- All 3 beacons appear in the walker's scan for 60 s, IDs stable.
- Wi-Fi std under about 4 dB, and signal drops clearly from 1 m to 3 m to 6 m (see `README.md`, LC-01).
- iPhone page shows "connected", heading changes when you turn, steps count when you walk.
- If beacons will not broadcast or readings are flat, fall back to showing zones ("near A1 / middle / near A3").

## 6. Obstacle map with a baseline
On the walker laptop, `spot_survey.py collect` scans the beacon hotspots directly with `netsh` (`--wifi netsh` is the default on Windows; Bluetooth is off unless you pass `--bluetooth`). In `anchors.json` set each `match` to the SSID, e.g. `"ITC-A1"`. Use `--seconds 10` or more because `netsh` can repeat stale values.

Survey the same taped spots twice: first with nothing in the way (`collect --out empty.json`), then with the obstacle in place (`collect --out survey.json`). Then:
`python spot_survey.py map --anchors anchors.json --survey survey.json --baseline empty.json`
Spots within 0.2 m are matched. This removes path-loss model error (BE-11). It is an obstacle **hint**, not a floor plan.
