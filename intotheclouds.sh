#!/bin/bash
# IntoTheClouds one-command launcher (macOS).
#   ./intotheclouds.sh setup    create venvs + install deps (done automatically on first start)
#   ./intotheclouds.sh start    phone backend (HTTPS :8443) + mapper dashboard (:8899)
#   ./intotheclouds.sh stop | restart | status | link | logs
# Beacon positions/calibration live in anchors_config.json and are never touched here.
set -u
R="$(cd "$(dirname "$0")" && pwd)"
RUN="$R/.run"; TLS="$RUN/tls"; mkdir -p "$TLS"
BVENV="$R/project/backend/.venv"; MVENV="$R/project/laptop_client/.venv"
BACKEND_PORT="${BACKEND_PORT:-8443}"; MAPPER_PORT="${MAPPER_PORT:-8899}"

ips() { for i in $(networksetup -listallhardwareports 2>/dev/null | awk '/Wi-Fi|AirPort/{getline; print $2}') en0; do ipconfig getifaddr "$i" 2>/dev/null; done | awk 'NF && !s[$0]++'; }

setup() {
  PY=""; for c in python3.13 python3.12 python3.11 python3.10; do command -v "$c" >/dev/null && { PY="$(command -v "$c")"; break; }; done
  [ -n "$PY" ] || { echo "Need Python 3.10+ (brew install python@3.12). Apple's 3.9 can't build pyobjc."; exit 1; }
  [ -x "$BVENV/bin/python" ] || { echo "Creating backend venv..."; "$PY" -m venv "$BVENV" && "$BVENV/bin/pip" -q install -r "$R/project/backend/requirements.txt" || { rm -rf "$BVENV"; echo "backend install failed"; exit 1; }; }
  [ -x "$MVENV/bin/python" ] || { echo "Creating mapper venv..."; "$PY" -m venv "$MVENV" && "$MVENV/bin/pip" -q install -r "$R/project/laptop_client/requirements-mac.txt" || { rm -rf "$MVENV"; echo "mapper install failed"; exit 1; }; }
  "$MVENV/bin/python" -c "import CoreWLAN" 2>/dev/null || echo "WARN: CoreWLAN missing in mapper venv (pip install pyobjc-framework-CoreWLAN); mapper can only run --mock"
}

cert() {  # self-signed cert listing every current IP, so the iPhone accepts the address
  local san="IP:127.0.0.1,IP:::1,DNS:localhost"
  for a in $(ips); do san="$san,IP:$a"; done
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=IntoTheClouds" \
    -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -addext "subjectAltName=$san" 2>/dev/null
}

stop() {
  pkill -f "wifi_2d_grid_mapper.py" 2>/dev/null; pkill -f "uvicorn app.main:app" 2>/dev/null; sleep 1; echo "stopped"
}

link() {
  local ip; ip="$(ips | head -1)"
  [ -n "$ip" ] && echo "WALKER LINK (open on the iPhone): https://$ip:$BACKEND_PORT/walker" || echo "No Wi-Fi address - join the FireBeacon hotspot first."
  echo "DASHBOARD: http://127.0.0.1:$MAPPER_PORT"
}

start() {
  setup; stop; cert
  (cd "$R/project/backend" && nohup "$BVENV/bin/python" -m uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" \
     --ssl-certfile "$TLS/cert.pem" --ssl-keyfile "$TLS/key.pem" > "$RUN/backend.log" 2>&1 &)
  (cd "$R" && nohup "$MVENV/bin/python" -u wifi_2d_grid_mapper.py --no-browser --port "$MAPPER_PORT" \
     --phone-url "https://127.0.0.1:$BACKEND_PORT" "$@" > "$RUN/mapper.log" 2>&1 &)
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$MAPPER_PORT/api/calib_status" && break; sleep 1; done
  status; link
  [ -z "${NO_OPEN:-}" ] && open "http://127.0.0.1:$MAPPER_PORT" 2>/dev/null
  echo "On the iPhone: Show Details > visit website > Start > allow Motion. Keep screen on, Auto-Lock off."
}

status() {
  curl -sk -o /dev/null -w "backend  :$BACKEND_PORT  HTTP %{http_code}\n" "https://127.0.0.1:$BACKEND_PORT/walker" || echo "backend  DOWN"
  curl -s  -o /dev/null -w "mapper   :$MAPPER_PORT  HTTP %{http_code}\n" "http://127.0.0.1:$MAPPER_PORT/api/calib_status" || echo "mapper   DOWN"
  curl -sk "https://127.0.0.1:$BACKEND_PORT/api/phone" 2>/dev/null | "$BVENV/bin/python" -c "import sys,json
try: d=json.load(sys.stdin); print('phone    age_s=%s samples=%s'%(d.get('age_s'),d.get('samples')))
except Exception: print('phone    (no data)')" 2>/dev/null
}

case "${1:-start}" in
  setup) setup;; start) shift 2>/dev/null; start "$@";; stop) stop;; restart) stop; start;;
  status) status;; link) link;; logs) tail -n 40 "$RUN/backend.log" "$RUN/mapper.log";;
  *) echo "usage: $0 {setup|start|stop|restart|status|link|logs}"; exit 1;;
esac
