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
