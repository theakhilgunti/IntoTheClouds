from starlette.testclient import TestClient
from app import main

client = TestClient(main.app)


def test_default_room_matches_old_bounds():
    r = client.get("/api/room").json()
    assert r["width_m"] == 10 and r["bounds"] == {"min_x": -2.0, "min_y": -2.0, "max_x": 12.0, "max_y": 12.0}


def test_set_room_resizes_everything_and_resets_walk():
    try:
        r = client.post("/api/room", json={"width_m": 6, "length_m": 4, "height_m": 2.5, "margin_m": 1}).json()
        assert r["bounds"] == {"min_x": -1.0, "min_y": -1.0, "max_x": 7.0, "max_y": 5.0}
        assert (main.localizer.max_x, main.localizer.max_y) == (7.0, 5.0)
        assert (main.rf_map.max_x, main.rf_map.max_y) == (7.0, 5.0)
        assert main.voxel_grid.max[0] == 7.0 and main.voxel_grid.max[2] == 2.5
        assert main.localizer.particles[:, 0].max() <= 7.0 and main.localizer.particles[:, 1].max() <= 5.0
        assert len(main.breadcrumbs) == 0
        # the reset path keeps the new size
        client.post("/api/reset")
        assert main.localizer.max_x == 7.0
    finally:
        client.post("/api/room", json={})  # back to defaults for other tests


def test_bad_room_rejected_and_unchanged():
    before = client.get("/api/room").json()
    assert client.post("/api/room", json={"width_m": -3}).status_code == 422
    assert client.post("/api/room", json={"width_m": 500}).status_code == 422
    assert client.post("/api/room", json={"width_m": 100, "length_m": 100, "voxel_m": 0.05}).status_code == 422  # too many voxels
    assert client.get("/api/room").json() == before
