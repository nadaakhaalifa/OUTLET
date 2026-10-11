# Phase 0 remainder and Phase 1 task breakdown

Date: 2026-10-10 · Companion to `docs/plan/phase-0-completion-report.md` · Status: proposal for owner approval

## 1. How to read this

- Tiers: Fable = chief-reviewer checkpoint (gate, no feature code), Opus = architect (design, ADR, hard review), Sonnet = builder or tester, Haiku = quick fix. The task text referred to a tier strategy in CLAUDE.md; CLAUDE.md contains none (recorded in the completion report), so these tiers are used as given in the task. External = human or third party time.
- Estimates are ideal days for one agent working uninterrupted, including tests and docs, excluding waiting on people. They are planning figures, not measurements, and have not been calibrated. Expect them to be wrong by up to a factor of two on tasks that touch providers.
- "Earliest finish" is the day a task can end with unlimited parallel agents and zero waiting on external parties, computed from the dependency list. It is a lower bound, not a forecast.
- Items marked BLOCKED need an owner or external decision (section 5). No provider API, price, legal fact or statistic is assumed.
- Scope follows the owner decisions of 2026-10-10: one Expo codebase for iOS and Android, full Phase 1 spec kept, Arabic-first RTL, no real personal data, no backend deployment. The spec places the Android launch in Phase 2; this plan keeps that and keeps Android compatibility in the code from day one.

## 2. Totals

| Tier | Ideal days |
|---|---|
| Sonnet (build and test) | 298 |
| Opus (architecture and hard review) | 20 |
| Fable (checkpoints) | 4 |
| Haiku (quick fixes) | 7 |
| External (human elapsed, not agent days) | 3 |
| Total | 332 |

- Phase 0 remainder (section 3): 56 ideal days, of which 3 external.
- Phase 1 (section 4): 276 ideal days.
- Critical path length: 91.5 ideal days, dominated by sequential dependencies (not by the total effort). With enough parallel agents the build can finish near that figure; with the team size currently unknown (open question 12) the realistic calendar is the total effort divided by effective parallelism, plus external lead times. The spec figure of 4 weeks for Phase 0 and 12 to 14 weeks for Phase 1 should not be accepted until the team size and external lead times are known.

## 3. Phase 0 remainder

| ID | Task | Tier | Days | Depends on | Earliest finish (day) | Notes |
|---|---|---|---|---|---|---|
| A-01 | Reconcile vocabularies: ledger owner types, OrderGroup/Return/Dispute states, consent purposes, price-history path, users status; one source per enum, generated mirrors | Opus | 2 | - | 2 | completion report s5 items 2-9 |
| A-02 | Fix red gates: 2 ESLint errors; tag 12 untagged columns in data_inventory.yaml; wire privacy check into CI | Haiku | 0.5 | - | 0.5 |  |
| A-03 | Housekeeping: ADR README rows 0015-0017, CLAUDE.md (approval record, tier strategy), .gitignore for reports/.stryker-tmp/.terraform | Haiku | 0.5 | - | 0.5 | CLAUDE.md edit needs owner approval |
| A-04 | ledger_account_types seed migration and owner_type alignment incl. bank_settlement; generated from ACCOUNT_TYPES with parity test | Sonnet | 1.5 | A-01 | 3.5 |  |
| A-05 | Real Postgres 16 in CI service container; run @outlet/db suite there; concurrency tests for outbox SKIP LOCKED and CREATE INDEX CONCURRENTLY | Sonnet | 3 | A-02 | 3.5 | needs A-08 |
| A-06 | Postgres adapters: idempotency store, outbox/inbox UnitOfWork, consent store, session store, audit sink | Sonnet | 5 | A-05, A-04 | 8.5 |  |
| A-07 | RLS: per-table policy matrix tests, FORCE decision, separate migrator role, add roles/session vars from RLS.md | Opus | 1 | A-01 | 3 | design |
| A-07b | RLS implementation and negative tests (every tenant table, every role) | Sonnet | 3 | A-07, A-05 | 6.5 |  |
| A-08 | CI first run on GitHub: pin actions to SHA, replace conftest-action@master, fix workflows, required checks, rulesets | Sonnet | 2 | A-02 | 2.5 | needs GitHub org and teams (owner) |
| A-09 | Auth endpoints: refresh, logout, GET /v1/me, session list, JWT signing behind KMS port (dev signer clearly labelled) | Sonnet | 4 | A-06 | 12.5 |  |
| A-10 | Auth providers: Apple, Google, passkeys (WebAuthn) endpoints and verifier adapters | Sonnet | 5 | A-09 | 17.5 | provider docs VERIFY |
| A-11 | Auth threat-model review and negative tests for A-09/A-10 | Opus | 1 | A-10 | 18.5 |  |
| A-12 | Mutation hardening for domain (state machines, chart builders, money.allocate) to >=80 and ratchet; coverage measurement and 90% gate | Sonnet | 5 | A-02 | 5.5 | current reported 45% |
| A-13 | OTel SDK wiring and first metrics (RED, ledger drift, outbox lag); load rules in promtool/Prometheus in CI | Sonnet | 3 | A-08 | 5.5 | promtool needed |
| A-14 | OpenAPI conformance: response validation in API tests, Pact consumer for mobile, drift check taxonomy vs docs | Sonnet | 3 | A-01 | 5 |  |
| A-15 | Mobile: declare workspace deps (owner approves install), verify Metro resolves packages, run iOS simulator, capture RTL evidence | Sonnet | 2.5 | A-02 | 3 | needs deps in needsDeps |
| A-16 | ui-native: render tests (RN testing lib), icons, focus state, split basic.tsx; RTL and large-font snapshots | Sonnet | 3 | A-15 | 6 | dep needed |
| A-17 | ASVS 5.0 requirement-ID expansion, MASVS mapping, proving-test ID to real test links | Opus | 2 | - | 2 | needs official ASVS list |
| A-18 | Terraform validate, conftest, fix; state bootstrap; compute service | Sonnet | 3 | ADR-0002, ADR-0016 | 3 | blocked on region decision |
| A-19 | Native Arabic copy review and legal copy review of consent, privacy, deletion texts | External | 3 | - | 3 | elapsed days, not agent days |
| A-20 | ERD: render Mermaid, resolve 87-item inconsistency register to decisions | Opus | 2 | A-01 | 4 |  |
| F-0 | CHECKPOINT Fable: Phase 0 exit review (money, privacy, authz, reconciliation) | Fable | 1 | A-04, A-06, A-07b, A-09, A-12, A-14, A-15, A-20 | 13.5 | gate |

## 4. Phase 1

| ID | Task | Tier | Days | Depends on | Earliest finish (day) | Notes |
|---|---|---|---|---|---|---|
| P-01 | Phase 1 module scaffolds using one template (domain/application/adapters), depcruise rules per module | Opus | 2 | F-0 | 15.5 |  |
| P-02 | users, addresses, age attestation (B6), device soft-block on server | Sonnet | 4 | P-01, A-09 | 19.5 | needs under-18 decision |
| P-03 | sellers and stores onboarding, KYC machine, legal seller identity fields | Sonnet | 6 | P-02 | 25.5 | Law 181/2018 fields VERIFY |
| P-04 | catalog: products, variants, SKUs, media, taxonomy, bulk import | Sonnet | 8 | P-01 | 23.5 |  |
| P-05 | worlds (Local, Global, All, My Stores) and store pages | Sonnet | 3 | P-04, P-03 | 28.5 |  |
| P-06 | search index sync and query API, filters: budget, size, installments | Sonnet | 8 | P-04 | 31.5 | engine choice ADR first (Opus 1d included in 2d P-01) |
| P-07 | price integrity v1: pure engine in domain, evidence tiers E0-E5, lite mode, enforcement ladder, price-history API | Opus | 2 | P-04, X-2 | 25.5 | design |
| P-07b | price integrity implementation and display rules, AR labels | Sonnet | 8 | P-07 | 33.5 |  |
| P-08 | Shopify and WooCommerce integrations v1 (read prices, history, webhooks) | Sonnet | 8 | P-07b | 41.5 | provider API facts VERIFY |
| P-09 | product page API (fit, price integrity, seller identity, delivery estimate) | Sonnet | 3 | P-04, P-07b | 36.5 |  |
| P-10 | size profile, measurement guide, size charts | Sonnet | 6 | P-04 | 29.5 | measurements consent purpose |
| P-11 | fit v1: chart matching and item flags | Sonnet | 5 | P-10 | 34.5 |  |
| P-12 | intent wishlists and alerts | Sonnet | 4 | P-04 | 27.5 |  |
| P-13 | cart/bag multi-store, free delivery threshold per store, availability checks | Sonnet | 5 | P-04 | 28.5 | ADR-0010 decision |
| P-14 | inventory row-per-unit reservations, TTL by payment method | Sonnet | 6 | A-06 | 14.5 | ADR-0005, ADR-0011 |
| P-15 | checkout saga, sessions, order splitting, idempotent place-order | Opus | 2 | P-13, P-14, A-06 | 30.5 | design |
| P-15b | checkout implementation incl. compensation and degraded mode | Sonnet | 8 | P-15 | 38.5 |  |
| F-1 | CHECKPOINT Fable: money design review before any PSP, payout or ledger posting code | Fable | 1 | P-15 | 31.5 | gate |
| P-16 | PSP adapter behind port: cards, Apple Pay, wallets, InstaPay, Fawry; webhooks, reconciliation feed | Sonnet | 10 | F-1, P-15b, C-1 | 48.5 | BLOCKED on provider contract |
| P-17 | COD flow with risk controls (limits, OTP confirm, blocklists, per-area rules) | Sonnet | 6 | P-15b | 44.5 | COD baseline X-4 |
| P-18 | BNPL: one partner, eligibility, installment quote, refund routing | Sonnet | 5 | P-15b, C-2 | 43.5 | BLOCKED on partner |
| P-19 | store credit integration with spend planner (wallet read-only) | Sonnet | 3 | P-15b | 41.5 | ADR-0003, ADR-0014 |
| P-20 | order posting integration with ledger, daily reconciliation engine, break handling | Sonnet | 8 | F-1, P-15b, A-04 | 46.5 |  |
| P-21 | payouts: eligibility, holdback, saga, bank rail adapter, seller statements | Sonnet | 8 | P-20, C-3 | 54.5 | BLOCKED on funds-flow licensing |
| P-21d | payouts design review (dual approval, negative balance, clawback) | Opus | 2 | F-1 | 33.5 |  |
| P-22 | orders service and seller-order machine wiring, seller actions (accept, pack, ship) | Sonnet | 6 | P-15b | 44.5 |  |
| P-23 | ETA e-invoice for commission and e-receipts | Sonnet | 10 | P-20, C-4 | 56.5 | ETA sandbox and tax decisions; VERIFY |
| P-24 | Bosta integration: shipments, tracking webhooks, COD remittance | Sonnet | 7 | P-22, C-5 | 51.5 | BLOCKED on contract and API access |
| P-25 | returns, refunds, exchange-first, RefundRouter (BNPL to provider), ETA credit notes | Sonnet | 11 | P-22, P-20, P-23 | 67.5 | ADR-0009 |
| P-26 | vouchers core | Sonnet | 4 | P-13, P-20 | 50.5 |  |
| P-27 | referrals core and abuse controls | Sonnet | 4 | P-26, P-02 | 54.5 |  |
| P-28 | notifications: push, SMS, WhatsApp, email, AR/EN templates, consent gating | Sonnet | 6 | A-06, P-02 | 25.5 | providers VERIFY |
| P-29 | seller analytics v1 | Sonnet | 4 | P-22 | 48.5 |  |
| P-30 | admin essentials, DPO console, audit viewer, dual approval | Sonnet | 12 | A-07b, P-22 | 56.5 |  |
| P-31 | Privacy Center backend: DSAR export, deletion jobs, retention jobs; legal pages AR/EN | Sonnet | 6 | A-06, A-19 | 14.5 |  |
| P-32 | Seller Center web app | Sonnet | 15 | P-04, P-22 | 59.5 |  |
| P-33 | mobile: catalog, worlds, search, product page, wishlist, size profile | Sonnet | 15 | P-05, P-06, P-09, P-10, P-12 | 51.5 |  |
| P-34 | mobile: bag, checkout, orders, returns, notifications | Sonnet | 15 | P-15b, P-25 | 82.5 | partially parallel |
| P-35 | E2E and negative authorization tests for every endpoint; Pact verification | Sonnet | 8 | P-22 | 52.5 | rolling |
| P-36 | security verification: ASVS L2 evidence, MASVS, pen-test prep, secrets and supply chain checks | Opus | 4 | P-34, P-30 | 86.5 |  |
| P-37 | performance, accessibility (WCAG 2.2 AA), RTL and image budgets | Sonnet | 4 | P-34 | 86.5 |  |
| P-38 | runbook drills: restore, PSP outage, reconciliation break, breach tabletop | Sonnet | 3 | P-21, P-16 | 57.5 |  |
| F-2 | CHECKPOINT Fable: privacy, legal and verify-register closure before beta | Fable | 1 | P-31, P-36, A-19 | 87.5 | gate |
| P-39 | TestFlight beta, App Review prep, store listing AR/EN | Sonnet | 3 | F-2, P-37, P-38 | 90.5 |  |
| F-3 | CHECKPOINT Fable: Phase 1 exit review | Fable | 1 | P-39 | 91.5 | gate |
| P-40 | Haiku quick-fix buffer across the phase (lint, copy, small defects) | Haiku | 6 | - | 6 | unscheduled |

Items not in the table because P3 puts them in Phase 2 or 3: Plus, gift cards sales, budget suite, AI stylist, recommendations, rewards and games, drops, crawler, sponsored products, Android launch.

## 5. External dependencies (long lead, start now)

| ID | Item | Owner | Blocks | Notes |
|---|---|---|---|---|
| C-1 | Contract with a PSP or aggregator (cards, wallets, InstaPay, Fawry, Apple Pay) | Owner | P-16 | Provider list unverified (VR register). |
| C-2 | One BNPL partner contract | Owner | P-18 | Minimum age, refund routing are provider-specific. |
| C-3 | Funds-flow and collection/payout licensing opinion | Counsel | P-21, wallet scope | Long lead. Until known, payouts and any held balance stay behind kill switches. |
| C-4 | ETA onboarding and tax treatment | Owner, Finance | P-23 | VAT, credit-note flow unverified (I-11, I-38). |
| C-5 | Bosta contract and API access | Owner | P-24 | API specifics unverified. |
| C-6 | PDPC and PDPL licensing and DPO appointment | Owner, Counsel | P-31, F-2 | Lead time unknown (VR-20). |
| C-7 | Importer-of-record structure for foreign sellers | Counsel | Global world scope | VR-19. |
| C-8 | Apple Developer account, App Store Connect, App Review path | Owner | P-39 | VR-23. |

## 6. Research-driven validation experiments on the plan

These three tests decide whether parts of the plan are worth building. They need no production backend and must not collect real personal data until ADR-0002 is accepted. Thresholds below are proposals for the owner to set, not facts; market figures are unverified and are not used as inputs.

| ID | Experiment | Window | What it decides | Method | Decision rule (proposed, owner to set) |
|---|---|---|---|---|---|
| X-1 | Brand LOI sprint | Weeks 0 to 4, in parallel with A-tasks, finish before P-03 and P-32 are started | Whether seller supply and discount depth support the model; first catalog; which integration to build first (P-08) | Approach a target list of brands and liquidators; collect non-binding letters of intent: volume, discount depth, return terms, exclusivity, integration capability (Shopify, Woo, CSV). Record seller-agreement concerns (suspension, price-evidence duties). | Owner sets the number of LOIs and aggregate depth needed to proceed. Without it, hold P-03, P-08, P-32 and build only buyer-side vertical slices on fixtures. |
| X-2 | Truth Audit of 200 SKUs | Weeks 1 to 3, must finish before P-07 design is frozen | Which evidence tiers (E0 to E5) are actually reachable, therefore what the product can honestly show (percentage off or not), and ADR-0013 | Sample 200 SKUs across candidate sellers. For each, record the claimed reference price, whether the platform's own 30-day history, a seller channel history, a brand RRP or a document supports it, and the resulting tier. Use only manual, lawful sources; do not crawl until the crawler legality item in the verify register is resolved. Store no personal data. | Share of SKUs reaching E2 or better sets the launch display mode (lite versus percentage display) and the anomaly threshold default. Publish the sample method with the result; do not extrapolate it to the market. |
| X-3 | Device-split fake-door test | Weeks 1 to 4 | iOS-first versus earlier Android, and TestFlight-only beta size | Run a clearly labelled "coming soon" page and ads; measure outbound clicks by device OS for "iOS beta" and "Android notify me". No fake stock, timers, discounts or reviews; no unlabelled claims. Count anonymous clicks only; no phone numbers or emails until ADR-0002 is accepted and a consent flow exists. | Owner sets the Android share that would pull Android forward. Result also informs A-15 and P-39 sizing. Ad-network and App Store policy compliance to be checked (VERIFY BEFORE LAUNCH). |
| X-4 | Own COD baseline (supports P-17) | Weeks 4 to 8, needs courier data | Refusal and failed-delivery assumptions; COD limits and risk controls | Measure from a pilot or from partner data once available; do not use external COD rates as facts. | Sets default COD limits and deposits per area. VR-24. |

Placement: X-1, X-2 and X-3 start in week 0 to 1 and run alongside Phase 0 remainder tasks A-01 to A-20. Their results feed F-0 (Phase 0 exit) as inputs: the go or hold decision on P-03, P-08, P-32, and the display mode for P-07.

## 7. Critical path

Sequence (ideal days, from the dependency graph above):
A-02 (0.5) then A-05 Postgres in CI (3), A-06 Postgres adapters (5), A-09 auth endpoints (4), F-0 (1), P-01 (2), P-04 catalog (8), P-13 bag (5), P-15 checkout design (2), P-15b checkout implementation (8), P-20 ledger posting and reconciliation (8), P-23 ETA invoicing (10), P-25 returns and refunds (11), P-34 mobile checkout, orders and returns (15), P-36 security verification (4), F-2 (1), P-39 TestFlight (3), F-3 (1). Total 91.5 days.

Observations:
- Persistence adapters (A-06) are the first bottleneck: nearly every Phase 1 module needs them.
- ETA invoicing (P-23) precedes returns (credit notes) and so extends the path; if the ETA process cannot be tested early, P-25 and the release slip together.
- P-34 depends on P-25 only for the returns screens. Splitting the mobile task would shorten the path by up to 11 days, at the cost of a second integration pass.
- Items on the external list (section 5) are not in the day count. Any of C-1, C-3 or C-4 arriving late moves the date directly.
- A-18 (Terraform validation) is off the critical path but blocks the first deployed environment, which does not exist and is not planned before ADR-0002.

## 8. Checkpoints (Fable)

| ID | When | Reviews |
|---|---|---|
| F-0 | End of Phase 0 remainder | Ledger and outbox correctness on real Postgres, authz and RLS matrix, vocabulary reconciliation, privacy gate green, mutation and coverage gates met on money modules. |
| F-1 | Before any PSP, payout or order-posting code | Money design: checkout saga compensation, refund pivots, payout holdback, negative balances, dual approval. |
| F-2 | Before TestFlight | Privacy review (inventory, consent, deletion), legal copy, verify-register closure or explicit owner acceptance, security verification evidence. |
| F-3 | Phase 1 exit | Definition of Done per P4 for every shipped feature. |

## 9. Assumptions and open points

- Team size and number of parallel agents are unknown (open question 12); the critical path is the only team-independent figure.
- Estimates assume the vocabularies are reconciled first (A-01). Skipping it increases rework in P-14, P-15b, P-20 and P-25.
- Provider tasks (P-16, P-18, P-23, P-24, P-28) are scheduled against ports and fixtures until contracts exist. Their estimates exclude real-provider certification.
- Every Phase 1 task needs, per P4: spec (A3 template), Zod boundaries, negative authorization tests, AR/EN and RTL, analytics events, runbook and feature flag. These are included in the Sonnet day counts, not listed separately.
- No task here assumes a deployed backend. The first deployment depends on ADR-0002 and ADR-0016.
