#!/usr/bin/env python3
"""
LC-01 spike (Bluetooth half): how well can a laptop hear phone BLE beacons?

Listens to Bluetooth Low Energy advertisements and reports, per advertiser:
  - how many packets per second we get (BLE is usually much faster than Wi-Fi scans)
  - mean RSSI in dBm, noise (std), and how many times the device ADDRESS changed
    (iPhones rotate a random address; if it changes, we must identify anchors by
    NAME or SERVICE UUID, not by address)

Needs:  pip install bleak
Phones need a beacon app advertising with the app in the FOREGROUND and the screen on,
for example nRF Connect (Advertiser tab) with a Complete Local Name like ITC-A1.

  python ble_scan_benchmark.py --name-prefix ITC- --duration 60 --label 3m --json ble_runs.json
  python ble_scan_benchmark.py --list      # 10-second look at everything nearby
"""
import argparse
import asyncio
import json
import statistics
import sys
from typing import Dict, List


def summarize(samples: Dict[str, dict], wall: float) -> dict:
    """samples: key -> {name, rssi:[...], addrs:set([...]), uuids:set([...])}."""
    rows = []
    for key, s in samples.items():
        v = s["rssi"]
        rows.append({
            "id": key, "name": s["name"], "packets": len(v),
            "rate_hz": round(len(v) / wall, 2),
            "mean_dbm": round(statistics.mean(v), 1),
            "std_db": round(statistics.pstdev(v), 2),
            "min_dbm": min(v), "max_dbm": max(v),
            "address_count": len(s["addrs"]),
            "service_uuids": sorted(s["uuids"]),
        })
    rows.sort(key=lambda r: -r["mean_dbm"])
    return {"kind": "ble", "wall_seconds": round(wall, 1), "devices": rows}


def print_report(r: dict, label: str) -> None:
    print(f"\n=== Bluetooth LE{' [' + label + ']' if label else ''} ===")
    if not r["devices"]:
        print("  no matching advertisers heard. Check the beacon app is advertising in the "
              "foreground, Bluetooth is on, and --name-prefix matches.")
        return
    print(f"  {'name / id':<24}{'pkts':>6}{'Hz':>7}{'mean':>7}{'std':>6}{'min':>6}{'max':>6}{'addrs':>7}")
    for d in r["devices"][:15]:
        nm = (d["name"] or d["id"])[:23]
        print(f"  {nm:<24}{d['packets']:>6}{d['rate_hz']:>7}{d['mean_dbm']:>7}{d['std_db']:>6}"
              f"{d['min_dbm']:>6}{d['max_dbm']:>6}{d['address_count']:>7}")
    if any(d["address_count"] > 1 for d in r["devices"]):
        print("\n  NOTE: an address changed during the run (random address rotation). "
              "Identify anchors by name or service UUID, not by address.")
    print("  Check: all 3 phones heard? rate over ~2 Hz? std under ~5 dB?")


async def scan(duration: float, prefix: str, list_all: bool) -> Dict[str, dict]:
    from bleak import BleakScanner  # imported here so --help works without bleak
    samples: Dict[str, dict] = {}

    def on_adv(device, adv):
        name = adv.local_name or device.name or ""
        if not list_all and prefix and not name.startswith(prefix):
            return
        key = name or device.address
        s = samples.setdefault(key, {"name": name, "rssi": [], "addrs": set(), "uuids": set()})
        s["rssi"].append(adv.rssi)
        s["addrs"].add(device.address)
        s["uuids"].update(adv.service_uuids or [])

    async with BleakScanner(detection_callback=on_adv):
        await asyncio.sleep(duration)
    return samples


def main() -> int:
    p = argparse.ArgumentParser(description="LC-01: Bluetooth LE advertisement benchmark")
    p.add_argument("--duration", type=float, default=60.0)
    p.add_argument("--name-prefix", default="ITC-", help="only phones whose advertised name starts with this")
    p.add_argument("--list", action="store_true", help="show every advertiser for 10 s (find your phones)")
    p.add_argument("--label", default="", help="tag this run, e.g. '1m', '3m', '6m'")
    p.add_argument("--json", help="append this run's results to this JSON file")
    a = p.parse_args()
    dur = 10.0 if a.list else a.duration
    try:
        samples = asyncio.run(scan(dur, a.name_prefix, a.list))
    except ImportError:
        print("Install bleak first:  pip install bleak", file=sys.stderr)
        return 2
    except Exception as e:  # bluetooth off, no adapter, permission
        print(f"Bluetooth scan failed: {e}\nIs Bluetooth turned on?", file=sys.stderr)
        return 1
    result = summarize(samples, dur)
    result["label"] = a.label
    print_report(result, a.label)
    if a.json:
        try:
            runs = json.load(open(a.json))
        except (OSError, ValueError):
            runs = []
        runs.append(result)
        json.dump(runs, open(a.json, "w"), indent=2)
        print(f"\nAppended to {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
