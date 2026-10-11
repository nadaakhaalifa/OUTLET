# Phase 2 plan: Love and Monetize

Status: **Draft for owner approval.** Specs: `docs/specs/phase2/`. ADRs: 0022-0027 (Proposed). New VERIFY rows: VR-P2-01 to VR-P2-14. Estimates are engineer-weeks for one builder pair including tests and docs; calendar target 10-12 weeks with parallel tracks. Tiers follow the global table: Fable = chief-reviewer checkpoint, Opus = architect, Sonnet = builder/tester, Haiku = quick fix.

Engineering proceeds on synthetic data. Real money, personal data and launch are gated by the blocked items below.

## Task breakdown (dependency order)
| # | Task | Tier | Est | Depends on | Blocked on |
|---|---|---|---|---|---|
| 0.1 | Phase 2 owner decision pass: ADR-0022..0027 accept/default, Plan A confirmation | Opus (prep) | 0.5 | none | Owner |
| 0.2 | Chart-of-accounts additions (deferred Plus revenue recipes, coins, ads, hub cost, gift pots) and ledger design review | Opus, then **Fable** checkpoint | 1.5 | ADR-0021 | none |
| 1 | Entitlements module + `age_policy` wiring + feature-flag/kill-switch registry additions | Sonnet | 1 | 0.2 | none |
| 2 | Plus subscriptions: domain state machine, dunning, proration, sweeper | Opus (design) + Sonnet | 3 | 1, PSP recurring adapter | VR-08/ADR-0012 for 21+ vs 18 (default 21); VR-P2-02 for live recurring |
| 2b | Plus refund + ETA receipt per charge | Sonnet | 1 | 2, tax-eta | VR-P2-01 |
| 2c | Plus App Review TestFlight submission and outcome tracking | Sonnet / owner | 0.5 | 2 | VR-10, VR-23 (Apple) |
| 3 | Store-credit extensions: sub-balances for coins, referral, goodwill; expiry sweeper | Sonnet | 1.5 | 0.2 | none |
| 4 | Gift cards: domain, HMAC codes, issue/redeem saga, group pots (code complete, flags off) | Opus (money design) + Sonnet; **Fable** security sign-off | 3 | 3 | VR-03, VR-09, VR-F1-04 gate enabling |
| 5 | Budget suite + `AffordabilityFilterPort` + dependency-cruiser isolation rule | Sonnet; **Fable** privacy sign-off on P3 handling | 2.5 | consent core | VR-P2-13 |
| 6 | Event pipeline for history (`user_events`), personalization toggle, clear/pause jobs | Sonnet | 2 | consent core | none |
| 7 | Embeddings/attributes pipeline + pgvector replica (ADR-0023) | Opus (design) + Sonnet | 2.5 | 0.1 | ADR-0023 default |
| 8 | LLM gateway (schemas, scrubber, budgets, breaker, audit) + eval harness AR/EN | Opus + Sonnet | 3 | 0.1 | ADR-0025 (default: P0-only) |
| 9 | AI stylist v1: candidate gen, beam search + bound, rules fallback, API | Opus (algorithm) + Sonnet | 4 | 5 (filter), 7, 8 | none beyond 8 |
| 10 | Recommendations: co-occurrence, similar, similar-for-less contract, LTR offline v1 | Opus + Sonnet | 3 | 6, 7 | none |
| 11 | Rewards: coins earn/clawback/convert, tiers, challenges | Sonnet | 2.5 | 3 | VR-P2-04 (rates live) |
| 11b | Light games (flag off) with odds versioning | Sonnet + tester | 1 | 11 | VR-P2-03 |
| 12 | Drops: state machine, types, per-user limits, price ladder, mystery (flag off) | Sonnet | 3 | inventory (exists) | VR-09 for mystery |
| 12b | Waiting room (Redis FIFO + JWT, fail closed) + k6 50k/500 test | Opus (fairness) + Sonnet | 3 | 12 | ADR-0024 / VR-16 |
| 13 | Crawler infra + SSRF guard + egress isolation (ADR-0027), snapshots | Opus (security design) + Sonnet; **Fable** security sign-off | 3.5 | 0.1 | VR-P2-07 |
| 13b | Matching waterfall + labelled-set tooling (2,000 pairs) + tau tuning, shadow mode | Opus + Sonnet | 4 | 13, 7 | VR-13 labelled data and labelers |
| 14 | Aramex adapter + contract suite | Sonnet | 2 | fulfillment port | VR-11 / VR-P2-14 |
| 14b | Hub consolidation (domain, hub ops API, ledger cost) | Opus (state) + Sonnet | 3 | 14 | VR-P2-10 |
| 14c | Returns-resale lane | Sonnet | 2 | returns, price-integrity | VR-P2-09 |
| 15 | Sponsored products: auction, budgets, ad ledger, seller UI | Sonnet; Opus for auction | 3 | search cap (exists), 0.2 | VR-P2-11 |
| 16 | Admin/seller UI for all of the above (Plus plans, drops, ads, resale) | Sonnet | 3 | respective modules | none |
| 17 | Mobile UI: paywall, stylist, budget, rewards, drops queue, AR/RTL states | Sonnet | 4 | APIs | none |
| 18 | Android launch work (spec 11) | Sonnet + tester | 3 | iOS stable 4 weeks | ADR-0026, VR-P2-05/06, VR-14 |
| 19 | Authorization negative tests, Pact, mutation on money modules (Plus billing, gift cards, coins, ads ledger), chaos | Sonnet (tester) | 3 | each module | none |
| 20 | Phase 2 exit: load 20x, drop sim, restore drill, security + privacy review | Opus + **Fable** milestone review | 1.5 | all | none |
| 21 | Quick fixes, copy lint, AR key backfill, flag registry hygiene | Haiku | 1 | rolling | none |

Fable checkpoints (few): ledger additions (0.2), gift cards (4), budget/P3 privacy (5), crawler security (13), Phase 2 exit (20).

## Critical path
0.2 -> 3 -> 4/11 ; consent -> 6 -> 10 ; 7 + 8 -> 9 ; 12 -> 12b ; 13 -> 13b (labelled data is the long pole, start labeling in week 1). Android (18) starts only after iOS stability window.

## Blocked on owner or legal decisions
| Item | Decision / evidence | Effect if unresolved |
|---|---|---|
| Plus age 21 vs 18 (VR-08, ADR-0012) | Counsel | Keep 21; build is unaffected |
| Plus under Apple rules (VR-10, VR-23, ADR-0004) | App Review outcome | Plan B IAP SKU, entitlement groups already split |
| Plus refund/CPL (VR-P2-01), recurring (VR-P2-02) | Counsel, PSP contract | `plus_sales` stays off for real users |
| Gift cards (VR-03, VR-09, VR-F1-04) | CBE/counsel opinion | `gift_card_sales/redemption` off |
| Games, mystery box (VR-P2-03, VR-09) | Counsel | Flags off |
| Coin tax/expiry (VR-P2-04) | Tax | Coins disabled in prod |
| LLM provider and transfer (ADR-0025, VR-02, VR-P2-12) | Owner, DPO | LLM features off; rules stylist ships |
| Budget consent/DPIA (VR-P2-13) | DPO | Budget module off |
| Waiting-room vendor (ADR-0024, VR-16) | Owner | Self-built default |
| Crawler legality (VR-P2-07/08) | Counsel | External evidence shadow-only |
| tau labelled set (VR-13) | Owner funds labelers | VRP internal-only |
| Aramex contract (VR-11, VR-P2-14) | Ops | Adapter built against sandbox/mocks, not enabled |
| Hub liability (VR-P2-10), resale tax (VR-P2-09), ads VAT (VR-P2-11) | Tax/Legal | Flags off |
| Android Play policy (VR-P2-05/06, VR-14) | Product/Mobile | Launch gate |

## Exit criteria
All specs' Gherkin acceptance green, kill switches present and default as specified, 20x load and drop simulation pass, mutation >= 80% on Plus billing, gift cards, coins, ads ledger, authorization tests on every endpoint, AR/EN and RTL states, verify rows either Verified, Accepted risk, or gating a flag that is off.
