import math

import pytest
from starlette.testclient import TestClient

from app.main import app
from app.pro import ProSetup, build_state, local_to_site

client = TestClient(app)


def setup_body(o=(10.0, 10.0), x=(18.0, 10.0), y=(10.0, 18.0), ips=("192.168.1.21", "192.168.1.22", "192.168.1.23")):
    return {
        "house_id": "osm-1",
        "anchors": [
            {"id": "a1", "type": "origin", "ip": ips[0], "x": o[0], "y": o[1]},
            {"id": "a2", "type": "x", "ip": ips[1], "x": x[0], "y": x[1]},
            {"id": "a3", "type": "y", "ip": ips[2], "x": y[0], "y": y[1]},
        ],
    }


def test_frame_axis_lengths_and_anchor_positions():
    st = build_state(ProSetup(**setup_body()))
    assert math.isclose(st.frame.length_x_m, 8.0)
    assert math.isclose(st.frame.length_y_m, 8.0)
    pos = {a.id: (a.x, a.y) for a in st.anchors}
    assert pos["ORIGIN"] == (0.0, 0.0)
    assert pos["X"] == (8.0, 0.0)
    assert pos["Y"] == (0.0, 8.0)
    assert {a.bssid for a in st.anchors} == {"192.168.1.21", "192.168.1.22", "192.168.1.23"}


def test_local_to_site_roundtrip_rotated_and_flipped():
    # X anchor to the north, Y anchor to the east => rotated 90 deg and mirrored (flip -1)
    st = build_state(ProSetup(**setup_body(o=(5, 5), x=(5, 13), y=(11, 5))))
    assert st.frame.flip == -1
    sx, sy = local_to_site(st.frame, 8.0, 0.0)
    assert (round(sx, 6), round(sy, 6)) == (5.0, 13.0)
    sx, sy = local_to_site(st.frame, 0.0, 6.0)
    assert (round(sx, 6), round(sy, 6)) == (11.0, 5.0)


def test_rejects_duplicate_types_and_ips_and_tiny_spacing():
    body = setup_body()
    body["anchors"][1]["type"] = "origin"
    with pytest.raises(ValueError):
        build_state(ProSetup(**body))
    with pytest.raises(ValueError):
        build_state(ProSetup(**setup_body(ips=("1.1.1.1", "1.1.1.1", "1.1.1.2"))))
    with pytest.raises(ValueError):
        build_state(ProSetup(**setup_body(x=(10.5, 10.0))))


def test_setup_endpoint_registers_anchors_and_validates():
    bad = client.post("/api/pro/setup", json=setup_body(ips=("999.1.1.1", "192.168.1.22", "192.168.1.23")))
    assert bad.status_code == 422
    ok = client.post("/api/pro/setup", json=setup_body())
    assert ok.status_code == 200
    assert ok.json()["linked"] is True
    ids = {a["id"]: a["bssid"] for a in client.get("/api/anchors").json()}
    assert ids == {"ORIGIN": "192.168.1.21", "X": "192.168.1.22", "Y": "192.168.1.23"}


def test_simulate_requires_setup_then_tracks_walker():
    # Simulation tracks the true position: run the pipeline directly with synthetic scans.
    import asyncio
    import app.main as m

    client.post("/api/pro/setup", json=setup_body())
    from app.pro import sim_position, sim_scans

    async def run():
        errs = []
        px = py = 0.0
        for i in range(120):
            px, py = sim_position(i * 0.2, 8.0, 8.0)
            await m.ingest_telemetry({"pdr": {"step_detected": False}, "wifi_scans": sim_scans(m.pro_state.anchors, px, py)})
            if i > 40:
                errs.append(math.hypot(m.current_state.x - px, m.current_state.y - py))
        return sum(errs) / len(errs)

    mean_err = asyncio.run(run())
    assert mean_err < 3.0, f"mean tracking error {mean_err:.2f} m"
    status = client.get("/api/pro/status").json()
    assert status["site"] is not None


def test_simulate_endpoint_toggle():
    client.post("/api/pro/setup", json=setup_body())
    with client:  # lifespan/event loop kept alive for the background task
        on = client.post("/api/pro/simulate", json={"on": True})
        assert on.status_code == 200 and on.json()["simulating"] is True
        off = client.post("/api/pro/simulate", json={"on": False})
        assert off.json()["simulating"] is False
