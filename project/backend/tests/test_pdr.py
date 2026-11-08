import math
from starlette.testclient import TestClient
from app import main
from app.fusion.heading import compass_to_map_heading, offset_from_plus_x

client = TestClient(main.app)


def test_alignment_makes_pointed_direction_plus_x():
    off = offset_from_plus_x(200.0)
    assert math.isclose(compass_to_map_heading(200.0, off), 0.0, abs_tol=1e-9)
    # turning 90 deg clockwise (to compass 290) is -90 deg math, i.e. toward -y
    assert math.isclose(compass_to_map_heading(290.0, off), 270.0, abs_tol=1e-9)


def test_phone_steps_move_the_walker_along_plus_x():
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json({"type": "align", "compass_deg": 120.0})
        ws.send_json({"type": "start", "x": 1.0, "y": 2.0})
        for _ in range(6):
            ws.send_json({"compass_deg": 120.0, "step": True, "step_length_m": 0.7})
    assert main.current_state.x - 1.0 > 3.5  # 6 steps x 0.7 m = 4.2 m
    assert abs(main.current_state.y - 2.0) < 0.6
    assert main.pdr_state["aligned"]


def test_bad_messages_do_not_crash_or_move():
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_text("not json")
        ws.send_json([1, 2])
        ws.send_json({"compass_deg": "north", "step": True, "step_length_m": "x"})
        ws.send_json({"type": "start", "x": float("nan"), "y": 1})
    assert math.isfinite(main.current_state.x)


def test_walker_page_served():
    r = client.get("/walker")
    assert r.status_code == 200 and "/ws/pdr" in r.text
