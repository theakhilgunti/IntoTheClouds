#!/bin/bash
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/backend"

if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
fi

echo "Starting IntoTheClouds FastAPI backend on http://localhost:8000 ..."
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

