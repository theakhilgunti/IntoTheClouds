"""RF signal heatmap (BE-08).

This is a *signal map*, NOT a floor plan: it records how strong each anchor's
radio signal was at the places the walker's estimated position visited. RSSI
cannot tell us where walls are; at best the per-cell ``excess_loss`` is a hint
that something between the cell and the anchor attenuated the signal more than
the path-loss model predicts.

Grid layout: arrays have shape ``(ny, nx)``. Row index ``j`` follows y
(``j = floor((y - min_y) / cell_m)``) and column index ``i`` follows x
(``i = floor((x - min_x) / cell_m)``), so ``grid[j][i]`` is the cell whose
lower-left corner is ``(min_x + i*cell_m, min_y + j*cell_m)``.
"""
import math
from typing import Dict, Mapping, Optional

import numpy as np


class RFMap:
    def __init__(self, min_x: float, min_y: float, max_x: float, max_y: float, cell_m: float = 0.5):
        if cell_m <= 0 or max_x <= min_x or max_y <= min_y:
            raise ValueError("invalid RFMap bounds or cell size")
        self.min_x, self.min_y, self.max_x, self.max_y = min_x, min_y, max_x, max_y
        self.cell_m = cell_m
        self.nx = int(math.ceil((max_x - min_x) / cell_m))
        self.ny = int(math.ceil((max_y - min_y) / cell_m))
        self._sum: Dict[str, np.ndarray] = {}
        self._count: Dict[str, np.ndarray] = {}

    @property
    def anchor_ids(self):
        return list(self._sum.keys())

    def add(self, anchor_id: str, x: float, y: float, rssi: float) -> bool:
        """Record one reading. Returns False if ignored (non-finite or out of bounds)."""
        try:
            x, y, rssi = float(x), float(y), float(rssi)
        except (TypeError, ValueError):
            return False
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(rssi)):
            return False
        if not (self.min_x <= x < self.max_x and self.min_y <= y < self.max_y):
            return False
        i = min(int((x - self.min_x) // self.cell_m), self.nx - 1)
        j = min(int((y - self.min_y) // self.cell_m), self.ny - 1)
        if anchor_id not in self._sum:
            self._sum[anchor_id] = np.zeros((self.ny, self.nx))
            self._count[anchor_id] = np.zeros((self.ny, self.nx))
        self._sum[anchor_id][j, i] += rssi
        self._count[anchor_id][j, i] += 1
        return True

    def grid(self, anchor_id: str) -> np.ndarray:
        """Mean RSSI per cell, shape (ny, nx); NaN where nothing was recorded."""
        out = np.full((self.ny, self.nx), np.nan)
        if anchor_id in self._sum:
            cnt = self._count[anchor_id]
            mask = cnt > 0
            out[mask] = self._sum[anchor_id][mask] / cnt[mask]
        return out

    def excess_loss(self, anchor_id: str, anchors: Mapping, n: float, p0: Optional[float] = None) -> np.ndarray:
        """Per-cell ``expected - measured`` dB (NaN where unmeasured).

        expected = p0 - 10*n*log10(max(dist(cell centre, anchor), 0.1)).
        Positive means weaker than the model predicts. ``anchors`` maps keys to
        objects with x, y (and p0); the anchor is found by ``anchor_id`` key or
        by matching ``.id``. If p0 is None the anchor's own p0 is used.
        """
        anchor = anchors.get(anchor_id)
        if anchor is None:
            for a in anchors.values():
                if getattr(a, "id", None) == anchor_id:
                    anchor = a
                    break
        if anchor is None:
            return np.full((self.ny, self.nx), np.nan)
        if p0 is None:
            p0 = anchor.p0
        cx = self.min_x + (np.arange(self.nx) + 0.5) * self.cell_m
        cy = self.min_y + (np.arange(self.ny) + 0.5) * self.cell_m
        dist = np.hypot(cx[None, :] - anchor.x, cy[:, None] - anchor.y)
        expected = p0 - 10.0 * n * np.log10(np.maximum(dist, 0.1))
        return expected - self.grid(anchor_id)

    def reset(self) -> None:
        self._sum.clear()
        self._count.clear()

    clear = reset
