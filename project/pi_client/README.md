# Pi client

| File | Purpose |
| :-- | :-- |
| `pi_scanner.py` | Streams Wi-Fi scans + step/heading to the backend (`--mock` for off-hardware use) |
| `simulate_walk.py` | Hardware-free walking simulator |
| `scan_benchmark.py` | **HW-03**: measures real scan rate and RSSI noise on the Pi |

## HW-03: run the scan benchmark

Run this **on the Pi 4**, in the real room, with the anchor laptops' hotspots on (SSIDs `ITC-A1`..`A3`). Keep the rig still while it runs.

```bash
# 1. See what the Pi can hear (also gives you each anchor's real BSSID and channel)
sudo iw dev wlan0 scan | grep -E "^BSS|freq:|signal:|SSID:"

# 2. Quick check, no root needed (nmcli only)
python3 scan_benchmark.py --methods nmcli --duration 20 --ssid-prefix ITC-

# 3. Full comparison (needs root for iw). Use the anchors' channel centre
#    frequencies from step 1, e.g. 2437 (2.4 GHz ch 6) and 5180 (5 GHz ch 36)
sudo python3 scan_benchmark.py --ssid-prefix ITC- --freq 2437 5180 \
     --duration 30 --json hw03_results.json
```

Useful flags: `--iface` (default `wlan0`), `--methods nmcli iw-full iw-freq`, `--anchors <bssid> ...` to mark anchors with `*`.

### How to read the output

- **achieved rate**: scans completed per second. Target from the PRD is 2 Hz (500 ms).
- **identical to previous scan**: if this is high (say over 40%), the OS is returning cached results, so the *fresh* rate is lower than the raw rate. The VERDICT line accounts for this.
- **std dB**: RSSI noise per anchor. Over about 4 dB means distance estimates will jump around, so plan on the median filter in HW-04.
- **seen%**: should be near 100 for every anchor. A low number means the anchor is too weak or the scan misses its channel.

### Results (fill in after running on the Pi)

| Method | Raw Hz | Fresh Hz | Identical % | Worst anchor std (dB) | Anchors seen | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| nmcli | | | | | | |
| iw-full | | | | | | |
| iw-freq | | | | | | |

**Decision for HW-04:** _method chosen:_ ____ _why:_ ____

### Troubleshooting

- `Resource busy (-16)`: another process (NetworkManager, wpa_supplicant) is scanning. Retry, or stop NetworkManager scanning for the test.
- `Operation not permitted`: run the `iw` methods with `sudo`.
- No anchors in the list: confirm the hotspots are running, that the Pi's Wi-Fi country is set (`sudo raspi-config` → Localisation) so it can see 5 GHz channels, and that you used the right frequency in `--freq`.
- `nmcli` reports a 0 to 100 quality value, not dBm. The script converts it roughly (`quality/2 - 100`), so compare `nmcli` noise and rate, but trust `iw` for absolute dBm.
