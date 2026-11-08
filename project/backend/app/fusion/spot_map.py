"""2D RF obstacle map from readings taken at known spots (BE-09).

Each reading is (anchor x/y, spot x/y, RSSI). The straight line from anchor to
spot is a ray. If the signal is much weaker than the path-loss model predicts
for that distance, the ray is "blocked", otherwise "clear". Every 0.25 m cell
the ray crosses gets a vote. score = (blocked - clear) / total, in [-1, 1].
A wall should show up as a band of high-score cells. With few anchors the band
is blurry: this is an obstacle hint, not a floor plan.
"""
import math
from typing import Dict, List, Sequence

import numpy as np


class SpotMap2D:
    def __init__(self, bounds=(-2.0, -2.0, 8.0, 8.0), cell_m: float = 0.25, blocked_db: float = 6.0,
                 min_ray_m: float = 0.5):
        self.min_x, self.min_y, self.max_x, self.max_y = bounds
        if cell_m <= 0 or self.max_x <= self.min_x or self.max_y <= self.min_y:
            raise ValueError("invalid bounds or cell size")
        self.cell_m, self.blocked_db, self.min_ray_m = cell_m, blocked_db, min_ray_m
        self.nx = int(math.ceil((self.max_x - self.min_x) / cell_m))
        self.ny = int(math.ceil((self.max_y - self.min_y) / cell_m))
        self.blocked = np.zeros((self.ny, self.nx))
        self.clear = np.zeros((self.ny, self.nx))
        self.rays: List[Dict] = []

    @staticmethod
    def shortfall_db(anchor_xy, spot_xy, rssi: float, p0: float, n: float) -> float:
        d = max(math.dist(anchor_xy, spot_xy), 0.1)
        return (p0 - 10.0 * n * math.log10(d)) - rssi

    def add(self, anchor_xy: Sequence[float], spot_xy: Sequence[float], rssi: float, p0: float, n: float) -> bool:
        """Add one averaged reading. Returns False if it was ignored."""
        try:
            ax, ay = float(anchor_xy[0]), float(anchor_xy[1])
            sx, sy = float(spot_xy[0]), float(spot_xy[1])
            rssi = float(rssi)
        except (TypeError, ValueError, IndexError):
            return False
        if not all(math.isfinite(v) for v in (ax, ay, sx, sy, rssi)):
            return False
        if not (self.min_x <= sx < self.max_x and self.min_y <= sy < self.max_y):
            return False  # spot is off the map, so the ray is meaningless
        length = math.hypot(sx - ax, sy - ay)
        if length < self.min_ray_m:
            return False
        short = self.shortfall_db((ax, ay), (sx, sy), rssi, p0, n)
        steps = max(2, int(length / (self.cell_m * 0.5)))
        t = np.linspace(0.0, 1.0, steps)
        i = np.floor((ax + (sx - ax) * t - self.min_x) / self.cell_m).astype(int)
        j = np.floor((ay + (sy - ay) * t - self.min_y) / self.cell_m).astype(int)
        ok = (i >= 0) & (i < self.nx) & (j >= 0) & (j < self.ny)
        cells = np.unique(np.stack([j[ok], i[ok]], axis=1), axis=0)
        if len(cells) == 0:
            return False
        target = self.blocked if short >= self.blocked_db else self.clear
        target[cells[:, 0], cells[:, 1]] += 1.0
        self.rays.append({"a": [ax, ay], "s": [sx, sy], "rssi": rssi, "short_db": round(short, 1)})
        return True

    def score(self) -> np.ndarray:
        """(blocked - clear) / total per cell; NaN where no ray passed."""
        total = self.blocked + self.clear
        out = np.full(total.shape, np.nan)
        m = total > 0
        out[m] = (self.blocked[m] - self.clear[m]) / total[m]
        return out
