"""Phone GPS -> local map metres, plus sanitising of the phone sensor packet (BE-12).

Indoors (and in smoke-filled buildings) phone GPS is typically 5-50 m off, so the packet always carries
`acc` (metres, 68% radius) and consumers must gate on it. Outdoors with a clear sky it is ~3-10 m.
It is never centimetre-level. The local frame is the same as the particle filter's: +x is the
direction the phone was aligned to (see heading.py), +y is 90 deg counter-clockwise from it.
"""
import math
from typing import Dict, Optional

EARTH_R = 6371000.0
GPS_OK_ACC_M = 15.0  # fixes worse than this are recorded but flagged unusable for positioning


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def latlon_to_local(lat: float, lon: float, origin_lat: float, origin_lon: float, offset_deg: float = 0.0):
    """Equirectangular approximation (fine for < few km). offset_deg = compass bearing of map +y."""
    north = math.radians(lat - origin_lat) * EARTH_R
    east = math.radians(lon - origin_lon) * EARTH_R * math.cos(math.radians(origin_lat))
    by, bx = math.radians(offset_deg), math.radians(offset_deg + 90.0)
    return (east * math.sin(bx) + north * math.cos(bx), east * math.sin(by) + north * math.cos(by))


def clean_sensors(raw) -> Dict:
    """Keep only known numeric fields from a phone packet; drop anything non-finite or unexpected."""
    out: Dict = {}
    if not isinstance(raw, dict):
        return out
    gps = raw.get("gps")
    if isinstance(gps, dict):
        g = {k: _num(gps.get(k)) for k in ("lat", "lon", "acc", "alt", "alt_acc", "speed", "course")}
        if g["lat"] is not None and g["lon"] is not None and -90 <= g["lat"] <= 90 and -180 <= g["lon"] <= 180:
            out["gps"] = {k: v for k, v in g.items() if v is not None}
    for group, keys in (("orient", ("alpha", "beta", "gamma", "compass")), ("gyro", ("alpha", "beta", "gamma")),
                        ("accel", ("x", "y", "z")), ("accel_g", ("x", "y", "z"))):
        d = raw.get(group)
        if isinstance(d, dict):
            c = {k: _num(d.get(k)) for k in keys}
            c = {k: v for k, v in c.items() if v is not None}
            if c:
                out[group] = c
    return out
