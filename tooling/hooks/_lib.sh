#!/usr/bin/env bash
# Shared helper: read a JSON field from stdin payload ($1 = jq path, e.g. .tool_input.command)
set -u
json_get() {
  # $1 = jq filter, $2 = payload
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$2" | jq -r "$1 // empty" 2>/dev/null
  else
    printf '%s' "$2" | python3 -c '
import sys, json
p = sys.argv[1].lstrip(".").split(".")
try:
    d = json.load(sys.stdin)
    for k in p: d = d[k]
    print(d if isinstance(d, str) else "")
except Exception:
    pass' "$1"
  fi
}
