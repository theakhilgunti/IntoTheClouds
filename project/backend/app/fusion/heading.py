"""Compass <-> map heading conversion (BE-10).

A compass reports bearing in degrees clockwise from magnetic north. The particle
filter's heading is a math angle: 0 deg = +x on the map, counter-clockwise.
`offset` is the compass bearing of the map's +y axis. It is found by pointing the
phone along the map's +x axis and calling offset_from_plus_x().
"""
import math


def offset_from_plus_x(compass_deg: float) -> float:
    return (compass_deg - 90.0) % 360.0


def compass_to_map_heading(compass_deg: float, offset_deg: float) -> float:
    return (90.0 - (compass_deg - offset_deg)) % 360.0


def valid_angle(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
