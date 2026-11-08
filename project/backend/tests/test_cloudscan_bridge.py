"""CS-02 bridge tests. Only loopback mock servers are used; nothing leaves the machine."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "laptop_client"))
import cloudscan_bridge as cb  # noqa: E402

POSTED = []


def _trail(n):
    return [{"x": i * 0.5, "y": i * 0.25, "t": 1000.0 + i} for i in range(n)]


def _serve(handler_cls):
    srv = HTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}"


def _mapper(trail):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            pkt = {"type": "telemetry", "timestamp": 1.0, "trail": trail}
            self.wfile.write(f"data: {json.dumps(pkt)}\n\n".encode())

        def log_message(self, *a):
            pass

    return _serve(H)


def _cloudscan():
    POSTED.clear()

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            POSTED.append((self.path, json.loads(body)))
            self.send_response(201)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    return _serve(H)


def test_payload_shape_from_mapper_stream():
    srv, url = _mapper(_trail(5))
    try:
        store = cb.collect_trail(url, finish=True)
    finally:
        srv.shutdown()
    payload = cb.build_payload(store, "rig")
    assert payload["deviceId"] == "rig"
    assert len(payload["breadcrumbs"]) == 5
    assert set(payload["breadcrumbs"][0]) == {"x", "y", "z"}
    assert payload["breadcrumbs"][0]["z"] == 1.0
    assert payload["breadcrumbs"][2]["x"] == 1.0
    assert payload["startedAt"].endswith("Z") and payload["hazards"] == []


def test_too_short_walk_returns_nothing():
    assert cb.build_payload({}) is None
    assert cb.build_payload({1.0: (0.0, 0.0)}) is None


def test_remote_url_refused_without_flag(monkeypatch):
    monkeypatch.setenv("CLOUDSCAN_URL", "https://example.invalid")
    assert cb.post_payload({"a": 1}, "https://example.invalid") is False
    assert cb.main(["--finish"]) == 2
    assert cb.is_local_url("http://127.0.0.1:3000") and cb.is_local_url("http://[::1]:3000")
    assert cb.is_local_url("http://localhost:3000")
    assert not cb.is_local_url("https://example.invalid")


def test_server_down_does_not_crash():
    payload = cb.build_payload({1.0: (0, 0), 2.0: (1, 1)})
    assert cb.post_payload(payload, "http://127.0.0.1:9") is False


def test_posts_to_local_mock_and_dry_run_posts_nothing(monkeypatch, capsys):
    msrv, murl = _mapper(_trail(4))
    csrv, curl = _cloudscan()
    try:
        monkeypatch.setenv("CLOUDSCAN_URL", curl)
        assert cb.main(["--mapper-url", murl, "--finish", "--dry-run"]) == 0
        assert POSTED == []
        assert json.loads(capsys.readouterr().out)["breadcrumbs"]
        assert cb.main(["--mapper-url", murl, "--finish"]) == 0
        assert len(POSTED) == 1 and POSTED[0][0] == "/api/explorations"
    finally:
        msrv.shutdown()
        csrv.shutdown()


def test_mapper_down_handled(monkeypatch):
    monkeypatch.setenv("CLOUDSCAN_URL", "http://127.0.0.1:9")
    assert cb.main(["--mapper-url", "http://127.0.0.1:9", "--finish", "--dry-run"]) == 1
