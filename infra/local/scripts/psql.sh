#!/usr/bin/env bash
# Usage: psql.sh [direct|app|checkout|auth|worker] [psql args]   (default: direct, as migrator)
set -euo pipefail
target="${1:-direct}"; shift || true
case "$target" in
  direct)   url="postgresql://outlet_migrator:migrator_local_only@127.0.0.1:5432/outlet_dev" ;;
  app)      url="postgresql://outlet_app:app_local_only@127.0.0.1:6432/outlet_catalog" ;;
  checkout) url="postgresql://outlet_app:app_local_only@127.0.0.1:6432/outlet_checkout" ;;
  auth)     url="postgresql://outlet_auth:auth_local_only@127.0.0.1:6432/outlet_auth" ;;
  worker)   url="postgresql://outlet_worker:worker_local_only@127.0.0.1:6432/outlet_worker" ;;
  *) echo "unknown target $target" >&2; exit 2 ;;
esac
exec psql "$url" "$@"
