# Phase 0–1 task breakdown

Outlex (code name Outlet NK) · web-first outlet marketplace · written 2026-11-07 · task P0-19.

**Status: draft for owner approval (P0-20).** No application code is written until the owner approves the Phase 0 pack.

Sources: `docs/BUILD-PROMPT.md` (§2, §9, §10), `docs/plan-and-risks.md`, `reports/Outlet NK end to end build plan.md` (sprints S0–S14, gates G0–G4), `docs/adr/`, `docs/data-model.md` (module index), `docs/compliance/verify-register.md` (V1–V78), `docs/open-questions.md`, `docs/outlet-nk-vision-addendum.md` (MVP features). The same tasks are loaded into the Build Tracker.

## 1. How to read this

**Calendar.** Week 1 starts Monday 9 November 2026. Sprints are two weeks: S0 = weeks 1–2 … S14 = weeks 29–30. Gates: **G0** end of week 6 (Phase 0 pack approved, 15+ brands, quotes) · **G1** week 10 (foundations done, PSP and courier signed) · **G2** week 20 (MVP feature freeze) · **G3** week 24 (launch checklist green, beta can start) · **G4** week 30 (beta results, public launch decision).

**Columns.**
- **ID** prefixes: `P0-` Phase 0 documents · `E-` Phase 0b engineering · `P1-` Phase 1 product and tech · `L-` company and legal · `B-` brands · `O-` operations · `M-` marketing · `F-` money.
- **Phase:** 0 (documents and business set-up), 0b (engineering foundations), 1 (web MVP and soft launch).
- **Owner:** Claude, Owner, Lawyer, Tax adviser, External, Ops lead. "Claude / Owner" means Claude does the work and the owner must approve a stop-and-ask step (hosting, production, contracts).
- **Estimate:** engineering in **ideal days** (`d`), business in **weeks** (`wk`). Group rows say `epic: N d` (sum of their tasks).
- **Depends on:** task IDs, owner decisions **D0–D9**, verify-register rows **V#**.
- **Two-key:** the area that needs a fresh-context reviewer subagent **and** explicit human approval before merge (`ledger`, `payments`, `checkout`, `inventory`, `auth`, `policy/RLS`, `privacy`, `pricing-integrity`, `payouts`). PRs get the `needs-human` label.

**Assumptions behind the numbers.**
- An **ideal day** is one focused day of Claude work on one task, including tests and the pasted evidence the Definition of Done (§9) asks for. The human reviewer's time is inside it, not added. It is **not** a calendar day.
- Team for engineering: **Claude plus one human reviewer** (task L-17). Claude can run several lanes in parallel; the human reviewer cannot. See section 4.
- **PR size:** every Phase 1 task targets **one PR of about 400 changed lines or less** (generated files excluded). If a task's diff grows past that, it is split into stacked PRs under the same ID (`P1-06c-1`, `P1-06c-2`); the ID does not change.
- **Ramadan 2027** (about 8 Feb–9 Mar, **V51** not yet confirmed) lowers capacity about **20% in S7–S9**, as instructed. By the expected dates Ramadan actually starts in the second week of S6 and ends with Eid al-Fitr (about 10–12 Mar) inside S8, so S9 may be near full capacity and S6 slightly lower. Re-check when V51 is confirmed.
- Owner decisions D0–D9 use the owner's 2026-11-07 "do whatever is best" defaults for documents only. Anything real (hosting, prices, contracts, legal texts, production) is still stop-and-ask.

## 2. Critical path

The longest chain runs through money and stock, then through the launch checks:

1. **Approval:** P0-13 OpenAPI skeleton and P0-17 ledger chart review → **P0-20 owner approval** (S0). Nothing in Phase 0b starts before this.
2. **Foundations (S1–S3):** E-01 monorepo and CI → E-03 local stack → E-06 policy + RLS → E-14 money type → **E-07 ledger core** (two-key). The human reviewer (**L-17**) must be in place by S1, or every two-key PR waits.
3. **Stock and payment (S6–S8):** P1-01b listings → **P1-05a–c row-per-unit inventory** → **P1-06a–g checkout saga and Paymob adapter**. This needs the written PSP split answer (**O-02 → D5, latest week 8**) and the **signed PSP and Bosta contracts (O-06, latest week 10)**; without sandbox credentials P1-06e cannot start.
4. **After the order (S8–S10):** P1-07b Bosta adapter → P1-07e orders and cancel → **P1-08a–f returns and refunds router** → **P1-19a–b payouts** → G2 feature freeze (week 20).
5. **Launch checks (S9–S11):** **P1-22 production environment** (needs D4, the E-04 residency spike by week 4, E-15 staging, L-03 licences and F-05 budget) → **P1-13b external pen test** (2 weeks) → P1-13c/d fixes → P1-13f/g k6 20× and Drop Hour simulation → P1-13h restore drill → **P1-14c G3 go/no-go** (week 24) → P1-14d beta (S12–S14) → G4 (week 30).

**Side chains that can become critical:**
- **Transfer licence:** L-03 filed in week 2 → L-12 decision about week 15 (90-day review). Until then no processor abroad (Sentry, PostHog, LLM, email) in production; E-11 self-hosts and P1-20 copilot stays off.
- **ETA:** L-08 signing token and preprod access by week 18 → P1-09b–d e-receipts and commission invoices in S9.
- **Brands:** B-03 15 letters of intent (week 6) → B-08 15 brands listing (S6) → B-09 30 brands (week 20) → G3.
- **Price history:** VRP needs 30 days of history. If brand sites connect to Price Watch in production only in S9–S10 (B-10), most beta listings at week 25 will honestly show "Launch price", not "% off", for their first weeks. That is correct behaviour, not a bug, but it weakens the launch story. Bringing P1-22 forward helps.

## 3. Tasks by track

### 3.1 Company & legal

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| L-01 | Hire an Egyptian lawyer | 0 | Owner | 1 wk | — | S0 | G0 | — | to do |
| L-02 | Register company, tax card and VAT | 0 | Owner / Lawyer | 2 wk | L-01 | S0–S2 | G0 | — | to do |
| L-03 | PDPC licences (controller, marketing, transfer) and DPO; the 1 Nov 2026 deadline has passed | 0 | Owner / Lawyer | 2 wk | L-01, V1, V40 | S0 | G3 | — | to do |
| L-04 | Send the verify register top 8 to counsel | 0 | Owner | 0.2 wk | L-01, P0-12 | S0 | G0 | — | to do |
| L-05 | Trademark search for the brand name (EG, KSA, UAE, Morocco) | 0 | Lawyer | 2 wk | L-01, V31, D7 | S0–S1 | G0 | — | to do |
| L-06 | Counsel first opinion on V2, V3, V8, V19 | 0 | Lawyer | 2 wk | L-04, V2, V3, V8, V19 | S1–S3 | G0 | — | to do |
| L-07 | Startup Charter application | 0 | Owner | 1 wk | L-02, V52 | S1 | G0 | — | to do |
| L-08 | ETA onboarding: registration, signing token, virtual POS, preprod access | 1 | Tax adviser | 6 wk | L-02, F-09, V6 | S2–S8 | G2 | — | to do |
| L-09 | Seller Agreement and seller-plan terms draft (price parity, monitoring consent, defect accuracy, DPA) | 1 | Lawyer | 3 wk | L-06, D1, V27, V28 | S3 | G3 | — | to do |
| L-10 | Privacy Policy and consent texts, AR and EN | 1 | Lawyer | 2 wk | L-03, P0-11 | S4 | G3 | — | to do |
| L-11 | Returns and defect policy text (V19 safe default) | 1 | Lawyer | 2 wk | L-06, V19, V7 | S5 | G2 | — | to do |
| L-12 | Transfer licence decision (about week 15): decides Sentry, email and LLM vendors abroad | 1 | Owner / Lawyer | 1 wk | L-03, V2, V39, V68 | S7 | G3 | — | to do |
| L-13 | Final legal pack, Arabic authoritative (ToS, store credit terms, review rules) | 1 | Lawyer | 3 wk | L-09, L-10, L-11 | S10 | G3 | — | to do |
| L-14 | Breach tabletop exercise (PDPC 72 h clock) | 1 | Owner / Lawyer | 0.5 wk | P1-21b | S11 | G3 | — | to do |
| L-15 | Counsel sign-off on public claims and rows V2, V3, V7, V8, V19, V20 | 1 | Lawyer | 2 wk | L-13, V7, V20 | S12–S14 | G4 | — | to do |
| L-16 | VAT opinion for ledger and commission (V59–V62, V64, V24) | 1 | Tax adviser | 2 wk | L-02, F-09, V59, V60, V61, V62, V64, V24 | S3–S4 | G2 | — | to do |
| L-17 | Hire or contract the human code reviewer (CTO or senior engineer) for two-key PRs | 0 | Owner | 2 wk | L-01 | S0–S1 | G1 | — | to do |

### 3.2 Brands

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| B-01 | List 50 target brands | 0 | Owner | 0.5 wk | — | S0 | G0 | — | to do |
| B-02 | Interview 30 brands | 0 | Owner | 4 wk | B-01 | S0–S2 | G0 | — | to do |
| B-03 | 15+ signed letters of intent (G0) | 0 | Owner | 6 wk | B-02 | S0–S2 | G0 | — | to do |
| B-04 | Hire the partnerships lead (brands) | 0 | Owner | 2 wk | — | S0–S1 | G0 | — | to do |
| B-05 | Confirm the launch wedge (women's, modest, kids) | 1 | Owner | 0.5 wk | B-02, D6 | S3 | G1 | — | to do |
| B-06 | Onboard the first 5 brands to a test Seller Center | 1 | Owner | 2 wk | B-03, P1-10b | S4 | G1 | — | to do |
| B-07 | Brand Street content and the defect photo standard | 1 | Owner / Ops lead | 2 wk | B-06 | S5 | G2 | — | to do |
| B-08 | 15 brands listing in staging | 1 | Owner | 2 wk | B-07, P1-10i | S6 | G2 | — | to do |
| B-09 | Grow to 25, then 30 brands signed and listing | 1 | Owner | 4 wk | B-08 | S8–S9 | G3 | — | to do |
| B-10 | Connect brands' websites to Price Watch in production 30+ days before beta | 1 | Owner | 2 wk | B-09, P1-22, P1-03f | S9–S10 | G3 | — | to do |
| B-11 | Launch-partner deals for the first 30 brands | 1 | Owner | 2 wk | B-09, D1, L-09 | S10 | G3 | — | to do |
| B-12 | Beta event schedule (Drop Hours, Eid al-Adha) | 1 | Owner | 1 wk | B-09 | S11 | G3 | — | to do |
| B-13 | Track the second-event rate (target 60%+) | 1 | Owner | 6 wk | P1-14d | S12–S14 | G4 | — | to do |

### 3.3 Product & tech

One track, shown in three parts so it reads on a phone. Bold rows are **groups** (epics); their estimate is the sum of their tasks and they are not counted twice in the totals.

**Phase 0: documents** (already written today, 2026-11-07, except where marked)

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| P0-01 | Build Tracker page ([link](https://claude.ai/artifact/2kdF8JALVr6UtrCgHExqqV)) | 0 | Claude | 0.5 d | — | pre-S0 | G0 | — | done |
| P0-02 | Open questions (max 12) ([link](../../docs/open-questions.md)) | 0 | Claude | 0.5 d | P0-01 | pre-S0 | G0 | — | done |
| P0-03 | ADR-0001 architecture (web-first) ([link](../../docs/adr/0001-architecture.md)) | 0 | Claude | 0.5 d | P0-02 | pre-S0 | G0 | — | done |
| P0-04 | ADR-0002 data residency (draft; decision D4) ([link](../../docs/adr/0002-data-residency.md)) | 0 | Claude | 1 d | P0-02, D4 | pre-S0 | G0 | — | done |
| P0-05 | ADR-0003 wallet as closed-loop store credit ([link](../../docs/adr/0003-wallet-store-credit.md)) | 0 | Claude | 0.5 d | P0-02, D5 | pre-S0 | G0 | — | done |
| P0-06 | ADR-0004 Plus billing and app stores (Phase 2) ([link](../../docs/adr/0004-plus-billing-app-store.md)) | 0 | Claude | 0.5 d | P0-02 | pre-S0 | G0 | — | done |
| P0-07 | ADR-0005 inventory row-per-unit ([link](../../docs/adr/0005-inventory-row-per-unit.md)) | 0 | Claude | 0.5 d | P0-02 | pre-S0 | G0 | — | done |
| P0-08 | ADR-0006 global-ready ([link](../../docs/adr/0006-global-ready-from-day-one.md)) | 0 | Claude | 0.25 d | — | pre-S0 | G0 | — | done |
| P0-09 | ADRs 0007–0010: web-first, seller plans, defect grading, search bake-off ([link](../../docs/adr/README.md)) | 0 | Claude | 1.5 d | P0-03 | pre-S0 | G0 | — | done |
| P0-10 | Full data model (ERD) with market_id everywhere ([link](../../docs/data-model.md)) | 0 | Claude | 3 d | P0-03, P0-08 | pre-S0 | G0 | — | done |
| P0-11 | data_inventory.yaml and RoPA draft ([link](../../data_inventory.yaml)) | 0 | Claude | 1.5 d | P0-10 | pre-S0 | G0 | — | done |
| P0-12 | Verify register V1–V78 (one number per item) ([link](../../docs/compliance/verify-register.md)) | 0 | Claude | 1 d | P0-02 | pre-S0 | G0 | — | done |
| P0-13 | OpenAPI skeleton for Phase 1 | 0 | Claude | 2 d | P0-10 | pre-S0 | G0 | — | in progress |
| P0-14 | Event taxonomy ([link](../../docs/analytics/events.md)) | 0 | Claude | 1 d | P0-10 | pre-S0 | G0 | — | done |
| P0-15 | STRIDE threat models ([link](../../docs/security/threat-models.md)) | 0 | Claude | 2 d | P0-10 | pre-S0 | G0 | — | done |
| P0-16 | ASVS 5.0 L2 matrix ([link](../../docs/security/asvs-5.0-l2-matrix.md)) | 0 | Claude | 1.5 d | P0-15 | pre-S0 | G0 | — | done |
| P0-17 | Ledger chart of accounts with worked examples ([link](../../docs/specs/ledger-chart-of-accounts.md)) | 0 | Claude | 1.5 d | P0-05, P0-10 | pre-S0 | G0 | ledger | in review |
| P0-18 | Design tokens (Outlex palette) ([link](../../docs/design/tokens.md)) | 0 | Claude | 1 d | — | pre-S0 | G0 | — | done |
| P0-19 | Phase 0–1 task breakdown loaded here | 0 | Claude | 1 d | P0-09, P0-10, P0-13 | pre-S0 | G0 | — | in review |
| P0-20 | Approve the Phase 0 pack (before any app code) | 0 | Owner | 0.5 wk | P0-13, P0-17, P0-19 | S0 | G0 | — | waiting |

**Phase 0b: engineering foundations** (starts only after P0-20)

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| E-01 | Monorepo, CI with every gate, SBOM and signing | 0b | Claude | 3 d | P0-20 | S1 | G1 | — | to do |
| E-02 | Agent safety: deny rules, hooks, gitleaks | 0b | Claude | 1 d | P0-20 | S1 | G1 | — | to do |
| E-03 | Local Docker stack (Postgres 16, Redis) | 0b | Claude | 1 d | E-01 | S1 | G1 | — | to do |
| E-04 | Residency spike: Huawei Cloud Cairo test (needs D4; no provisioning without owner OK) | 0b | Claude / Owner | 4 d | E-01, D4, V37, V38 | S1–S2 | G1 | — | to do |
| E-05 | Auth: OTP, Apple, Google, passkeys, refresh rotation, 18+ gate | 0b | Claude | 5 d | E-03, E-08, V8, V45 | S2 | G1 | auth | to do |
| E-06 | Policy guard and Postgres RLS with negative tests | 0b | Claude | 4 d | E-03 | S2 | G1 | policy/RLS | to do |
| E-07 | Ledger core with property tests | 0b | Claude | 5 d | E-06, E-14, P0-17 | S3 | G1 | ledger | to do |
| E-08 | Outbox, inbox and idempotency middleware | 0b | Claude | 3 d | E-03 | S2 | G1 | — | to do |
| E-09 | Consent and privacy core | 0b | Claude | 3 d | E-06 | S3 | G1 | privacy | to do |
| E-10 | i18n/RTL, tokens and core web components | 0b | Claude | 4 d | P0-18 | S2 | G1 | — | to do |
| E-11 | Observability (self-hosted) and feature flags | 0b | Claude | 2 d | E-01, V2 | S2 | G1 | — | to do |
| E-12 | Admin staff RBAC, just-in-time elevation and dual approval core | 0b | Claude | 2 d | E-06 | S4 | G1 | policy/RLS | to do |
| E-13 | Web shell: Next.js [market]-[locale], CSP nonces, security headers, PWA | 0b | Claude | 2 d | E-10 | S2 | G1 | — | to do |
| E-14 | Markets and config module; Money type (bigint minor units + currency, one rounding point) | 0b | Claude | 1.5 d | E-01 | S1 | G1 | ledger | to do |
| E-15 | Staging environment IaC in the chosen region (owner approves provisioning) | 0b | Claude / Owner | 3 d | E-04, D4, F-05 | S4 | G1 | — | to do |
| E-16 | Hash-chained audit log and PII-redacting logger | 0b | Claude | 1.5 d | E-03 | S1 | G1 | privacy | to do |

**Phase 1: web MVP, PR-sized tasks grouped by module**

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| **P1-01** | **Catalog, condition grading, defect card and QR passport ([link](../../docs/adr/0009-defect-grading-and-defect-passport.md))** (group: P1-01a, P1-01b, P1-01c, P1-01d, P1-01e, P1-01f, P1-01g) | 1 | Claude | epic: 11.5 d | E-06, E-14 | S5 | G2 | — | to do |
| P1-01a | Category tree and attribute sets (women's, modest, kids; multi-category ready) and brands | 1 | Claude | 1.5 d | E-06, E-14, D6 | S5 | G2 | — | to do |
| P1-01b | Listings and variants with seller legal identity fields | 1 | Claude | 2 d | P1-01a, E-08, V75 | S5 | G2 | — | to do |
| P1-01c | Media pipeline: type sniff, EXIF/GPS strip, AVIF/WebP, signed URLs | 1 | Claude | 1.5 d | E-03 | S4 | G2 | — | to do |
| P1-01d | Condition grades and structured defects; critical defects blocked (ADR-0009) | 1 | Claude | 1.5 d | P1-01b | S5 | G2 | — | to do |
| P1-01e | Defect card with photo hotspots and the 'I have seen N defects' tick | 1 | Claude | 1.5 d | P1-01d, P1-01c | S5 | G2 | — | to do |
| P1-01f | QR defect passport per unit (signed QR, public passport page) | 1 | Claude | 1.5 d | P1-01d | S5 | G2 | — | to do |
| P1-01g | Product page: gallery, seller identity, size chart, return eligibility | 1 | Claude | 2 d | P1-01e, E-13 | S5 | G2 | — | to do |
| **P1-02** | **Village, stores, shelves and Discover deals ([link](../../docs/design/ui-reference-spec.md))** (group: P1-02a, P1-02b, P1-02c, P1-02d, P1-02e, P1-02f, P1-02g, P1-02h) | 1 | Claude | epic: 13.5 d | P1-01 | S5–S8 | G2 | — | to do |
| P1-02a | Stores and Brand Street storefront builder (feature 31) | 1 | Claude | 2 d | P1-01b, P1-10a | S5 | G2 | — | to do |
| P1-02b | Village: 3D store carousel hero (keyboard, RTL, reduced motion) | 1 | Claude | 2 d | P1-02a, E-10 | S6 | G2 | — | to do |
| P1-02c | Store directory with Local / Global / Both and 'Ship within Egypt' filters | 1 | Claude | 1.5 d | P1-02a | S6 | G2 | — | to do |
| P1-02d | Store page: lit shelves and quick-view panel | 1 | Claude | 2 d | P1-02a, P1-01g | S6 | G2 | — | to do |
| P1-02e | Discover deals: shelves by verified discount band (plain price until VRP) | 1 | Claude | 1.5 d | P1-02d, P1-03b | S8 | G2 | — | to do |
| P1-02f | Drop Hour and Ramadan–Eid calendar engine (features 2, 47) | 1 | Claude | 2 d | P1-02a, P1-11c, V51 | S6 | G2 | — | to do |
| P1-02g | Outlet Parties: themed events (feature 3) | 1 | Claude | 1.5 d | P1-02f | S6 | G2 | — | to do |
| P1-02h | Brand display modes (public / member-only / hidden) and hidden-brand events | 1 | Claude | 1 d | P1-02a, D3 | S6 | G2 | — | to do |
| **P1-03** | **Price Watch v1 and VRP ([link](../../docs/specs/price-watch.md))** (group: P1-03a, P1-03b, P1-03c, P1-03d, P1-03e, P1-03f, P1-03g, P1-03h) | 1 | Claude | epic: 13.5 d | P1-01 | S6–S8 | G2 | — | to do |
| P1-03a | Price events ledger, 30-day low view, launch-price rule | 1 | Claude | 1.5 d | P1-01b, E-08 | S6 | G2 | pricing-integrity | to do |
| P1-03b | VRP calculator and display rules; property tests (never above the true 30-day min); mutation 80%+ | 1 | Claude | 2 d | P1-03a | S7 | G2 | pricing-integrity | to do |
| P1-03c | Connect a website: domain verification and product feed URL | 1 | Claude | 1.5 d | P1-03a, E-15 | S6 | G2 | pricing-integrity | to do |
| P1-03d | Shopify connector (OAuth, egress proxy, SSRF guard) | 1 | Claude | 2 d | P1-03c, V27 | S7 | G2 | pricing-integrity | to do |
| P1-03e | WooCommerce connector | 1 | Claude | 1.5 d | P1-03d | S7 | G2 | pricing-integrity | to do |
| P1-03f | Pre-publish check, auto-correction, parity rule, enforcement ladder (MVP subset) | 1 | Claude | 2 d | P1-03b, P1-03e, V15, V28 | S8 | G2 | pricing-integrity | to do |
| P1-03g | Evidence records, Price Trust Score and public price-proof page (feature 28) | 1 | Claude | 2 d | P1-03f | S8 | G2 | pricing-integrity | to do |
| P1-03h | Contract test: no '% off' without VRP anywhere; social-proof copy lint | 1 | Claude | 1 d | P1-03b, P1-01g | S8 | G2 | pricing-integrity | to do |
| **P1-04** | **Search bake-off, then search ([link](../../docs/adr/0010-search-engine-bake-off.md))** (group: P1-04a, P1-04b, P1-04c, P1-04d, P1-04e, P1-04f) | 1 | Claude | epic: 9.5 d | E-03 | S3–S6 | G2 | — | to do |
| P1-04a | Collect ~500 real Egyptian queries (AR, EN, Franco-Arabic); owner adds about 1 week | 1 | Owner / Claude | 1 d | B-02 | S3 | G1 | — | to do |
| P1-04b | Bake-off harness: Typesense, Meilisearch, OpenSearch, Postgres FTS; Arabic folding, Franco | 1 | Claude | 2 d | P1-04a, E-03, V67 | S3 | G1 | — | to do |
| P1-04c | Bake-off scorecard and ADR-0010 decision | 1 | Claude | 1 d | P1-04b, V47 | S3 | G1 | — | to do |
| P1-04d | Index schema and outbox sync (staleness under 60 s) | 1 | Claude | 1.5 d | P1-04c, P1-01b, E-08 | S6 | G2 | — | to do |
| P1-04e | Search API: filters, keyset pagination, rate limit | 1 | Claude | 2 d | P1-04d | S6 | G2 | — | to do |
| P1-04f | Search UI: suggestions, zero-result relax, Postgres FTS fallback behind a kill switch | 1 | Claude | 2 d | P1-04e | S7 | G2 | — | to do |
| **P1-05** | **Row-per-unit inventory and bag ([link](../../docs/adr/0005-inventory-row-per-unit.md))** (group: P1-05a, P1-05b, P1-05c, P1-05d, P1-05e, P1-05f, P1-05g) | 1 | Claude | epic: 11.5 d | E-07 | S6–S7 | G2 | — | to do |
| P1-05a | Inventory levels and the row-per-unit pool with replenisher | 1 | Claude | 2 d | P1-01b, E-08 | S6 | G2 | inventory | to do |
| P1-05b | Reserve, claim, release with SKIP LOCKED; reservation sweeper | 1 | Claude | 2 d | P1-05a | S6 | G2 | inventory | to do |
| P1-05c | No-oversell property and concurrency test (10k reserves on 100 units) | 1 | Claude | 1.5 d | P1-05b | S6 | G2 | inventory | to do |
| P1-05d | One-off defect units linked to passport; versioned seller stock sync | 1 | Claude | 1.5 d | P1-05b, P1-01f | S6 | G2 | inventory | to do |
| P1-05e | Bag API: server-side, grouped by store, limits, price-change notes | 1 | Claude | 2 d | P1-05b | S6 | G2 | — | to do |
| P1-05f | Bag UI: per-store free-delivery progress and store bundle discount (feature 6) | 1 | Claude | 2 d | P1-05e, P1-16a | S7 | G2 | — | to do |
| P1-05g | Redis sold-out pre-filter (never the truth) | 1 | Claude | 0.5 d | P1-05b | S6 | G2 | inventory | to do |
| **P1-16** | **Promotions v1** (group: P1-16a, P1-16b) | 1 | Claude | epic: 3.5 d | E-14 | S6–S7 | G2 | — | to do |
| P1-16a | Promotions domain: store vouchers, bundles, deterministic stacking; property tests, mutation 80%+ | 1 | Claude | 2 d | E-14 | S4 | G2 | — | to do |
| P1-16b | Seller and admin promotion screens; evaluate inside the checkout quote | 1 | Claude | 1.5 d | P1-16a, P1-11a | S7 | G2 | — | to do |
| **P1-06** | **Checkout saga, PSP adapter and webhooks** (group: P1-06a, P1-06b, P1-06c, P1-06d, P1-06e, P1-06f, P1-06g, P1-06h, P1-06i, P1-06j, P1-06k, P1-06l) | 1 | Claude | epic: 22.5 d | P1-05, D5 | S7–S8 | G2 | — | to do |
| P1-06a | Checkout quote (pure): VAT-inclusive totals, shipping, every fee on first render | 1 | Claude | 2 d | P1-05e, P1-16a, P1-07a | S7 | G2 | checkout | to do |
| P1-06b | Order group, seller order, order line and their state machines | 1 | Claude | 2 d | P1-06a | S7 | G2 | checkout | to do |
| P1-06c | Checkout saga part 1: validate, reserve, credit hold, payment intent | 1 | Claude | 2 d | P1-06b, P1-05b, E-08 | S7 | G2 | checkout | to do |
| P1-06d | Checkout saga part 2: compensations and chaos test (no double charge, no oversell) | 1 | Claude | 2 d | P1-06c | S7 | G2 | checkout | to do |
| P1-06e | PaymentProviderPort and Paymob adapter (sandbox) with Pact contract | 1 | Claude | 2 d | P1-06c, O-06, D5, V4, V41 | S7 | G2 | payments | to do |
| P1-06f | PSP webhooks: HMAC, IP allow-list, ±5 min window, raw store, dedup, poll fallback, DLQ replay | 1 | Claude | 2 d | P1-06e | S7 | G2 | payments | to do |
| P1-06g | Ledger posting on payment success and claim in the same transaction | 1 | Claude | 1.5 d | P1-06f, E-07 | S7 | G2 | ledger | to do |
| P1-06h | Fawry codes, wallets and InstaPay via the PSP; separate non-drop pool for Fawry | 1 | Claude | 2 d | P1-06e | S8 | G2 | payments | to do |
| P1-06i | Second PSP adapter (Kashier) with failover and per-method kill switches | 1 | Claude | 2 d | P1-06e, O-19 | S8 | G2 | payments | to do |
| P1-06j | Closed-loop store credit sub-balances and split tender (ADR-0003) | 1 | docs/adr/0003-wallet-store-credit.md | 2 d | P1-06g, V3 | S8 | G2 | ledger | to do |
| P1-06k | Checkout UI: Egyptian address (Bosta geo taxonomy), delivery, payment, review | 1 | Claude | 2 d | P1-06c, E-13 | S7 | G2 | checkout | to do |
| P1-06l | Checkout abuse controls: Turnstile, per-user/device limits, card-testing rules | 1 | Claude | 1 d | P1-06k | S8 | G2 | checkout | to do |
| **P1-17** | **COD with risk rules** (group: P1-17a, P1-17b, P1-17c) | 1 | Claude | epic: 5.5 d | P1-06 | S8 | G2 | — | to do |
| P1-17a | COD risk rules v1: caps, refusal history, address quality, decisions | 1 | Claude | 2 d | P1-06c, O-07, V12, V26, V78 | S8 | G2 | checkout | to do |
| P1-17b | COD confirmation by WhatsApp or OTP within 2 h, else auto-cancel | 1 | Claude | 2 d | P1-17a, P1-07f, O-15 | S8 | G2 | checkout | to do |
| P1-17c | COD clearing in the ledger; refusal handling and prepaid-next-time rule | 1 | Claude | 1.5 d | P1-17a, E-07 | S8 | G2 | ledger | to do |
| **P1-18** | **One BNPL method via the PSP** (group: P1-18a, P1-18b) | 1 | Claude | epic: 3 d | P1-06 | S8 | G2 | — | to do |
| P1-18a | BNPL via Paymob; provider terms shown; no 'from X/month' line without a quote API | 1 | Claude | 2 d | P1-06e, O-17, V5, V42 | S8 | G2 | payments | to do |
| P1-18b | BNPL clearing; refund cancels the loan; cash-conversion signals to risk | 1 | Claude | 1 d | P1-18a, E-07 | S8 | G2 | ledger | to do |
| **P1-07** | **Orders, Bosta shipping and labels ([link](../../docs/specs/shipping-domestic-international.md))** (group: P1-07a, P1-07b, P1-07c, P1-07d, P1-07e, P1-07f) | 1 | Claude | epic: 11.5 d | P1-06, O-01 | S6–S9 | G2 | — | to do |
| P1-07a | Shipping quote: zones, chargeable weight (property test), free-delivery threshold; mutation 80%+ | 1 | Claude | 2 d | E-14, O-01, V53 | S4 | G2 | — | to do |
| P1-07b | CourierPort and Bosta adapter: AWB, pickup, A6 label PDF, idempotent | 1 | Claude | 2 d | P1-06b, O-06, V11, V43 | S8 | G2 | — | to do |
| P1-07c | Tracking webhooks: normalised, deduped, gap polling; double replay = same state | 1 | Claude | 2 d | P1-07b | S8 | G2 | — | to do |
| P1-07d | Seller order flow: accept in 24 h or auto-cancel, pack, ship in 48 h | 1 | Claude | 2 d | P1-06b | S9 | G2 | checkout | to do |
| P1-07e | Shopper orders, tracking, cancel before shipping (runs the refund saga) | 1 | Claude | 1.5 d | P1-06b, P1-08d | S9 | G2 | checkout | to do |
| P1-07f | Transactional messages AR/EN (WhatsApp, SMS, email), quiet hours; WhatsApp pay links (feature 44) | 1 | Claude | 2 d | E-09, O-15, V44, V45 | S8 | G2 | — | to do |
| **P1-08** | **Returns, exchange-first and refunds router** (group: P1-08a, P1-08b, P1-08c, P1-08d, P1-08e, P1-08f) | 1 | Claude | epic: 11 d | P1-07 | S9 | G2 | — | to do |
| P1-08a | Return request: windows from delivered_at, reasons, defect rules, photos | 1 | Claude | 2 d | P1-07e, L-11, V19, V7 | S9 | G2 | — | to do |
| P1-08b | Exchange-first: instant size swap when in stock | 1 | Claude | 1.5 d | P1-08a, P1-05b | S9 | G2 | inventory | to do |
| P1-08c | Return pickup, 48 h inspection with auto-approve, dispute queue | 1 | Claude | 2 d | P1-08a, P1-07b | S9 | G2 | — | to do |
| P1-08d | Refunds router: per-method rules, state machine, ledger-first reversing entries | 1 | Claude | 2 d | P1-06g, E-07 | S9 | G2 | payments | to do |
| P1-08e | Partial refunds per line with voucher share; mutation 80%+ | 1 | Claude | 2 d | P1-08d | S9 | G2 | payments | to do |
| P1-08f | PSP refund calls, retries, manual review; dual approval above threshold | 1 | Claude | 1.5 d | P1-08d, P1-06e, F-06 | S9 | G2 | payments | to do |
| **P1-19** | **Payouts and reconciliation** (group: P1-19a, P1-19b, P1-19c, P1-19d, P1-19e) | 1 | Claude | epic: 9 d | P1-08 | S9–S10 | G3 | — | to do |
| P1-19a | Payout eligibility (closed + 3 days, no dispute), state machine, negative-balance netting | 1 | Claude | 2 d | P1-08d, E-07 | S9 | G2 | payouts | to do |
| P1-19b | Payout execution via SettlementPort; IBAN checksum and name match; dual approval | 1 | Claude | 2 d | P1-19a, D5, V41, V63, F-06 | S10 | G3 | payouts | to do |
| P1-19c | PSP settlement file import and match to psp_clearing | 1 | Claude | 2 d | P1-06f, E-07 | S10 | G3 | ledger | to do |
| P1-19d | Courier COD and BNPL settlement matching; unmatched → ticket and aging alert | 1 | Claude | 1.5 d | P1-17c, P1-07c, P1-18b | S10 | G3 | ledger | to do |
| P1-19e | Integrity job: trial balance 0, hash chain, signed daily snapshot, credit projection check | 1 | Claude | 1.5 d | E-07, E-16 | S10 | G3 | ledger | to do |
| **P1-09** | **ETA e-receipts and commission e-invoices** (group: P1-09a, P1-09b, P1-09c, P1-09d, P1-09e) | 1 | Claude | epic: 8 d | P1-06, L-08 | S9–S10 | G2 | — | to do |
| P1-09a | Tax engine: VAT categories, net/VAT/gross per line, one rounding point; property tests | 1 | Claude | 2 d | E-14, L-16, V59, V60, V61, V62 | S9 | G2 | — | to do |
| P1-09b | ETA adapter: submission queue, signing (token/HSM), status polling, storage | 1 | Claude | 2 d | P1-09a, L-08, V6 | S9 | G2 | — | to do |
| P1-09c | Commission e-invoices to sellers (B2B) | 1 | Claude | 1.5 d | P1-09b, P1-19a | S9 | G2 | — | to do |
| P1-09d | E-receipts for our own B2C supplies (delivery fees); preprod tests pass | 1 | Claude | 1.5 d | P1-09b | S9 | G2 | — | to do |
| P1-09e | Daily ETA reconciliation report (submitted / accepted / rejected) | 1 | Claude | 1 d | P1-09b | S10 | G3 | — | to do |
| **P1-10** | **Seller Center: KYC, listing wizard, orders, labels** (group: P1-10a, P1-10b, P1-10c, P1-10d, P1-10e, P1-10f, P1-10g, P1-10h, P1-10i, P1-10j, P1-10k, P1-10l, P1-10m) | 1 | Claude | epic: 21.5 d | E-05, E-06 | S4–S10 | G2 | — | to do |
| P1-10a | Seller onboarding, stores, staff roles, mandatory passkey or TOTP | 1 | Claude | 2 d | E-05, E-06 | S4 | G1 | auth | to do |
| P1-10b | KYC with Valify hosted flow and webhook; KYC state machine | 1 | Claude | 2 d | P1-10a, O-16, V46, V72, V73 | S4 | G1 | privacy | to do |
| P1-10c | Manual Ops check: commercial register, tax card, brand authorisation; IBAN checksum | 1 | Claude | 1.5 d | P1-10b | S5 | G2 | privacy | to do |
| P1-10d | Seller plans as versioned config (numbers wait for D1); commission snapshot | 1 | Claude | 1.5 d | P1-10a, D1 | S5 | G2 | — | to do |
| P1-10e | Listing wizard step 1: photos, condition and defects, live buyer preview | 1 | Claude | 2 d | P1-01d, P1-01c | S5 | G2 | — | to do |
| P1-10f | Wizard step 2: details (Arabic required), attributes, size chart checks | 1 | Claude | 2 d | P1-10e, P1-01a | S5 | G2 | — | to do |
| P1-10g | Wizard step 3: price and stock (Price Watch pre-publish hook) | 1 | Claude | 1.5 d | P1-10f, P1-05a | S6 | G2 | pricing-integrity | to do |
| P1-10h | Wizard step 4: shipping (weight and size required) | 1 | Claude | 1 d | P1-10g, P1-07a | S6 | G2 | — | to do |
| P1-10i | Review and publish with gates (defect photos, Arabic, size chart, price check) | 1 | Claude | 1.5 d | P1-10h | S6 | G2 | — | to do |
| P1-10j | Bulk CSV import with dry-run and error report | 1 | Claude | 2 d | P1-10i | S9 | G2 | — | to do |
| P1-10k | Seller orders, pick list, label print, return inspection screen | 1 | Claude | 2 d | P1-07b, P1-07d | S9 | G2 | — | to do |
| P1-10l | Seller finance: balances, payouts, statements, e-invoices | 1 | Claude | 1.5 d | P1-19a, P1-09c | S10 | G3 | — | to do |
| P1-10m | Cross-tenant negative tests for every Seller Center endpoint | 1 | Claude | 1 d | P1-10k | S10 | G3 | policy/RLS | to do |
| **P1-11** | **Admin essentials, DPO console and reconciliation console** (group: P1-11a, P1-11b, P1-11c, P1-11d, P1-11e, P1-11f, P1-11g, P1-11h, P1-11i) | 1 | Claude | epic: 14.5 d | E-12 | S4–S10 | G3 | — | to do |
| P1-11a | Admin shell: passkey + SSO, RBAC, PII-view reason codes, audit viewer | 1 | Claude | 2 d | E-12 | S4 | G1 | policy/RLS | to do |
| P1-11b | Seller and KYC queue, catalog moderation, 48 h takedown | 1 | Claude | 2 d | P1-11a, P1-10c | S5 | G2 | — | to do |
| P1-11c | Flags, kill switches and config (calendar, thresholds) with audit | 1 | Claude | 1 d | P1-11a | S5 | G2 | — | to do |
| P1-11d | Orders, returns and disputes console; refund dual approval | 1 | Claude | 2 d | P1-11a, P1-08c | S10 | G3 | payments | to do |
| P1-11e | Price integrity monitor: action log, appeals, human review of suspensions | 1 | Claude | 1.5 d | P1-11a, P1-03f, V15 | S10 | G3 | pricing-integrity | to do |
| P1-11f | DPO console part 1: DSAR queue (export ZIP, delete with cooling period) | 1 | Claude | 2 d | P1-11a, E-09, V1, V77 | S10 | G3 | privacy | to do |
| P1-11g | DPO console part 2: breach register, consent stats, transfer register | 1 | Claude | 1.5 d | P1-11f | S10 | G3 | privacy | to do |
| P1-11h | Reconciliation console: unmatched lines, aging, tickets | 1 | Claude | 1.5 d | P1-19c, P1-19d | S10 | G3 | ledger | to do |
| P1-11i | Tax (ETA) console | 1 | Claude | 1 d | P1-09e | S10 | G3 | — | to do |
| P1-23 | Privacy Center: consents, export, delete account, sessions | 1 | Claude | 2 d | E-09, E-13 | S5 | G2 | privacy | to do |
| **P1-15** | **MVP engagement features (first to cut if late)** (group: P1-15a, P1-15b, P1-15c, P1-15d, P1-15e) | 1 | Claude | epic: 9 d | P1-01, P1-07 | S9–S10 | G2 | — | to do |
| P1-15a | Size profiles: encrypted measurements, consent, kids without DOB | 1 | Claude | 2 d | E-09, V73, V74 | S9 | G2 | privacy | to do |
| P1-15b | My Size Only feed (feature 4) | 1 | Claude | 1.5 d | P1-15a, P1-04e | S9 | G2 | — | to do |
| P1-15c | Shared family wishlist: hashed share token, enumeration limit (feature 10) | 1 | Claude | 2 d | P1-05e | S10 | G2 | — | to do |
| P1-15d | Fit-photo reviews: verified purchase, image and text moderation (feature 11) | 1 | Claude | 2 d | P1-07e | S10 | G2 | — | to do |
| P1-15e | WhatsApp 'see it first' video request (feature 19) | 1 | Claude | 1.5 d | P1-07f, P1-01g | S10 | G2 | — | to do |
| P1-20 | Listing copilot via LLM gateway (PII scrubber; kill switch off until a transfer licence or in-region model) | 1 | Claude | 2 d | P1-10f, L-12, V2 | S10 | G3 | — | to do |
| **P1-12** | **SEO foundation** (group: P1-12a, P1-12b, P1-12c, P1-12d, P1-12e) | 1 | Claude | epic: 7.5 d | P1-02 | S10–S11 | G3 | — | to do |
| P1-12a | SSR/ISR pages, canonical, hreflang (ar-EG, en-EG, x-default), Arabic slugs with 301 aliases | 1 | Claude | 2 d | E-13, P1-01g | S10 | G3 | — | to do |
| P1-12b | Sharded sitemaps with lastmod from outbox; robots.txt (search bots in, training bots out) | 1 | Claude | 1.5 d | P1-12a, E-08, D8 | S10 | G3 | — | to do |
| P1-12c | JSON-LD Product/Offer/itemCondition/return policy; CI: JSON-LD = page = feed price | 1 | Claude | 1.5 d | P1-12a, P1-03h | S10 | G3 | pricing-integrity | to do |
| P1-12d | Lifecycle (out of stock 200, sold unit 410/301), facet allow-list, agent-ready feed (feature 8) | 1 | Claude | 1.5 d | P1-12a | S11 | G3 | — | to do |
| P1-12e | Search Console, Bing, Merchant Center; Lighthouse CI budgets | 1 | Claude / Owner | 1 d | P1-12b | S11 | G3 | — | to do |
| **P1-21** | **Observability and SLOs** (group: P1-21a, P1-21b, P1-21c) | 1 | Claude | epic: 5 d | E-11 | S10–S11 | G3 | — | to do |
| P1-21a | SLO dashboards and burn-rate alerts (checkout, webhook→PAID, API p95, reconciliation) | 1 | Claude | 2 d | E-11, P1-06f | S10 | G3 | — | to do |
| P1-21b | Runbooks and degraded-mode matrix (PSP, courier, search, Redis down); on-call rota | 1 | Claude | 1.5 d | P1-21a | S11 | G3 | — | to do |
| P1-21c | RUM Core Web Vitals and low-end Android baseline (docs/perf/) | 1 | Claude | 1.5 d | P1-21a, E-13 | S10 | G3 | — | to do |
| P1-22 | Production environment in the chosen region (IaC; owner approves provisioning and go-live) | 1 | Claude / Owner | 3 d | E-15, D4, L-03, F-05 | S9 | G3 | — | to do |
| **P1-13** | **Pen test, load test, Drop Hour simulation, restore drill** (group: P1-13a, P1-13c, P1-13d, P1-13e, P1-13f, P1-13g, P1-13h, P1-13i, P1-13j) | 1 | Claude | epic: 16 d | P1-08, P1-22 | S9–S11 | G3 | — | to do |
| P1-13a | Pen-test scope and vendor brief; ASVS matrix mapped to official IDs | 1 | Claude / Owner | 1 d | P0-16, V65 | S9 | G3 | — | to do |
| P1-13b | External pen test | 1 | External | 2 wk | P1-13a, P1-22 | S10 | G3 | — | to do |
| P1-13c | Pen-test fixes, batch 1 (size unknown until the report) | 1 | Claude | 2 d | P1-13b | S11 | G3 | varies | to do |
| P1-13d | Pen-test fixes, batch 2 and retest | 1 | Claude | 2 d | P1-13c | S11 | G3 | varies | to do |
| P1-13e | Waiting room and Drop Hour edge setup (signed tokens, per-user limits) | 1 | Claude | 2 d | P1-22, O-18, V16, V48 | S10 | G3 | — | to do |
| P1-13f | k6 load test at 20× baseline | 1 | Claude | 2 d | P1-13e, P1-05c | S11 | G3 | — | to do |
| P1-13g | Drop Hour simulation: 50k virtual users on 500 units, zero oversell, FIFO ±1% | 1 | Claude | 2 d | P1-13f | S11 | G3 | inventory | to do |
| P1-13h | Restore drill (RPO ≤ 15 min, RTO ≤ 1 h) with integrity job | 1 | Claude | 1.5 d | P1-22, P1-19e | S11 | G3 | — | to do |
| P1-13i | PCI SAQ A evidence: CSP nonces, SRI, script inventory, payment-page monitor | 1 | Claude | 1.5 d | E-13 | S10 | G3 | payments | to do |
| P1-13j | WCAG 2.2 AA and RTL audit; 5-user tests per major flow | 1 | Claude / Owner | 2 d | E-10 | S11 | G3 | — | to do |
| **P1-14** | **Soft-launch beta (invite-only, Greater Cairo)** (group: P1-14a, P1-14b, P1-14e) | 1 | Claude | epic: 13.5 d | P1-13 | S11–S14 | G4 | — | to do |
| P1-14a | Invite gate, waitlist invites and beta flags | 1 | Claude | 1.5 d | P1-22 | S11 | G3 | — | to do |
| P1-14b | Beta metrics dashboard: COD refusal, returns, defect disputes, repeat, second event | 1 | Claude | 2 d | P1-21a | S11 | G3 | — | to do |
| P1-14c | G3 go/no-go: every launch row green; owner approves production go-live | 1 | Owner | 0.5 wk | P1-13d, P1-13g, P1-13h, L-13, L-03, B-09 | S11 | G3 | — | to do |
| P1-14d | Run the invite-only beta (Eid al-Adha event ~16 May) | 1 | Owner / Ops lead | 6 wk | P1-14c | S12–S14 | G4 | — | to do |
| P1-14e | Beta fix buffer (weekly fixes; size is a guess) | 1 | Claude | 10 d | P1-14d | S12–S14 | G4 | varies | to do |

### 3.4 Operations

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| O-01 | Bosta and Aramex quotes with real COD refusal data | 0 | Owner | 3 wk | — | S0–S1 | G0 | — | to do |
| O-02 | Written marketplace-split question to Paymob and Kashier | 0 | Owner | 3 wk | V4, V41 | S0–S1 | G0 | — | to do |
| O-03 | Contact one BNPL provider | 0 | Owner | 2 wk | V5 | S0 | G0 | — | to do |
| O-04 | Compare courier and PSP quotes | 0 | Owner | 1 wk | O-01, O-02 | S2 | G0 | — | to do |
| O-05 | Return-flow design with couriers | 1 | Ops lead | 2 wk | O-01, O-14 | S3 | G1 | — | to do |
| O-06 | Sign the primary PSP and Bosta contracts | 1 | Owner | 2 wk | O-04, D5, L-02, L-06 | S4 | G1 | — | to do |
| O-07 | Define COD risk rules and caps | 1 | Ops lead / Claude | 1 wk | O-01, V12, V26 | S5 | G2 | — | to do |
| O-08 | Fawry and InstaPay test flows | 1 | Ops lead | 1 wk | P1-06h | S8 | G2 | — | to do |
| O-09 | Bosta sandbox tests: AWB, pickup, tracking | 1 | Ops lead | 1 wk | P1-07b | S8 | G2 | — | to do |
| O-10 | Return pickups and COD remittance reconciliation process | 1 | Ops lead | 2 wk | P1-08c, P1-19d | S9 | G2 | — | to do |
| O-11 | Hire support and ops staff; WhatsApp inbox macros | 1 | Ops lead | 3 wk | O-14 | S10 | G3 | — | to do |
| O-12 | Beta operations runbook | 1 | Ops lead | 1 wk | O-11 | S11 | G3 | — | to do |
| O-13 | Measure COD refusal, returns and defect disputes | 1 | Ops lead | 6 wk | P1-14d | S12–S14 | G4 | — | to do |
| O-14 | Hire the operations lead | 0 | Owner | 3 wk | — | S2–S4 | G1 | — | to do |
| O-15 | SMS (two providers) and WhatsApp BSP contracts | 1 | Owner | 3 wk | L-02, V44, V45 | S3–S4 | G2 | — | to do |
| O-16 | Valify KYC contract (residency, price) | 1 | Owner | 2 wk | L-02, V46 | S3 | G1 | — | to do |
| O-17 | Enable one BNPL method through Paymob | 1 | Owner | 3 wk | O-06, V5, V42 | S5–S6 | G2 | — | to do |
| O-18 | Cloudflare plan for Waiting Room and bots (Business vs Enterprise) | 1 | Owner | 1 wk | V16, V48 | S8 | G3 | — | to do |
| O-19 | Sign the second PSP (Kashier) for failover | 1 | Owner | 2 wk | O-06 | S6 | G2 | — | to do |

### 3.5 Marketing

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| M-01 | WhatsApp Channel and Instagram waitlist | 0 | Owner | 1 wk | — | S0 | G0 | — | to do |
| M-02 | Brand identity | 0 | Owner | 3 wk | D7 | S1 | G0 | — | to do |
| M-03 | First «لاقي العيب» videos | 0 | Owner | 2 wk | M-02 | S2 | G0 | — | to do |
| M-04 | Ramadan content calendar | 1 | Owner | 1 wk | M-02, V51 | S3 | G1 | — | to do |
| M-05 | Ramadan pre-launch content | 1 | Owner | 2 wk | M-04 | S6 | G2 | — | to do |
| M-06 | Eid al-Fitr social posts | 1 | Owner | 1 wk | M-05 | S8 | G2 | — | to do |
| M-07 | Beta invite design | 1 | Owner | 1 wk | M-02 | S9 | G2 | — | to do |
| M-08 | Creator shortlist | 1 | Owner | 2 wk | — | S10 | G3 | — | to do |
| M-09 | Invite the waitlist | 1 | Owner | 1 wk | M-07, P1-14a | S11 | G3 | — | to do |
| M-10 | «عيبه مكتوب» campaign production (real numbers only) | 1 | Owner | 6 wk | L-15, V20, V57 | S12–S14 | G4 | — | to do |

### 3.6 Money

| ID | Task | Phase | Owner | Estimate | Depends on | Sprint | Gate | Two-key | Status |
|---|---|---|---|---|---|---|---|---|---|
| F-01 | 18-month budget | 0 | Owner | 1 wk | — | S0 | G0 | — | to do |
| F-02 | Funding path (decision D9) | 0 | Owner | 1 wk | F-01, D9 | S0–S2 | G0 | — | waiting |
| F-03 | Pre-seed conversations (if D9 says raise) | 0 | Owner | 4 wk | F-02 | S1–S3 | G0 | — | to do |
| F-04 | Pre-seed close target | 1 | Owner | 2 wk | F-03 | S6 | G2 | — | to do |
| F-05 | Approve cloud and tooling budget before any provisioning | 0 | Owner | 0.5 wk | D4, E-04, V37, V48 | S2 | G1 | — | to do |
| F-06 | Set dual-approval thresholds for payouts and refunds | 1 | Owner | 0.5 wk | P0-17 | S8 | G2 | — | to do |
| F-07 | Name and train the daily reconciliation owner | 1 | Owner | 1 wk | P1-11h | S10–S11 | G3 | — | to do |
| F-08 | Seed preparation with beta data (runway 9+ months) | 1 | Owner | 6 wk | P1-14d | S12–S14 | G4 | — | to do |
| F-09 | Engage an accountant and tax adviser | 0 | Owner | 1 wk | L-02 | S0 | G0 | — | to do |

## 4. Engineering load per sprint

Claude ideal days that **start** in each sprint (tasks owned by Claude or shared with Claude; epics not counted twice). "Lanes needed" = load ÷ (10 working days × capacity). Capacity is 1.0, or 0.8 in S7–S9 for Ramadan as instructed.

| Sprint | Weeks | Dates | Claude ideal days | Capacity | Lanes needed | Gate at end |
|---|---|---|---|---|---|---|
| S0 | 1–2 | 9–22 Nov 2026 | 0 | 1 | 0.0 | — |
| S1 | 3–4 | 23 Nov–6 Dec | 12 | 1 | 1.2 | — |
| S2 | 5–6 | 7–20 Dec | 20 | 1 | 2.0 | G0 (wk 6) |
| S3 | 7–8 | 21 Dec–3 Jan | 12 | 1 | 1.2 | — |
| S4 | 9–10 | 4–17 Jan 2027 | 16.5 | 1 | 1.6 | G1 (wk 10) |
| S5 | 11–12 | 18–31 Jan | 24 | 1 | 2.4 | — |
| S6 | 13–14 | 1–14 Feb | 30 | 1 | 3.0 | — |
| S7 | 15–16 | 15–28 Feb | 26.5 | 0.8 | 3.3 | — |
| S8 | 17–18 | 1–14 Mar | 26 | 0.8 | 3.2 | — |
| S9 | 19–20 | 15–28 Mar | 35 | 0.8 | 4.4 | G2 (wk 20) |
| S10 | 21–22 | 29 Mar–11 Apr | 39.5 | 1 | 4.0 | — |
| S11 | 23–24 | 12–25 Apr | 19 | 1 | 1.9 | G3 (wk 24) |
| S12 | 25–26 | 26 Apr–9 May | 10 | 1 | 1.0 | — |
| S13 | 27–28 | 10–23 May | 0 | 1 | 0.0 | — |
| S14 | 29–30 | 24 May–6 Jun | 0 | 1 | 0.0 | G4 (wk 30) |
| **Total** | | | **270.5** | | | |

S12 shows the 10-day beta fix buffer (P1-14e), which is spread over S12–S14. Phase 0 documents (21.25 d) were done before S0 and are not in this table.

## 5. Totals

### 5.1 Task counts by track and phase (groups/epics counted as rows)

| Track | Phase 0 | Phase 0b | Phase 1 | Total |
|---|---|---|---|---|
| Company & legal | 8 | 0 | 9 | 17 |
| Brands | 4 | 0 | 9 | 13 |
| Product & tech | 20 | 16 | 150 | 186 |
| Operations | 5 | 0 | 14 | 19 |
| Marketing | 3 | 0 | 7 | 10 |
| Money | 5 | 0 | 4 | 9 |
| **All** | **45** | **16** | **193** | **254** |

Of these, 20 rows are groups (epics) in Phase 1, so there are 234 workable tasks.

### 5.2 Engineering ideal days by phase and owner

| Phase | Claude (incl. shared) | Of which two-key | Done already | Left |
|---|---|---|---|---|
| 0 | 21.25 | 1.5 | 16.75 | 4.5 |
| 0b | 45 | 22 | 0 | 45 |
| 1 | 225.5 | 97 | 0 | 225.5 |
| **All** | **291.75** | **122.5** | **16.75** | **275** |

Two-key tasks: 65 of 162 engineering tasks. The P1-13c/d pen-test fixes and P1-14e beta buffer are marked "varies": they become two-key when they touch a two-key area.

### 5.3 Business effort in weeks by owner

These are **elapsed weeks per task, added up**. Many run at the same time, so the sum is a workload signal, not a calendar length.

| Owner | Weeks (sum) | Tasks |
|---|---|---|
| Owner | 99.2 | 48 |
| Lawyer | 16 | 7 |
| Ops lead | 16 | 7 |
| Tax adviser | 8 | 2 |
| Owner / Ops lead | 8 | 2 |
| Owner / Lawyer | 5.5 | 4 |
| External | 2 | 1 |
| Ops lead / Claude | 1 | 1 |
| **All** | **155.7** | **72** |

## 6. Honest notes on the estimates

- **No baseline yet.** There is no measured velocity for Claude + one reviewer on this codebase. Every number above is an estimate. Re-estimate after S1–S2 using real PR cycle times (open → merged) and update the tracker.
- **Review is the real limit.** The build plan sized the build for about 5 engineers. This plan uses Claude plus one human reviewer. The load table shows **2.4 to 4.4 parallel lanes** in S5–S10. Claude can run lanes in parallel; one person cannot review that much. At about 1–2 PRs per ideal day, Phase 1 is roughly **225–450 PRs in about 8 sprints, or 3–6 PRs per working day**, and about 40% of the engineering days are two-key. **Recommendation:** add a second human reviewer (the CTO and senior backend engineer from the hiring plan) by S5, or use the cut list in section 7.
- **Integrations are the most likely to slip.** Paymob, Kashier, Bosta, ETA and Valify estimates assume documentation and sandboxes we have not seen (V41, V43, V6, V46). Expect 30–50% more time on P1-06e, P1-06i, P1-07b, P1-09b and P1-10b. This contingency is **not** included in the totals.
- **Placeholders.** Pen-test fixes (P1-13c/d, 4 d) and the beta fix buffer (P1-14e, 10 d) are guesses; their real size is unknown until the report and the beta.
- **Business weeks are elapsed time**, mostly owner time. External lead times we do not control dominate: PDPC review (up to 90 days), counsel opinions, PSP onboarding, ETA signing tokens.
- **G2 freeze vs S10 work.** The build plan places several features in S10, after the week-20 freeze. This breakdown keeps launch-hardening work there (payout execution, consoles, SEO, observability) and marks the S10 engagement features (P1-15c–e) and P1-20 copilot as the first to cut.
- **Public holidays are not modelled:** Coptic Christmas (7 Jan, S4), 25 January (S5), Eid al-Fitr (S8), Sinai Liberation Day (25 Apr, S11), Labour Day and Sham el-Nessim (early May, S12). Dates are approximate.
- **Older code (D0 = A)** on `feat/phase-0-foundations` may shorten E-07, E-08 and P1-05 if reviewed parts are ported. No saving is subtracted, because ported code still needs fresh tests and two-key review.

## 7. Cut list if we are late at G2

Cut in this order, and move each item to Phase 2:
1. P1-15c–e: shared family wishlist, fit-photo reviews, "see it first" video.
2. P1-20 listing copilot (it is blocked by the transfer licence anyway).
3. P1-15a–b: size profiles and My Size Only feed.
4. P1-02g Outlet Parties (keep Drop Hour).
5. P1-10j bulk CSV import (brands list by the wizard).
6. P1-06i second PSP. Risk: no payment failover at beta; keep per-method kill switches.

**Never cut:** tests, two-key review, the pen test, the k6 and Drop Hour tests, the restore drill, reconciliation, the Arabic legal pack.

## 8. Changes to the Build Tracker list

- **Kept** all existing codes: P0-01..P0-20, L-01..L-05, B-01..B-03, O-01..O-03, M-01..M-03, F-01..F-02, E-01..E-11, P1-01..P1-14.
- **Status updates:** P0-02 to P0-12, P0-14 to P0-16 and P0-18 are done; P0-17 ledger chart is in review (two-key); P0-13 OpenAPI is in progress; P0-19 (this file) is in review; P0-20 waits for the owner.
- **Changed:** P0-12 now says V1–V78. P0-15 depends on P0-10, not P0-13 (it was written before the OpenAPI file). L-04, B-01 and F-02 estimates are now in weeks, like other business tasks.
- **P1-08 narrowed** to returns, exchange-first and refunds; payouts and reconciliation moved to the new **P1-19**. **P1-10** now includes the listing wizard (P1-10e–i). **P1-13** and **P1-14** are now groups.
- **New codes:** L-06..L-17, B-04..B-13, O-04..O-19, M-04..M-10, F-03..F-09, E-12..E-16, the lettered Phase 1 tasks (P1-01a …), and P1-15..P1-23 (P1-21 observability, P1-22 production, P1-23 Privacy Center; P1-17 COD, P1-18 BNPL, P1-16 promotions, P1-20 copilot).
- **Group rows** (P1-01 … P1-21 epics) have the estimate `epic: N d`. The tracker should leave rows whose estimate starts with `epic` out of "% complete" so work is not counted twice.
