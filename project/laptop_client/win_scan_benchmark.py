#!/usr/bin/env python3
"""
LC-01 spike (Wi-Fi half): how well can a Windows laptop see phone hotspots?

Runs `netsh wlan show networks mode=bssid` in a loop and reports, per BSSID:
  - how often it was seen, mean signal, noise (std), and how many distinct values
    it reported (few distinct values = Windows is handing back cached results)
  - the overall scan rate, and how often a scan was identical to the previous one

IMPORTANT limits of netsh (check them against your output):
  * Signal is a 0-100 % quality number, NOT dBm. We convert roughly
    (dBm ~= quality/2 - 100) and label it approximate.
  * netsh does NOT force a new radio scan. Windows rescans on its own schedule,
    so the fresh rate may be low. The "identical to previous" figure shows this.
  * Recent Windows 11 builds may need Location services ON for Wi-Fi scan results.

Standard library only. Run on the Windows laptop:

  python win_scan_benchmark.py --ssid-prefix ITC- --duration 60 --label 3m --json wifi_runs.json
"""
import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from typing import Dict, List


def parse_netsh(output: str) -> List[dict]:
    """Parse `netsh wlan show networks mode=bssid` into [{ssid, bssid, quality, rssi_dbm, channel}]."""
    results: List[dict] = []
    ssid = ""
    cur = None
    for raw in output.splitlines():
        line = raw.strip()
        m = re.match(r"^SSID\s+\d+\s*:\s*(.*)$", line)
        if m:
            ssid = m.group(1).strip()
            cur = None
            continue
        m = re.match(r"^BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})", line)
        if m:
            cur = {"ssid": ssid, "bssid": m.group(1).lower(), "quality": None,
                   "rssi_dbm": None, "channel": None}
            results.append(cur)
            continue
        if cur is None:
            continue
        m = re.match(r"^Signal\s*:\s*(\d+)\s*%", line)
        if m:
            cur["quality"] = float(m.group(1))
            cur["rssi_dbm"] = cur["quality"] / 2.0 - 100.0
            continue
        m = re.match(r"^Channel\s*:\s*(\d+)", line)
        if m:
            cur["channel"] = int(m.group(1))
    return [r for r in results if r["rssi_dbm"] is not None]


def run_scan(timeout: float) -> List[dict]:
    proc = subprocess.run(["netsh", "wlan", "show", "networks", "mode=bssid"],
                          capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
    return parse_netsh(proc.stdout)


def summarize(durations: List[float], snaps: List[Dict[str, float]], meta: Dict[str, dict],
              errors: List[str], wall: float) -> dict:
    ok = len(durations)
    out: dict = {"scans_ok": ok, "scans_failed": len(errors), "wall_seconds": round(wall, 1)}
    if errors:
        out["first_error"] = errors[0]
    if not ok:
        return out
    out["rate_hz"] = round(ok / wall, 2)
    same = sum(1 for a, b in zip(snaps, snaps[1:]) if a == b)
    out["identical_to_previous_pct"] = round(100.0 * same / max(1, ok - 1), 1)
    per: Dict[str, List[float]] = {}
    for s in snaps:
        for b, v in s.items():
            per.setdefault(b, []).append(v)
    out["bssids"] = [{
        "bssid": b, "ssid": meta[b]["ssid"], "channel": meta[b]["channel"],
        "seen_pct": round(100.0 * len(v) / ok), "mean_dbm": round(statistics.mean(v), 1),
        "std_db": round(statistics.pstdev(v), 2), "distinct_values": len(set(v)),
    } for b, v in sorted(per.items(), key=lambda kv: -statistics.mean(kv[1]))]
    return out


def print_report(r: dict, label: str) -> None:
    print(f"\n=== Wi-Fi (netsh){' [' + label + ']' if label else ''} ===")
    if "rate_hz" not in r:
        print(f"  no successful scans. error: {r.get('first_error', 'unknown')}")
        return
    print(f"  scans ok/failed : {r['scans_ok']}/{r['scans_failed']} in {r['wall_seconds']}s")
    print(f"  achieved rate   : {r['rate_hz']} Hz")
    print(f"  identical to previous scan: {r['identical_to_previous_pct']}%  (high = cached results)")
    print(f"  {'BSSID':<19}{'SSID':<14}{'ch':>4}{'seen%':>7}{'~dBm':>8}{'std':>7}{'values':>8}")
    for b in r["bssids"][:15]:
        print(f"  {b['bssid']:<19}{b['ssid'][:13]:<14}{str(b['channel']):>4}{b['seen_pct']:>7}"
              f"{b['mean_dbm']:>8}{b['std_db']:>7}{b['distinct_values']:>8}")
    fresh = r["rate_hz"] * (1 - r["identical_to_previous_pct"] / 100.0)
    print(f"\n  FRESH RATE ~ {fresh:.2f} scans/s. "
          + ("Slow: Wi-Fi alone will be jumpy; lean on BLE (ble_scan_benchmark.py) and averaging."
             if fresh < 0.5 else "Usable."))
    print("  Check: SSIDs seen? BSSIDs stay the same between runs? std under ~4 dB?")


def main() -> int:
    p = argparse.ArgumentParser(description="LC-01: Windows Wi-Fi scan benchmark (netsh)")
    p.add_argument("--duration", type=float, default=60.0)
    p.add_argument("--timeout", type=float, default=15.0)
    p.add_argument("--ssid-prefix", default="", help="only report SSIDs starting with this, e.g. ITC-")
    p.add_argument("--label", default="", help="tag this run, e.g. '1m', '3m', '6m' (distance from the phone)")
    p.add_argument("--json", help="append this run's results to this JSON file")
    a = p.parse_args()
    if sys.platform != "win32":
        print(f"Run this on the Windows laptop (netsh). This is {sys.platform}.", file=sys.stderr)
        return 2
    print(f"Scanning for {a.duration:.0f}s. Keep the laptop still"
          f"{' at ' + a.label if a.label else ''}.", flush=True)
    durations, snaps, errors, meta = [], [], [], {}
    start = time.time()
    while time.time() - start < a.duration:
        t0 = time.time()
        try:
            res = run_scan(a.timeout)
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as e:
            errors.append(str(e))
            time.sleep(0.5)
            continue
        durations.append(time.time() - t0)
        snap = {}
        for r in res:
            if a.ssid_prefix and not r["ssid"].startswith(a.ssid_prefix):
                continue
            snap[r["bssid"]] = r["rssi_dbm"]
            meta[r["bssid"]] = r
        snaps.append(snap)
        time.sleep(0.2)
    result = summarize(durations, snaps, meta, errors, time.time() - start)
    result.update({"kind": "wifi", "label": a.label})
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
