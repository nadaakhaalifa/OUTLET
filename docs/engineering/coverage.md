# Test coverage (measured)

> **Update 2026-10-10:** the apps/api failures described below were an in-progress edit and are resolved: apps/api now passes 167/167 tests. Domain coverage was re-measured by `node tooling/coverage/check.mjs` (97.65% lines, 90.29% branches in the agent run; gate is 90% lines). See the script output for the current per-package table; `baseline.json` is the ratchet.

Measured with `node tooling/coverage/check.mjs` (vitest + @vitest/coverage-v8, `src/**/*.{ts,tsx}`, test files excluded, `coverage.all=true`). Per-package output goes to `<pkg>/coverage/` (`coverage-summary.json`, `coverage-final.json`). No per-package config is needed: the script passes the coverage flags on the CLI.

Gates: `packages/domain` lines >= 90% (master prompt A2.10) fails the script. Every other package is report-only plus a ratchet against `tooling/coverage/baseline.json` (a drop of more than 0.05 points fails). Refresh the baseline with `--update-baseline` after an intentional change. `--no-run` re-reads existing summaries.

## Results (run of 2026-10-10)

| Package | Lines % | Branches % | Note |
|---|---:|---:|---|
| packages/domain | 97.65 | 90.29 | Gate 90%: PASS |
| packages/analytics | 98.17 | 98.05 | |
| packages/auth-core | 97.60 | 80.95 | |
| packages/db | 98.69 | 84.45 | |
| packages/feature-flags | 94.82 | 94.11 | |
| packages/i18n | 100 | 100 | |
| packages/idempotency | 96.42 | 71.81 | weakest branch coverage |
| packages/outbox | 93.90 | 81.15 | |
| packages/policy | 95.05 | 87.32 | |
| packages/privacy | 98.10 | 91.27 | |
| packages/ui-native | 38.99 | 91.13 | components mostly untested |
| packages/ui-tokens | 100 | 100 | |
| packages/validation | 100 | 88.88 | |
| apps/mobile | 37.65 | 83.64 | screens/routes largely untested |
| apps/api | no data | no data | 16 of 54 tests fail (see below) |

Mutation score (A2.10, >= 80% on ledger etc.) is a separate Stryker gate and is not measured here.

## apps/api: not measured

`vitest run` in apps/api ends with `16 failed | 30 passed | 8 skipped`, all in `src/auth.privacy.http.test.ts`: `POST /v1/auth/otp/request` returns 500 `internal_error`, so the harness `login()` fails. Coverage is therefore not reported and the script marks it "NO DATA". The auth module and env config were being modified in the working tree by other work during this run, so this is likely an in-progress change, not a coverage issue; it needs a re-run by the auth owner. apps/api is not in the baseline until it passes.

## Uncovered in packages/domain

Files at 0% lines are barrel re-exports (`src/index.ts`, `src/chart-of-accounts/index.ts`, `src/state-machine/index.ts`); they hold no logic.

| File | Lines % | Branches % | Uncovered branch lines |
|---|---:|---:|---|
| src/money.ts | 95.45 | 88.88 | 12, 46, 113, 114, 120, 121 |
| src/ledger.ts | 100 | 96.55 | 55 |
| src/chart-of-accounts/accounts.ts | 100 | 93.10 | 317, 324 |
| src/chart-of-accounts/builders.ts | 96.96 | 90.00 | 51, 140, 167, 228, 255, 283, 484 |
| src/chart-of-accounts/spend.ts | 95.00 | 80.95 | 20, 32, 43, 46 |
| src/state-machine/machine.ts | 97.10 | 89.70 | 73, 74, 77, 82, 83, 84, 89 |

All 13 state-machine definitions under `src/state-machine/machines/` and `registry.ts`/`errors.ts` are at 100%/100%.

Priorities: `money.ts` (A2.4 rounding paths, 113-121) and `chart-of-accounts/spend.ts` (spend-order branches, lowest branch %) first. The tests live in packages/domain, which this task does not own.
