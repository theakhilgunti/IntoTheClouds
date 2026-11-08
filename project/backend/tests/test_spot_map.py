import numpy as np
from app.fusion.spot_map import SpotMap2D

N, P0 = 2.5, -55.0
A = (0.0, 0.0)


def rssi(anchor, spot, loss=0.0):
    d = float(np.hypot(spot[0] - anchor[0], spot[1] - anchor[1]))
    return P0 - 10 * N * np.log10(d) - loss


def test_wall_rays_blocked_clear_rays_not():
    m = SpotMap2D()
    for y in np.arange(-1, 4.1, 0.5):
        m.add(A, (4.0, y), rssi(A, (4.0, y), 12.0), P0, N)  # behind wall
        m.add(A, (-1.5, y), rssi(A, (-1.5, y), 0.0), P0, N)  # same side
    s = m.score()
    i = int((2.0 - m.min_x) // m.cell_m)
    j = int((0.0 - m.min_y) // m.cell_m)
    assert s[j, i] > 0.5          # between anchor and wall-side spots
    jl, il = int((0.0 - m.min_y) // m.cell_m), int((-1.25 - m.min_x) // m.cell_m)
    assert s[jl, il] < 0          # on the clear side


def test_no_wall_gives_no_positive_cells():
    m = SpotMap2D()
    for y in np.arange(-1, 4.1, 0.5):
        m.add(A, (4.0, y), rssi(A, (4.0, y)), P0, N)
    assert not (np.nan_to_num(m.score(), nan=-1) > 0).any()


def test_bad_and_short_readings_ignored():
    m = SpotMap2D()
    assert not m.add(A, (float("nan"), 1), -60, P0, N)
    assert not m.add(A, (0.1, 0.1), -60, P0, N)
    assert not m.add(A, (500, 500), -60, P0, N)
    assert not m.add(A, None, -60, P0, N)
    assert m.rays == []


def test_baseline_cancels_model_error():
    # Real environment is 15 dB weaker than the model everywhere (clutter). Model-only calls
    # everything blocked; baseline-differential sees only the real 12 dB wall loss.
    ys = np.arange(-1, 4.1, 0.5)
    m_model, m_base = SpotMap2D(), SpotMap2D()
    for y in ys:
        for spot, wall in (((4.0, y), 12.0), ((-1.5, y), 0.0)):
            base = rssi(A, spot, 15.0)
            now = rssi(A, spot, 15.0 + wall)
            m_model.add(A, spot, now, P0, N)
            m_base.add(A, spot, now, P0, N, baseline_rssi=base)
    assert not (np.nan_to_num(m_model.score(), nan=0) < 0).any()  # model: no clear rays at all
    s = m_base.score()
    assert s[int((0.0 - m_base.min_y) // m_base.cell_m), int((2.0 - m_base.min_x) // m_base.cell_m)] > 0.5
    assert s[int((0.0 - m_base.min_y) // m_base.cell_m), int((-1.25 - m_base.min_x) // m_base.cell_m)] < 0
    assert all(r["baseline"] for r in m_base.rays)


def test_nonfinite_baseline_ignored():
    m = SpotMap2D()
    assert not m.add(A, (3, 3), -60, P0, N, baseline_rssi=float("nan"))
