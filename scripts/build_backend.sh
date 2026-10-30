#!/usr/bin/env bash
# Bundle the FastAPI replay server into a single executable for Electron.
# Output: backend/dist/backtester-backend
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [[ ! -x "$ROOT/backend/.venv/bin/python" ]]; then
  echo "backend/.venv not found. Create it with:" >&2
  echo "  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller" >&2
  exit 1
fi

"$ROOT/backend/.venv/bin/python" -m pip install --quiet pyinstaller
cd backend

"$ROOT/backend/.venv/bin/pyinstaller" \
  --noconfirm \
  --clean \
  --onefile \
  --name backtester-backend \
  --collect-submodules uvicorn \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  app/main.py

echo
echo "Built: backend/dist/backtester-backend"
echo "Set BT_FRONTEND_DIST to frontend/dist when running it outside Electron."
