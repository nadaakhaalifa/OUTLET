#!/usr/bin/env bash
# Tests for pre-tool-guard.sh. Usage: tooling/hooks/test-hooks.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
pass=0; failn=0
t() { # expect(0|2) description command
  exp="$1"; desc="$2"; cmd="$3"
  payload="$(python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$cmd")"
  printf '%s' "$payload" | "$here/pre-tool-guard.sh" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$exp" ]; then pass=$((pass+1)); echo "PASS  $desc (exit $rc)"; else failn=$((failn+1)); echo "FAIL  $desc (exit $rc, want $exp)"; fi
}
t 2 "force push blocked" "git push --force origin main"
t 2 "short -f push blocked" "git push -f origin feat"
t 0 "normal push allowed" "git push origin feat/x"
t 2 "cat .env blocked" "cat .env.local"
t 0 "cat .env.example allowed" "cat .env.example"
t 2 "psql prod host blocked" "psql -h db.prod.example.com -c 'select 1'"
t 2 "DROP TABLE on remote url blocked" "psql postgres://u:p@db.example.com/app -c 'DROP TABLE users'"
t 0 "psql localhost allowed" "psql -h localhost -c 'select 1'"
t 2 "DELETE FROM no WHERE remote blocked" "psql -h 10.0.0.5 -c 'DELETE FROM orders'"
t 2 "rm -rf outside scratchpad blocked" "rm -rf /Users/x/project"
t 0 "rm -rf in claude tmp allowed" "rm -rf /private/tmp/claude-501/abc/scratchpad/out"
t 0 "plain ls allowed" "ls -la"
echo "passed=$pass failed=$failn"
[ "$failn" = 0 ]
