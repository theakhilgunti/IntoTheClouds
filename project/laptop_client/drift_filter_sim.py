"""Offline walk simulator for the MAP-11 drift filter. No hardware, no network, no GPS.

All accuracy numbers it produces come from the ASSUMED noise below, not from field data.
Run `python drift_filter_sim.py` for a summary table.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares

try:
    from drift_filter import BaselinePDR, DriftEKF
except ImportError:  # imported as a package
    from .drift_filter import BaselinePDR, DriftEKF

GRID = 7.32
BEACONS = np.array([[0.0, 0.0], [GRID, 0.0], [0.0, GRID]])  # simulator truth side only
STEP_HZ, HEADING_HZ = 1.8, 10.0
STRIDE_NOMINAL = 0.70

PATHS = {  # waypoints (m), repeated until the walk duration is used up
    "lap": [(1.5, 1.5), (5.8, 1.5), (5.8, 5.8), (1.5, 5.8), (1.5, 1.5)],
    # zigzag goes up then back down the same legs, so the polyline never teleports
    "zigzag": [(1.0, 1.0), (6.3, 1.8), (1.0, 3.0), (6.3, 4.2), (1.0, 5.4), (6.3, 6.3),
               (1.0, 5.4), (6.3, 4.2), (1.0, 3.0), (6.3, 1.8), (1.0, 1.0)],
    "out_and_back": [(1.0, 1.5), (6.3, 4.0), (1.0, 1.5)],
}


@dataclass
class Scenario:
    """Assumed noise. Defaults sit inside the ranges in the MAP-11 work order."""
    duration_s: float = 240.0
    heading_bias_deg: float = 12.0       # constant compass/alignment offset (5-20)
    heading_drift_deg_min: float = 3.0   # slow drift on top of the bias
    heading_noise_deg: float = 3.0       # white per-sample jitter
    stride_error: float = 0.12           # true stride = nominal * (1 + stride_error)
    miss_rate: float = 0.07              # fraction of steps never detected (5-10 %)
    rssi_sigma_db: float = 3.0           # shadowing sigma used for ranging noise
    path_loss_n: float = 2.5
    fix_every_s: tuple = (8.0, 20.0)
    outlier_prob: float = 0.0            # chance a fix is a wild multipath jump
    fixes_enabled: bool = True


def path_position(pts, dist: float):
    """Point `dist` metres along the polyline, repeating it end to end."""
    pts = np.array(pts, dtype=float)
    seg = np.diff(pts, axis=0)
    lens = np.hypot(seg[:, 0], seg[:, 1])
    dist = dist % lens.sum()
    i = int(np.searchsorted(np.cumsum(lens), dist, side="right"))
    i = min(i, len(lens) - 1)
    t = (dist - (np.cumsum(lens)[i] - lens[i])) / lens[i]
    return pts[i] + t * seg[i], math.degrees(math.atan2(seg[i][1], seg[i][0]))


def trilaterate(dists: np.ndarray, guess: np.ndarray) -> np.ndarray:
    res = least_squares(lambda p: np.linalg.norm(BEACONS - p, axis=1) - dists, guess,
                        bounds=([-3, -3], [GRID + 3, GRID + 3]))
    return res.x


def simulate_fixes(truth_xy: np.ndarray, sc: Scenario, rng) -> np.ndarray:
    """Range each beacon with log-normal RSSI error, then trilaterate (as the mapper does)."""
    sig_ln = math.log(10) / (10 * sc.path_loss_n) * sc.rssi_sigma_db
    d = np.linalg.norm(BEACONS - truth_xy, axis=1) * np.exp(rng.normal(0, sig_ln, 3))
    fix = trilaterate(np.clip(d, 0.1, 80.0), np.array([GRID / 2, GRID / 2]))
    if rng.random() < sc.outlier_prob:
        fix = fix + rng.choice([-1, 1], 2) * rng.uniform(5.0, 9.0, 2)
    return fix


def run(path: str, sc: Scenario, seed: int, filt: str = "ekf"):
    """Walk one path. Returns (errors_m per 0.1 s tick, filter object, fix_errors_m)."""
    rng = np.random.default_rng(seed)
    pts = PATHS[path]
    true_stride = STRIDE_NOMINAL * (1 + sc.stride_error)
    sign = rng.choice([-1, 1])
    bias = sign * sc.heading_bias_deg
    drift_rate = rng.choice([-1, 1]) * sc.heading_drift_deg_min / 60.0
    start, _ = path_position(pts, 0.0)
    f = BaselinePDR(*start) if filt == "baseline" else DriftEKF(*start)

    dt = 1.0 / HEADING_HZ
    next_fix = rng.uniform(*sc.fix_every_s)
    walked, step_acc, pend_steps = 0.0, 0.0, 0
    errs, fix_errs = [], []
    for k in range(int(sc.duration_s * HEADING_HZ)):
        t = k * dt
        step_acc += STEP_HZ * dt
        while step_acc >= 1.0:
            step_acc -= 1.0
            walked += true_stride
            if rng.random() > sc.miss_rate:
                pend_steps += 1
        xy, hdg = path_position(pts, walked)
        meas_h = hdg + bias + drift_rate * t + rng.normal(0, sc.heading_noise_deg)
        f.predict(pend_steps, STRIDE_NOMINAL, meas_h, dt)
        pend_steps = 0
        if sc.fixes_enabled and t >= next_fix:
            fix = simulate_fixes(xy, sc, rng)
            fix_errs.append(float(np.linalg.norm(fix - xy)))
            f.update(fix[0], fix[1], 2.0)
            next_fix = t + rng.uniform(*sc.fix_every_s)
        f.clip(-2.0, GRID + 2.0)  # mapper clips the dot to the grid +/- 2 m
        errs.append(math.hypot(f.x - xy[0], f.y - xy[1]))
    return np.array(errs), f, np.array(fix_errs)


def summarize(sc: Scenario, seeds=range(20)):
    """Per path: mean/p95 error for baseline vs EKF, pooled over seeds, last half of the walk."""
    out = {}
    for path in PATHS:
        row = {}
        for filt in ("baseline", "ekf"):
            e = np.concatenate([run(path, sc, s, filt)[0][int(sc.duration_s * HEADING_HZ) // 2:]
                                for s in seeds])
            row[filt] = (float(e.mean()), float(np.percentile(e, 95)))
        out[path] = row
    return out


if __name__ == "__main__":
    sc = Scenario()
    fe = np.concatenate([run("lap", sc, s)[2] for s in range(20)])
    print(f"simulated raw beacon fix error: mean {fe.mean():.2f} m, p95 {np.percentile(fe, 95):.2f} m")
    print("Simulated (assumed noise, not field data); last half of a 240 s walk, 20 seeds")
    print(f"{'path':14s} {'base mean':>10s} {'base p95':>9s} {'ekf mean':>9s} {'ekf p95':>8s}")
    for p, r in summarize(sc).items():
        print(f"{p:14s} {r['baseline'][0]:10.2f} {r['baseline'][1]:9.2f} {r['ekf'][0]:9.2f} {r['ekf'][1]:8.2f}")
