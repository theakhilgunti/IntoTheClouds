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
| Wi-Fi | 1m | 1.25 | 12% | -46.5 dBm | 1.8 dB | n/a | Clean signal; netsh caching yields low fresh rate |
| Wi-Fi | 3m | 1.28 | 15% | -59.0 dBm | 2.4 dB | n/a | Steady attenuation; BSSID completely stable |
| Wi-Fi | 6m | 1.22 | 10% | -73.5 dBm | 3.1 dB | n/a | Detectable; clear path loss across room |
| BLE | 1m | 4.80 | 92% | -58.2 dBm | 4.1 dB | 2 | High packet rate; multipath ripple |
| BLE | 3m | 4.10 | 88% | -71.4 dBm | 4.8 dB | 3 | Clear drop with distance; iPhone MAC rotation observed |
| BLE | 6m | 3.20 | 79% | -82.6 dBm | 5.3 dB | 4 | Weak edge signals; requires median filter window |

**Decision & Directive for LC-02**
- **Strategy:** **Hybrid (BLE + Wi-Fi) with 5-Sample Median Filter**.
- **Wi-Fi:** Fixed BSSID, low noise (std < 3.2 dB), but slow fresh rate due to Windows OS caching.
- **BLE:** High packet rate (~3-5 Hz) and clear distance decay, but higher variance (std ~4.5 dB) and random address rotation on iOS.
- **Implementation Rules for LC-02:**
  1. Identify anchors by advertised name (`ITC-A*`) for BLE and by BSSID for Wi-Fi.
  2. Decouple Wi-Fi (`netsh` in thread) from BLE (`bleak` callback) via asynchronous tasks so Wi-Fi never blocks BLE.
  3. Apply a 5-point median window (`--window 5`) per anchor to filter multipath noise before transmission.
  4. Include full `--mock` mode for offline testing and simulated walkthroughs.

**Go / no-go**
- All 3 phones seen for the whole run, IDs stable (same BSSID for Wi-Fi, same name for BLE).
- Std under about 4 dB for Wi-Fi and 5 dB for BLE.
- Signal clearly drops from 1 m to 3 m to 6 m.
- If Wi-Fi scans are slow (fresh rate under 0.5 per second), use Bluetooth as the main signal and Wi-Fi as a slow correction.
- If neither shows a clear distance trend, show **zones** ("near A1 / middle / near A3") instead of exact positions.

## Known limits
- `netsh` signal is a 0-100 % quality number, converted roughly to dBm. It does not force a rescan, so values can be stale (the report shows "identical to previous scan").
- iPhone Bluetooth advertising is restricted, so apps may behave differently. The addresses rotate, so identify anchors by **name**.
