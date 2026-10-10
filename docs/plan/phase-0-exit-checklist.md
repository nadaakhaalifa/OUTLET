# Phase 0 exit checklist (independent audit)

Date: 2026-10-10. Branch: feat/phase-0-foundations. Scope: master prompt A2 rules 1-15 and P3 Phase 0 list.
Strictness: DONE only when a test or an enforced check proves it. A document, a config that never ran, or a
commitment is PARTIAL at best. Evidence below is from commands run during this audit, not from earlier reports.

## Commands run

| Command | Result |
|---|---|
| `pnpm lint` (Node 25.9) | PASS, no errors printed |
| `pnpm -r typecheck` | PASS, all workspace projects |
| `pnpm -r test` | PASS, 1299 tests, 0 failures (analytics 138, auth-core 31, feature-flags 25, i18n 6, domain 466, db 48, idempotency 42, outbox 79, policy 119, privacy 70, ui-tokens 12, validation 29, ui-native 18, mobile 49, api 167) |
| `pnpm depcruise` (Node 24.15) | FAIL, 2 errors, 7 warnings (301 modules). Errors: `no-deep-import-into-shared-package` from `packages/db/src/ledger-owner.test.ts` and `packages/db/src/ledger-account-types.test.ts` into `packages/domain/src/chart-of-accounts/accounts.ts`. Warnings: 7 `no-orphans` on the per-package `stryker.config.mjs` files. (On Node 25 the tool refuses to run; CI pins Node 24.) |
| `pnpm i18n-check` | PASS, 119 keys, parity OK, 4 identical-text warnings |
| `node tooling/privacy/check-inventory.mjs` | FAIL, 93 tables, 594 fields, 7 errors: `ledger_account_types.{category,code,created_at,in_spec_t4,normal_side,owner_type,status}` untagged in `data_inventory.yaml` (migration 0011 added the table) |
| `node tooling/api/validate-openapi.mjs` | PASS, 159 operations, 187 schemas |
| Stryker, terraform, promtool, GitHub Actions, real Postgres 16, device/simulator | NOT RUN in this audit. Treat as NOT VERIFIED |

Two red gates exist today (depcruise, privacy inventory). CI would fail on both.

## A2 rules 1-15

| # | Rule | Status | Evidence and gap |
|---|---|---|---|
| 1 | Strict TS, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no any / ts-ignore / non-null outside tests; Python ML | DONE for TS | `tsconfig.base.json` sets all three flags. `eslint.config.mjs` enforces `no-explicit-any`, `ban-ts-comment` (ts-ignore), `no-non-null-assertion` (off only for tests); `pnpm lint` green; `pnpm typecheck` green in CI. Python ML (mypy strict, ruff, pydantic) has no code yet: N/A in Phase 0. Gap: `no-non-null-assertion` test exemption matches spec. |
| 2 | pnpm + Turborepo with remote cache; shared packages | PARTIAL | `pnpm-workspace.yaml`, `turbo.json`, 13 packages. Remote cache is only stated in ADR-0001: no `TURBO_TOKEN`/`TURBO_TEAM`, no `--remote-only`, no config anywhere. Generated API client and shared `config` package do not exist (`packages/` has no `api-client`, `config`). |
| 3 | Hexagonal modular monolith, depcruise fitness functions in CI | PARTIAL | `.dependency-cruiser.cjs` has deep-import, domain-purity, layer, no-circular rules; `ci.yml` job `boundaries`; eslint bans clock/random/env in domain. But the gate is RED now (2 errors above), so the enforced check currently fails. Only auth and privacy modules exist under `apps/api/src/modules`; the rest of T1's module list is absent. |
| 4 | Money integer piastres bigint, currency on every amount, banker's rounding at one point, property-tested | DONE (domain) / PARTIAL (DB) | `packages/domain/src/money.ts` bigint amount + currency; `divideRoundHalfEven` banker's rounding; `money.test.ts`, `money.mutation.test.ts`, fast-check in `machine.test.ts` etc.; eslint bans `parseFloat`. Gaps: no ESLint ban on `Number()` of money or float arithmetic; no property test file for money in `money.test.ts` was confirmed beyond example tests (fast-check is used in 16 test files across packages). DB `BIGINT` columns exist in migrations 0003. |
| 5 | Idempotency-Key, 24h store of (key, route, actor, request_hash, response), 422 on hash mismatch | PARTIAL | `packages/idempotency` `DEFAULT_TTL_MS = 24h`, `errors.ts` httpStatus 422, `idempotency.test.ts`, `mutation-kill.test.ts`; Nest `idempotency.interceptor.ts` tested over HTTP. Gaps: only in-memory store (no Postgres adapter though migration 0004 exists); `@Idempotent` is applied to one route (`privacy.controller.ts:80`) and OTP request with `required: false`; no money/stock/order/webhook route exists to apply it to; UUIDv7 not validated by client key check (not verified). |
| 6 | Explicit state machines for the 13 named entities, typed errors, every transition tested, property test no unreachable states | DONE | 13 files in `packages/domain/src/state-machine/machines/` match the list exactly (order-group, seller-order, shipment, return, refund, payout, subscription, drop, price-claim, gift-card, kyc, dispute, price-drop-auto-buy). `machines.table.test.ts` pins every table; `machine.test.ts:91` static reachability analysis, `:155` fast-check property. Gap: tables are characterisations pending domain review (per mutation doc); vocabularies reconciled in ADR-0018 (Proposed). |
| 7 | Transactional outbox + inbox, same tx, relay, idempotent consumers | PARTIAL | `packages/outbox` (`inbox.ts` records message_id in same unit of work, `relay.ts`), 79 tests, migrations 0004/0008/0009 with PGlite tests. Gaps: no Postgres adapter, only `memory.ts`; no SKIP LOCKED / multi-relay concurrency exercised on real Postgres 16; no API module writes an outbox event in a state-change transaction (consent change does not emit). |
| 8 | Orchestrated sagas with compensations (checkout, refund, payout, cancellation cascade) | PARTIAL | `packages/outbox/src/saga.ts`, `saga.test.ts`, `saga-definitions.test.ts` define checkout, checkout_cod, refund (and others) with compensation steps. Gaps: definitions and an in-memory runner only; steps are `*.noop` placeholders for validation; no persistence-backed runner, no chaos test (kill mid-saga), no real step handlers. |
| 9 | Append-only hash-chained `audit_log` with actor/action/target/diff/IP/device/request ID | PARTIAL | Migration 0005 trigger-assigned hash chain, immutability trigger, `audit_log_verify`; `packages/db/src/migrations.test.ts:174` tests chain verify, tamper detection, UPDATE/DELETE rejected (PGlite). Gaps: no application code writes audit rows (no audit port in `apps/api`); PII-redaction of diffs not enforced; WORM shipping absent; retention job absent; not run on real Postgres. |
| 10 | Tests: domain >= 90%, mutation >= 80% on critical modules, endpoint integration + negative authz, Pact, property tests, Maestro/Playwright E2E, k6 | PARTIAL | Domain line coverage 97.65% per `docs/engineering/coverage.md` (measured by `tooling/coverage/check.mjs`; not re-run by me). Negative authz matrix `apps/api/test/authz-matrix.test.ts` (578 lines) runs in the api suite. Property tests in 16 files. Gaps: (a) **mutation**: root `stryker.config.mjs` `break: 40` for domain; per-package breaks are analytics 63, feature-flags 63, idempotency 71, outbox 52, policy 51, privacy 77, validation 76, all below 80 and ADR-0019 (Proposed) says critical modules break at 80; the ledger/money files reach 94-100% per `docs/engineering/mutation-testing.md` but the committed gate does not enforce it; CI `mutation` job runs only domain and only on push or label. (b) **Pact**: zero code or config (grep finds only prose). (c) **Maestro, Playwright, k6**: no config or test anywhere. (d) coverage: ui-native 38.99% lines, mobile 37.65%. (e) apps/api coverage not in the recorded baseline. |
| 11 | Spec-first: spec.md per module (A3 template), data model, OpenAPI, threat model, ADRs (MADR) | PARTIAL | `docs/specs/` holds only 3 specs (money-and-ledger, ledger-chart-of-accounts, price-integrity); no A3-template spec for auth, privacy, checkout, etc. 13 threat models, `docs/data-model.md`, `docs/api/openapi.yaml` (validated), 19 ADRs, but only 0006 (and 0002/README text match "Accepted" in grep; 0002 itself says "Proposed") is Accepted; ADR-0001..0005 are Proposed. |
| 12 | OpenFeature flags on non-trivial features; kill switches for each payment method, BNPL, COD, drops, games, stylist LLM, ML ranking, crawlers, referral payouts, gift cards | PARTIAL | `packages/feature-flags/src/registry.ts` has 14 kill switches covering every item in the rule (card, apple_pay, mobile_wallet, instapay, fawry, cod, bnpl, drops, games, stylist_llm, ml_ranking, crawlers, referral_payouts, gift_card_sales); 25 tests. Gaps: in-memory provider only, no OpenFeature SDK or self-hosted provider; no API or mobile code path consults a kill switch (grep of `apps/api/src` finds no use). |
| 13 | Never fake data; CI lints UI copy for hard-coded numeric social proof | MISSING (lint) | No copy-lint exists: `.github/scripts` only has `i18n-check.mjs` and workflow validation; grep for social-proof/copy-lint finds nothing. Fake-data absence was sampled manually only (dev fixtures labelled). The mobile dev fake API and dev OTP `000000` are labelled dev-only; release refusal is reported, not re-verified. |
| 14 | DORA metrics on Admin engineering dashboard | MISSING | No Admin app, no DORA collection, no mention outside the spec. Not expected before Admin Console, but nothing is staged (no deployment event schema). |
| 15 | Arabic-first, CI fails on missing AR key | DONE (keys) / PARTIAL (rest) | `.github/scripts/i18n-check.mjs` + `i18n-check.test.mjs`, CI job `i18n-parity`; run: 119 keys parity OK. `packages/i18n/src/index.test.ts` 6 tests. Gaps: RTL layout never rendered on device; Arabic copy has no native review; invoices/notifications/server-side strings (problem details, error messages) are not covered by the check. |

## P3 Phase 0 list

| # | Item | Status | Evidence and gap |
|---|---|---|---|
| P0-1 | Monorepo | DONE | workspace, turbo, 13 packages + 2 apps; typecheck and 1299 tests green. (Remote cache not configured: see rule 2.) |
| P0-2 | CI/CD | PARTIAL | `.github/workflows/{ci,codeql,sbom,release}.yml`; offline lint via `validate-workflows.mjs`. Never executed on GitHub. CI would fail today on depcruise and privacy inventory. Actions use floating tags (comment in `ci.yml` admits it). Mobile typecheck/tests and `pnpm -r test` coverage gate are not CI jobs (coverage script not in `ci.yml`). |
| P0-3 | SBOM and signing | PARTIAL | `sbom.yml` and `release.yml` exist; ADR-0015 Proposed. Inert: no registry, no Dockerfile, no cosign run. Not verified. |
| P0-4 | IaC | PARTIAL | `infra/terraform` modules + 3 environments + conftest policies. terraform, conftest, checkov not installed here; never validated. |
| P0-5 | Environments | PARTIAL | dev/staging/prod directories only; no environment exists; ADR-0016 Proposed. |
| P0-6 | Region ADR | BLOCKED | ADR-0002 is Proposed, blocked on open questions 1, 2, 8 and register rows. Owner decision. |
| P0-7 | Auth: OTP | PARTIAL | `packages/auth-core` (31 tests); `POST /v1/auth/otp/request`, `/verify` in `apps/api` with HTTP tests. In-memory adapters, dev OTP, no real SMS/WhatsApp provider, no App Attest verification, no persistence. |
| P0-8 | Auth: Apple, Google, passkeys, refresh, logout | PARTIAL | Endpoints now exist in `identity.controller.ts`: `auth/apple`, `auth/google`, `auth/passkey/register[/options]`, `auth/passkey/assert[/options]`, `auth/refresh`, `auth/logout`, `me/sessions`. Tested over HTTP with in-memory identity (`auth.identity.http.test.ts`). Gaps: identity-token verification is `jwt-identity-verifier` against fixtures, not Apple/Google JWKS in a live test; no persistence; access token is "claims only, signing is an adapter concern" so no real JWT signing/KMS. |
| P0-9 | Policy / RLS layer | PARTIAL | `packages/policy` (119 tests, property tests, matrix) wired through `policy.guard.ts`. RLS: migration 0007 plus a single test "RLS skeleton" (`migrations.test.ts:273`, 2 cases) on PGlite. No per-table RLS matrix, no FORCE, no real Postgres, role/variable gaps recorded in `packages/policy/RLS.md`. |
| P0-10 | Consent and privacy core | PARTIAL | `packages/privacy` (70 tests), consent GET/PATCH in `apps/api`. No persistence, no outbox emission, DSAR export/delete and deletion jobs have no endpoint wired (only privacy controller GET/PATCH consent). |
| P0-11 | Security baseline | PARTIAL | `docs/security` (ASVS matrix, MASVS, API Top 10, LLM threats, crypto inventory, 13 threat models). Controls proven by code are limited to money/ledger, policy deny-by-default, idempotency, rate limit guard. ASVS rows are chapter-level, test IDs are commitments. SAST (CodeQL) and secret scan configured, never run. |
| P0-12 | Design tokens | DONE | `packages/ui-tokens`, 12 tests. |
| P0-13 | Core components | PARTIAL | `packages/ui-native` logic tests (18); components in `components/basic.tsx` typechecked only, never rendered (ui-native lines 38.99%). |
| P0-14 | i18n / RTL | PARTIAL | See rule 15. RTL, restart-on-switch, fonts unverified on device. |
| P0-15 | Observability + SLO dashboards | PARTIAL | `infra/observability` + generator drift check (in CI); nothing emits metrics; OpenTelemetry not imported in `apps/api/src`; rules never loaded into Prometheus. |
| P0-16 | Event taxonomy | DONE (with caveat) | `packages/analytics` 138 tests, `docs/analytics/event-taxonomy.md`. Spec path `docs/analytics/events.md` not created; no doc-drift CI check; no schema registry in CI; no real SDK. |
| P0-17 | STRIDE threat models, ADRs, ERD | PARTIAL | 13 threat models; 19 ADRs, nearly all Proposed; `docs/data-model.md` plus module files (docs only; Mermaid not rendered). |
| P0-18 | `data_inventory.yaml` | PARTIAL | File, RoPA, DPIAs, checker exist. Checker FAILS (7 errors, `ledger_account_types`). Blocks CI. |
| P0-19 | Ledger core | PARTIAL | `packages/domain` ledger + chart of accounts (466 tests), migration 0003 balance trigger and immutability on PGlite, `ledger-owner.test.ts` and `ledger-account-types.test.ts` cross-check domain to DB. Gaps: no Postgres adapter or posting service; not run on real Postgres; the cross-check tests violate the depcruise rule; domain mutation gate 40, not 80. |
| P0-20 | Outbox / inbox | PARTIAL | See rule 7. |
| P0-21 | Idempotency middleware | PARTIAL | See rule 5. |
| P0-22 | Feature flags | PARTIAL | See rule 12. Registry done, provider/OpenFeature and consumption missing. |

## Blocking items to close before Phase 0 can be called complete

1. Fix depcruise: move the two `packages/db` cross-check tests to import `@outlet/domain` public entry (or export the needed symbol from `src/index.ts`), and relax or restructure the `no-orphans` warnings.
2. Tag `ledger_account_types` columns in `data_inventory.yaml` (privacy gate red).
3. Raise committed mutation `break` to the measured score and to 80 for money modules per ADR-0019; extend the CI `mutation` job beyond `packages/domain`.
4. Add the copy-lint for numeric social proof (rule 13), a Pact skeleton (rule 10), and record the E2E/k6 plan as explicitly deferred with an owner.
5. Configure Turbo remote cache or amend ADR-0001 (rule 2).
6. Apply `@Idempotent` and kill-switch checks where the first money/stock routes land (rules 5, 12).
7. NOT VERIFIED anywhere: GitHub Actions run, terraform/conftest/checkov, promtool, real Postgres 16 (SKIP LOCKED, RLS, triggers), Stryker re-run on current tests, device/simulator RTL.
