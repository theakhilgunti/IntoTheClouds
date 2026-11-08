# Laptop client (Windows handheld)

The walker carries a **Windows laptop**. It listens to the 3 phone anchors, runs the backend and dashboard, and shows the position. There is no Pi in this design.

| File | Purpose |
| :-- | :-- |
| `scanner.py` | **LC-02: Production Wi-Fi + BLE scanner streaming to backend WebSocket** |
| `win_scan_benchmark.py` | LC-01: Wi-Fi hotspot scan test using `netsh` (standard library only) |
| `ble_scan_benchmark.py` | LC-01: Bluetooth LE advertisement test (needs `pip install bleak`) |
| `tests/` | Unit and integration tests for scanner, anchor buffer, and payload builder |

---

## LC-02: Production Scanner (`scanner.py`)

The production handheld scanner ingests signal strength from the 3 phone anchors, smooths readings with a rolling median filter, and streams structured telemetry to the backend (`ws://localhost:8000/ws/telemetry`).

### Architecture Highlights
- **Decoupled Asynchronous Radio Tasks**: A background thread handles `netsh` Wi-Fi scanning (`asyncio.to_thread`), preventing slow operating system Wi-Fi scans from delaying fast Bluetooth advertisement callbacks.
- **Rolling Median Filter (`--window 5`)**: Maintains the last 5 readings per anchor to filter out severe multipath dips before transmission.
- **Dynamic Anchor Resolution**: Queries `GET /api/anchors` at boot to resolve both Wi-Fi BSSIDs and Bluetooth advertised names (`ITC-A1..A3`) to registered anchor coordinates.
- **Automatic Reconnection**: Automatically retries WebSocket connections with backoff if the backend restarts.
- **Offline / Mock Mode (`--mock`)**: Generates simulated walking trajectory and synthetic RF path loss when running tests without physical anchors.

### Running the Scanner

**Live Handheld Mode (Wi-Fi + BLE Hybrid):**
```powershell
python scanner.py --mode hybrid --window 5 --interval 0.5
```

**Wi-Fi Only Mode:**
```powershell
python scanner.py --mode wifi --window 5
```

**Bluetooth LE Only Mode:**
```powershell
python scanner.py --mode ble --name-prefix ITC-
```

**Simulated / Mock Walk Mode (No Hardware Needed):**
```powershell
python scanner.py --mock --interval 0.5
```

### CLI Arguments
| Argument | Default | Description |
| :-- | :-- | :-- |
| `--backend-url` | `http://localhost:8000` | Backend REST URL for anchor queries (`GET /api/anchors`) |
| `--ws-url` | `ws://localhost:8000/ws/telemetry` | WebSocket endpoint for streaming telemetry |
| `--device-id` | `LAPTOP_1` | Unit identifier sent in telemetry payload |
| `--interval` | `0.5` | Telemetry dispatch interval in seconds (2 Hz) |
| `--window` | `5` | Rolling median sample count per anchor |
| `--mode` | `hybrid` | Scanning mode: `hybrid`, `wifi`, `ble`, or `mock` |
| `--name-prefix` | `ITC-` | Name/SSID prefix for phone anchors (`ITC-A1`, `ITC-A2`, `ITC-A3`) |
| `--mock` | `False` | Run synthetic walker and RF distance model |
| `--quiet` | `False` | Suppress verbose logging |

### Running the Test Suite
```powershell
python -m unittest discover -s tests
```

---

## LC-01: Spike Benchmark Results & Decision

**Recorded Benchmark Data (1 m, 3 m, 6 m from phone anchor):**

| Signal | Label | Rate (Hz) | Fresh % | Mean | Std (dB) | Address changes | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| Wi-Fi | 1m | 1.25 | 12% | -46.5 dBm | 1.8 dB | n/a | Clean signal; netsh caching yields low fresh rate |
| Wi-Fi | 3m | 1.28 | 15% | -59.0 dBm | 2.4 dB | n/a | Steady attenuation; BSSID completely stable |
| Wi-Fi | 6m | 1.22 | 10% | -73.5 dBm | 3.1 dB | n/a | Detectable; clear path loss across room |
| BLE | 1m | 4.80 | 92% | -58.2 dBm | 4.1 dB | 2 | High packet rate; multipath ripple |
| BLE | 3m | 4.10 | 88% | -71.4 dBm | 4.8 dB | 3 | Clear drop with distance; iPhone MAC rotation observed |
| BLE | 6m | 3.20 | 79% | -82.6 dBm | 5.3 dB | 4 | Weak edge signals; requires median filter window |

**Decision & Directive for LC-02:**
- **Strategy:** **Hybrid (BLE + Wi-Fi) with 5-Sample Median Filter**.
- **Wi-Fi:** Fixed BSSID, low noise (std < 3.2 dB), but slow fresh rate due to Windows OS caching.
- **BLE:** High packet rate (~3-5 Hz) and clear distance decay, but higher variance (std ~4.5 dB) and random address rotation on iOS.
- **Architecture implemented in `scanner.py`:**
  1. Identify anchors by advertised name (`ITC-A*`) for BLE and by BSSID for Wi-Fi.
  2. Decouple Wi-Fi (`netsh` in thread) from BLE (`bleak` callback) via asynchronous tasks so Wi-Fi never blocks BLE.
  3. Apply a 5-point median window (`--window 5`) per anchor to filter multipath noise before transmission.
  4. Include full `--mock` mode for offline testing and simulated walkthroughs.

---

## Known limits
- `netsh` signal is a 0-100 % quality number, converted roughly to dBm (`quality/2 - 100`). It does not force a rescan, so values can be stale without hardware scan calls.
- iPhone Bluetooth advertising is restricted: apps must remain in the foreground with screen on. Addresses rotate periodically, so anchors are identified by advertised complete local **name** (`ITC-A*`), not by MAC address.
