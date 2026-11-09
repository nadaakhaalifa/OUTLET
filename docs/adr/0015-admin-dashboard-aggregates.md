# ADR-0015: Admin dashboard aggregates (rollup tables, policy actions, GMV definition)

Status: Proposed (needs chief-reviewer and owner approval: policy, RLS and finance aggregates are two-key areas). Date: 2026-11-10.
Plan: `docs/plan/admin-dashboard-port.md` (section 4 D1-D3, section 5). Contract: `docs/api/admin-dashboard-contract.md`. Relates to ADR-0011 (roles and RLS contexts).

## Context
The Admin Console Home needs market-wide totals (orders, GMV, queues). No cheap aggregate exists: `order_groups` is indexed by user, `seller_orders` by store, and the ledger has no per-day projection. Counting live on the request pool would need many cross-tenant SELECT policies and heavy counts at 4M users.

## Options
- A. Live `COUNT(*)` per tile per request through new `outlet_worker` job-scoped policies on about 15 tables. Request cost grows with data; the most exception policies.
- B. A worker job (`reporting.rollup`) writes small per-market tables; the API reads them as job `admin.dashboard`. O(1) request cost; staleness is shown honestly through `as_of`.
- C. Materialized views. Rejected: a view cannot carry the RLS that ADR-0011 requires.

## Decision
1. **B.** Migration 0035 adds `market_sales_daily`, `store_sales_daily`, `admin_dashboard_snapshots` (plain tables, RLS forced, market pinned). `reporting.rollup` reads the source tables with SELECT-only, market-pinned policies (one per table, named `<table>__worker_reporting_rollup`) and upserts the rollups; `admin.dashboard` has SELECT on the three rollup tables only. Queue tables that are small, indexed and caller-specific (approvals "for me", elevations, KYC, attention, flags) stay live. `breach_records` has no RLS by design (0028), so the job gets a column-limited SELECT grant and pins the market in SQL.
2. **Policy v7.** New actions `dashboard.read` (all admin roles), `finance.summary.read` (finance; super_admin only in break-glass) and `attention.read` (ops, finance), plus `attention.write` (ops, finance) for acknowledging and resolving attention items. `finance.summary.read` returns market totals only (no per-person rows; the per-store rows of `store_sales_daily` stay inside the admin dashboard, and a sole trader's store is a natural person, so those columns are tagged P2 in `data_inventory.yaml`), so it is deliberately **not** in `REQUIRES_REASON_CODE` (unlike `ledger.read`, `reconciliation.read`, which open per-entity records). The dashboard service authorizes every tile with its own action before reading it.
3. **GMV (D3).** `gmv_minor` = sum of `order_groups.total_minor` (VAT-inclusive, after discounts, including shipping) of groups that reached PAID (day of `paid_at`) or CONFIRMED_COD with no `paid_at` (day of `placed_at`, because no confirmation timestamp exists), bucketed by the market-local day (Africa/Cairo). The day is `(ts AT TIME ZONE tz)::date`, exact on DST switch days. The same basis applies to COD and prepaid groups: `cancelled_at` is never consulted, so a confirmed COD group that is later cancelled (REFUND_PENDING / REFUNDED) counts like a paid group that is later cancelled and the cancellation appears in `refunded_minor` once its refund completes; a COD group whose status is CANCELLED, or that still awaits confirmation, is not counted (no confirmation timestamp exists to tell them apart). The `gmvBasis` tile note text states this order basis. Not net of refunds; `refunded_minor` is separate (by `refunds.completed_at`). Not a cash basis.
4. Honest numbers: a tile with no read, a missing snapshot or a failing read is `unavailable` (`not_connected` / `read_failed`), a snapshot older than 15 minutes is `stale`, a denied tile is `forbidden` and is never read. `cod_unremitted` and `ledger_integrity` stay `not_connected` until a courier adapter and a persisted integrity-job result exist.

## Consequences
- Two more worker jobs and 20 reviewed exception policies in `packages/db/test/fixtures/rls-exceptions.json`.
- Rollups are at most one scheduler interval stale (sales 5 min, snapshots 60 s planned; the tick source is composed with the worker process).
- Snapshot counts over `products`, `skus`, `return_requests`, `stores` and `price_claims` scan by market without a dedicated index; review `EXPLAIN` before launch scale.
- `dispatch_by` is not written by any code yet, so `late_dispatch` is `null` (unknown, never a fabricated 0) until it is.
- Retention: sales rollups 25 months (no purge job yet); snapshots are overwritten.
