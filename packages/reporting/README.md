# @outlet/reporting

Rollups behind the Admin Console Home (ADR-0015, migration 0035). Worker job `reporting.rollup`; the API reads the result as job `admin.dashboard`.

- `RollupService.run(marketId, day)`: one market-local day of `market_sales_daily` and `store_sales_daily`. GMV = `order_groups.total_minor` (VAT-inclusive, order basis, not net of refunds) of groups PAID (day of `paid_at`) or confirmed COD without `paid_at` (day of `placed_at`); `cancelled_at` is never consulted for either method (a confirmed COD group later cancelled counts, and its refund shows in `refunded_minor`); refunds go to `refunded_minor` by `completed_at`. The day is `(ts AT TIME ZONE tz)::date`, exact on Egypt's DST switch days. Idempotent upsert; a day that lost its activity is zeroed, never deleted (no DELETE grant). The market currency always gets a row, so a row's presence means "this day was rolled up".
- `RollupService.snapshots(marketId)`: the 15 snapshot tiles of `admin_dashboard_snapshots` (counts, oldest timestamps, amounts; every payload validated by `SNAPSHOT_TILE_DATA` before it is written and again by the API when it is read).
- `RollupConsumer`: inbox consumer of `reporting.rollup_requested` (`{scope: sales | nightly | snapshots, days?}`), one transaction per market. Intended cadence: sales every 5 min (3 days), snapshots every 60 s, nightly 90 days. Register with `reportingRollupHandlers` in `apps/api/src/worker-consumers.ts`; the scheduler that emits the tick belongs to the worker process.

Tests: `test/rollup.test.ts` (worked example, idempotency, a fast-check property against brute-force sums per Cairo day around both DST switches, store sums equal the market row, snapshots, inbox).


Privacy: `store_sales_daily` is per store, and a sole trader's store is a natural person (P2 in `data_inventory.yaml`). The table is read only by the admin dashboard job (`admin.dashboard`); it never reaches seller-visible or export paths.
