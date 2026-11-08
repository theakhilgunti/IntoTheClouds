"""MAP-11 simulator tests. Offline only. Results depend on the assumed noise in Scenario."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import drift_filter_sim as S  # noqa: E402
from drift_filter import DriftEKF  # noqa: E402

SEEDS = range(12)


def pooled_mean(sc, filt, paths=tuple(S.PATHS)):
    half = int(sc.duration_s * S.HEADING_HZ) // 2
    return float(np.mean(np.concatenate(
        [S.run(p, sc, s, filt)[0][half:] for p in paths for s in SEEDS])))


def test_beats_baseline_on_biased_heading_walk():
    sc = S.Scenario(duration_s=600, heading_bias_deg=18, heading_drift_deg_min=2, stride_error=0.14)
    base, ekf = pooled_mean(sc, "baseline"), pooled_mean(sc, "ekf")
    assert ekf < base, (ekf, base)


def test_beats_baseline_on_lap_with_sparse_fixes():
    sc = S.Scenario(duration_s=600, heading_bias_deg=15, fix_every_s=(15.0, 20.0))
    base, ekf = pooled_mean(sc, "baseline", ("lap",)), pooled_mean(sc, "ekf", ("lap",))
    assert ekf < base * 0.97, (ekf, base)


def test_learns_heading_offset_on_turning_walk():
    # With little noise on everything else the filter should recover roughly -bias.
    sc = S.Scenario(duration_s=600, heading_bias_deg=15, heading_drift_deg_min=0, heading_noise_deg=1,
                    stride_error=0.0, miss_rate=0.0, rssi_sigma_db=1.0)
    errs = []
    for s in SEEDS:
        rng = np.random.default_rng(s)
        sign = rng.choice([-1, 1])
        _, f, _ = S.run("lap", sc, s, "ekf")
        errs.append(abs(f.heading_offset_deg + sign * 15))
    assert np.median(errs) < 6.0, errs


def test_stable_without_fixes():
    """No fixes: no NaN, no blow-up, bias/scale stay inside their clamps, covariance stays valid."""
    sc = S.Scenario(duration_s=300, fixes_enabled=False)
    for path in S.PATHS:
        e, f, _ = S.run(path, sc, 1, "ekf")
        base, _, _ = S.run(path, sc, 1, "baseline")
        assert np.all(np.isfinite(e)) and np.all(np.isfinite(f.P))
        assert np.all(np.linalg.eigvalsh(f.P) > -1e-9)
        assert abs(f.heading_offset_deg) < 1e-9 and f.stride_scale == 1.0  # nothing to learn from
        assert e.max() < 15.0
        # dead reckoning alone is the same as the baseline (no worse)
        assert abs(e[-1] - base[-1]) < 0.5


def test_wild_outlier_fix_barely_moves_estimate():
    f = DriftEKF(3.0, 3.0)
    for _ in range(30):                       # settle with a few ordinary steps and agreeing fixes
        f.predict(3, 0.7, 0.0, 1.7)
        f.update(f.x, f.y, 2.0)
    before = np.array([f.x, f.y]), f.heading_offset_deg, f.stride_scale
    f.update(f.x + 40.0, f.y - 40.0, 2.0)     # absurd multipath fix
    assert math.hypot(f.x - before[0][0], f.y - before[0][1]) < 1.0
    assert abs(f.heading_offset_deg - before[1]) < 1.0
    assert abs(f.stride_scale - before[2]) < 0.02


def test_outliers_in_walk_do_not_beat_clean_ekf_by_much_but_stay_bounded():
    sc = S.Scenario(duration_s=600, outlier_prob=0.15)
    ekf = pooled_mean(sc, "ekf")
    assert ekf < 3.0, ekf  # an unconstrained filter chasing outliers would sit well above this
    assert ekf < pooled_mean(sc, "baseline") * 1.05


def test_state_clamps_hold():
    f = DriftEKF(3.0, 3.0)
    for _ in range(200):
        f.predict(3, 0.7, 0.0, 1.0)
        f.update(0.0, 7.0, 0.5)               # adversarial, consistent bad fixes
    assert abs(f.heading_offset_deg) <= 35.0 + 1e-6
    assert 0.7 <= f.stride_scale <= 1.3
