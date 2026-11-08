#!/usr/bin/env bash
# Destroys all local data (volumes) and re-runs init scripts.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down -v
docker compose up -d --wait
