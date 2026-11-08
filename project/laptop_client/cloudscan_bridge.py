#!/usr/bin/env python3
"""CS-02 bridge: save a finished mapper walk to CloudScan (local-safe).

Reads the mapper's local SSE telemetry (default http://127.0.0.1:8899/api/stream),
collects the breadcrumb trail (x, y metres + timestamps), converts it with
``build_exploration_payload`` and POSTs it once when the walk ends.

Only x/y/z metres and timestamps leave this script. No phone GPS, no network
identifiers beyond the existing deviceId.

Examples:
    python3 cloudscan_bridge.py --dry-run --finish     # snapshot, print, post nothing
    python3 cloudscan_bridge.py                        # collect until Ctrl+C, then post
"""

import argparse
import asyncio
import ipaddress
import json
import os
import socket
import sys
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

# Reuse the backend payload builder rather than duplicating it.
_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.explored_session import build_exploration_payload, persist_exploration  # noqa: E402

DEFAULT_MAPPER_URL = "http://127.0.0.1:8899"
DEFAULT_CLOUDSCAN_URL = "http://127.0.0.1:3000"
DEFAULT_DEVICE_ID = "wifi-grid-rig"


def map_to_building_frame(x: float, y: float) -> Tuple[float, float, float]:
    """Map a mapper-frame point (metres, origin FireBeacon) to the viewer frame.

    TODO(#46): identity for now. Issue #46 (CS-01) decides the real mapping
    (building origin, rotation, floor/z). Change only this function.
    """
    return x, y, 1.0


def is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def merge_trail(store: Dict[float, Tuple[float, float]], trail: List[dict]) -> None:
    """Merge a telemetry packet's trail into store keyed by timestamp (dedupes overlaps)."""
    for p in trail or []:
        try:
            store[float(p["t"])] = (float(p["x"]), float(p["y"]))
        except (KeyError, TypeError, ValueError):
            continue


def iter_sse_packets(lines):
    """Yield decoded JSON objects from an iterable of SSE byte/str lines."""
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            yield json.loads(line[5:].strip())
        except ValueError:
            continue


def collect_trail(mapper_url: str, finish: bool = False, timeout: float = 15.0) -> Dict[float, Tuple[float, float]]:
    """Read the SSE stream. finish=True takes one snapshot; otherwise runs until Ctrl+C/stream end."""
    store: Dict[float, Tuple[float, float]] = {}
    url = mapper_url.rstrip("/") + "/api/stream"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            for pkt in iter_sse_packets(resp):
                if pkt.get("type") not in (None, "telemetry"):
                    continue
                merge_trail(store, pkt.get("trail", []))
                if finish and store:
                    break
    except KeyboardInterrupt:
        pass
    except (OSError, socket.timeout) as exc:
        print(f"[!] mapper stream ended: {exc}", file=sys.stderr)
    return store


def build_payload(store: Dict[float, Tuple[float, float]], device_id: str = DEFAULT_DEVICE_ID) -> Optional[dict]:
    if not store:
        return None
    ts = sorted(store)
    crumbs = []
    for t in ts:
        x, y, z = map_to_building_frame(*store[t])
        crumbs.append({"x": x, "y": y, "z": z})
    return build_exploration_payload(crumbs, [], device_id, ts[0], ts[-1])


def post_payload(payload: dict, cloudscan_url: str, allow_remote: bool = False) -> bool:
    """POST once. Refuses non-local URLs unless allow_remote. Never raises on server errors."""
    if not allow_remote and not is_local_url(cloudscan_url):
        print("[!] Refusing non-local CLOUDSCAN_URL (use --allow-remote to override).", file=sys.stderr)
        return False
    os.environ["CLOUDSCAN_URL"] = cloudscan_url
    return asyncio.run(persist_exploration(payload))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mapper-url", default=DEFAULT_MAPPER_URL)
    ap.add_argument("--dry-run", action="store_true", help="print the payload, post nothing")
    ap.add_argument("--finish", action="store_true", help="take one snapshot of the trail now instead of waiting for Ctrl+C")
    ap.add_argument("--allow-remote", action="store_true", help="allow a non-local CLOUDSCAN_URL")
    ap.add_argument("--device-id", default=DEFAULT_DEVICE_ID)
    args = ap.parse_args(argv)

    cloudscan_url = os.environ.get("CLOUDSCAN_URL", DEFAULT_CLOUDSCAN_URL)
    if not args.dry_run and not args.allow_remote and not is_local_url(cloudscan_url):
        print("[!] Refusing non-local CLOUDSCAN_URL (use --allow-remote to override). Nothing sent.", file=sys.stderr)
        return 2

    if not args.finish:
        print("[*] Collecting walk... press Ctrl+C when finished.", file=sys.stderr)
    store = collect_trail(args.mapper_url, finish=args.finish)
    payload = build_payload(store, args.device_id)
    if payload is None:
        print("[!] Walk too short (need at least 2 breadcrumbs). Nothing saved.", file=sys.stderr)
        return 1

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    ok = post_payload(payload, cloudscan_url, args.allow_remote)
    print("[+] Saved walk." if ok else "[!] Could not save walk (server down or rejected).", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
