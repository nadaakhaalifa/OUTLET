#!/usr/bin/env bash
# Usage: tooling/e2e/run.sh seller|admin|shopper [playwright args]
# Boots API (DEV_FIXTURES) + fixture gateway + ONE web app, runs Playwright (1 worker), stops by exact PID.
set -u
APP="${1:?seller|admin|shopper}"; shift || true
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${E2E_LOG_DIR:-/tmp}"; PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; for port in 3917 3918 ${PORT_APP:-}; do for p in $(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null); do kill "$p" 2>/dev/null; done; done; }
for port in 3917 3918 3001 3002 3003; do lsof -ti tcp:$port -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $port busy; refusing to start"; exit 1; }; done
trap cleanup EXIT
cd "$ROOT/apps/api" && [ -f dist/apps/api/src/main.js ] || node build/build.mjs
PORT=3917 DEV_FIXTURES=true node "$ROOT/apps/api/dist/apps/api/src/main.js" >"$LOG/e2e-api.log" 2>&1 & PIDS+=($!)
node "$ROOT/tooling/e2e/gateway.mjs" >"$LOG/e2e-gw.log" 2>&1 & PIDS+=($!)
if [ "$APP" = seller ]; then PORT_APP=3001; export SELLER_API_BASE_URL=http://127.0.0.1:3918
elif [ "$APP" = shopper ]; then PORT_APP=3003; export SHOPPER_API_BASE_URL=http://127.0.0.1:3918 SHOPPER_SITE_URL=http://localhost:3003 SHOPPER_IMAGE_ORIGINS=""
else PORT_APP=3002; export ADMIN_API_BASE_URL=http://127.0.0.1:3918; fi
NEXT="$ROOT/apps/$APP-web/node_modules/.bin/next"
cd "$ROOT/apps/$APP-web"
if [ "${E2E_PROD:-0}" = 1 ]; then
  # A leaked NODE_ENV=development makes Next prerender with the dev React build and crash on /_global-error.
  NODE_ENV=production "$NEXT" build >"$LOG/e2e-build.log" 2>&1 || { echo build failed; exit 1; }
  NODE_ENV=production "$NEXT" start -p $PORT_APP >"$LOG/e2e-$APP.log" 2>&1 & PIDS+=($!)
else
  "$NEXT" dev -p $PORT_APP >"$LOG/e2e-$APP.log" 2>&1 & PIDS+=($!)
fi
for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:3917/v1/health && curl -s -o /dev/null http://127.0.0.1:$PORT_APP/$([ "$APP" = shopper ] && echo ar || echo login) && break; sleep 2; done
cd "$ROOT" && E2E_APP=$APP E2E_BASE=http://localhost:$PORT_APP node_modules/.bin/playwright test -c tooling/e2e/playwright.config.ts "$@"
