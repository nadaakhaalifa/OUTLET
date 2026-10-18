#!/usr/bin/env bash
# Usage: .maestro/run.sh <en|ar> <device-name> [tags] [--device <udid>]   e.g. .maestro/run.sh ar "iPhone 15" smoke
#   iPad: .maestro/run.sh en "iPad Pro 13" ipad --device C2256CDB-5411-4FE9-AC02-A2B92026D838
set -euo pipefail
cd "$(dirname "$0")"
LOCALE_ARG="${1:?locale en|ar}"; DEVICE_ARG="${2:?device name}"; TAGS="${3:-smoke}"
UDID=""
if [ "${4:-}" = "--device" ]; then UDID="${5:?udid after --device}"; fi
args=()
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  args+=(-e "$line")
done < <(cat "env/${LOCALE_ARG}.env" env/fixtures.env)
args+=(-e "DEVICE=${DEVICE_ARG// /-}")
if [ -n "$UDID" ]; then exec maestro --device "$UDID" test "${args[@]}" --include-tags="$TAGS" flows; fi
exec maestro test "${args[@]}" --include-tags="$TAGS" flows
