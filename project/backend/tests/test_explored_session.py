from app.explored_session import build_exploration_payload


def test_payload_requires_two_points():
    assert build_exploration_payload([], [], "rig", 0, 1) is None
    assert build_exploration_payload([{"x": 0, "y": 0}], [], "rig", 0, 1) is None


def test_payload_shape():
    payload = build_exploration_payload(
        [{"x": 1, "y": 2, "z": 1}, {"x": 3, "y": 4, "z": 1}],
        [{"id": "h", "hazard_type": "fire", "x": 1, "y": 2, "z": 1, "note": "n", "timestamp": 1}],
        "rig",
        0,
        10,
    )
    assert payload is not None
    assert payload["buildingId"] == "explored"
    assert payload["deviceId"] == "rig"
    assert payload["address"] == "Explored structure"
    assert len(payload["breadcrumbs"]) == 2
    assert payload["breadcrumbs"][1]["z"] == 1.0
    assert payload["startedAt"].endswith("Z")
    assert payload["endedAt"].endswith("Z")
    assert payload["hazards"][0]["hazard_type"] == "fire"
