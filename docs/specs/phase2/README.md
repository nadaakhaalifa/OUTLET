# Phase 2 specs (Love and Monetize)

Source: master prompt v3 section P3 (Phase 2), sections 11, 12, 14, 15, 16, 20.5, 20.6, 21, 28, B7. Read "HAUL" as "Z-OUTLET". All specs follow template A3. Status: **Draft for owner review**; no code before approval.

| # | Spec | Module(s) | Blocked on |
|---|---|---|---|
| 01 | [plus-subscriptions](01-plus-subscriptions.md) | `subscriptions`, `entitlements` | VR-08/ADR-0012, VR-10/ADR-0004, VR-F1-04 (e-receipt) |
| 02 | [gift-cards](02-gift-cards.md) | `gift-cards` | VR-03, VR-09, VR-F1-04; kill switch off |
| 03 | [budget-affordability](03-budget-affordability.md) | `budget` | `budget_insights` consent copy (Legal) |
| 04 | [ai-stylist](04-ai-stylist.md) | `stylist-gateway`, `llm-gateway` | ADR-0025 (LLM residency), VR-02 |
| 05 | [recommendations-history](05-recommendations-history.md) | `recommendations`, `history` | ADR-0023 |
| 06 | [rewards-coins-games](06-rewards-coins-games.md) | `rewards` | VR-09 (games), VR-F1-04 |
| 07 | [drops-waiting-room](07-drops-waiting-room.md) | `drops`, `waiting-room` | ADR-0024 / VR-16 |
| 08 | [crawler-price-integrity-v2](08-crawler-price-integrity-v2.md) | `crawler`, `price-integrity` | ADR-0027, VR-13 labelled set |
| 09 | [aramex-hub-resale](09-aramex-hub-resale.md) | `fulfillment`, `returns` | VR-11 |
| 10 | [sponsored-products](10-sponsored-products.md) | `ads` | none (cap rule in search spec) |
| 11 | [android-launch](11-android-launch.md) | `apps/mobile` | ADR-0026, VR-14 |

Conventions: money integer piastres (`bigint`), every money write idempotent and ledger-first (ADR-0021), explicit state machines in `packages/domain/src/<module>`, Zod at every boundary, deny-by-default authz with 404 on foreign objects, Arabic-first copy, feature flag plus kill switch on every non-trivial feature, no fake stock, timers, reviews or discounts. PII classes: P0 public, P1 internal, P2 personal, P3 sensitive (field-encrypted). Each spec's rate limits are defaults and admin-configurable with audit.
