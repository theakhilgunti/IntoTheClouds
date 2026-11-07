import pytest
from starlette.testclient import TestClient
from app.main import app
from app.fusion.math_engine import estimate_distance_rssi, ParticleFilterLocalizer

client = TestClient(app)


def test_health_check():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_anchors_endpoint():
    response = client.get("/api/anchors")
    assert response.status_code == 200
    anchors = response.json()
    assert len(anchors) >= 3


def test_hazard_pinning():
    new_hazard = {
        "id": "hazard-test-1",
        "label": "FIRE",
        "hazard_type": "fire",
        "x": 3.5,
        "y": 4.2,
        "z": 1.0,
        "note": "Unit test flashover",
        "timestamp": 1234567.89,
    }
    post_res = client.post("/api/hazards", json=new_hazard)
    assert post_res.status_code == 200

    get_res = client.get("/api/hazards")
    assert get_res.status_code == 200
    hazard_ids = [h["id"] for h in get_res.json()]
    assert "hazard-test-1" in hazard_ids


def test_rssi_distance_model():
    # At 1 meter with P0 = -40 dBm, distance should be 1.0m
    dist_1m = estimate_distance_rssi(rssi=-40.0, p0=-40.0, n=2.5)
    assert abs(dist_1m - 1.0) < 0.01

    # At weaker signal (-65 dBm), distance should be larger
    dist_weaker = estimate_distance_rssi(rssi=-65.0, p0=-40.0, n=2.5)
    assert dist_weaker > 1.0


def test_particle_filter_prediction():
    pf = ParticleFilterLocalizer(num_particles=100, room_bounds=(0, 0, 10, 10))
    initial_x = pf.estimated_x
    initial_y = pf.estimated_y

    # Move east (0 degrees)
    pf.predict(step_detected=True, step_length_m=1.0, heading_deg=0.0)
    state = pf.get_state(device_id="test_rig", heading_deg=0.0, timestamp=100.0)

    assert state.step_count == 1
    assert state.x > initial_x



def test_ble_name_lookup_matches_bssid():
    import numpy as np
    from app.models import BeaconAnchor
    a = BeaconAnchor(id="A1", bssid="aa:bb:cc:11:22:33", ble_name="ITC-A1", x=0.0, y=0.0)
    table = {"aa:bb:cc:11:22:33": a, "itc-a1": a}
    np.random.seed(1)
    pf_ble = ParticleFilterLocalizer(num_particles=300, room_bounds=(-2, -2, 12, 12))
    np.random.seed(1)
    pf_wifi = ParticleFilterLocalizer(num_particles=300, room_bounds=(-2, -2, 12, 12))
    start = pf_ble.particles.copy()
    np.random.seed(2)
    pf_ble.update_rssi([{"bssid": "ITC-A1", "rssi_dbm": -60}], table)
    np.random.seed(2)
    pf_wifi.update_rssi([{"bssid": "AA:BB:CC:11:22:33", "rssi_dbm": -60}], table)
    assert np.allclose(pf_ble.particles, pf_wifi.particles)
    assert np.allclose(pf_ble.weights, pf_wifi.weights)
    # filter actually moved
    assert not np.allclose(pf_ble.particles, start) or not np.allclose(pf_ble.weights, 1.0 / 300)


def test_unknown_id_ignored():
    import numpy as np
    from app.models import BeaconAnchor
    a = BeaconAnchor(id="A1", bssid="aa:bb:cc:11:22:33", ble_name="ITC-A1", x=0.0, y=0.0)
    table = {"aa:bb:cc:11:22:33": a, "itc-a1": a}
    pf = ParticleFilterLocalizer(num_particles=100, room_bounds=(-2, -2, 12, 12))
    w = pf.weights.copy()
    pf.update_rssi([{"bssid": "ITC-ZZ", "rssi_dbm": -60}, {"rssi_dbm": -50}, {"bssid": None}], table)
    assert np.allclose(pf.weights, w)


def test_wifi_and_ble_both_update_weights():
    import numpy as np
    from app.models import BeaconAnchor
    a = BeaconAnchor(id="A1", bssid="aa:bb:cc:11:22:33", ble_name="ITC-A1", x=0.0, y=0.0)
    table = {"aa:bb:cc:11:22:33": a, "itc-a1": a}
    np.random.seed(3)
    one = ParticleFilterLocalizer(num_particles=300, room_bounds=(-2, -2, 12, 12))
    np.random.seed(3)
    two = ParticleFilterLocalizer(num_particles=300, room_bounds=(-2, -2, 12, 12))
    np.random.seed(4)
    one.update_rssi([{"bssid": "aa:bb:cc:11:22:33", "rssi_dbm": -60}], table)
    np.random.seed(4)
    two.update_rssi([{"bssid": "aa:bb:cc:11:22:33", "rssi_dbm": -60},
                     {"bssid": "ITC-A1", "rssi_dbm": -60}], table)
    # two independent measurements concentrate weight/particles more tightly
    assert np.std(two.particles[:, 0]) < np.std(one.particles[:, 0])


def test_anchor_listed_once_and_post_registers_ble_name():
    from app.main import anchors, unique_anchors
    ids = [a["id"] for a in client.get("/api/anchors").json()]
    assert len(ids) == len(set(ids))
    assert "itc-a1" in anchors and "aa:bb:cc:11:22:33" in anchors
    res = client.post("/api/anchors", json={"id": "T9", "bssid": "11:22:33:44:55:66",
                                            "ble_name": "ITC-T9", "x": 1.0, "y": 2.0})
    assert res.status_code == 200
    ids = [a["id"] for a in client.get("/api/anchors").json()]
    assert ids.count("T9") == 1
    assert anchors["itc-t9"] is anchors["11:22:33:44:55:66"]
    with client.websocket_connect("/ws/dashboard") as ws:
        init = ws.receive_json()
        assert [a["id"] for a in init["anchors"]].count("T9") == 1

def _synthetic_scans(px, py, anchors, noise_db=1.5, rng=None):
    import math
    rng = rng or __import__("random")
    scans = []
    for a in anchors.values():
        d = max(0.5, math.hypot(px - a.x, py - a.y))
        scans.append({"bssid": a.bssid, "rssi_dbm": a.p0 - 25.0 * math.log10(d) + rng.gauss(0, noise_db)})
    return scans


def test_diffuse_moves_particles_and_stays_in_bounds():
    pf = ParticleFilterLocalizer(num_particles=200, room_bounds=(0, 0, 10, 10))
    before = pf.particles.copy()
    pf.diffuse(sigma_m=0.5)
    assert not (pf.particles == before).all()
    assert pf.particles[:, 0].min() >= 0 and pf.particles[:, 0].max() <= 10
    assert pf.particles[:, 1].min() >= 0 and pf.particles[:, 1].max() <= 10


def test_diffuse_zero_sigma_is_noop():
    pf = ParticleFilterLocalizer(num_particles=50, room_bounds=(0, 0, 10, 10), diffuse_sigma_m=0.0)
    before = pf.particles.copy()
    pf.diffuse()
    assert (pf.particles == before).all()


def test_signal_only_tracking_converges_near_true_position():
    import random
    import numpy as np
    from app.models import BeaconAnchor
    random.seed(1)
    np.random.seed(1)
    anchors = {
        "a1": BeaconAnchor(id="A1", bssid="a1", x=0.0, y=0.0, z=1.0, p0=-40.0),
        "a2": BeaconAnchor(id="A2", bssid="a2", x=10.0, y=0.0, z=1.0, p0=-40.0),
        "a3": BeaconAnchor(id="A3", bssid="a3", x=5.0, y=10.0, z=1.0, p0=-40.0),
    }
    pf = ParticleFilterLocalizer(num_particles=600, room_bounds=(-2, -2, 12, 12))
    true_x, true_y = 6.0, 4.0
    for _ in range(60):
        pf.diffuse()
        pf.update_rssi(_synthetic_scans(true_x, true_y, anchors), anchors)
        assert 1.0 / np.sum(pf.weights ** 2) > 1.5   # filter has not collapsed to one point
    state = pf.get_state("t", 0.0, 0.0)
    assert ((state.x - true_x) ** 2 + (state.y - true_y) ** 2) ** 0.5 < 3.0


# ---- BE-08: RF heatmap ----
import json as _json
import math as _math
import numpy as _np
from types import SimpleNamespace
from app import main as _main
from app.fusion.rf_map import RFMap


def test_rfmap_signal_falls_with_distance():
    m = RFMap(-2, -2, 12, 12, 0.5)
    for x in (1.0, 8.0):
        for _ in range(5):
            m.add("A1", x, 1.0, -40 - 25 * _math.log10(_math.hypot(x, 1.0)))
    g = m.grid("A1")
    row = int((1.0 + 2) // 0.5)
    assert g[row, int((1.0 + 2) // 0.5)] > g[row, int((8.0 + 2) // 0.5)]


def test_rfmap_ignores_bad_points_and_empty_is_nan():
    m = RFMap(0, 0, 4, 4, 0.5)
    assert not m.add("A", float("nan"), 1, -50)
    assert not m.add("A", 1, 1, float("inf"))
    assert not m.add("A", 99, 1, -50)
    assert not m.add("A", -1, 1, -50)
    assert m.anchor_ids == []
    assert m.add("A", 1.2, 1.2, -50)
    g = m.grid("A")
    assert int(_np.isnan(g).sum()) == g.size - 1


def test_rfmap_excess_loss_follows_model_and_detects_weaker():
    m = RFMap(0, 0, 10, 10, 0.5)
    a = SimpleNamespace(id="A1", x=0.0, y=0.0, p0=-40.0)
    cx, cy = 5.25, 5.25  # centre of its cell
    m.add("A1", cx, cy, -40.0 - 25 * _math.log10(_math.hypot(cx, cy)))
    m.add("A1", 8.25, 2.25, -40.0 - 25 * _math.log10(_math.hypot(8.25, 2.25)) - 10.0)
    e = m.excess_loss("A1", {"A1": a}, 2.5, -40.0)
    assert abs(e[int(cy // 0.5), int(cx // 0.5)]) < 1e-6
    assert abs(e[int(2.25 // 0.5), int(8.25 // 0.5)] - 10.0) < 1e-6


def test_api_map_bssid_and_ble_same_grid_null_cells_and_reset():
    _main.rf_map.reset()
    try:
        # Messages are processed in order; the handler finishes this one before
        # it sees the disconnect when the context exits.
        with client.websocket_connect("/ws/telemetry") as ws:
            ws.send_text(_json.dumps({"pdr": {"step_detected": False}, "wifi_scans": [
                {"bssid": "AA:BB:CC:11:22:33", "rssi_dbm": -55},
                {"bssid": "ITC-A1", "rssi_dbm": -57}]}))
        res = client.get("/api/map")
        assert res.status_code == 200
        assert "NaN" not in res.text
        body = _json.loads(res.text)
        assert list(body["cells"].keys()) == ["A1"]
        rows = body["cells"]["A1"]
        assert len(rows) == body["height"] and len(rows[0]) == body["width"]
        flat = [v for r in rows for v in r]
        assert None in flat
        assert [v for v in flat if v is not None] == [-56.0]
        client.post("/api/reset")
        assert client.get("/api/map").json()["cells"] == {}
    finally:
        _main.rf_map.reset()
