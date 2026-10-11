#!/usr/bin/env bash
# Usage: .maestro/run.sh <en|ar> <device-name> [tags]   e.g. .maestro/run.sh ar "iPhone 15" smoke
set -euo pipefail
cd "$(dirname "$0")"
LOCALE_ARG="${1:?locale en|ar}"; DEVICE_ARG="${2:?device name}"; TAGS="${3:-smoke}"
args=()
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  args+=(-e "$line")
done < <(cat "env/${LOCALE_ARG}.env" env/fixtures.env)
args+=(-e "DEVICE=${DEVICE_ARG// /-}")
exec maestro test "${args[@]}" --include-tags="$TAGS" flows
