from starlette.testclient import TestClient
from app import main

client = TestClient(main.app)


def post(action, **kw):
    return client.post("/api/record", json={"action": action, **kw})


def test_route_is_l_shape_ending_at_a3():
    assert main.build_route(1) == ["A2", "A1", "A3"]
    assert main.build_route(2) == ["A2", "A1", "A3", "A1", "A2", "A1", "A3"]
    for n in (1, 3, 5):
        r = main.build_route(n)
        assert r[0] == "A2" and r[-1] == "A3" and len(r) == 3 + 4 * (n - 1)


def test_full_session_flow():
    post("stop")
    d = post("start", rounds=1).json()
    assert d["active"] and d["route"] == ["A2", "A1", "A3"] and d["n_marks"] == 1
    assert d["marks"][0]["type"] == "arrive" and d["marks"][0]["label"] == "A2"
    assert d["button"] == "Leaving A2" and d["next_label"] == "A1"
    d = post("mark").json()
    assert d["phase"] == "walking" and d["marks"][-1] == {**d["marks"][-1], "type": "depart", "label": "A2"}
    assert d["button"] == "Arrived at A1"
    d = post("mark").json()
    assert d["idx"] == 1 and d["marks"][-1]["type"] == "arrive" and d["marks"][-1]["label"] == "A1"
    post("mark")
    d = post("mark").json()
    assert d["idx"] == 2 and d["done"] and d["button"] == "" and d["n_marks"] == 5
    assert post("mark").status_code == 409                      # route finished
    d = post("stop").json()
    assert not d["active"] and d["stopped_t"] and d["n_marks"] == 5


def test_undo_walks_state_back():
    post("start", rounds=1)
    post("mark"); post("mark")                                  # left A2, arrived A1
    d = post("undo").json()
    assert d["idx"] == 0 and d["phase"] == "walking" and d["n_marks"] == 2
    d = post("undo").json()
    assert d["phase"] == "at" and d["n_marks"] == 1
    assert post("undo").status_code == 409                      # the start tap cannot be undone
    post("stop")


def test_rejects_when_not_collecting_and_bad_input():
    post("stop")
    assert post("mark").status_code == 409
    assert post("undo").status_code == 409
    post("start", rounds=1)
    assert post("bogus").status_code == 422
    assert post("start", rounds=0).status_code == 422
    assert post("start", rounds=99).status_code == 422
    post("stop")


def test_session_state_carries_no_location():
    d = post("start", rounds=1).json()
    post("stop")
    keys = set(d) | {k for m in d["marks"] for k in m}
    assert not keys & {"gps", "lat", "lon", "latitude", "longitude", "location"}


def test_walker_page_has_collect_controls():
    t = client.get("/walker").text
    assert "recToggle" in t and "/api/record" in t
    for word in ("geolocation", "watchPosition", "latitude"):
        assert word not in t
