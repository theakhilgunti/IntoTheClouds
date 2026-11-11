"""RF obstacle hints -> voxel grid -> extruded mesh (BE-01, BE-02, BE-03).

This is *coarse*. Each reading gives one number: how much weaker an anchor's
signal was than the path-loss model predicts for that distance. We treat the
straight line from anchor to walker as a ray. A ray with a big shortfall is
"blocked"; a ray with none is "clear". Voxels accumulate both kinds of votes,
and a voxel is called occupied when most rays through it were blocked. With a
few anchors the result is a rough obstacle hint, not a floor plan.
"""
import math
from typing import Dict, List, Optional, Tuple

import numpy as np


def expected_rssi(p0: float, dist_m: float, n: float) -> float:
    return p0 - 10.0 * n * math.log10(max(dist_m, 0.1))


class VoxelGrid:
    def __init__(self, bounds=(-2.0, -2.0, 0.0, 12.0, 12.0, 3.0), voxel_m: float = 0.25,
                 blocked_db: float = 6.0, min_rays: int = 3, occupied_frac: float = 0.6,
                 min_ray_m: float = 1.0):
        self.min = np.array(bounds[:3], dtype=float)
        self.max = np.array(bounds[3:], dtype=float)
        if voxel_m <= 0 or np.any(self.max <= self.min):
            raise ValueError("invalid VoxelGrid bounds or voxel size")
        self.voxel_m = voxel_m
        self.shape = tuple(int(math.ceil(v)) for v in (self.max - self.min) / voxel_m)  # (nx, ny, nz)
        self.blocked_db, self.min_rays, self.occupied_frac, self.min_ray_m = blocked_db, min_rays, occupied_frac, min_ray_m
        self.blocked = np.zeros(self.shape, dtype=np.float32)
        self.total = np.zeros(self.shape, dtype=np.float32)

    def add_ray(self, anchor_xyz, walker_xyz, rssi: float, p0: float, n: float) -> bool:
        """Vote along one anchor->walker ray. Returns False if the reading was ignored."""
        try:
            a = np.array(anchor_xyz, dtype=float)
            w = np.array(walker_xyz, dtype=float)
            rssi = float(rssi)
        except (TypeError, ValueError):
            return False
        if not (np.all(np.isfinite(a)) and np.all(np.isfinite(w)) and math.isfinite(rssi)):
            return False
        # The walker position is an estimate; if it is off the grid, the ray is meaningless.
        if np.any(w < self.min) or np.any(w >= self.max):
            return False
        length = float(np.linalg.norm(w - a))
        # Very short rays say nothing about walls (and the position error dominates).
        if length < self.min_ray_m:
            return False
        shortfall = expected_rssi(p0, length, n) - rssi
        steps = max(2, int(length / (self.voxel_m * 0.5)))
        pts = a[None, :] + (w - a)[None, :] * np.linspace(0.0, 1.0, steps)[:, None]
        idx = np.floor((pts - self.min) / self.voxel_m).astype(int)
        ok = np.all((idx >= 0) & (idx < np.array(self.shape)), axis=1)
        idx = np.unique(idx[ok], axis=0)
        if len(idx) == 0:
            return False
        # Skip the voxels at either end: the anchor/walker themselves are not obstacles.
        cells = tuple(idx.T)
        self.total[cells] += 1.0
        if shortfall >= self.blocked_db:
            self.blocked[cells] += 1.0
        return True

    def score(self) -> np.ndarray:
        """Fraction of rays through each voxel that were blocked (0 where unseen)."""
        return np.divide(self.blocked, self.total, out=np.zeros_like(self.blocked), where=self.total > 0)

    def occupied(self) -> np.ndarray:
        return (self.total >= self.min_rays) & (self.score() >= self.occupied_frac)

    def reset(self) -> None:
        self.blocked.fill(0)
        self.total.fill(0)

    def to_mesh(self, extrude: bool = True, wall_height_m: float = 2.5) -> Dict:
        """Box mesh of occupied voxels. extrude=True fills each occupied (x, y) column
        up to wall_height_m (2.5D), since rays at walker height only see one slice."""
        occ = self.occupied()
        if extrude:
            nz = min(self.shape[2], max(1, int(math.ceil(wall_height_m / self.voxel_m))))
            col = occ.any(axis=2)
            occ = np.zeros(self.shape, dtype=bool)
            occ[:, :, :nz] = col[:, :, None]
        return _boxes(occ, self.min, self.voxel_m)

    def stats(self) -> Dict:
        return {"voxel_m": self.voxel_m, "shape": list(self.shape),
                "seen_voxels": int((self.total > 0).sum()), "occupied_voxels": int(self.occupied().sum())}


_FACES = [  # (neighbour offset, 4 corner offsets CCW seen from outside)
    ((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
    ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
    ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
    ((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
    ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
    ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
]


def _boxes(occ: np.ndarray, origin: np.ndarray, v: float) -> Dict:
    """Surface-only mesh: faces between two occupied voxels are dropped."""
    padded = np.pad(occ, 1)
    verts: List[List[float]] = []
    faces: List[List[int]] = []
    vert_index: Dict[Tuple[int, int, int], int] = {}

    def vid(c):
        if c not in vert_index:
            vert_index[c] = len(verts)
            verts.append([round(float(origin[k] + c[k] * v), 3) for k in range(3)])
        return vert_index[c]

    for i, j, k in zip(*np.nonzero(occ)):
        for (dx, dy, dz), corners in _FACES:
            if padded[i + 1 + dx, j + 1 + dy, k + 1 + dz]:
                continue
            q = [vid((i + cx, j + cy, k + cz)) for cx, cy, cz in corners]
            faces.append([q[0], q[1], q[2]])
            faces.append([q[0], q[2], q[3]])
    return {"vertices": verts, "faces": faces, "voxel_count": int(occ.sum())}
