# ADR-0005: Inventory reservations: row-per-unit with `FOR UPDATE SKIP LOCKED` in Postgres

- Status: **Proposed** (no external blocker, ready for approval)
- Date: 2026-10-10
- Deciders: CTO, Tech Lead
- Spec refs: §20.2, §7, §16 (drops), §T3, §T9

## Context and problem statement

Clearance stock is scarce and drops create bursts of contention on a few SKUs. We must never oversell, must hold stock during payment, and must stay available at 20× baseline. The v2 design held reservations in Redis, which splits stock truth across two stores and cannot be made atomic with the order and ledger writes.

## Decision drivers

- Zero oversell, provable under concurrency.
- Reserve, claim and ledger posting in the same ACID transaction.
- Hot-SKU throughput without row-lock convoys.
- No second source of truth for stock.

## Considered options

1. **Row-per-unit in Postgres with `FOR UPDATE SKIP LOCKED`**, a capped available pool, and a replenisher (modelled on Shopify's 2025 reservation redesign).
2. Single counter row per SKU with `UPDATE … WHERE available >= qty`.
3. Redis holds (v2 design) with asynchronous reconciliation.

## Decision

Option 1.

**Schema**
- `inventory_levels(sku_id, location_id, on_hand, committed)`: authoritative counts.
- `inventory_units(sku_id, location_id, id, state available|reserved|claimed, reservation_id, expires_at)`, PK `(sku_id, location_id, id)`. The available pool is materialized from `on_hand − committed` and capped at `min(on_hand_free, 1000)` per SKU/location.

**Operations**
- **Reserve** in one transaction at READ COMMITTED. Lock SKUs in sorted order, pick `LIMIT qty` available rows `FOR UPDATE SKIP LOCKED`, and set `reserved`, `reservation_id` and `expires_at = now() + 10 min`. If any SKU returns fewer than requested, roll back the whole multi-SKU reservation and report the shortfall.
- **Claim** on `payment.succeeded`: mark units `claimed`, increment `committed`, write the outbox event and post the ledger entries in the **same transaction**.
- **Release:** a `pg_cron` sweeper runs every 30 s and returns expired reservations to `available` in batches of 500 with `SKIP LOCKED`.
- **Replenisher:** a background job tops up the pool. For hot SKUs one inline replenish runs under `pg_advisory_xact_lock(hash(sku))`.
- **Late payment after expiry:** auto-claim if stock exists, otherwise refund automatically with an apology voucher. Alert when this exceeds 0.1% of orders.
- **Seller stock sync** adjusts `on_hand` through idempotent, versioned updates. A negative adjustment while units are reserved honours the existing orders and records an oversell penalty against the seller.

**Operational rules**
- Redis keeps only a "definitely sold out" pre-filter flag and the waiting-room queue. It is never the source of truth.
- PgBouncer in transaction mode, with `application_name` tagged by business process (`checkout.reserve`, `catalog.read`). The checkout pool is isolated from analytics, and the reserve path has a 2 s statement timeout. Connection exhaustion, not query speed, was Shopify's bottleneck.
- Fawry's 24h payment windows draw from a **separate non-drop stock pool**, and drop SKUs are excluded from Fawry.

**Acceptance**
- Property/chaos test: 10,000 concurrent reserves against 100 units gives exactly 100 claimed, zero oversold and no deadlocks across 1,000 runs.
- k6: reserve p95 < 150 ms at 20× baseline (SLO in §T8).
- Killing the API process mid-saga leaves no leaked reservations beyond the TTL and no double charge.

## Consequences

**Good**
- Stock, orders and ledger commit atomically. There is no cross-store reconciliation for stock.
- `SKIP LOCKED` avoids lock convoys on hot SKUs.

**Bad / risks**
- Many small rows per SKU mean more storage and write amplification. Mitigation: cap the pool and partition or archive claimed units.
- The sweeper and replenisher are extra moving parts that need metrics and alerts (stuck reservations, pool depletion).
- Postgres is on the hot path of every drop, so connection pooling and capacity must be load-tested before launch (§T9).

## Revisit when

A single SKU's reserve rate exceeds what one Postgres primary sustains in load tests. Then evaluate sharding by `sku_id` before reconsidering Redis.
