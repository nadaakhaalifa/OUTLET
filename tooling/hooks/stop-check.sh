#!/usr/bin/env bash
# Stop hook: typecheck, depcruise, related tests. Exit 2 feeds failures back to Claude.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="${CLAUDE_PROJECT_DIR:-$(cd "$here/../.." && pwd)}"
cd "$root" || exit 0
payload="$(cat 2>/dev/null || true)"
# Avoid loops: when Claude is already continuing because of this hook, do not re-run.
if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi
[ -f package.json ] || exit 0
command -v pnpm >/dev/null 2>&1 || exit 0
has_script() { grep -Eq "\"$1\"[[:space:]]*:" package.json; }
fail=0; out=""; summary=""
run() { # name, cmd...
  n="$1"; shift
  log="$("$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then summary="$summary\n  ok   $n"; else
    fail=1; summary="$summary\n  FAIL $n"; out="$out\n--- $n ---\n$(printf '%s' "$log" | tail -n 25)"; fi
}
has_script typecheck && run typecheck pnpm -s typecheck
has_script depcruise && run depcruise pnpm -s depcruise
if has_script test || [ -x node_modules/.bin/vitest ]; then
  changed="$( (git diff --name-only HEAD; git ls-files --others --exclude-standard) 2>/dev/null | grep -E '\.(ts|tsx)$' | tr '\n' ' ')"
  # shellcheck disable=SC2086
  [ -n "$changed" ] && [ -x node_modules/.bin/vitest ] && run "vitest related" pnpm -s vitest related --run --passWithNoTests $changed
fi
printf 'stop-check:%b\n' "$summary" >&2
if [ $fail -ne 0 ]; then printf 'stop-check failed, fix before finishing:%b\n' "$out" >&2; exit 2; fi
exit 0
