# CI workflows

Complements `ci-cd.md`. Workflows live in `.github/workflows/`. `copy-lint.yml` and `dora.yml` are owned elsewhere.

## Rules applied to every workflow
* Third-party actions are pinned to a full commit SHA with the version in a trailing comment. Renovate (`helpers:pinGitHubActionDigests`) keeps them current. `node .github/scripts/validate-workflows.mjs --require-sha` enforces it in CI.
* `permissions: contents: read` at workflow level. Elevated scopes are job-scoped only (`security-events: write` for CodeQL; `packages: write`, `id-token: write` for release).
* Every workflow has a `concurrency` group and every job a `timeout-minutes`. Every checkout sets `persist-credentials: false`.
* Tool versions fetched at run time are pinned: semgrep 1.180.0, cdxgen 12.8.5, conftest 0.56.0. Renovate does not track these env-var pins, so bump them by hand.

## Jobs in `ci.yml`
| Job | Gate |
|---|---|
| verify | `pnpm typecheck`, `pnpm lint`, `pnpm test` |
| boundaries | `pnpm depcruise` on Node 24 (`.nvmrc`) |
| coverage | `node tooling/coverage/check.mjs` (domain >= 90 percent, ratchet elsewhere) |
| i18n-parity | checker tests, `pnpm i18n-check` |
| secret-scan | gitleaks with `.github/gitleaks.toml` |
| semgrep | SAST, registry rulesets, fails on findings |
| dependency-audit | `pnpm audit --audit-level high --prod`, OSV scanner |
| iac | terraform fmt/validate, conftest, checkov |
| contracts | OpenAPI validate, privacy inventory tests and check, observability, workflow lint |
| migrations-pg16 | `tooling/db/run-on-postgres16.sh` (runs `pg16-verify.mjs`) on a throw-away PG16 cluster |
| mutation | Stryker, on push or label `run-mutation` |
| inventory-concurrency | SKIP LOCKED storm on real PG16 |

## Supply chain
* `sbom.yml`: CycloneDX 1.6 from the lockfile.
* `release.yml`: image build, keyless cosign signature, CycloneDX attestation, SLSA generic container provenance, verify job. Skipped until `vars.CONTAINER_REGISTRY` is set and `apps/api/Dockerfile` exists (neither does yet). The SLSA generator is the one reference that must remain a tag.
