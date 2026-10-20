# Phase 3 plan: Scale and Wow

Status: **Draft for owner approval.** Date: 2026-10-12. Source: master prompt P3, §28, §15.4, §B2, §B7, §10, §11, §20.5, §20.6, §20.8. Specs: `docs/specs/phase-3/`. ADRs: 0036-0041 (Proposed). New VERIFY rows: VR-P3-01 to VR-P3-15 in `docs/compliance/verify-register.md`.
Sizing: S = up to 1 engineer-week, M = 2-3, L = 4-6, XL = more than 6, for a builder pair including tests and docs. Tiers per the global table (Opus architect, Sonnet builder/tester, Haiku quick fix, Fable chief-reviewer checkpoint). Engineering proceeds on synthetic data and fake adapters; nothing here enables real money, real personal data or a new market.

## Honest status and assumptions
- Read for this plan: the master prompt, `docs/plan/phase-2-plan.md`, `phase-2-integration.md`, the Phase 2 specs 04, 05, 09, ADR-0003, 0008, 0025, the module directory list under `apps/api/src/modules` and port files of subscriptions, payments and stylist. I did **not** audit the source of every module; "exists" below means the module directory and its Phase 2 spec exist, and `phase-2-integration.md` lists it as wired with dev fakes.
- Phase 2 exit (task 20 of the Phase 2 plan: 20x load, restore drill, Fable milestone review) is not confirmed complete. Phase 3 wave A may start in parallel with Phase 2 hardening because it only extends modules through ports, but **no Phase 3 feature may go live before Phase 2 exit and ADR-0002/0003/0019 Accepted**.
- Production adapters are still unconfigured by design (ADR-0029). Every Phase 3 external integration therefore lands as port + fake + contract test, flag off.
- Unknowns are tagged VR-P3-xx. No Egyptian or GCC legal fact is asserted in these documents.
- Kill-switch polarity follows ADR-0028 (Proposed); specs say "kill switch engaged" meaning the feature is disabled.
- Phase 3 is large. Realistic scope: waves A-C engineering plus gated enablement. GCC per-country enablement, partner wallet and C2C are options, not commitments.

## Feature table
Legend for "Build now": **Y** = full domain, API, tests on synthetic data; **P** = partial (what can be built is listed); **N** = wait.

| # | Feature | Depends on (existing) | Size | Tier | Gate (VERIFY / ADR) | Build now | Must wait for |
|---|---|---|---|---|---|---|---|
| 1 | **Stylist chat** (spec P3-07) | stylist, llm-gateway, search, budget (band), sizing labels | L | Opus (tool/planner design, eval set) + Sonnet; **Fable** security sign-off on LLM04/06 | ADR-0025, VR-02, VR-P2-12, VR-P3-15 | **Y**: intent/slot parser, planner, tools, quotas, rules fallback, adversarial golden set, fake LLM | Real provider and any P2 text leaving region |
| 2 | **Outfit calendar** (P3-02) | stylist, wishlists, notifications, budget filter | M | Sonnet (Opus review of delivery-feasibility rule) | none own; DPO note for device-calendar read | **Y** | Wardrobe slots (item 3) for "owned items" |
| 3 | **Wardrobe digitization** | upload pipeline, product_attributes extractor, stylist, privacy (deletion) | M | Opus (privacy design) + Sonnet | VR-P3-13 (image vendor residency) | **P**: manual add by catalog/purchase history ("from my orders"), attribute extraction on fake vision port, deletion/export | Photo-to-attribute via real vision vendor |
| 4 | **Visual search** (P3-08) | embeddings/attributes pipeline, pgvector (ADR-0023), search, upload pipeline | L | Opus (index/versioning, privacy) + Sonnet | VR-P3-13, ADR-0023, ADR-0002 | **Y**: port, fake embedder, retrieval, re-rank, zero-retention upload, eval harness | Real embedder, labelled set, region decision |
| 5 | **Photo body measurement, on-device** | sizing (profiles, P3 encryption), consent `measurements`, mobile | L | Opus (privacy/accuracy design) + Sonnet native; **Fable** privacy sign-off | ADR-0039, VR-P3-06 | **P**: server contract for submitting reviewed numbers, confidence schema, UX spec, test harness with synthetic landmarks | Pose model licence/choice, device testing, accuracy study |
| 6 | **LTR ranking v2** | recommendations (v1 GBDT, `ranking_models`), history events, seller-analytics, experiments | L | Opus (offline eval, counterfactual/bias) + Sonnet | none legal; needs enough real interaction data and A/B framework | **P**: offline training/eval pipeline, feature store contracts, position-bias correction on synthetic logs, shadow-serve harness, model card | Real traffic for training and online A/B; guardrails sign-off |
| 7 | **Live shopping** | drops, waiting-room, reviews moderation, notifications, stores | L | Opus (realtime/moderation design) + Sonnet | VR-P3-11, vendor/residency decision (new ADR when chosen) | **P**: session/pinned-product/chat-moderation domain, state machine, fake video provider port | Video vendor, moderation law |
| 8 | **Creators and affiliates** (P3-04) | referrals graph, ledger, orders/returns, payouts, stylist | L | Opus (ledger design) + Sonnet; **Fable** ledger and payout checkpoint | ADR-0037, VR-17, VR-P3-03, VR-P3-04 | **Y**: attribution, accrual, clawback, dashboards, fake payout port | Cash payouts, real KYC vendor |
| 9 | **Resale: trade-in (and C2C option)** | resale-lane, returns, hub, store-credit, ledger | M (trade-in) / L (C2C) | Opus (money/liability) + Sonnet; **Fable** if C2C money flow built | ADR-0038, VR-P3-05, VR-P2-09 | **P**: trade-in quote/inspection/credit flow behind flags only if owner picks it; C2C stays spec-only | Owner choice; Legal/Tax |
| 10 | **Shopper web with SEO** (P3-06) | public catalog/search/price-integrity read, auth, ui-web, CSP baseline | L | Sonnet builder, Opus review of SEO/consent/CSP; tester for a11y | VR-P3-12; checkout increment needs PSP hosted page (VR-04) | **Y** read-only increments 1-2 | Web checkout; consent copy sign-off |
| 11 | **Odoo channel integration** | seller channel integrations (Shopify/Woo), price-integrity evidence, inventory sync | M | Sonnet | VR-P3-10 | **Y**: adapter + contract tests against recorded fixtures (hand-authored, labelled as such) | Real sandbox, API terms |
| 12 | **Family and student plans** (P3-03) | subscriptions, entitlements, age_policy, PersonKeyPort | M | Opus (seat/proration design) + Sonnet; tester for property tests | ADR-0012, VR-08, VR-P3-09, VR-P2-01/02, VR-10/23 | **Y** with fake verifier and fake recurring | Student verifier vendor, live billing, App Review outcome |
| 13 | **Demand forecasting** (P3-05) | seller-analytics warehouse feed, orders, inventory, returns | M | Opus (model/backtest design) + Sonnet | VR-P3-14 | **Y**: baseline + backtest + reconciliation on synthetic series | Real history (months) before trusting any model |
| 14 | **Price-drop auto-buy** (P3-01) | wishlists alerts, price-integrity, subscriptions, checkout saga, payments tokens | M (mode A: S) | Opus (money design) + Sonnet; **Fable** money/security checkpoint before any enablement | ADR-0036, VR-P3-01, VR-P3-02, VR-04, VR-F1-* | **Y**: mandate, state machine, evaluator, notify mode, fake MIT adapter | Unattended charging |
| 15 | **Partner e-money wallet** | store-credit separation, `WalletProviderPort` (port to define), ledger | S now / XL later | Opus (port + separation) ; **Fable** before any adapter | ADR-0041, VR-03, VR-F1-04, VR-P3-08 | **P**: port, `PartnerWalletAccount` separation test, kill switch; **no** adapter | Everything else, owner decision |
| 16 | **GCC expansion foundation** | money (integer minor units), i18n, tax-eta, legal-text bundles, courier/PSP ports | L foundation, XL per country | Opus (design) + Sonnet | ADR-0040, VR-P3-07, ADR-0002 | **P**: `market` config abstraction, currency exponent handling, tax-table seam, locale and legal bundle seams, all with single `EG` value | Country choice, law and tax research, entity |
| 17 | **Session-based recommendations** (§20.6 P3) | history events, recommendations | M | Opus + Sonnet | personalization consent only | **P**: offline sequence model on synthetic logs (fold into LTR v2 track) | Real sessions |
| 18 | **Phase 3 hardening**: authz negative tests, Pact, mutation on creators, auto-buy, family billing, partner wallet port; chaos; load for web and live | all above | M | Sonnet (tester) | none | Y, rolling | none |

## What stays fake until evidence exists
Every PSP MIT call, creator payout transfer, student verifier, LLM provider, vision/embedding vendor, video vendor, Odoo sandbox, pose model. Each has a port, a fake and a contract test; production selection fails closed per ADR-0029.

## Dependencies on Phase 2 decisions still Proposed
ADR-0023 (vector store) for items 3, 4, 17; ADR-0025 (LLM provider and residency) for items 1, 3; ADR-0024 (waiting room) for item 7; ADR-0004/0012 for item 12; ADR-0002/0003/0019 for everything real.

## Recommended wave order (max 6 parallel agents per wave)
**Wave A, start now (6 agents):** the highest value that needs no external gate, all extending existing modules through ports.
1. Price-drop auto-buy (mode A + dark mode B) - Opus design, Sonnet build
2. Family and student plans - Opus + Sonnet
3. Stylist chat - Opus + Sonnet
4. Outfit calendar - Sonnet
5. Demand forecasting baseline + backtest - Opus + Sonnet
6. Visual search retrieval path + eval harness - Opus + Sonnet
*Fable checkpoint after wave A:* auto-buy money path (hand-off design, ledger, saga reuse) and chat LLM safeguards.

**Wave B (6 agents), after A integrates:**
1. Creators and affiliates (domain, ledger, accrual; Fable checkpoint on ledger additions)
2. Shopper web read-only (SEO, consent, CSP; increments 1-2)
3. LTR ranking v2 offline pipeline + session model
4. Odoo adapter
5. Wardrobe digitization (manual + fake vision)
6. GCC `market` abstraction seams (EG only)

**Wave C (up to 6), conditional on owner decisions:**
1. Live shopping domain (if VR-P3-11 path acceptable)
2. Photo measurement server contract + mobile native spike (needs device and DPO approval, ADR-0039)
3. Trade-in resale (only if owner chooses ADR-0038 option 1)
4. Partner wallet port and separation tests (S)
5. Mobile UI for waves A-B features (RTL/AR, states)
6. Seller and admin UI for creators, forecasts, family plan admin

**Wave D, gated enablement (no parallel limit issue):** web checkout increment, MIT enablement, creator payouts, real LLM provider for chat, student verifier, per-feature Phase 3 exit review (load 20x on web and live, restore drill, security and privacy review, Fable milestone review).

## Critical path
Owner decisions on ADR-0025 and ADR-0023 -> chat and visual search real providers. Evidence for VR-P3-01/02 -> auto-buy mode B. Ledger additions review -> creators. Real traffic volume -> LTR v2 and forecasting trust. Labelled Egyptian visual sets and fit accuracy study are long-poles; start labelling in week 1 (VR-13 labelers are shared).

## Decisions the owner must make
| Decision | ADR / row | Default if no answer |
|---|---|---|
| Approve notify-and-confirm for auto-buy; decide whether to pursue unattended charge | ADR-0036 | Notify only |
| Creator commission rates and caps; cash payout vs credit; who signs terms | ADR-0037 | Accrue only |
| Trade-in vs C2C vs neither | ADR-0038 | No new resale |
| On-device-only body measurement and accuracy threshold; fund the consented test set | ADR-0039 | Not built |
| First GCC country and entity (after ADR-0002) | ADR-0040 | Egypt only |
| Pursue a partner wallet at all | ADR-0041 | No |
| LLM provider and whether chat free text may leave the region | ADR-0025, VR-P3-15 | Rules-only chat |
| Vector store and embedder hosting | ADR-0023 | pgvector, self-hosted embedder |
| Family and student prices and seat limits | spec P3-03 | Spec defaults, admin-editable |
| Waiting-room/video vendor for live shopping | ADR-0024, VR-P3-11 | Live shopping not started |
| Fund labelers and approve Fable checkpoints | Phase 2 plan | n/a |

## Exit criteria (Phase 3, per feature)
Spec acceptance green; flags and kill switches present and off by default for gated features; authorization negative tests on every endpoint; mutation >= 80% on auto-buy, creator commission, family billing and any money module; Pact for every external adapter; AR/EN, RTL and all UI states; privacy review with `data_inventory.yaml` updated for each new P2/P3 field; OWASP LLM mapping filed for chat and wardrobe; VERIFY rows Verified, Accepted risk, or gating a flag that is off.
