# Spec 03: Budget suite and affordability

Refs: §12, §B1, §B3, §17 (budget data never used for targeting), §20.5. Phase 2.

## Flow
Me -> Budget: set monthly total, optional per category, payday, cap mode (off | soft | hard). Dashboard (spent, remaining, category donut, month over month, top stores, verified savings only, Plus savings). Affordability view filters feed, search, stylist and wishlist to remaining budget now. Plan my purchases assigns wishlist items to cycles (Need > date > Want > Treat) and watches verified price drops. Installment-aware: monthly commitments from provider quotes or user entry, labelled "estimate". Wellbeing: soft cap (10 s hold to override), hard cap (blocks checkout until payday, 24h delayed unlock), no-spend days, hide trending, impulse cool-off.

## Rules
- `remaining = budget - spent_this_cycle - (bag_total if toggle) - installments_due_this_cycle`, all piastres, never negative display clamp with explicit "over by X".
- Spend counts net of refunds on the order's cycle; COD counts at placement and reverses on refusal; refund in later cycle credits original cycle in reports and "available now" in the current one.
- Payday 31 -> last day of month. Budget change mid-cycle recomputes.
- **Opt-in** consent purpose `budget_insights`; no data collected or computed before consent; withdrawal deletes derived tables within 24h.
- **Isolation (non-negotiable):** budget tables are P3 and are never exposed to sellers, ads, ranking features at rest or promotion targeting. Enforced by dependency-cruiser rule: modules `promotions`, `ads`, `seller-analytics`, `recommendations` (ranking stores) cannot import `budget`. Affordability is a **request-time filter** evaluated on the shopper's own request via a port `AffordabilityFilterPort` implemented by `budget`; consumers receive only a price ceiling integer for that request and must not persist it. No FRA content: never credit scoring or loan recommendations.
- Hard cap unlock: request -> 24h delay -> unlock; notification sent at request.

## Edge cases
Zero budget -> feature empty state; multiple orders crossing cap concurrently -> checkout re-checks with row lock on `budget_cycles`; DST; user deletes account -> all budget rows purged (not retained); consent withdrawn mid-cycle; installment source conflict -> provider data wins.

## Data
| Table | Columns | PII |
|---|---|---|
| `budgets` | user_id, amount, per_category jsonb, payday, cap_mode, hold_until | P3 enc |
| `budget_cycles` | user_id, start, end, spent, refunded | P3 enc |
| `installment_commitments` | user_id, provider, monthly, start, end, source provider|user | P3 enc |
| `savings_goals` | id, user_id, target, due, saved | P3 enc |
| `budget_unlock_requests` | id, user_id, requested_at, unlock_at | P3 |
All encrypted with field-level envelope keys; blind index on `user_id` only.

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `PUT /v1/me/budget` | owner + consent | yes | 20/h |
| `GET /v1/me/budget/summary` | owner | no | 60/min |
| `GET /v1/me/affordability?context=` | owner | no | 60/min |
| `POST /v1/me/budget/plan` | owner | yes | 10/h |
| `POST /v1/me/budget/cap-unlock` | owner | yes | 5/day |
| `DELETE /v1/me/budget` | owner | yes | 5/day |

## Events
`budget.set`, `budget.cycle_rolled`, `budget.cap_unlock_requested`. Analytics (no amounts): `budget_set`, `budget_warning_shown`, `affordability_view_opened`, `budget_cap_blocked_checkout`.

## Failure handling
Cycle roll job idempotent per `(user, cycle)`; if budget service is down, checkout proceeds (fail open for soft cap, fail closed only for an already-active hard cap with cached flag); reconciliation of `spent` against orders nightly.

## Security and abuse
BOLA owner-only; P3 encryption; log redaction; export includes budget fields (DSAR); no analytics event carries amounts; lint rule fails CI on cross-import.

## Metrics
Adoption, % under budget, return rate vs control, retention uplift. Guardrail: opt-out rate.

## Acceptance
```
Given a hard cap reached, When checkout, Then blocked with explanation; unlock request takes 24h.
Given no budget_insights consent, When PUT /v1/me/budget, Then 403 consent_required.
Given module promotions imports budget, Then dependency-cruiser CI fails.
Given a refund in the next cycle, Then reports credit the original cycle and available-now increases in current.
Given consent withdrawn, Then budget tables for the user are empty within 24h.
Given payday 31 in a 30-day month, Then the cycle ends the 30th.
```

## Build notes (Phase 2 builder, budget module)

Options compared and decisions:
- **Planner:** greedy first-fit in priority order (chosen) vs per-cycle 0/1 knapsack. Greedy is deterministic, explainable and never defers a Need to fit two Treats; knapsack packs more value but breaks "Need first". Items that cannot fit any cycle are reported `exceeds_every_cycle` or `no_capacity`. Plans are returned, never stored (no extra P3 table).
- **Spend accounting:** an idempotent event log (`budget_spend_events`, PK user + key) with cached per-cycle totals (`budget_cycles`) vs a running counter. The log makes refunds, COD refusal, payday change and nightly reconciliation exact and replay safe; the counter cannot be repaired. Totals are always derivable from events.
- **Cap concurrency:** the spec says re-check with a row lock on `budget_cycles`. The cycle row may not exist yet, so the module takes a per-user transaction advisory lock (Postgres) / per-user queue (in-memory) and the guard records the order provisionally (`placed:<orderKey>`) inside the same lock. Two concurrent orders crossing the cap therefore serialize (tested: exactly one passes). Checkout must call `CheckoutCapPort.release` when the order fails or is abandoned; the later paid event with the same key is a no-op.

Gaps found and chosen defaults:
- "Payday 31 ends the 30th": cycles are `[this payday, next payday)` with Cairo local midnight boundaries, so the cycle that starts 31 March ends (exclusively) on 30 April, the clamped payday.
- A refund received for an earlier cycle lowers current "spent" but never below zero, so remaining never exceeds the budget.
- Spec table lists no endpoint for savings goals or a checkout check. `savings_goals` exists (RLS, purge, export) without endpoints; the checkout check is the `CheckoutCapPort` consumed in-process.
- `start`/`end` columns are `cycle_start`/`cycle_end` (cycles) and `starts_at`/`ends_at` (commitments) because they are reserved words. `hold_until` is the maturity of the latest unlock request: the hard hold cannot be bypassed before it, and after it the cap is lifted only for the cycle the request was made in.
- Backfill on first set reads the current cycle only (data minimisation); month over month fills as events arrive.
- Consent withdrawal: handled on the next spend event, by `PurgeUserBudget` (consent.changed consumer) and by the daily `RollCycles` job as the 24 h backstop.
- The domain folder is imported through a relative path in `domain/bridge.ts` until the integrator adds `export * as budget from "./budget"` to `packages/domain/src/index.ts` (that file is not owned by this task).
- Flags: `release.budget_suite` and `kill.budget_caps` are consumed through `BudgetFlagsPort`; registering them in `packages/feature-flags` is a needs item. Both default off and fail closed, as the registry requires.
