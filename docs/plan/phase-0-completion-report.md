# Phase 0 completion report (independent audit)

Date: 2026-10-10 · Branch: feat/phase-0-foundations · Auditor: independent completeness audit (did not write the audited work)
Scope: spec section P3 "Phase 0 - Foundations" and section P5.2 deliverables. Evidence is the repository state at audit time, not agent reports.

Legend: DONE = artefact exists and what it claims is proven by a check I ran. PARTIAL = exists, but part of the claim is unproven or missing. BLOCKED = cannot finish without an owner or external decision. MISSING = not present.

## 1. Headline

- Phase 0 is not complete. Documentation, pure-domain code and the migrations are in place and, since the first audit pass, verified more deeply (real Postgres 16 run, whole-domain mutation score, measured coverage). Nothing has run on a device, simulator, GitHub Actions or a cloud account.
- Re-audit of 2026-10-10 (second pass): typecheck, lint, all tests, coverage gate, Postgres 16 script and the mutation scores I re-ran match their claims. Two gates are RED: the privacy inventory gate (7 untagged `ledger_account_types` columns, 3 failing tests) and `pnpm depcruise` (2 errors, deep imports from `packages/db` tests into `packages/domain/src`).
- No real personal data and no backend deployment exist, in line with the owner decisions. ADR-0002 is not accepted, so residency, key custody and every production adapter remain design intent.

## 2. Real check results

Environment: Node v25.9.0 default; Node v24.15.0 (/usr/local/bin) used for everything below (target is Node 24). Postgres.app 16 binaries via `PG_BIN`.

| Command | Result (re-run by the second audit) |
|---|---|
| `pnpm -r typecheck` | PASS, exit 0. |
| `pnpm lint` | PASS, exit 0. (First audit's 2 errors are gone.) |
| `pnpm -r test` | PASS. 15 projects, 1299 tests, 0 failures. |
| `pnpm depcruise` | FAIL. 301 modules, 898 dependencies, 9 violations: 2 errors (`no-deep-import-into-shared-package`: `packages/db/src/ledger-owner.test.ts` and `packages/db/src/ledger-account-types.test.ts` import `packages/domain/src/chart-of-accounts/accounts.ts`), 7 `no-orphans` warnings (`stryker.config.mjs` in 7 packages). |
| `pnpm i18n-check` | PASS, 119 keys, parity OK, 3 warnings (placeholder and the two language names identical in AR and EN). |
| `node tooling/privacy/check-inventory.mjs` | FAIL. 93 tables, 594 fields, 7 errors, 1 warning: all 7 columns of `ledger_account_types` (migration 0011) untagged. |
| `node --test tooling/privacy/test/*.test.mjs` | FAIL. 31 tests, 28 pass, 3 fail (consent purposes/spec fields, every migration column tagged, generator matches files on disk). |
| `node tooling/api/validate-openapi.mjs` | PASS. 159 operations, 90 writes, 187 schemas. |
| `node tooling/observability/generate.mjs --check` and tests | PASS, 15 generated files in sync; 22 of 22 tests. |
| `node tooling/coverage/check.mjs` | PASS, all packages ok. Lines %: api 96.7, mobile 37.65, analytics 98.6, auth-core 97.6, db 98.69, domain 98.69 (branch 97.14), feature-flags 100, i18n 100, idempotency 98.57, outbox 98.56, policy 98.9, privacy 99.65, ui-native 38.99, ui-tokens 100, validation 100. Domain gate (>= 90) passes. Mobile and ui-native remain weak. |
| `tooling/db/run-on-postgres16.sh` (PostgreSQL 16, Postgres.app) | PASS, `passed=44 failed=0`, migrations 0001-0011. Matches docs/plan/postgres16-run.md. pg_cron is absent on that server, so its jobs are unverified. |
| Stryker `src/money.ts` | 94.52% (138 killed, 8 survived) when run alone; 93.84% (137 killed, 9 survived) inside the whole-domain run. |
| Stryker `src/ledger.ts` | 100% (57 killed, 0 survived). |
| Stryker whole `packages/domain` (committed config, ignoreStatic false) | 97.69% (1642 killed, 7 timeout, 37 survived, 2 no coverage), about 3m24s. Builders 93.75, spend 90.77, accounts 97.63, machines 100. |
| terraform, conftest, opa, promtool, actionlint | NOT INSTALLED (docker binary exists but was not used). Terraform, Rego and Prometheus rules are unvalidated. |
| Simulator, device, Metro bundle, `main.ts` boot, GitHub Actions run, managed Postgres, PgBouncer | NOT RUN anywhere. |

Per-package test counts: analytics 138, auth-core 31, db 48, domain 466, feature-flags 25, i18n 6, idempotency 42, outbox 79, policy 119, privacy 70, ui-tokens 12, ui-native 18, validation 29, apps/mobile 49, apps/api 167. Total 1299.

Stale claims found in the audited documents (all proven by the re-run above):
- `docs/plan/verification-run.md` row 8: "893 tests (domain 390 ...)" is stale (now 1299, domain 466). Row 13: "29 of 31 tests pass" is stale (28 of 31, 3 failures). Row 11: "117 keys, 7/7 tests, 3 warnings" keys now 119. Row 12: "156 operations, 87 writes, 184 schemas" is stale (159, 90, 187). Row 7 (lint 140 errors from a Stryker sandbox) and row 10 (depcruise not verified) are superseded: lint passes, depcruise runs and fails with 2 errors. Row 9 is still true (no package defines `build`; not re-checked).
- `docs/engineering/coverage.md`: domain 97.65 / 90.29 is stale (98.69 / 97.14); every other package row changed; "apps/api no data, 16 of 54 tests fail" is false now (96.7 / 84.93, 167 pass). The "Uncovered in packages/domain" table was not re-verified.
- `docs/engineering/mutation-testing.md`: "domain tests: 195 passing" is stale (466). The "45.08% committed config" headline and the per-file "Before" table are historical; current committed-config whole-domain score is 97.69%. The per-file "After" numbers I re-ran (money 94.52, ledger 100) are accurate; the machines (100) and "all together 97.75% (1642 killed, 7 timeout, 36 survived, 2 no coverage)" are within one survivor of my run (37 survived, 97.69%). `stryker.config.mjs` comment still cites 45.08% and `break: 40`, far below the real score; other packages carry their own ratchets (feature-flags 63, idempotency 71, analytics 63, outbox 52, policy 51, privacy 77, validation 76), none at 80, and mutation scores for those packages were not re-run by me.
- `docs/plan/postgres16-run.md`: no false claim found. Caveats: the outbox claim query is a transcription, not shipped code; the TS runner was not exercised.

Note: the first audit's "419 tests in domain" claim and its 662 total were already stale before this pass.

## 3. Phase 0 list (spec P3), item by item

| # | P3 item | Status | Evidence and caveats |
|---|---|---|---|
| 1 | Monorepo | DONE | `pnpm-workspace.yaml`, `turbo.json`, 13 packages, 2 apps; typecheck and tests green. |
| 2 | CI/CD with SBOM and signing | PARTIAL | `.github/workflows/{ci,codeql,sbom,release}.yml` exist and parse as YAML. None has ever run. `release.yml` is inert (no registry var, no `apps/api/Dockerfile`). Actions use floating tags and `conftest-action@master`. Signing and the SLSA level are not claimed. CODEOWNERS teams are placeholders. |
| 3 | IaC | PARTIAL | `infra/terraform` 9 modules and 3 environments exist. Never validated (no terraform). No ECS service, ALB, alarms, state bootstrap. Provider and region undecided (ADR-0016 Proposed). |
| 4 | Environments | PARTIAL | dev, staging, prod directories with `backend.hcl.example` only. No environment exists. |
| 5 | Region ADR | BLOCKED | `docs/adr/0002-data-residency.md` exists, Proposed, blocked on open questions 1, 2, 8 and VR-01, VR-02, VR-20, VR-21. |
| 6 | Auth: OTP | PARTIAL | `@outlet/auth-core` (25 tests) and `apps/api` `POST /v1/auth/otp/request`, `/verify` against in-memory dev fixtures. No JWT (opaque dev tokens), no real SMS, no attestation, no persistence. |
| 7 | Auth: Apple, Google, passkeys | MISSING | Port interface shapes only. No endpoints (`/v1/auth/apple`, `/google`, `/passkey/*`, `/refresh`, `/logout`, `GET /v1/me`, session list). Refresh rotation exists as domain logic only. |
| 8 | Policy / RLS layer | PARTIAL | `@outlet/policy` decide() with 78 tests; guard wired in API. RLS in migration 0007 only tested for `users` and `audit_log` on PGlite, ENABLE not FORCE, no per-table matrix. `packages/policy/RLS.md` lists unresolved differences (roles ops, trust_safety, marketing, courier, creator; variables `app.hub_id`, `app.creator_id`). |
| 9 | Consent and privacy core | PARTIAL | Domain model, 33 tests, consent API on in-memory store. No persistence, no outbox write on consent change, DSAR and deletion have no endpoint or job. |
| 10 | Security baseline | PARTIAL | `docs/security` (ASVS matrix, MASVS, API Top 10, LLM threats, crypto inventory, 13 threat models). Only the money and ledger rows are code-proven. ASVS rows are chapter-level, official requirement IDs absent. Proving-test IDs (AUTH-T01 etc.) are commitments, not tests. Pinning deferred by ADR-0007 (Proposed). |
| 11 | Design tokens | DONE | `@outlet/ui-tokens`, 12 tests. |
| 12 | Core components | PARTIAL | `@outlet/ui-native` logic tested (18); components typechecked only, never rendered. All components in one file `components/basic.tsx`. No icons. TextField focus state not wired. |
| 13 | i18n / RTL | PARTIAL | 117 keys with AR and EN parity test. RTL layout, language-switch restart and fonts never run on a device. Arabic strings are model-written, no native review. |
| 14 | Observability + SLO dashboards | PARTIAL | `infra/observability` SLOs, 8 rule files, 7 dashboards generated and drift-checked. Nothing emits a metric; rules not loaded in Prometheus; dashboards not imported. OTel SDK not wired in API. |
| 15 | Event taxonomy | DONE | `docs/analytics/event-taxonomy.md`, `@outlet/analytics` 100 tests. Caveats: no doc-drift CI check, no schema registry, spec path `docs/analytics/events.md` not created, no real SDK. |
| 16 | STRIDE threat models | DONE (docs) | 13 models under `docs/security/threat-models`. Not line-by-line verified by author of the agent claim; I sampled. |
| 17 | ADRs | PARTIAL | 0001-0019 exist. Only 0006 is Accepted; all others Proposed. `docs/adr/README.md` now lists 0015-0019 (fixed since the first pass). ADR-0018 and 0019 are Proposed. |
| 18 | ERD | DONE (docs) | `docs/data-model.md` + 27 module files, 379 entities. Mermaid only syntax-linted, not rendered. Contains 87 flagged inconsistencies; several drift items point at code (see section 5). |
| 19 | `data_inventory.yaml` | PARTIAL | File, RoPA, processors, retention, 4 DPIA skeletons, and checker exist. Checker FAILS today (section 2). 457 of 582 fields have no migration column yet (expected). DPIA risk ratings and sign-off blank (correct: DPO). |
| 20 | Ledger core | PARTIAL | `@outlet/domain` money and ledger plus chart of accounts (17 types, 11 worked examples) tested; migration 0003 enforces balance and immutability on PGlite. Migration 0010 added the `bank` owner type and 0011 added `ledger_account_types` (Postgres 16 run passes); inventory not yet tagged (section 2). Mutation score 97.69% on whole domain (re-run); other packages unmeasured by this audit. |
| 21 | Outbox / inbox | PARTIAL | `@outlet/outbox` 30 tests, migrations 0004, 0008, 0009. Concurrency (SKIP LOCKED, multi-relay) never exercised; out-of-order commit risk documented not closed; no saga runtime; no Postgres adapter; hand-written validation (no Zod). |
| 22 | Idempotency middleware | PARTIAL | `@outlet/idempotency` 18 tests plus Nest interceptor tested over HTTP with in-memory store. No Postgres adapter. OTP verify intentionally not idempotent. |
| 23 | Feature flags | DONE | `@outlet/feature-flags` 10 tests, 14 kill switches default off. In-memory provider only; no provider timeout. |

## 4. Deliverables list (spec P5.2)

| Deliverable | Status | Evidence |
|---|---|---|
| Open questions (max 12) | DONE with caveat | `docs/open-questions.md` exists (26 lines). Verify-register adds VR-19 to VR-24 needing owners (open question 12). |
| ADR 0001 to 0005 | DONE (all Proposed) | `docs/adr/0001` to `0005`. 0005 has no external blocker. |
| Complete ERD | DONE (docs) | see item 18. Not a deployed schema; only migrations 0001-0009 exist. |
| `data_inventory.yaml` and RoPA draft | PARTIAL | see item 19; gate red. |
| OpenAPI skeleton for Phase 1 | DONE | validator passes. 74 of 156 operations are `x-derived` (not named in the spec). Not used to generate a client or Pact contracts. API implementation was never machine-checked against it. |
| Design tokens | DONE | `packages/ui-tokens`. |
| Event taxonomy | DONE | see item 15. |
| STRIDE threat models + ASVS 5.0 L2 matrix skeleton | DONE (skeleton) | ASVS IDs not expanded (official list not in repo). |
| Price-integrity spec | DONE (docs) | `docs/specs/price-integrity.md`; thresholds are proposals; Shopify and Woo API facts unverified. |
| Ledger chart of accounts with worked examples | DONE | `docs/specs/ledger-chart-of-accounts.md`, `packages/domain/src/chart-of-accounts`, 24 executable examples. All figures are fixtures. |
| Verify register | DONE | `docs/compliance/verify-register.md`, 24 rows (the agent and my count agree); all Open except VR-14. |
| Phase 0-1 task breakdown | DONE by this audit | `docs/plan/phase-0-1-breakdown.md`. |

## 5. Contradictions and unproven statements

Each item is a recorded discrepancy. I did not fix other agents' files.

1. Privacy gate red (re-confirmed). The earlier cause (migration 0008, `consent_records.seq`) is fixed; the gate is now red because the 7 columns of `ledger_account_types` (migration 0011) are untagged: 7 errors, 3 failing tests of 31. The gate works; the inventory lags the migrations again.
2. Ledger owner types: partly resolved. Migration 0010 adds `bank` to the `owner_type` CHECK (verified on Postgres 16). The seller/shopper (domain) vs store/user (DB) naming difference remains with no adapter test proven by me.
3. `ledger_account_types`: resolved. Migration 0011 creates and seeds it (17 types) with an FK; checked on Postgres 16 (typo type rejected). Not yet tagged in `data_inventory.yaml` (item 1).
4. OrderGroup states. Code (`packages/domain/src/state-machine/machines/order-group.ts`): CREATED, RESERVED, PAYMENT_PENDING, PAID, CONFIRMED_COD, FULFILLING, COMPLETED, EXPIRED, FAILED, CANCELLED. `docs/data-model/orders.md`: PENDING_PAYMENT, PAID, CONFIRMED_COD, PARTIALLY_FULFILLED, COMPLETED, CANCELLED, FAILED. OpenAPI `OrderGroup.status` (lowercase): pending_payment, awaiting_customer_action, paid, confirmed_cod, ... Three vocabularies for one machine. OpenAPI also states a "proposed projection, not reconciled" for Return, Dispute, Refund statuses.
5. Consent purposes. OpenAPI `ConsentState` lists `marketing_sms` and omits `location_precise` and `budget_insights`; B1, `@outlet/privacy`, migration 0006 and the API use nine purposes with no `marketing_sms`. The API rejects `marketing_sms` with 400 though the published contract lists it. The register also flags missing SMS purpose (I-06).
6. Price-history path. OpenAPI `GET /v1/products/{productId}/price-history` vs `docs/specs/price-integrity.md` `GET /v1/skus/{id}/price-history`. Owner decision needed.
7. Users status values. Migration 0006 `users.status` is pending, active, suspended, deleted; the data model (D-01) and API (`age_pending`, `age_band`) differ. No `push_token` column (D-03).
8. Outbox migration vs data model. Migration 0004 outbox unpartitioned with PK(id) (D-02); data model expects partitioning.
9. Data inventory vs data model naming (D-05, D-06): table names differ. Policy RLS names and session variables differ from data model (D-07) and RLS.md lists roles/variables not in 0002.
10. ADR README: fixed; lists 0015 to 0019.
11. CLAUDE.md "Current phase" says "Do not write application code until that is approved" while apps/api, apps/mobile features and 13 packages exist. The master prompt P5.3 says "Wait for approval, then implement Phase 0". The owner decisions of 2026-10-10 may be that approval, but it is not recorded in CLAUDE.md or an ADR. Record it.
12. CLAUDE.md contains no model-tier strategy (no mention of Fable, Opus, Sonnet or Haiku, and no "strategy" section). The task referred to "the CLAUDE.md strategy". The breakdown uses the tier names given in the task and flags this.
13. ADR-0006 is Accepted and says "Expo SDK 57, no backend", with an owner approval note about "iOS-only start". The owner decision text for this run says one Expo codebase for iOS and Android with a spec Phase 2 Android launch. Not a conflict, but the Android timing needs to be stated once.
14. `apps/api/package.json` declares `@outlet/outbox`, `@outlet/db`, `@outlet/feature-flags`, `@outlet/analytics`, `@opentelemetry/api` which are unused by the code (API gap list confirms). Declared dependency does not mean implemented.
15. `apps/mobile/package.json` does not declare `@outlet/privacy`, `auth-core`, `analytics`, `ui-native`; code reaches them by relative path (`src/workspace.ts`, `src/ui.ts`). Metro resolution of `./x.js` specifiers and of package-internal dependencies is unverified. This could fail at bundle time even though typecheck passes.
16. Mobile language persistence: stored locale not re-applied at launch (reported gap).
17. Under-18 flow: OTP precedes DOB, so a session exists before the age gate; mobile and API implement different assumptions (device soft-block hashed locally vs `POST /v1/me/age-attestation` on the server). Reinstall bypasses the 30-day block.
18. "implemented" claims in security docs are limited to money and ledger rows; the migrations are labelled partial. I found no other control claimed as implemented that the code does not back. Controls that are described in docs but have no code: certificate pinning (deferred), JWT signing with KMS, App Attest and Play Integrity verification, rate limiting in shared storage, WORM audit shipping, DAST, Semgrep, pre-commit secret scan, SBOM signing.
19. Fakes: all adapters inspected are labelled development fixtures (dev OTP `000000`, in-memory stores, fake API). No fake stock, reviews, timers or discounts were found in the files I sampled. Release builds refuse the fake API (reported; not exercised).
20. Placeholder files presented as finished: none found as empty `export {}` after the reruns. Residual stubs by design: `packages/domain` state-machine README states design choices for owner review; Terraform skeleton is not a deployable stack; Grafana dashboards are skeletons; `RLS.md` is a spec, not enforcement.
21. Mutation score: whole `packages/domain` re-run at 97.69% (committed config, ignoreStatic false), so the earlier 45.08% is stale. Domain line coverage 98.69%, measured. Remaining gaps: `stryker.config.mjs` break is still 40 and its comment cites 45.08%; other packages carry ratchets of 51 to 77, below 80; mobile and ui-native line coverage are 37.65 and 38.99. Also new: `pnpm depcruise` is red (2 deep-import errors in `packages/db` tests).
22. Node: `engines >=24.3.0` but the default shell node is 25.9; privacy and observability suites passed on 24.15.0 here; the agents ran some checks on 25.9. Not an inconsistency of the repo, but CI must pin 24.
23. Generated artefacts: OpenAPI YAML is now hand-maintained (generator not committed); event taxonomy tables were generated once with no drift check.

## 6. What could not be done here and why

- Anything that needs a real Postgres 16, concurrency, pg_cron, PgBouncer: PGlite only.
- Anything that needs a device or simulator: RTL, VoiceOver, TalkBack, expo-secure-store, Metro bundling, app restart on language switch.
- Terraform, Rego and Prometheus validation: tools not installed.
- GitHub Actions: nothing has executed; no org, teams, rulesets or environments.
- Mermaid rendering: mmdc not installed.
- Any legal or provider fact: unverifiable offline; all tagged VERIFY BEFORE LAUNCH.
- I did not independently re-audit every cell of the ASVS matrix, every threat model, every data-model entity or every OpenAPI operation. Spot checks and mechanical checks only.

## 7. Owner decisions needed (consolidated, highest leverage first)

1. Approve or amend ADR-0001 and accept ADR-0005 (no external blocker). Everything downstream depends on these.
2. ADR-0002 data residency and region. Blocks real data, IaC apply, key custody, telemetry vendor choice, SBOM signing choice.
3. Funds flow and licensing (open questions 3 and 4, VR-03, VR-22): who holds money, store credit scope, collection and payout licensing. Blocks payouts, wallet and BNPL design.
4. Refund deadline basis and return windows (ADR-0009, VR-07, I-27, I-83). Blocks order CLOSED and payout eligibility.
5. Age gates: majority age, 18-20 capacity, DOB-before-OTP ordering, under-18 server signal (ADR-0012, VR-08).
6. Authoritative vocabularies: consent purposes, OrderGroup states, price-history path, ledger owner types. Reconciled in ADR-0018 (Proposed, applied as the safe default: code wins, else the master prompt). Remaining: the seller/store and shopper/user mapping has no adapter or test yet.
7. Tax and accounting: VAT treatment for gift cards, coins, discounts, commission, credit notes; ETA flow (I-11, I-38).
8. Dual-approval thresholds for refunds and payouts (policy package fail-closed placeholders).
9. DPO and deputy appointment, on-call rota, breach runbook language and PDPC channel.
10. Mutation and coverage gate: ratchet vs immediate 80% on money modules.
11. Pinning (ADR-0007), observability stack (ADR-0017), CI provenance (ADR-0015), environments (ADR-0016).
12. Record the approval that lifts the "no application code" instruction in CLAUDE.md, and add the model-tier strategy to CLAUDE.md.

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Docs, code and migrations drift on vocabularies (section 5 items 2 to 9) | High, already happening | Medium: rework, wrong contract | One reconciliation task (T0-R1) before any further module work; add contract checks to CI. |
| Money and security modules below mutation floor | High | High: Definition of Done not met | Test-hardening task on domain; raise ratchet. |
| Mobile bundle does not resolve workspace packages | Medium | Medium: lost days late | Run Expo start and a device build in week 1 of continuation. |
| Production Postgres behaviour differs from PGlite | Medium | High (ledger, outbox) | Run suite on real Postgres 16 in CI service container. |
| Licensing and funds flow take longer than build | High | High: cannot take money legitimately | Start counsel engagement now; build with kill switches and COD-first. |
| Unit economics too thin to fund Phase 1 scope | Medium | High | Run the validation experiments in the breakdown before committing Phase 1 spend. |
| Scope: owner keeps the full Phase 1 spec (about 12 to 14 weeks in P3) with a small team | High | High | Treat the critical path in the breakdown as the real estimate; do not accept P3 timing until team size (open question 12) is known. |
| Arabic copy and legal copy are model-written | High | Medium to High (legal exposure) | Native and legal review gate before TestFlight. |
| Market statistics unverified | High | Medium | Not used as fact in deliverables; the LOI sprint, Truth Audit and fake-door test generate our own data. |

## 9. Verdict

Phase 0 foundations: documentation and pure-domain deliverables are substantially complete; platform runtime, infrastructure, auth providers and privacy persistence are not. Recommend closing Phase 0 through the remainder list in `phase-0-1-breakdown.md` (section A) before starting Phase 1 feature work, with the reconciliation task and the red gates (lint, privacy inventory) fixed first.
