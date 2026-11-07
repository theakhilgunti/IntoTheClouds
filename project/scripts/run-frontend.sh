#!/bin/bash
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/frontend"

echo "Starting IntoTheClouds 3D Dashboard frontend on http://localhost:5173 ..."
npm run dev

