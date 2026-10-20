# Seller analytics v1 (spec 19.1)

Status: implemented v1 on in-memory and Kysely adapters; not yet registered in `app.module.ts`.
Code: `apps/api/src/modules/seller-analytics`, pure rules in `packages/domain/src/seller-analytics`,
migration `0028_seller_analytics.sql`.

## Flow
Event relay -> `EventSourcePort.poll` -> `ConsumeSellerAnalytics` (Zod strict parse, drop and count poison)
-> `AnalyticsStore.ingest` (inbox `inbox_processed`, consumer `seller-analytics`, one transaction) -> ack.
Sellers read through `GET /v1/seller/stores/:storeId/analytics/*`; every response carries `meta.freshness`.

## Algorithm choice (2 options)
1. Pre-aggregated rollup tables updated on ingest: fastest reads, but k-anonymity needs distinct-shopper
   counts that cannot be re-derived from rollups, and a late or replayed event would corrupt them.
2. Append-only fact table plus query-time aggregation (chosen for v1): distinct shoppers, repeat rate and
   k-suppression are exact for any date range and replay is trivially idempotent by message id.
   Cost: scan per request; mitigated by `(store_id, kind, occurred_at)` indexes and the 366-day cap.
   The 15 minute freshness SLO is met because ingest is the only lag. Rollups can be added behind the same port.

## Read models
| Route | Content | Privacy gate |
|---|---|---|
| `traffic` | store views, product views, unique visitors, by source | source buckets k >= 50 |
| `funnel` | impression, view, save, bag, checkout, purchase per product, bps conversion | none (product aggregate) |
| `sales` | GMV, commission, net, units, orders, AOV (banker's rounding), repeat rate | repeat rate withheld below 50 shoppers |
| `sell-through` | sold / (sold + on hand) per SKU | none |
| `size-curve` | sold share vs stocked share per size | none |
| `aging` | 30/60/90 day alerts with markdown recommendation | none |
| `returns` | return rate and reason counts per SKU | none |
| `search-terms` | terms leading to the store | k >= 50 distinct shoppers, PII-looking terms rejected at ingest |
| `geography` | governorate cells | k >= 50 distinct shoppers |
| `POST exports` | watermarked CSV of any of the above | same filters; owner or manager only; audit first |

## Privacy rules (all tested)
- k-anonymity: constant `K_ANONYMITY_MIN = 50`, counted on DISTINCT `shopper_key`, no parameter to lower it.
  Suppressed cells are only counted, never named.
- `shopper_key` is stored only to count distinct shoppers and appears in no port return type, wire type or CSV.
- Ingest schemas are strict objects: `measurements`, `budget_*`, `user_id`, and any unknown key fail validation.
- Budget and measurement tables are never imported or queried (`test/boundaries.test.ts`; depcruise rule requested).
- Markdown recommendation (`recommendMarkdown`) is a pure heuristic (`basis: heuristic_v1`, not the elasticity
  model, no clearance-probability claim). Every result sets `showsPercentOff: false` and carries the AR/EN notice
  that the new price will NOT show a % off unless verified against the VRP (spec 9, 17).
- CSV: header carries seller id, report, time and a per-export watermark; every row repeats seller id and
  watermark; text cells get a spreadsheet-formula guard. The audit entry (`AuditPort`) is written before any
  content is returned; if the audit trail fails the export fails closed.

## Differencing defence (k-anonymity)
Defect: ungated totals (store/product views, GMV, orders) minus released cells recovered a suppressed cell.
Options: (a) complementary suppression of the next-smallest released cell, which hides released data and
(per-cell counts cannot prove union size under shopper overlap) needs extra suppression; (b) fold suppressed
cells into the smallest released cell so sum(released) equals the total and the residual is exactly 0;
(c) noise, which is non-deterministic and breaks money reconciliation. Chosen: (b), `kAnonymizeAdditive` in
domain `kanon`, applied to traffic by_source and geography (sales gmv/orders reconcile with geography).
The merged cell has >= 50 shoppers on its own and is flagged `includes_suppressed: true` on the wire; no
"other" bucket is shown because shopper overlap makes a union lower bound unprovable. When nothing is
released there is no cell to subtract from and the totals describe the whole population.
Time-window limit (inherent): differencing adjacent windows can still isolate a short period's delta; k
protects cells, not the sequence of releases. Mitigation: windows are snapped outward to whole UTC days
(minimum granularity one day, `snapToDays`), plus rate limits and the export audit. Purchases without a
governorate are not in geography cells (checkout requires one).

## Authorization
Resolver returns the addressed store; policy compares with the actor's brand grants. Foreign, missing and
malformed store ids are all 404 with identical bodies. Dashboards use policy resource `store_order` read
(owner, manager, warehouse, support, finance); export uses `store_settings` read (owner, manager).
Database: RLS on all three tables by `app_store_ids()`; only role `system` writes; adapter reads set
`app.role=seller` and `app.store_ids=<store>` and still repeat `store_id = $1`.

## Edge cases
Zero orders (AOV null, rates null), empty range (400 when from >= to or span > 366 days), stale stock
observation (ignored, earliest `listed_at` kept), duplicate delivery (inbox), checkout and impression events
without a store (see gaps), commission above gross (CHECK + domain error), suspended seller (403).

## Gaps and follow-ups
- `impression` is not in the analytics taxonomy; the catalog or feed module must publish it as a SourceEvent.
- `checkout_started` and `order_placed` carry no store id. The orders module must publish per-store `checkout`
  and `purchase` SourceEvents (with `sellerOrderId`, `skuId`, `grossMinor`, `commissionMinor`, `governorate`).
- `stock_snapshot` must come from the inventory module on every on-hand change.
- Seller demographics (age band, etc.) are not collected anywhere, so only geography exists; any new dimension
  must use `kAnonymize`.
- Elasticity-based markdown ("clear 80% in 7 days") and ClickHouse serving are out of scope for v1.
- A dedicated `store_analytics` policy resource type would be cleaner than borrowing `store_order` / `store_settings`.
