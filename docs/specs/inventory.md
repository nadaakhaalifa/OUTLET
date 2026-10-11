# Spec: Inventory (row-per-unit reservations, claim, expiry, seller stock sync)

Phase 1 wave 1 · Spec refs: master prompt §20.2, §7, §6, §16, §19, §A2.5, §A2.7, §T3, §T8 · ADR-0005, ADR-0011 · Data model: `docs/data-model/inventory.md` · API: `docs/api/openapi.yaml` operation `updateSellerSkuStock` · Migration: `packages/db/migrations/0016_inventory.sql` · Status: Draft for review, synthetic data only, nothing deployed.

Naming: the spec says HAUL, the product is Z-OUTLET. Identifiers use the neutral prefix `inventory_`.

This document was written while the module was being built, not before it. The decisions that changed during implementation (the lock design in section 4 and 11) are recorded as findings, not hidden.

## 0. Scope and evidence

In scope: stock levels, the capped unit pool, reserve, claim, release, expiry sweeper, replenisher, pool transfer (Fawry allocation), idempotent versioned seller stock sync and the oversell record.

Out of scope here (named so nobody assumes they exist): drop admission and purchase limits (`purchase_limits`, `drop_admissions`, Phase 2), hub stock, returns restock, the seller bulk endpoint, the Redis "sold out" pre-filter, the catalog SKU directory (port only).

What is proven and what is not:

| Claim | Evidence | Limit |
|---|---|---|
| All-or-nothing reserve, idempotency, version guards, RLS, append-only evidence | Vitest on PGlite and on the pure model (`apps/api/src/modules/inventory/**`, `packages/domain/src/inventory`) | PGlite is one backend: it proves single-session semantics only |
| SQL functions agree with the pure model | Differential test, 3 seeds x 200 operations | Single session |
| No oversell and no deadlock under concurrent sessions | `tooling/db/inventory-concurrency.sh` on a throw-away PostgreSQL 16.13 (Postgres.app): 25 runs x 10,000 attempts x 100 connections, 5 run modes, 0 deadlocks, exactly 100 claimed where exact | One machine, local disk, one SKU per run. Not a production load test. The spec target of 1,000 runs was not executed |
| Production readiness | None | Nothing here is "production verified" |

## 1. Flow

1. **Stock arrives.** A seller (or a channel integration) calls `PUT /v1/seller/skus/{skuId}/stock`. The function takes the advisory and level locks, applies `set` or `adjust`, writes an `inventory_adjustments` row, and rebalances the pool.
2. **Pool.** For each `(sku, location, pool)` the replenisher materialises `min(1000, max(0, on_hand - committed - reserved))` rows in state `AVAILABLE`. Extra rows are removed from the highest ids.
3. **Reserve** (checkout saga step `ReserveInventory`). The application resolves each SKU's location and pool, validates the plan, then calls `inventory_reserve` in one transaction with `statement_timeout = 2 s`. Lines are processed in `(sku, location, pool)` order. Each line picks `LIMIT qty` rows with `FOR UPDATE SKIP LOCKED`. Any shortfall rolls back the whole request and returns every shortfall.
4. **Claim** (`payment.succeeded` or confirmed COD). `inventory_claim` turns the reservation's `RESERVED` units into `CLAIMED`, increments `committed`, and writes the outbox rows in the same transaction. The caller runs it in the same unit of work as its ledger posting.
5. **Release** (payment failed, cancelled, abandoned). `inventory_release` returns units to the pool.
6. **Expiry.** `inventory_sweep_expired` (every 30 s, batches of 500, `SKIP LOCKED`) expires `ACTIVE` reservations past `expires_at` and rebalances.
7. **Late payment.** A claim on an `EXPIRED` or `RELEASED` reservation tries to take free units directly (`claimed_late`). If none are free it returns `unavailable` and the saga refunds automatically with an apology voucher (spec §7).

## 2. Rules

- One reservation per OrderGroup (`UNIQUE(order_group_id)`). Same lines return the same reservation. Different lines are a `conflict`. Same lines on a closed reservation are `closed`.
- TTL by payment method (ADR-0011, proposed, owner approval pending): CARD, APPLE_PAY, MEEZA, COD 10 min; BNPL 15 min; WALLET and INSTAPAY 30 min; FAWRY 24 h. Policy rows are versioned; a reservation cites the policy it ran under.
- Pools: STANDARD (default), DROP (one per drop), FAWRY (separate, non-drop). A drop SKU can never be reserved with FAWRY. Fawry quantity per line is capped at 2 (policy `max_qty_per_line`, configuration).
- Bag limits enforced again here: 1 to 50 lines, 1 to 10 units per SKU, no duplicate SKU/location in one request.
- Pool cap 1000 rows per `(sku, location, pool)`.
- Real stock display ("2 left in M") only when 1 to 5 free, computed from counters, never from the pool (`displayableStock`).
- Seller sync: `set` needs `quantity >= 0`; `adjust` needs a non-zero signed delta; the result must be `>= 0`. `sync_version` increments on every applied change. `If-Match` is optimistic concurrency against it. A channel `source_version` equal or older than the last accepted one is a stale no-op.
- A decrease below what is already promised (`committed + reserved`) is accepted. Orders are honoured, `inventory_oversell_events` gets a row with the shortfall, and `inventory.oversold` goes to the outbox for the seller-health module. The pool is trimmed so it never offers more than free stock.
- The STANDARD pool is what the seller controls over HTTP. The FAWRY allocation is carved out by an operator through `TransferBetweenPools`.

## 3. Edge cases

| Case | Behaviour |
|---|---|
| Two taps, same OrderGroup | One reservation (unique key), second call replays |
| Reserve succeeds, response lost | Retry with the same order group returns the same reservation |
| Multi-SKU, one SKU short | Nothing held, shortfalls for every short SKU, reservation row rolled back so the order group can retry |
| Pool empty but stock unmaterialised | One inline replenish under the advisory lock, then a second pick |
| Pool empty and no free stock | Fails with no lock taken (sold out is cheap) |
| Rows skipped because other sessions hold them | Treated as "maybe stock": inline replenish path, then shortfall if still none |
| Claim after TTL but before the sweeper | Normal claim (units are still `RESERVED`) |
| Claim after sweep and stock still free | `claimed_late` |
| Claim after sweep and stock taken | `unavailable` plus shortfalls; reservation stays `EXPIRED`; saga refunds |
| Seller sync replay with same key | Returns the current level, `replayed: true`, no second adjustment |
| Seller sync out of order (channel) | `stale`, no change |
| Seller lowers stock below reserved | Applied, oversell record and event, pool trimmed |
| Concurrent identical sync keys | Idempotency key is checked under the level lock, so one applies |
| Level row first created by a failed sync (stale, version conflict, negative) | The just-created empty level is removed in the same call |
| `release` after `claim` | No-op (`CLAIMED` stock is never returned by a compensation) |
| Claimed unit lost at inspection | `WRITTEN_OFF` state exists; the write-off flow is not built here |

## 4. Data

Entities, keys and PII classes are in `docs/data-model/inventory.md`. Privacy tags for the new columns are in `docs/privacy/fragments/inventory.yaml`. Deviations from the data model, each deliberate:

1. **No `committed <= on_hand` CHECK.** The spec requires honouring orders when the seller cuts stock. The invariant that does hold, and is tested, is `AVAILABLE rows <= max(0, on_hand - committed - reserved)` and `committed = count(CLAIMED rows)`. Oversell is recorded, never silent.
2. **No FK from `inventory_units` or `reservation_lines` to `inventory_levels`.** The data model already says the hot path avoids the SKU FK. The concurrency script showed that a composite FK is worse than slow: the key-share lock it takes on the level row queued every reserve behind claims and produced real `40P01` deadlocks. Units are only created by `inventory_rebalance_core`, which holds the level lock and requires the level row.
3. **`inventory_adjustments` is not partitioned yet.** Same deferral as the outbox in 0004. Idempotency is one unique index `(idempotency_key, sku_id, pool_id)`. Monthly partitioning and the `inventory_adjustment_keys` dedupe table are a later expand migration.
4. **No adjustment rows for CLAIM and RELEASE.** Reservations, units and the outbox are the record. Adjustments record `on_hand` changes only (`SELLER_SYNC`, `POOL_TRANSFER`, and the reserved `MANUAL`, `RETURN_RESTOCK`, `WRITE_OFF`, `CORRECTION`).
5. **`store_id` columns have no FK to stores.** The sellers module owns that table and does not exist in this migration range yet.
6. **Added columns:** `inventory_levels.source_version` (channel monotonic version), `reservations.lines_fingerprint` (request identity for idempotency), `reservation_lines.pool_id`, `inventory_adjustments.reason_detail`, `inventory_adjustments.resulting_on_hand`, `inventory_oversell_events` (new table).
7. **Wallets and InstaPay hold on the STANDARD pool for 30 min.** The data-model "Rules" bullet says wallet redirects use the FAWRY pool, while ADR-0011 and the TTL policy table say only Fawry does. ADR-0011 wins; the pool is a column in `reservation_ttl_policies`, so flipping it is a data change.

## 5. API

### HTTP (conforms to `updateSellerSkuStock`)

| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `PUT /v1/seller/skus/{skuId}/stock` | seller audience, policy resource `store_inventory`, action `update`, brand roles owner, manager, warehouse, token scope `seller:write` | required `Idempotency-Key` | 60 per minute per user |

Request: `{ mode: "set" | "adjust", quantity: int, reason: "recount" | "received" | "damaged" | "channel_sync" | "other" }`, unknown fields rejected. Optional `If-Match: "<sync_version>"`.
Response 200: `{ sku_id, on_hand, reserved, available, updated_at }` for the STANDARD pool at the SKU's location.
Errors: 400 validation or missing key, 401, 403 (wrong role, missing scope, suspended), 404 (unknown SKU and other store's SKU are indistinguishable), 409 `stock_version_conflict` (extension `current_version`), 422 `stock_negative` or idempotency-key reuse, 429.

### Internal use cases (no HTTP surface; called by the checkout saga, the sweeper job and operators)

`ReserveStock`, `ClaimReservation`, `ReleaseReservation`, `SweepExpiredReservations`, `ReplenishPools`, `TransferBetweenPools`. Exported through the module's `index.ts` tokens. The drop admission and the bulk endpoint in the data model are not in the OpenAPI document and are not built.

## 6. Events

Outbox (written in the same transaction as the state change, `aggregate_type` `reservation` or `sku`, ordering key `<aggregate_type>:<id>`):

| Event | Payload | Taxonomy |
|---|---|---|
| `inventory.reserved` | `reservation_id, sku_id, quantity, expires_at` | yes (`docs/analytics/event-taxonomy.md`) |
| `inventory.claimed` | `reservation_id, sku_id, quantity, order_group_id`; header `late` | yes |
| `inventory.released` | `reservation_id, sku_id, quantity, reason` (`payment_failed`, `cancelled`, `abandoned`, `expired`) | yes |
| `inventory.oversold` | `sku_id, shortfall_units` | not in the taxonomy; needs an entry |

Event ids are `gen_random_uuid()` in SQL (v4). The relay orders by `(occurred_at, id)` within an ordering key, which does not need v7. No analytics events are emitted by this module.

## 7. Failure handling

| Failure | Handling |
|---|---|
| Reserve statement exceeds 2 s | `57014`, transaction rolled back, nothing held; caller retries with the same order group |
| Process dies mid-saga | Transaction rolled back, or committed `ACTIVE` and later expired by the sweeper. No half-applied claim: claim, outbox and level update share a transaction |
| Sweeper falls behind | Reservations hold stock past TTL; claim still works; metric `sweeper lag` alerts |
| Pool drift (rows missing or surplus) | `inventory_replenish_due` repairs; reserve self-heals through inline replenish |
| Shortfall | Typed result, not an exception |
| Deadlock (`40P01`) | Treated as retryable by the caller; the lock order below is designed so it should not occur, and the script counts it |

Lock order (all functions): reservation row, then advisory lock, then level rows sorted by `(sku_id, location_id, pool_id)`; unit rows are taken only with `SKIP LOCKED` or by the transaction that owns the reservation. Claim, release and sweep update unit rows **before** taking any level or advisory lock.

## 8. Security and abuse

### Authorization (A2.10, API1, API3, API5)

- Guard: `Authorize` with a resolver that loads the SKU's store from the catalog directory; the policy engine decides. Unknown SKU and another store's SKU both resolve to 404.
- Use case re-checks `sku.storeId in actor store ids` (defence in depth if the guard wiring regresses).
- RLS (class B): levels, units, adjustments, locations, oversell events readable by `store_id = ANY(app_store_ids())`; units and reservations writable only by `system`. Reservations readable by owner. Seller staff never see buyer ids: `reservation_lines` carry no user id and `reservations` are not seller-readable.
- Functions are `SECURITY INVOKER`, `EXECUTE` revoked from PUBLIC.

### STRIDE notes

| Threat | Control |
|---|---|
| Spoofing a store | Store comes from the verified grant, never from the body |
| Tampering with stock of another tenant | 404 plus RLS plus use-case check; negative tests per case |
| Repudiation | `inventory_adjustments` append-only (trigger plus no grant); `actor_id`, `actor_type`, idempotency key |
| Information disclosure | Seller sees own levels only; error bodies carry only RFC 9457 members; no buyer data in events |
| Denial of service (stock hoarding) | Per-method TTL, per-line quantity caps, one reservation per order group, 60/min on the seller route; **per-user and per-device purchase limits and drop admission are Phase 2 and are not built** |
| Elevation | `seller:write` scope plus brand role; `system` DB role set only by the adapter after authorization |

### Business-flow abuse (API6)

Hoarding via repeated reserve/abandon is bounded by TTL and the order-group key, not by a user limit yet. That gap is open (section 12).

## 9. Metrics

Oversell count (must be 0), reserve p95 (SLO < 150 ms, §T8), reservation expiry rate, pool starvation (reserve `insufficient` while `free > 0`), claim-after-expiry rate (alert above 0.1%, spec §7), sweeper lag, replenisher candidates, `40P01` count (must be 0), oversell penalty events per store. Connections should carry a business `application_name` (`checkout.reserve`, `inventory.sync`, §T8); the connection factory is not part of this module and does not set it yet.

## 10. Acceptance

```gherkin
Scenario: Concurrent reserves never oversell
  Given a SKU with 100 units and 100 concurrent connections
  When 10,000 reserve-then-claim attempts run
  Then exactly 100 units are CLAIMED and level.committed = 100
  And 9,900 attempts report insufficient stock
  And no unit is left RESERVED and no deadlock occurs

Scenario: A multi-SKU reserve is all-or-nothing
  Given SKU A has 3 units and SKU B has 1 unit
  When a reservation asks for 2 of A and 2 of B
  Then nothing is held and the shortfall names B with available 1

Scenario: Fawry uses its own pool and never a drop SKU
  Given a drop SKU and a Fawry payment
  Then the reservation is refused with drop_sku_not_allowed_for_fawry
  And a non-drop SKU is served from the FAWRY pool for 24 hours only

Scenario: Cutting stock below promised units
  Given 4 units reserved of 10
  When the seller sets stock to 1
  Then the call succeeds, an oversell of 3 is recorded, no new reservation can be made
  And the held order can still be claimed

Scenario: Another store's SKU
  When seller A updates seller B's SKU
  Then the response is 404, identical to an unknown SKU, and nothing changes
```

How each is verified: scenario 1 by `inventory-concurrency.sh`; 2 to 5 by the PGlite, model and HTTP tests (and 2, 4 also by the differential test).

## 11. Algorithm choice (2 to 3 lines each)

- **Reservation:** row-per-unit with `SKIP LOCKED` (chosen, ADR-0005) vs a single counter row with `UPDATE ... WHERE available >= qty`. The counter is simpler and correct, but every reserve of a hot SKU serialises on one row; `SKIP LOCKED` lets concurrent buyers take different rows. Cost: pool maintenance and stray-lock subtleties (below).
- **Pool sizing:** recompute from one statement over the live partial index (chosen) vs maintain `reserved` as a counter on the level row. A counter makes every reserve write the hot level row, which is exactly what the row-per-unit design avoids.
- **Replenish trigger:** inline under `pg_advisory_xact_lock` only when free stock exists (chosen) vs always. Always-lock put every sold-out attempt in one queue (seen in the first run, p99 and timeouts).

### Findings from the real-Postgres run (kept because they change how the code must be written)

1. Composite FKs from units and lines to levels took key-share locks on the hot level row and deadlocked with claims. Removed (deviation 2), locks are `FOR NO KEY UPDATE`.
2. `SELECT ... FOR UPDATE SKIP LOCKED ... LIMIT n` followed by an `UPDATE ... FROM` can leave a lock on a row that failed its predicate re-check. A claim that took the level lock first and then updated units waited on such a stray lock while the owner waited for the level lock: a deadlock. Claim, release and sweep now update unit rows before any level lock.
3. After both fixes, 25 runs x 10,000 attempts gave 0 deadlocks. One earlier version failed roughly one run in three, so a handful of runs is not enough evidence; the script defaults to 25 and should run in CI on every change to the migration.

## 12. Open questions and needs

1. **Fawry allocation size** (ADR-0011 "pool size limit"): who sets it and how (per SKU, percentage)? Built as an operator transfer with no UI.
2. **Per-user and per-device purchase limits** to bound hoarding (spec §6, §16) are not built; the admission module owns them.
3. **Seller `set` semantics** (resolved, ADV-3): `set N` is the PHYSICAL total across pools. The STANDARD pool becomes `max(0, N - fawry_on_hand)`, so a re-sync never creates stock above N. Reserved and claimed units are honoured; any shortfall is recorded as oversell as before. `adjust` is a delta on the STANDARD pool only. Product may still revisit.
4. **`seller:inventory.write` (OpenAPI `x-scope`) vs `seller:write` (policy rule token scope):** the code follows the policy rules. One of them should change.
5. **`inventory.oversold` event** needs a taxonomy entry and a consumer (seller health).
6. **Catalog `SkuDirectory`:** first-time stock for a SKU needs the catalog to say which store and location own it. The SQL `LevelBackedSkuDirectory` can only answer for SKUs that already have a level.
7. **Returns restock** (`RETURN_RESTOCK`) and write-off flows are reserved in the schema but not built.
8. **Idempotency scope:** the HTTP idempotency key is stored by the platform interceptor and also used as the DB adjustment key. Keys are UUIDv7 and unique per actor, but the DB key is global per `(key, sku, pool)`; reuse by the same seller on a different SKU is fine, on the same SKU is a replay.
9. **VERIFY BEFORE LAUNCH (carried):** provider payment windows (VR-04, VR-05) that set the 30 min and 15 min TTLs.
