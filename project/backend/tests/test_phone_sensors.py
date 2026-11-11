from starlette.testclient import TestClient
from app import main
from app.fusion.geo import clean_sensors

client = TestClient(main.app)


def test_clean_sensors_drops_bad_values():
    s = clean_sensors({"orient": {"alpha": float("nan"), "beta": 10, "evil": 1},
                       "gyro": "x", "accel": {"x": True, "y": 1.5}})
    assert s["orient"] == {"beta": 10.0} and "gyro" not in s and s["accel"] == {"y": 1.5}
    assert clean_sensors(None) == {} and clean_sensors([1]) == {}


def test_clean_sensors_never_keeps_location():
    """Privacy: any location-style key from an old or modified client is dropped, whatever its shape."""
    raw = {"gps": {"lat": 42.7, "lon": -73.6, "acc": 5}, "location": {"lat": 1, "lon": 2},
           "coords": {"latitude": 1, "longitude": 2}, "lat": 42.7, "lon": -73.6,
           "orient": {"beta": 10, "latitude": 42.7}, "gyro": {"alpha": 1, "lon": -73.6}}
    s = clean_sensors(raw)
    assert set(s) == {"orient", "gyro"}
    assert s["orient"] == {"beta": 10.0} and s["gyro"] == {"alpha": 1.0}


def test_ws_records_motion_sensors_and_drops_gps():
    main.phone_state.update(latest={}, t=0.0)
    main.phone_log.clear()
    pkt = {"compass_deg": 90.0, "sensors": {"gps": {"lat": 42.7, "lon": -73.6, "acc": 8.0},
                                            "orient": {"alpha": 1, "beta": 2, "gamma": 3, "compass": 90}}}
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json(pkt)
        ws.send_json({"sensors": {"gps": {"lat": 42.7 + 0.0001, "lon": -73.6, "acc": 9.0}}})  # GPS only: ignored
    r = client.get("/api/phone").json()
    assert r["samples"] == 1 and r["latest"]["orient"]["beta"] == 2.0
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield str(k).lower()
                yield from walk(v)
        elif isinstance(o, (list, tuple)):
            for v in o:
                yield from walk(v)
        else:
            yield o
    seen = list(walk([r, client.get("/api/phone/log?last=100").json(), main.phone_state, main.phone_log]))
    for bad in ("gps", "lat", "lon", "latitude", "longitude", "acc", "alt"):
        assert bad not in seen, bad
    assert 42.7 not in seen and -73.6 not in seen
    for key in ("gps_usable", "gps_origin", "gps_local"):
        assert key not in r


def test_walker_page_streams_sensors_without_location():
    t = client.get("/walker").text
    assert "sensors" in t and "devicemotion" in t
    for word in ("geolocation", "watchPosition", "getCurrentPosition", "latitude", "longitude"):
        assert word not in t, word


def test_step_events_logged_with_peak():
    main.phone_log.clear()
    with client.websocket_connect("/ws/pdr") as ws:
        ws.send_json({"compass_deg": 10.0, "step": True, "step_length_m": 0.7, "peak": 2.34, "threshold": 1.6})
        ws.send_json({"compass_deg": 10.0, "step": True, "step_length_m": 0.7, "peak": "x"})
    steps = [e for e in main.phone_log if e.get("step")]
    assert len(steps) == 1 and steps[0]["peak"] == 2.34 and steps[0]["threshold"] == 1.6
