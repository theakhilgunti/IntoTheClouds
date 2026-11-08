# Laptop client (Windows handheld)

The walker carries a **Windows laptop**. It listens to the 3 **laptop beacons** (stationary laptops broadcasting hotspots `ITC-A1`..`A3`), runs the backend and dashboard, and shows the position. An **iPhone** carried with the walker supplies heading and steps. There is no Pi in this design. Full rig setup: `LAPTOP_ANCHORS.md`.

| File | Purpose |
| :-- | :-- |
| `win_scan_benchmark.py` | LC-01: Wi-Fi hotspot scan test using `netsh` (standard library only) |
| `ble_scan_benchmark.py` | LC-01: Bluetooth LE advertisement test (needs `pip install bleak`) |

## LC-01: run the spike (about 1 hour)

**Setup**
1. On each of the 3 beacon laptops, turn on Windows **Mobile hotspot** and name it `ITC-A1`, `ITC-A2`, `ITC-A3` (see `LAPTOP_ANCHORS.md` for the "no connection to share" risk). Plug them in and disable sleep.
2. Bluetooth is optional and not used for laptop beacons. The Bluetooth test below applies only if you also use phone beacons (`IPHONE_ANCHORS.md`).
3. On the laptop: install Python 3 and `pip install bleak`. Turn Bluetooth on. If Wi-Fi scan results are empty, turn on Windows Location services.
4. Place the beacon laptops on tables or stands about 1 m high, spread around the room, and do not move them. Run the test from the walker laptop.

**Run** (60 seconds each, walker laptop held still), at 1 m, 3 m and 6 m from **one** beacon laptop:
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
- All 3 beacon laptops seen for the whole run, IDs stable (same BSSID for Wi-Fi, same name for BLE).
- Std under about 4 dB for Wi-Fi and 5 dB for BLE.
- Signal clearly drops from 1 m to 3 m to 6 m.
- If Wi-Fi scans are slow (fresh rate under 0.5 per second), use Bluetooth as the main signal and Wi-Fi as a slow correction.
- If neither shows a clear distance trend, show **zones** ("near A1 / middle / near A3") instead of exact positions.

## Known limits
- `netsh` signal is a 0-100 % quality number, converted roughly to dBm. It does not force a rescan, so values can be stale (the report shows "identical to previous scan").
- iPhone Bluetooth advertising is restricted, so apps may behave differently. The addresses rotate, so identify anchors by **name**.
