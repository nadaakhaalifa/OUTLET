#!/usr/bin/env bash
# Runs every StrykerJS config in the repo on Node 24 and prints a score table (ADR-0019).
#   bash tooling/mutation/run-all.sh            # all configs
#   bash tooling/mutation/run-all.sh ledger     # only configs whose path contains "ledger"
# Configs live next to the code they cover: packages/*/stryker*.mjs and apps/api/stryker.refunds.mjs.
set -u
# tree-kill (used by Stryker) calls `pgrep -P <pid>`. Homebrew's proctools ships a pgrep that IGNORES -P and
# lists every process, which makes tree-kill recurse until the process table is full (spawn EAGAIN).
# Always use the system pgrep first.
export PATH="/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/../.."
STRYKER=$(ls -d node_modules/.pnpm/@stryker-mutator+core*/node_modules/@stryker-mutator/core/bin/stryker.js | head -1)
FILTER="${1:-}"
OUT=reports/mutation-summary.md
mkdir -p reports
{ echo "# Mutation scores ($(date -u +%FT%TZ), node 24)"; echo; echo "| config | score | break | result |"; echo "|---|---|---|---|"; } > "$OUT"
fail=0
while IFS= read -r cfg; do
  [[ -n "$FILTER" && "$cfg" != *"$FILTER"* ]] && continue
  dir=$(dirname "$cfg"); file=$(basename "$cfg")
  brk=$(grep -oE "break: *[0-9]+" "$cfg" | head -1 | grep -oE "[0-9]+" || echo "?")
  echo ">>> $cfg"
  log=$(mktemp)
  # Sandboxes from an interrupted run would be collected as tests; clear them before and after (never a glob on "/").
  clean_sandboxes() { find "${dir:?}" -maxdepth 1 -type d -name '.stryker-tmp*' -exec rm -rf {} + 2>/dev/null; }
  clean_sandboxes
  ( cd "$dir" && npx -y node@24 "$OLDPWD/$STRYKER" run "$file" ) >"$log" 2>&1
  rc=$?
  clean_sandboxes
  score=$(grep -oE "All files *\| *[0-9.]+" "$log" | grep -oE "[0-9.]+$" | tail -1)
  [[ -z "$score" ]] && score="n/a"
  if [[ $rc -eq 0 ]]; then res="PASS"; else res="FAIL (exit $rc)"; fail=1; fi
  echo "| $cfg | $score | $brk | $res |" >> "$OUT"
  tail -n 4 "$log"
  rm -f "$log"
done < <(find packages apps -maxdepth 3 \( -name 'stryker*.mjs' -o -name 'stryker.config.*' \) -not -path '*/node_modules/*' | sort)
echo; cat "$OUT"
exit $fail
