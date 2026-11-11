"""Sanitising of the phone sensor packet (BE-12).

The phone supplies orientation (compass), gyro and accelerometer ONLY. Location data is never accepted:
`clean_sensors` keeps a fixed set of numeric motion fields and drops everything else, so a GPS/location
key sent by an old or modified client is discarded before it can be stored, logged or served.
"""
import math
from typing import Dict, Optional

# The only groups and fields that are kept.
ALLOWED_SENSORS = {
    "orient": ("alpha", "beta", "gamma", "compass"),
    "gyro": ("alpha", "beta", "gamma"),
    "accel": ("x", "y", "z"),
    "accel_g": ("x", "y", "z"),
}


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def clean_sensors(raw) -> Dict:
    """Keep only known numeric motion fields from a phone packet; drop anything non-finite or unexpected."""
    out: Dict = {}
    if not isinstance(raw, dict):
        return out
    for group, keys in ALLOWED_SENSORS.items():
        d = raw.get(group)
        if isinstance(d, dict):
            c = {k: _num(d.get(k)) for k in keys}
            c = {k: v for k, v in c.items() if v is not None}
            if c:
                out[group] = c
    return out
