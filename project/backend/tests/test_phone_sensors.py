import math
from starlette.testclient import TestClient
from app import main
from app.fusion.geo import clean_sensors, latlon_to_local

client = TestClient(main.app)


def test_latlon_to_local_axes():
    # ~111 m north of origin; map +y = north (offset 0)
    x, y = latlon_to_local(42.7298 + 0.001, -73.6789, 42.7298, -73.6789, 0.0)
    assert abs(x) < 0.01 and abs(y - 111.19) < 0.5
    # same move, but map +y points east (offset 90): north becomes -x
    x, y = latlon_to_local(42.7298 + 0.001, -73.6789, 42.7298, -73.6789, 90.0)
    assert abs(x + 111.19) < 0.5 and abs(y) < 0.5


def test_clean_sensors_drops_bad_values():
    s = clean_sensors({"gps": {"lat": 999, "lon": 1, "acc": 5}, "orient": {"alpha": float("nan"), "beta": 10, "evil": 1},
                       "gyro": "x", "accel": {"x": True, "y": 1.5}})
    assert "gps" not in s and s["orient"] == {"beta": 10.0} and "gyro" not in s and s["accel"] == {"y": 1.5}
    assert clean_sensors(None) == {} and clean_sensors([1]) == {}


def test_ws_records_sensors_and_api_reports_gps_usability():
    main.phone_state.update(latest={}, t=0.0, gps_origin=None, gps_local=None)
    main.phone_log.clear()
    main.pdr_state["offset"] = 0.0  # map +y = north
    pkt = {"compass_deg": 90.0, "sensors": {"gps": {"lat": 42.7, "lon": -73.6, "acc": 8.0},
                                            "orient": {"alpha": 1, "beta": 2, "gamma": 3, "compass": 90}}}
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json(pkt)
        pkt2 = {"sensors": {"gps": {"lat": 42.7 + 0.0001, "lon": -73.6, "acc": 9.0}}}
        ws.send_json(pkt2)
    r = client.get("/api/phone").json()
    assert r["gps_usable"] and r["samples"] == 2 and r["latest"]["orient"]["beta"] == 2.0
    assert math.isclose(r["gps_local"]["y"], 11.1, abs_tol=0.5) and abs(r["gps_local"]["x"]) < 0.5
    assert len(client.get("/api/phone/log?last=1").json()) == 1


def test_poor_gps_is_not_usable_and_not_used_as_origin():
    main.phone_state.update(latest={}, t=0.0, gps_origin=None, gps_local=None)
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json({"sensors": {"gps": {"lat": 42.7, "lon": -73.6, "acc": 60.0}}})
    r = client.get("/api/phone").json()
    assert not r["gps_usable"] and r["gps_origin"] is None and r["gps_local"] is None


def test_walker_page_streams_sensors():
    t = client.get("/walker").text
    assert "watchPosition" in t and "sensors" in t


def test_step_events_logged_with_peak():
    main.phone_log.clear()
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json({"compass_deg": 10.0, "step": True, "step_length_m": 0.7, "peak": 2.34, "threshold": 1.6})
        ws.send_json({"compass_deg": 10.0, "step": True, "step_length_m": 0.7, "peak": "x"})
    steps = [e for e in main.phone_log if e.get("step")]
    assert len(steps) == 1 and steps[0]["peak"] == 2.34 and steps[0]["threshold"] == 1.6
