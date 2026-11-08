"""CloudScan Pro (Phase 2): 3-point setup from the website -> scanner coordinate frame.

The website sends three points placed around the house, each with a type
(origin / x / y) and a device IP. The scanner math expects an orthogonal frame:

    Origin anchor at (0, 0), X anchor at (Lx, 0), Y anchor at (0, Ly)

so we measure Lx = |origin -> x| and Ly = |origin -> y| from the site positions
and remember how to turn scanner coordinates back into site coordinates
(`local_to_site`) for drawing on the 3D model.
"""
import math
import random
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .models import BeaconAnchor

AnchorType = Literal["origin", "x", "y"]
MIN_AXIS_M = 2.0  # points closer than this cannot be triangulated sensibly


class ProAnchorIn(BaseModel):
    id: str
    type: AnchorType
    ip: str
    x: float  # site metres, x = east
    y: float  # site metres, y = north

    @field_validator("ip")
    @classmethod
    def _ip(cls, v: str) -> str:
        v = v.strip()
        parts = v.split(".")
        if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
            raise ValueError("ip must be an IPv4 address like 192.168.1.21")
        return v


class ProSetup(BaseModel):
    house_id: Optional[str] = None
    anchors: List[ProAnchorIn] = Field(min_length=3, max_length=3)


class SiteFrame(BaseModel):
    origin_x: float
    origin_y: float
    rotation_rad: float  # direction of the scanner X axis in the site frame
    flip: int  # +1 if scanner Y is 90 deg counter-clockwise of X in the site, else -1
    length_x_m: float
    length_y_m: float


class ProState(BaseModel):
    house_id: Optional[str]
    frame: SiteFrame
    anchors: List[BeaconAnchor]  # scanner-frame metres, bssid == device IP
    bounds: List[float]  # min_x, min_y, max_x, max_y (scanner frame)


def validate_setup(setup: ProSetup) -> None:
    types = sorted(a.type for a in setup.anchors)
    if types != ["origin", "x", "y"]:
        raise ValueError("Need exactly one origin, one x and one y point")
    ips = [a.ip for a in setup.anchors]
    if len(set(ips)) != 3:
        raise ValueError("Each point needs its own IP address")


def build_state(setup: ProSetup) -> ProState:
    validate_setup(setup)
    by = {a.type: a for a in setup.anchors}
    o, px, py = by["origin"], by["x"], by["y"]
    ux, uy = px.x - o.x, px.y - o.y
    vx, vy = py.x - o.x, py.y - o.y
    lx, ly = math.hypot(ux, uy), math.hypot(vx, vy)
    if lx < MIN_AXIS_M or ly < MIN_AXIS_M:
        raise ValueError(f"Points are too close together (need at least {MIN_AXIS_M:.0f} m from the origin)")
    flip = 1 if (ux * vy - uy * vx) >= 0 else -1
    frame = SiteFrame(
        origin_x=o.x,
        origin_y=o.y,
        rotation_rad=math.atan2(uy, ux),
        flip=flip,
        length_x_m=lx,
        length_y_m=ly,
    )
    local = [
        BeaconAnchor(id="ORIGIN", bssid=o.ip, x=0.0, y=0.0, z=1.5),
        BeaconAnchor(id="X", bssid=px.ip, x=lx, y=0.0, z=1.5),
        BeaconAnchor(id="Y", bssid=py.ip, x=0.0, y=ly, z=1.5),
    ]
    pad = 2.0
    return ProState(
        house_id=setup.house_id,
        frame=frame,
        anchors=local,
        bounds=[-pad, -pad, lx + pad, ly + pad],
    )


def local_to_site(frame: SiteFrame, x: float, y: float) -> tuple[float, float]:
    c, s = math.cos(frame.rotation_rad), math.sin(frame.rotation_rad)
    sx = frame.origin_x + x * c - frame.flip * y * s
    sy = frame.origin_y + x * s + frame.flip * y * c
    return sx, sy


# --- Simulated walk (demo fallback, no radios needed) -------------------------


def sim_position(t: float, lx: float, ly: float) -> tuple[float, float]:
    """A smooth loop through the rectangle spanned by the three points."""
    mx, my = 1.0, 1.0
    cx, cy = lx / 2, ly / 2
    ax, ay = max(0.5, lx / 2 - mx), max(0.5, ly / 2 - my)
    return cx + ax * math.sin(t * 0.35), cy + ay * math.sin(t * 0.52 + 0.8)


def sim_scans(anchors: List[BeaconAnchor], px: float, py: float, noise_db: float = 1.5, n: float = 2.5) -> list[dict]:
    """Fake RSSI from the true position using the same log-distance model the filter inverts."""
    scans = []
    for a in anchors:
        d = max(0.3, math.hypot(px - a.x, py - a.y))
        rssi = a.p0 - 10.0 * n * math.log10(d) + random.gauss(0.0, noise_db)
        scans.append({"bssid": a.bssid, "rssi_dbm": round(rssi, 1)})
    return scans
