# ADR-0005: Inventory: row-per-unit with `FOR UPDATE SKIP LOCKED`, including one-off outlet units

- Status: **Proposed** (technical; no owner-decision dependency). Ready for approval.
- Date: 2026-11-07
- Deciders: CTO, tech lead
- Sources: master prompt §7, §16, §20.2, §T3, §T9; `docs/BUILD-PROMPT.md` §3, §5 (sold one-off → 410/301); Shopify Engineering, "Scaling inventory reservations" (2025, cited in the master prompt); `docs/outlet-nk-vision-addendum.md` §3 (defect per unit); ADR-0009

## Context

- Outlet stock is scarce, and Drop Hour concentrates many buyers on a few items in the first minutes (ADR-0001 capacity math). We must **never oversell**, must hold stock while the shopper pays, and must commit stock, order and ledger together.
- Much outlet stock is **one-off**: a single unit with its own defects, its own photos and its own QR passport (ADR-0009). Two "identical" units with different defects are **not** interchangeable.
- Shopify's 2025 redesign moved reservations out of Redis into the same ACID database as the inventory ledger, with one row per sellable unit taken by `SELECT … FOR UPDATE SKIP LOCKED`. Its bottleneck was **connection exhaustion**, not query speed.

## Options considered

| Option | Good | Bad |
|---|---|---|
| **1. Row-per-unit in Postgres with `FOR UPDATE SKIP LOCKED` (chosen)** | Atomic with orders and ledger; no lock convoy on hot SKUs; a one-off unit is naturally one row | More rows and writes; sweeper and replenisher to run |
| 2. One counter row per SKU (`UPDATE … SET available = available - qty WHERE available >= qty`) | Simple, few rows | Every buyer of a hot SKU waits on one row lock (convoy at Drop Hour); cannot represent unique one-off units |
| 3. Redis holds with async reconciliation (master prompt v2 design) | Very fast | Two sources of truth; cannot commit atomically with the ledger; Redis loss = oversell |

**Choice (2–3 lines):** Option 1 is the only one that is both atomic with the ledger and free of single-row contention, and it models one-off units with no extra concept. Its costs (rows, sweeper) are bounded by capping the pool and partitioning claimed units.

## Decision

Option 1.

### Schema
- `inventory_levels(market_id, sku_id, location_id, on_hand, committed)`: authoritative counts.
- `inventory_units(sku_id, location_id, id, state available|reserved|claimed, reservation_id, expires_at, condition_report_id NULL, passport_id NULL)`. PK `(sku_id, location_id, id)`. IDs are UUIDv7.
- **Fungible stock** (e.g. 50 identical new-with-tags pieces): the available pool is materialised from `on_hand − committed`, capped at `min(on_hand_free, 1000)` per SKU and location, and topped up by a replenisher.
- **One-off units** (own defects): the listing has `qty = 1`; the unit row links to its `condition_report_id` and `passport_id`. The shopper reserves **that** unit, never "any unit". The UI hint "create a separate listing for each condition" (UI spec §5) is enforced: a listing never mixes condition reports.

### Operations
- **Reserve:** one transaction, READ COMMITTED, SKUs locked in sorted order (no deadlocks):
  ```sql
  WITH picked AS (
    SELECT id FROM inventory_units
    WHERE sku_id = $1 AND location_id = $2 AND state = 'available'
    ORDER BY id LIMIT $qty FOR UPDATE SKIP LOCKED)
  UPDATE inventory_units u
     SET state = 'reserved', reservation_id = $r, expires_at = now() + $ttl
    FROM picked WHERE u.id = picked.id
  RETURNING u.id;
  ```
  Fewer rows than `qty` for any SKU → roll back the whole multi-SKU reservation and return the shortfall. One reservation per order group. TTL default 10 min (market config).
- **Claim** on `payment.succeeded` (or COD confirmation): mark units `claimed`, increment `committed`, write the outbox event and post the ledger **in the same transaction**.
- **Release:** a sweeper every 30 s returns expired reservations to `available` in `SKIP LOCKED` batches of 500. It runs on `pg_cron` if available in the chosen cloud (V37), otherwise in `apps/workers`.
- **Replenisher:** background top-up of the fungible pool; for hot SKUs one inline replenish under `pg_advisory_xact_lock(hash(sku))`.
- **Late payment after expiry:** auto-claim if the unit is still available; otherwise automatic refund and an apology. For a one-off unit there is no substitute, so this is always a refund. Alert when the rate exceeds 0.1% of orders.
- **Seller stock sync** (Price Watch connectors, `docs/specs/price-watch.md`) adjusts `on_hand` through idempotent, versioned updates. A negative adjustment while units are reserved honours existing orders and records a seller oversell penalty.

### Rules around the core
- **Redis** holds only a "definitely sold out" pre-filter flag and the Waiting Room queue. Never the truth.
- **Pools:** PgBouncer transaction mode, `application_name = checkout.reserve`, pool isolated from analytics, statement timeout 2 s on the reserve path (pool math in ADR-0001).
- **Slow payment methods:** Fawry (24 h) and wallet redirects (30 min) hold the reservation for their payment window (master prompt §7). **Drop Hour items are excluded from Fawry.** One-off units outside drops may be reserved for the Fawry window; the window length is market config and admin-editable with audit.
- **Price and stock on pages** are never served from a stale cache (ADR-0001). "N left" is shown only when real and ≤ 5.
- **SEO lifecycle** (BUILD-PROMPT §5): temporarily out of stock → 200 with `OutOfStock`; a sold one-off unit → 410, or a 301 to the closest match. The unit's defect passport stays reachable (ADR-0009).

### Acceptance (become tests)
- Property/chaos: 10,000 concurrent reserves on 100 units → exactly 100 claimed, 0 oversold, no deadlocks, across 1,000 runs.
- One-off: 1,000 concurrent buyers on one unit → exactly one claim; every other buyer gets "sold" with no charge.
- k6: reserve p95 < 150 ms at 20× baseline.
- Killing the API mid-saga leaves no reservation held beyond its TTL and no double charge.

## Consequences

**Good**
- Stock, orders and ledger commit atomically; no cross-store reconciliation for stock.
- One-off defect units need no special model.

**Bad / risks**
- Write amplification and many small rows. Mitigation: pool cap; partition or archive claimed units.
- The sweeper and replenisher need metrics and alerts (stuck reservations, pool depletion).
- Postgres is on the hot path of every drop; connection pooling must be load-tested before launch.

## Verify-register rows
- **V37** whether `pg_cron` exists on the chosen managed Postgres (else worker-based sweeper).
- No legal row. Reservation windows for Fawry and wallets depend on contracts (V4).

## Related
ADR-0001 (pool math), ADR-0003 (ledger in the same transaction), ADR-0009 (passport per unit), ADR-0006 (`market_id`).

## Revisit when
One SKU's reserve rate exceeds what one primary sustains in load tests. Then evaluate sharding by `sku_id` before reconsidering Redis.
