# Spec: promotions and vouchers core (master prompt section 17)

Phase 1 scope. Types: percent, fixed, free shipping, BOGO, tiered. Product name is Z-OUTLET (spec name HAUL).
Source of truth order (ADR-0018): tested code, then `docs/haul-master-prompt-v3.md`. Data model: `docs/data-model/promotions.md`.
Out of scope here (later waves): bundle, first order, birthday, win-back, payment-partner offers, Plus-only grants as a type,
store-follower deals, sponsored products, segments and category targeting.

## Hard limits for this module
- No PSP call, no ledger posting, no payout or refund-money execution. The engine only computes discount allocations and
  funding splits (`platform_funded`, `seller_funded`) that the checkout saga and ledger consume later (F-1 checkpoint).
- Budget data is never read: the module has no import path to the budget module or budget tables
  (`forbidden_importers: [promotions, ads]` in `docs/privacy/data_inventory.yaml`; guarded by `test/no-budget-import.test.ts`).
- A voucher never creates a "% off" claim or a reference price (section 9). Output carries `display: "voucher_minus"` only.

## Flow
1. Admin (platform promotions) or a seller (own store) creates a promotion: kind, scope, value, funding split, caps, window.
   It has either a voucher code or `auto_apply`, never both. Economic terms are immutable after creation.
2. Checkout quote calls internal `POST /v1/promotions/evaluate` with lines, per-store shipping fees, entered codes, payment
   method, Plus flag and the instant `at`. The use case loads candidates (auto promos plus entered codes) and usage
   counters, then runs the pure engine.
3. The engine gates each candidate, keeps the best five by standalone value, tries every subset (at most 32), drops subsets
   that break the stacking matrix, applies each surviving subset in the fixed order and returns the one the shopper pays
   least for.
4. At order commit checkout records a redemption per applied promotion (`RecordRedemptions`, idempotent per
   promotion and order group, cap-checked under a row lock). Whole-order cancellation before shipping reinstates them.

## Rules
Evaluation order: item, store, order, shipping. Inside a scope: bogo, tiered, fixed, percent, free shipping, then promotion id.
Every step works on what is left after the previous one, so a discount can never push a line below zero.

| Kind | Allowed scopes | Computation |
|---|---|---|
| percent | item, store, order | `percentOfBps(remaining, bps)` per line (item), per store base (store) or whole base (order) |
| fixed | item, store, order | item: amount per unit, capped at the line; store: once per store; order: once |
| bogo | item | per line, `floor(qty / (buy + get)) * get` units at `getPercentBps` of the unit price |
| tiered | store, order | highest tier whose `minSubtotal` is reached by the eligible list subtotal, percent of the remaining base |
| free_shipping | shipping | the remaining shipping fee of each eligible store |

- Rounding: one documented point, `divideRoundHalfEven` in `packages/domain/src/money.ts` (banker's rounding, via `percentOfBps`).
  Splitting a discount across lines or between funders uses `allocate` (largest remainder, ties to the lowest index, so the
  platform column takes an odd piastre). Parts always sum to the whole.
- Funding: `platform_pct + seller_pct = 100`. Seller-owned promotions must be 0 / 100 and only touch their own store lines.
  Co-funded means both greater than zero. The split is stored per line (and per store for shipping) for the ledger and VAT base.
- Constraints: `min_order` (eligible list subtotal before any promotion; per store for store and shipping scope),
  `max_discount` (cap on one promotion in one evaluation), `per_user_cap`, `per_day_cap` (Cairo calendar day),
  `total_budget` (promotion spend, never user budget), validity window `[starts_at, ends_at)` evaluated against the injected
  instant. Cairo day boundaries use the IANA zone (Egypt observes DST); instants are stored UTC.
- Stacking matrix (versioned, `StackingPolicy` v1): at most one platform code, at most one store voucher per store, at most
  one auto promotion per scope, at most five candidates. Entered codes compete with auto promotions on equal terms: auto-best
  minimises what the shopper pays; losers are reported with `stacking_conflict` or `no_additional_saving`.
  Tie-break: fewer promotions, then smaller id list. The ADR-level default "one auto per scope" is the safest professional
  default; admin can raise it by publishing a new policy version.
- Plus delivery is already free: a free-shipping promotion never stacks on it (the fee is zero once).
- Entered codes: trimmed and upper-cased, at most 5 considered. An unknown code is `unknown_code`.
- Authorization: seller routes need a brand grant (owner or manager) for the target store and `seller:read|write`;
  admin routes need an admin grant `marketing` or `ops` (or `super_admin`), a passkey and `admin:access`.

## Edge cases
- Concurrent redemption of the last capped use: `recordRedemption` re-checks caps and budget under a `FOR UPDATE` lock on the promotion row and returns `cap_reached` or `budget_exhausted`.
- Voucher expires between quote and commit: commit re-evaluates; caller shows the delta.
- Budget exhausted mid-checkout: the discount is capped at what remains; at zero it is rejected. Totals never go negative.
- Zero-priced lines, zero fees, empty bag (no result), mixed stores, a store with a fee but no lines (ignored).
- Duplicate promotion rows in the pool are collapsed by id. Same code in a different case is the same code.
- Currency is EGP only; any other currency is a validation error.
- Partial refund of a voucher order: handled by orders and refunds from the stored per-line allocations; vouchers are not reinstated.

## Data
Tables (`packages/db/migrations/0021_promotions.sql`, RLS on, data inventory tagged):
`promotions` (one row per promotion, `version` bumped on operational edits, economic terms immutable) and
`promotion_redemptions` (one row per promotion and order group; carries `promotion_version`, discount and funding split, `day_key`).
PII: `promotions.created_by` P2 (staff user id); redemptions carry `user_id` P2. No budget column, no FK or join to budget tables.
RLS class: tenant-by-store for sellers (`store_id = ANY(app_store_ids())`), platform rows (`store_id IS NULL`) readable by
marketing, ops and super admin roles; `system` role does the evaluation reads and writes; redemptions are owner-scoped for
shoppers (read only) and system-written.

## API
| Method and path | Audience and scope | Idempotent | Rate limit |
|---|---|---|---|
| `POST /v1/promotions/evaluate` | internal service token, `internal:promotions.evaluate` | pure | 600 per minute |
| `GET /v1/admin/promotions`, `GET /v1/admin/promotions/{id}` | admin, `admin:promotions.read` | n/a | 120 per minute |
| `POST /v1/admin/promotions` | admin, `admin:promotions.write` | required | 30 per minute |
| `PATCH` and `DELETE /v1/admin/promotions/{id}` | admin, `admin:promotions.write` | optional, `If-Match` on PATCH | 60 per minute |
| `GET /v1/seller/promotions`, `GET .../{id}` | seller, `seller:promotions.read` | n/a | 120 per minute |
| `POST /v1/seller/promotions` | seller, `seller:promotions.write` | required | 30 per minute |
| `PATCH` and `DELETE /v1/seller/promotions/{id}` | seller, `seller:promotions.write` | optional, `If-Match` on PATCH | 60 per minute |

Contract notes (OpenAPI deltas the integrator must apply, see gaps): the evaluate request needs `shipping_fees`;
create input needs `scope`, `bogo` and `tiers` for those kinds; seller routes need a store selector (`X-Store-Id`, defaulted
when the actor has exactly one brand store). Only the five Phase 1 kinds are accepted; others answer 422
`promotion_type_not_supported`.

## Events (outbox, emitted by checkout and the commit path, not by this module)
`promotion.activated`, `promotion.ended`, `voucher.redeemed`, `voucher.reinstated`, `promotion.budget_exhausted`.
This module exposes an event port and an in-memory publisher; wiring to the outbox is a follow-up.

## Failure handling
Evaluation is pure with no external calls. If the promotion store is unavailable the use case throws
`PromotionsUnavailableError`; checkout proceeds without auto promotions and shows no discount rather than guessing.
Optimistic concurrency on edits (`version`); a stale `If-Match` is 412, missing is 428.

## Security and abuse
- API1/API3/API5: non-owned or foreign-tenant promotion is 404, missing role is 403, unauthenticated 401, wrong audience 401.
- API6: code guessing on evaluate is bounded by the internal caller's per-user limits; codes are not secrets but are
  lower-entropy by design, so the evaluate endpoint is service-only and unknown and expired codes return the same wire shape.
- Mass assignment: `status`, `version`, usage counters and `created_by` are server owned; DTOs are strict allow-lists.
- Seller promotions cannot be platform funded and cannot target other stores (domain validation and RLS).
- Targeting by budget, age band or protected attributes is not offered.

## Metrics
Promo ROI, incremental GMV (holdout), redemption rate, abuse rate, budget burn, evaluation p95 (target under 20 ms for 50 lines).

## Acceptance (Gherkin)
- Given store A at 1,000 EGP and a 10% platform code, when evaluated, then the discount is 100 EGP and the result has no percent or reference price field.
- Given two platform codes entered, then exactly one applies (the cheaper for the shopper) and the other is `stacking_conflict`.
- Given a store voucher for store A and a bag with stores A and B, then only A lines are discounted.
- Given `max_discount` 50 EGP on a 50% code, then the discount is 50 EGP, split as funding says, summing exactly.
- Given a promotion at its per-user cap, then it is rejected `per_user_cap_reached`.
- Given the same request twice, then the results are deeply equal (idempotent), and shuffling lines or pool keeps the total.
- Property tests: no combination exceeds caps, no negative totals, funding splits sum to the discount, auto-best is exact over all stacking-valid subsets.
- Mutation score on `stacking.ts`, `funding.ts`, `apply.ts`, `evaluate.ts` is at least 80% (Stryker, `break: 80`).
- Seller A cannot read, patch or delete seller B's promotion (404). A shopper token on admin or seller routes is 401.
