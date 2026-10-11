#!/usr/bin/env bash
# Infra verification runner: terraform fmt/validate, promtool check/test, conftest verify/test.
# Usage: tooling/infra/verify.sh [repo-root]   (defaults to the repo containing this script)
# Exits non-zero if any step fails. No cloud credentials needed (validate uses -backend=false).
set -u
ROOT="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
cd "$ROOT" || exit 2
# Share downloaded providers across the three environments (the AWS provider is large).
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
declare -a NAMES RESULTS
fail=0
run() { # name, command...
  local name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@"; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); fail=1; fi
  NAMES+=("$name")
}

TF=infra/terraform
run "terraform fmt -check -recursive" terraform -chdir="$TF" fmt -check -recursive
for env in dev staging prod; do
  d="$TF/environments/$env"
  [ -d "$d" ] || continue
  # Isolated data dir so init never touches the working tree's .terraform.
  validate_env() {
    local dd; dd="$(mktemp -d)"
    TF_DATA_DIR="$dd" terraform -chdir="$1" init -backend=false -input=false -no-color >/dev/null 2>&1 \
      && TF_DATA_DIR="$dd" terraform -chdir="$1" validate -no-color
    local rc=$?; rm -rf "$dd"; return $rc
  }
  run "terraform validate ($env)" validate_env "$d"
done

shopt -s nullglob
rules=(infra/observability/prometheus/rules/*.yaml)
tests=(infra/observability/prometheus/tests/*.test.yaml)
run "promtool check rules (${#rules[@]} files)" promtool check rules "${rules[@]}"
for t in "${tests[@]}"; do run "promtool test rules $(basename "$t")" promtool test rules "$t"; done
# every rule file must have a test file
missing=0
for r in "${rules[@]}"; do
  base="$(basename "$r" .rules.yaml)"; base="${base#slo-}"
  [ -f "infra/observability/prometheus/tests/$base.test.yaml" ] || { echo "no test for $r"; missing=1; }
done
run "every rule file has a test" test "$missing" -eq 0

run "conftest verify (rego unit tests)" conftest verify --policy "$TF/policy"
# Only *.tf files: the hcl2 parser chokes on non-HCL files such as .checkov.yaml in the tree.
conftest_src() {
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$TF" -name '*.tf' -not -path '*/.terraform/*')
  conftest test "${files[@]}" --policy "$TF/policy" --parser hcl2
}
run "conftest test (${TF} *.tf source)" conftest_src

printf '\n=== SUMMARY\n'
for i in "${!NAMES[@]}"; do printf '%-6s %s\n' "${RESULTS[$i]}" "${NAMES[$i]}"; done
if [ "$fail" -eq 0 ]; then echo "ALL ${#NAMES[@]} STEPS PASSED"; else echo "VERIFICATION FAILED"; fi
exit "$fail"
