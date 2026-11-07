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

