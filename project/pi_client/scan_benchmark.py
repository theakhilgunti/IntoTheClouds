#!/usr/bin/env python3
"""
HW-03: Wi-Fi RSSI scan benchmark for the Raspberry Pi.

Answers, with measurements instead of guesses:
  1. How many scans per second can each method really deliver?
  2. Are the readings fresh, or is the OS handing back a cached list?
  3. How noisy is the RSSI of each anchor (standard deviation in dB)?
  4. Are all of our anchors visible?

Methods:
  nmcli      nmcli dev wifi list --rescan yes     (no root, rate-limited by NetworkManager)
  iw-full    iw dev <iface> scan                  (needs root, sweeps every channel)
  iw-freq    iw dev <iface> scan freq <MHz> ...   (needs root, only the anchors' channels)

Standard library only. Run on the Pi (Linux). Examples:

  python3 scan_benchmark.py --methods nmcli --duration 20
  sudo python3 scan_benchmark.py --ssid-prefix ITC- --duration 30
  sudo python3 scan_benchmark.py --ssid-prefix ITC- --freq 2437 5180 --json out.json
"""
import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from typing import Dict, List, Optional

BSS_RE = re.compile(r"^BSS\s+([0-9a-fA-F:]{17})")


def parse_iw(output: str) -> List[dict]:
    """Parse `iw dev X scan` output into [{bssid, ssid, freq, rssi_dbm}]."""
    results: List[dict] = []
    cur: Optional[dict] = None
    for raw in output.splitlines():
        m = BSS_RE.match(raw)
        if m:
            cur = {"bssid": m.group(1).lower(), "ssid": "", "freq": None, "rssi_dbm": None}
            results.append(cur)
            continue
        if cur is None:
            continue
        line = raw.strip()
        if line.startswith("signal:"):
            try:
                cur["rssi_dbm"] = float(line.split()[1])
            except (IndexError, ValueError):
                pass
        elif line.startswith("freq:"):
            try:
                cur["freq"] = int(float(line.split()[1]))
            except (IndexError, ValueError):
                pass
        elif line.startswith("SSID:"):
            cur["ssid"] = line[5:].strip()
    return [r for r in results if r["rssi_dbm"] is not None]


def parse_nmcli(output: str) -> List[dict]:
    """Parse `nmcli -t -f BSSID,SSID,FREQ,SIGNAL,... dev wifi list` output.

    Terse mode escapes colons inside values as '\\:'. SIGNAL is a 0-100 quality
    value, NOT dBm. We apply the same rough conversion as pi_scanner.py
    (dBm ~= quality/2 - 100) and label it as approximate.
    """
    results: List[dict] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = re.split(r"(?<!\\):", line)
        if len(fields) < 4:
            continue
        bssid = fields[0].replace("\\:", ":").lower()
        ssid = fields[1].replace("\\:", ":")
        try:
            freq = int(fields[2].split()[0])
            quality = float(fields[3])
        except (ValueError, IndexError):
            continue
        results.append({
            "bssid": bssid,
            "ssid": ssid,
            "freq": freq,
            "rssi_dbm": quality / 2.0 - 100.0,
        })
    return results


def run_scan(method: str, iface: str, freqs: List[int], timeout: float) -> List[dict]:
    if method == "nmcli":
        cmd = ["nmcli", "-t", "-f", "BSSID,SSID,FREQ,SIGNAL", "dev", "wifi", "list",
               "ifname", iface, "--rescan", "yes"]
        parse = parse_nmcli
    elif method == "iw-full":
        cmd = ["iw", "dev", iface, "scan"]
        parse = parse_iw
    elif method == "iw-freq":
        cmd = ["iw", "dev", iface, "scan"]
        if freqs:
            cmd += ["freq"] + [str(f) for f in freqs]
        parse = parse_iw
    else:
        raise ValueError(method)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"exit code {proc.returncode}")
    return parse(proc.stdout)


def summarize(method: str, durations: List[float], snapshots: List[Dict[str, float]],
              errors: List[str], wall: float, anchors: List[str]) -> dict:
    ok = len(durations)
    out: dict = {
        "method": method,
        "scans_ok": ok,
        "scans_failed": len(errors),
        "wall_seconds": round(wall, 1),
    }
    if errors:
        out["first_error"] = errors[0]
    if not ok:
        return out
    out["rate_hz"] = round(ok / wall, 2)
    out["scan_time_s"] = {
        "mean": round(statistics.mean(durations), 2),
        "min": round(min(durations), 2),
        "max": round(max(durations), 2),
    }
    # Freshness: a scan whose readings are identical to the previous one is
    # probably a cached result, not a new measurement.
    same = sum(1 for a, b in zip(snapshots, snapshots[1:]) if a == b)
    out["identical_to_previous_pct"] = round(100.0 * same / max(1, ok - 1), 1)

    per_bssid: Dict[str, List[float]] = {}
    for snap in snapshots:
        for b, v in snap.items():
            per_bssid.setdefault(b, []).append(v)
    rows = []
    for b, vals in sorted(per_bssid.items(), key=lambda kv: -statistics.mean(kv[1])):
        rows.append({
            "bssid": b,
            "seen_pct": round(100.0 * len(vals) / ok, 0),
            "mean_dbm": round(statistics.mean(vals), 1),
            "std_db": round(statistics.pstdev(vals), 2),
            "distinct_values": len(set(vals)),
            "is_anchor": b in anchors,
        })
    out["bssids"] = rows
    return out


def benchmark(method: str, args, anchors: List[str]) -> dict:
    durations: List[float] = []
    snapshots: List[Dict[str, float]] = []
    errors: List[str] = []
    start = time.time()
    while time.time() - start < args.duration:
        t0 = time.time()
        try:
            res = run_scan(method, args.iface, args.freq, args.timeout)
        except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            errors.append(str(e))
            if isinstance(e, FileNotFoundError):
                break
            time.sleep(0.5)
            continue
        durations.append(time.time() - t0)
        snap = {}
        for r in res:
            if args.ssid_prefix and not r["ssid"].startswith(args.ssid_prefix) \
                    and r["bssid"] not in anchors:
                continue
            snap[r["bssid"]] = r["rssi_dbm"]
        snapshots.append(snap)
    return summarize(method, durations, snapshots, errors, time.time() - start, anchors)


def print_report(r: dict) -> None:
    print(f"\n=== {r['method']} ===")
    if "rate_hz" not in r:
        print(f"  no successful scans. error: {r.get('first_error', 'unknown')}")
        if "Operation not permitted" in r.get("first_error", "") or "root" in r.get("first_error", ""):
            print("  hint: iw scans need root; re-run with sudo")
        return
    st = r["scan_time_s"]
    print(f"  scans ok/failed : {r['scans_ok']}/{r['scans_failed']} in {r['wall_seconds']}s")
    print(f"  achieved rate   : {r['rate_hz']} Hz  (scan time mean {st['mean']}s, "
          f"min {st['min']}s, max {st['max']}s)")
    print(f"  identical to previous scan: {r['identical_to_previous_pct']}%  "
          f"(high = likely cached results)")
    if r["scans_failed"]:
        print(f"  first error     : {r['first_error']}")
    print(f"  {'BSSID':<19}{'seen%':>6}{'mean dBm':>10}{'std dB':>8}{'values':>8}  anchor")
    for b in r["bssids"][:15]:
        print(f"  {b['bssid']:<19}{b['seen_pct']:>6.0f}{b['mean_dbm']:>10}{b['std_db']:>8}"
              f"{b['distinct_values']:>8}  {'*' if b['is_anchor'] else ''}")


def verdict(results: List[dict]) -> None:
    good = [r for r in results if "rate_hz" in r]
    if not good:
        print("\nVERDICT: no method worked. Check iface name, root, and that Wi-Fi is on.")
        return
    best = max(good, key=lambda r: r["rate_hz"] * (1 - r["identical_to_previous_pct"] / 100.0))
    fresh = best["rate_hz"] * (1 - best["identical_to_previous_pct"] / 100.0)
    print(f"\nVERDICT: best method = {best['method']} at ~{fresh:.2f} fresh scans/s "
          f"(raw {best['rate_hz']} Hz).")
    if fresh < 1.0:
        print("  Below 1 Hz: tell the team. Plan for RSSI at that rate and rely on step "
              "dead-reckoning between scans; update the PRD claim of 500 ms.")
    else:
        print("  At or above 1 Hz: usable. Put this method in pi_scanner.py (HW-04).")


def main() -> int:
    p = argparse.ArgumentParser(description="HW-03 Wi-Fi scan rate / RSSI noise benchmark")
    p.add_argument("--iface", default="wlan0")
    p.add_argument("--methods", nargs="+", default=["nmcli", "iw-full", "iw-freq"],
                   choices=["nmcli", "iw-full", "iw-freq"])
    p.add_argument("--duration", type=float, default=20.0, help="seconds per method")
    p.add_argument("--timeout", type=float, default=15.0, help="per-scan timeout seconds")
    p.add_argument("--freq", type=int, nargs="*", default=[],
                   help="channel centre frequencies in MHz for iw-freq (e.g. 2437 5180)")
    p.add_argument("--ssid-prefix", default="",
                   help="only report SSIDs starting with this (e.g. ITC-)")
    p.add_argument("--anchors", nargs="*", default=[],
                   help="anchor BSSIDs to flag with * in the report")
    p.add_argument("--json", help="also write full results to this file")
    args = p.parse_args()

    if sys.platform != "linux":
        print("This benchmark must run on the Raspberry Pi (Linux): nmcli/iw are not "
              f"available on {sys.platform}.", file=sys.stderr)
        return 2
    if "iw-freq" in args.methods and not args.freq:
        print("note: iw-freq without --freq behaves like iw-full; pass --freq to test "
              "a channel-limited scan.", file=sys.stderr)

    anchors = [a.lower() for a in args.anchors]
    results = []
    for m in args.methods:
        print(f"Running {m} for {args.duration:.0f}s ... keep the rig still.", flush=True)
        r = benchmark(m, args, anchors)
        print_report(r)
        results.append(r)
    verdict(results)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nWrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
