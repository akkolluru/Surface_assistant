#!/usr/bin/env bash
set -euo pipefail

# Launches the full Surface Assistant Kiosk + Mac Hardware Simulator locally.
# Usage: ./scripts/simulate-mac.sh [--no-open]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

[[ -f .env ]] || cp .env.example .env
[[ -f config.yaml ]] || cp config.example.yaml config.yaml

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "Creating Python .venv and installing daemon requirements..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r daemon/requirements-dev.txt
fi

if [[ ! -d frontend/node_modules ]]; then
  echo "Installing frontend npm dependencies..."
  (cd frontend && npm ci)
fi

echo "Building production frontend bundle..."
(cd frontend && npm run build)

OPEN_BROWSER=true
if [[ "${1:-}" == "--no-open" ]]; then
  OPEN_BROWSER=false
fi

if [[ "${OPEN_BROWSER}" == "true" ]] && command -v open >/dev/null 2>&1; then
  (
    sleep 1.5
    open "http://127.0.0.1:8000"
    open "http://127.0.0.1:8000/sim"
  ) &
fi

echo ""
echo "Surface Assistant Mac Simulation running:"
echo "  Kiosk Hub UI:        http://127.0.0.1:8000"
echo "  Hardware Simulator:  http://127.0.0.1:8000/sim"
echo "Press Ctrl+C to stop."
echo ""

export HARDWARE_BACKEND=mock
exec .venv/bin/uvicorn daemon.main:app --host 127.0.0.1 --port 8000
