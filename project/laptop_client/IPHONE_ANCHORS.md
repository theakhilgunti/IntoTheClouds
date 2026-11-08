> **Not our current setup.** Our beacons are 3 laptops (`LAPTOP_ANCHORS.md`) and the iPhone carries heading and steps. This guide is kept only as an alternative if you use phones as beacons.

# Using iPhones as Bluetooth anchors

Three iPhones each broadcast a fixed Bluetooth name (ITC-A1, ITC-A2, ITC-A3). The Mac radar hears them, and `radar_bridge.py` turns their signal strength into anchors for the backend. No iOS app is needed.

## 1. Set up each phone (nRF Connect)

1. Install **nRF Connect for Mobile** (Nordic) from the App Store.
2. Open the **Advertiser** tab and tap the **+** button to create a new advertising packet.
3. Add a record of type **Complete Local Name**. Set the value to `ITC-A1` (use `ITC-A2` and `ITC-A3` on the other phones).
4. Save and switch the advertiser **on**.
5. Keep the app **in the foreground with the screen on**. iOS throttles or stops advertising from background apps. Turn off auto-lock (Settings > Display & Brightness > Auto-Lock > Never) and plug the phones in.
6. Prop each phone up where it will stay, and do not move it after you measure its position.

## 2. Measure each phone's position

Pick one corner of the area as the origin (0, 0), then use a tape measure or laser measure.

- **x**: metres along one wall from the origin.
- **y**: metres along the perpendicular wall from the origin.
- **z**: height of the phone above the floor in metres (about 1.0 if on a tripod or shelf).

Use the same axes for all three phones. Write the numbers into your anchors file.

## 3. Check the radar sees them

Start the unified radar on the Mac, then run:

```
python3 radar_bridge.py --list
```

You should see rows with type `BT` and names `ITC-A1`, `ITC-A2`, `ITC-A3`, each with an RSSI (for example -55). If a phone is missing:

- Confirm the nRF Connect advertiser is on and the app is in the foreground.
- Confirm the Mac radar has Bluetooth permission (see caveats).
- Move the phone closer and run `--list` again.
- If you renamed a phone after the radar started, restart the radar. It can keep the old name.

## 4. Run the bridge

Copy `anchors.example.json` to `anchors.json`, then edit the coordinates:

```
cp anchors.example.json anchors.json
python3 radar_bridge.py --anchors anchors.json
```

Each entry has `id` (anchor name), `match` (text that must appear in the device name, case-insensitive), and `x`/`y`/`z` in metres. Optionally add `"p0": -45` (expected RSSI at 1 m) if you have calibrated it. Defaults are `z` 1.0 and `p0` -40.

Run the offline matching tests (no hardware) with `python3 -m unittest test_radar_bridge`.

## Honest caveats

- **iPhones rotate their Bluetooth addresses**, so the address changes every so often. That is why we match by the advertised **name**, not by address. The bridge re-registers an anchor when the address changes. A phone may briefly disappear while it does.
- **Phone Bluetooth RSSI is noisy**: expect swings of several dB even when nothing moves, and it varies with phone orientation, cases and the body. Treat distances as rough, meter-level hints, not precise positions.
- **The Mac needs Bluetooth permission** for the program running the radar (Terminal, iTerm or your IDE). Go to System Settings > Privacy & Security > Bluetooth and enable it, then restart the radar. Without it, no devices are listed.
- Names are matched as substrings, so `ITC-A1` would also match a device named `ITC-A10`. Keep names distinct.
