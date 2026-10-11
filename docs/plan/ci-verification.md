# CI verification (static only)

No workflow has been executed on GitHub runners. What was checked locally:

* `node .github/scripts/validate-workflows.mjs --require-sha`: "workflow lint: OK" (50 SHA-pinned, 1 version tag).
* YAML parse of all four workflow files with the `yaml` package: OK.
* actionlint 1.7.12 (release binary, run on ci/codeql/release/sbom): no findings. Note: shellcheck integration was not verified.

Not verified: semgrep ruleset findings, checkov skip list, `migrations-pg16` on ubuntu-24.04 (script defaults to Postgres.app path and relies on `PG_BIN`), coverage job duration, release job (no Dockerfile).
Possible first-run failures to triage: semgrep findings on existing code, and the checkov skip list (see `infra/terraform/.checkov.yaml`).
