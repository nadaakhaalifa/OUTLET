#!/usr/bin/env bash
# Runs the bg-removal sidecar locally for development (macOS/Linux). Idempotent: re-running reuses the venv and model.
# Local only: models are fetched unpinned (ALLOW_UNPINNED_MODELS=1) and the measured hash is printed for review.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SVC="$ROOT/apps/ml-services/bg-removal"
HOST=127.0.0.1
PORT="${SIDECAR_PORT:-8099}"
cd "$SVC"

if curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  echo "Sidecar already running at http://$HOST:$PORT"
  echo "Set EXPO_PUBLIC_DEV_CUTOUT_URL=http://$HOST:$PORT in apps/mobile/.env.local, then restart Expo (npx expo start -c)."
  exit 0
fi

pick_python() {
  local best="" bestminor=0 c v
  for c in python3.13 python3.12 python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    v="$("$c" -c 'import sys; print(sys.version_info.major, sys.version_info.minor)')"
    set -- $v
    if [ "$1" -eq 3 ] && [ "$2" -ge 12 ] && [ "$2" -lt 14 ] && [ "$2" -gt "$bestminor" ]; then best="$c"; bestminor="$2"; fi
  done
  [ -n "$best" ] || { echo "Need Python 3.12 or 3.13 (3.14 is not supported yet)." >&2; exit 1; }
  echo "$best"
}

if [ ! -x .venv/bin/python ]; then
  PY="$(pick_python)"
  echo "Creating .venv with $("$PY" --version)"
  "$PY" -m venv .venv
fi
PIP=(.venv/bin/python -m pip --default-timeout=180 --retries 8)
if ! .venv/bin/python -c 'import fastapi, uvicorn, rembg, onnxruntime, numpy, scipy, PIL' >/dev/null 2>&1; then
  echo "Installing dependencies (first run takes a few minutes)"
  "${PIP[@]}" install --upgrade pip
  "${PIP[@]}" install -r requirements.txt
fi

if [ ! -s .models/u2netp.onnx ]; then
  echo "Fetching u2netp (unpinned, local dev only)"
  ALLOW_UNPINNED_MODELS=1 .venv/bin/python scripts/fetch_models.py --dest .models --models u2netp
fi
if command -v shasum >/dev/null 2>&1; then
  echo "u2netp.onnx sha256: $(shasum -a 256 .models/u2netp.onnx | cut -d' ' -f1)"
fi

echo
echo "Starting sidecar on http://$HOST:$PORT  (Ctrl-C to stop)"
echo "In apps/mobile/.env.local set:  EXPO_PUBLIC_DEV_CUTOUT_URL=http://$HOST:$PORT"
echo "then restart Expo with: npx expo start -c"
echo
U2NET_HOME="$SVC/.models" BG_DEFAULT_MODEL=u2netp exec .venv/bin/python -m uvicorn app.main:factory --factory --host "$HOST" --port "$PORT"
