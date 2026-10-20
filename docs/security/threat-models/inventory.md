# Threat model: inventory and reservations

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §20.2, §7, §16, ADR-0005 · Modules: `inventory`, `search-sync` (sold-out flags), seller stock sync

No inventory code exists yet.

## Scope and assets
`inventory_levels`, `inventory_units` (row per sellable unit), reservations with TTL, claim transaction, Redis sold-out flags and waiting room (never source of truth), seller stock-sync updates.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| INV-S1 | S | A seller or integration updates another seller's stock | Stock sync authenticated per channel connection; writes scoped by store through policy guard and RLS; foreign SKU is 404 | INV-T01 seller A adjusting seller B's SKU is 404 | planned |
| INV-T1 | T | Oversell through concurrent reserves | `FOR UPDATE SKIP LOCKED` row-per-unit reserve in one transaction, sorted SKU lock order, claim and ledger post in the same transaction | INV-T02 10k concurrent reserves on 100 units yield exactly 100 claimed, 0 oversold, no deadlocks over 1,000 runs (spec §20.2) | planned |
| INV-T2 | T | Seller stock sync replays or arrives out of order and resurrects stock | Idempotent, versioned updates (monotonic version per SKU and location); negative adjustment while reserved honors existing orders and applies oversell penalty | INV-T03 out-of-order and duplicate sync messages converge to the highest version | planned |
| INV-T3 | T | Redis flag treated as truth, giving false sold-out or false in-stock | Redis only a pre-filter; reserve path always checks Postgres; flag loss fails open to Postgres, waiting room fails closed during drops | INV-T04 flush Redis mid-test: no oversell, no phantom sold-out beyond TTL | planned |
| INV-R1 | R | Dispute over who held or released stock | Reservation and claim events through the outbox with reservation ID, actor and timestamps retained | INV-T05 every claimed unit traces to a payment event and an order line | planned |
| INV-I1 | I | Exact stock counts exposed to competitors or scrapers | Public API returns bucketed availability or "in stock in size M", not raw counts; seller sees own counts only. Never display invented scarcity | INV-T06 public product endpoint contains no `on_hand` field; CI lint for hard-coded social proof | planned |
| INV-D1 | D | Reservation hoarding: bots reserve drop stock and let it expire | Attestation and velocity limits on reserve, one reservation per OrderGroup, per-user and per-device caps on drop SKUs, 10 min TTL with 30 s sweeper | INV-T07 a single device cannot hold more than the cap; expired holds return to the pool within the sweeper interval | planned |
| INV-D2 | D | Connection exhaustion on hot SKUs (Shopify's observed bottleneck) | PgBouncer transaction mode, checkout pool isolated, `application_name` tagging, 2 s statement timeout, pool cap per hot key | INV-T08 k6 drop simulation keeps reserve p95 under 150 ms | planned |
| INV-D3 | D | Fawry or wallet payment windows tie up drop stock | Separate non-drop pool for 24 h Fawry holds; drop SKUs excluded from Fawry | INV-T09 Fawry method unavailable for drop SKU; pool counters stay separate | planned |
| INV-E1 | E | Shopper API manipulates reservation IDs or TTL | Reservation IDs are server-generated and bound to user and OrderGroup; no client-supplied expiry | INV-T10 foreign reservation ID is 404; TTL field in request ignored | planned |

## Open items
- Hot-key replenisher uses an advisory lock; lock hashing collisions across SKUs must be tested.
- Fake stock is forbidden (§A2.13): development fixtures must never be reachable from a release build. Test INV-T11 asserts fixture adapters are excluded when `NODE_ENV=production`.

## Residual risk
Legitimate fast humans cannot be distinguished from tuned bots by attestation alone; the waiting room and per-user caps are the backstop.
