# Laptop client (Windows handheld)

The walker carries a **Windows laptop**. It listens to the 3 phone anchors, runs the backend and dashboard, and shows the position. There is no Pi in this design.

| File | Purpose |
| :-- | :-- |
| `win_scan_benchmark.py` | LC-01: Wi-Fi hotspot scan test using `netsh` (standard library only) |
| `ble_scan_benchmark.py` | LC-01: Bluetooth LE advertisement test (needs `pip install bleak`) |

## LC-01: run the spike (about 1 hour)

**Setup**
1. On each of the 3 phones, turn on **Personal Hotspot** and name it `ITC-A1`, `ITC-A2`, `ITC-A3`. iPhone: keep the Personal Hotspot settings screen open, because iPhone hotspots can stop broadcasting when nothing is connected. Turn on "Maximize Compatibility" only if the laptop cannot see the hotspot.
2. For Bluetooth: install a beacon app (for example **nRF Connect**) on each phone, add an advertiser with Complete Local Name `ITC-A1` etc., start it, and keep the app in the foreground with the screen on.
3. On the laptop: install Python 3 and `pip install bleak`. Turn Bluetooth on. If Wi-Fi scan results are empty, turn on Windows Location services.
4. Place the phones on tables or stands about 1 m high, spread around the room, and do not move them.

**Run** (60 seconds each, laptop held still), at 1 m, 3 m and 6 m from **one** phone:
```bat
python win_scan_benchmark.py --ssid-prefix ITC- --duration 60 --label 1m --json wifi_runs.json
python ble_scan_benchmark.py --name-prefix ITC- --duration 60 --label 1m --json ble_runs.json
```
Repeat with `--label 3m` and `--label 6m`. To find your phones first: `python ble_scan_benchmark.py --list`.

**Record** in the table below, then post it on the LC-01 issue.

| Signal | Label | Rate (Hz) | Fresh % | Mean | Std (dB) | Address changes | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Wi-Fi | 1m | | | | | n/a | |
| Wi-Fi | 3m | | | | | n/a | |
| Wi-Fi | 6m | | | | | n/a | |
| BLE | 1m | | | | | | |
| BLE | 3m | | | | | | |
| BLE | 6m | | | | | | |

**Go / no-go**
- All 3 phones seen for the whole run, IDs stable (same BSSID for Wi-Fi, same name for BLE).
- Std under about 4 dB for Wi-Fi and 5 dB for BLE.
- Signal clearly drops from 1 m to 3 m to 6 m.
- If Wi-Fi scans are slow (fresh rate under 0.5 per second), use Bluetooth as the main signal and Wi-Fi as a slow correction.
- If neither shows a clear distance trend, show **zones** ("near A1 / middle / near A3") instead of exact positions.

## Known limits
- `netsh` signal is a 0-100 % quality number, converted roughly to dBm. It does not force a rescan, so values can be stale (the report shows "identical to previous scan").
- iPhone Bluetooth advertising is restricted, so apps may behave differently. The addresses rotate, so identify anchors by **name**.
