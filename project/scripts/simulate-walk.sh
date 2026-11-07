#!/bin/bash
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Starting SAR Firefighter Walk Simulator -> ws://127.0.0.1:8000/ws/telemetry ..."
"$ROOT_DIR/backend/.venv/bin/python" "$ROOT_DIR/pi_client/simulate_walk.py"

