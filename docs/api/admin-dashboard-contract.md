# Contract: `GET /v1/{market}/admin/dashboard`

Status: **Proposed** (architect, 2026-11-10). Plan: `docs/plan/admin-dashboard-port.md`. Add to `docs/api/openapi.yaml` (tag `Admin Dashboard`, operationId `adminGetDashboard`) and to `apps/api/openapi.todo.json` until served.

## 1. Operation

| | |
|---|---|
| Method / path | `GET /v1/{market}/admin/dashboard?range=7d\|30d\|90d` (default `30d`; anything else -> 400 `validation-failed`) |
| Auth | Admin passkey session (tenant `admin`), `@Authorize("dashboard.read", market, { tenant: "admin" })`. Wrong market -> 404; shopper / seller principal -> 403; no session -> 401. |
| Per-tile authZ | The service calls `authorize(principal, tileAction, { type: "admin_console", marketId })` for every tile **before** reading. Denied -> `{ status: "forbidden" }`, nothing queried. super_admin counts only while break-glass is live (same as `@outlet/policy`). |
| Idempotent | Read only; no `Idempotency-Key`. |
| Reason code | Not required: totals and counts only, no per-person or per-account rows (`finance.summary.read`, `dashboard.read` are not in `REQUIRES_REASON_CODE`). No `pii_access_log` entry. |
| Rate limit | New budget `adminDashboard: b("admin_dashboard", 30, MINUTE, ["user"], "open", "default")` in `apps/api/src/platform/rate-limit/budgets.ts`. 429 with `Retry-After`. |
| Query budget | `@Contract({ maxQueries: 10 })`: 1 snapshot read (all snapshot tiles, `WHERE market_id = $1 AND tile_key = ANY($2)`), 1 sales-daily read (series + today), 1 store-sales read (top stores), plus live counts: KYC 1, approvals 1, elevations 1, attention 1, flags 1. Each live reader returns its count in one statement. Statement timeout 2 s per query; the whole op 5 s. p95 target < 300 ms (SLO API read). |
| Caching | `Cache-Control: no-store` (BFF already sets it). Server-side: none (snapshots are already precomputed; caller-specific counts must not be shared). |
| Errors | Problem+JSON. A failing tile never fails the whole response: `Promise.allSettled`, the failed tile is `{ status: "unavailable", reason: "read_failed" }` and the error is logged with the tile key (no PII). Only auth/validation/rate-limit fail the request. |

## 2. Tile -> action -> reader

| Tile key | Action | Reader | Exists today |
|---|---|---|---|
| `orders_today`, `sales_series.orders` | `order.read` | `PgDashboardReader.salesDaily` (`market_sales_daily`) | NEW (migration 0035 + rollup) |
| `gmv_today`, `sales_series.gmv`, `top_stores` | `finance.summary.read` (NEW) | `salesDaily`, `storeSalesTop` (`store_sales_daily`) | NEW |
| `orders_by_step`, `seller_sla_breaches`, `cod_awaiting_confirmation` | `order.read` | `PgDashboardReader.snapshots` | NEW |
| `returns_pipeline` | `return.read` | snapshots | NEW |
| `disputes_open` | `dispute.decide` | snapshots | NEW |
| `refunds_waiting`, `refunds_overdue` | `refund.approve` | snapshots | NEW |
| `payouts` | `payout.read` | snapshots | NEW |
| `recon_unmatched` | `finance.summary.read` | snapshots (`reconciliation_exceptions`) | NEW (PgReconciliationReader lists runs/items only, reason-coded) |
| `cod_unremitted` | `finance.summary.read` | none until a courier adapter is configured | returns `unavailable/not_connected` |
| `ledger_integrity` | `finance.summary.read` | integrity-job result | returns `unavailable/not_connected` until the job persists results |
| `kyc_queue` | `seller_kyc.review` | `PgKycAdmin.count` (worker ctx `seller.kyc`) | list YES, add `count` |
| `stores_moderation` | `store.read` | snapshots | NEW |
| `price_enforcement`, `verified_discount_share` | `price_integrity.read` | snapshots | NEW (enforcement list route is contract-only) |
| `listings_by_status` | `listing.read` | snapshots | NEW |
| `breaches_open`, `dsar_queue` | `breach.manage` | snapshots | NEW (privacy routes contract-only) |
| `attention_open` | `attention.read` (NEW) | `PgAttentionReader.countOpen` (app `user` ctx) | reader YES, add `countOpen` |
| `approvals_pending` | `approval.read` | `PgApprovalReader.countPending(principal)` (excludes own requests and actions the caller's roles cannot decide) | list YES, add count |
| `elevations_active` | `elevation.request` (own) / `elevation.approve` (market) | `PgElevationReader.countActive(principal, seesAll)` | list YES, add count |
| `kill_switches` | `kill_switch.read` | `FlagAdmin.list(marketId)` + `KILL_SWITCHES` | YES |

Orders and GMV have **no cheap aggregate today**: `order_groups` is indexed by `user_id` and expiry only, `seller_orders` by `store_id`, and the ledger has no per-day projection (`ledger.ts` sums all `postings` of a market). Hence the rollup tables in migration `0035_admin_dashboard_rollups.sql` (plain tables, not materialized views, because views cannot carry the RLS that ADR-0011 requires); spec in the plan §5.

## 3. Response shape (Zod, `apps/api/src/modules/admin/dto-dashboard.ts`; the admin app re-parses it in `apps/admin/src/lib/dashboard/schemas.ts`)

```ts
import { z } from "zod";

export const DashboardQuery = z.object({ range: z.enum(["7d", "30d", "90d"]).default("30d") }).strict();

const Count = z.int().nonnegative();
const Iso = z.iso.datetime({ offset: true });
const Day = z.iso.date(); // market-local day, YYYY-MM-DD
export const Money = z.object({
  amount_minor: z.string().regex(/^-?\d{1,19}$/), // bigint as decimal string
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
const Point = z.object({ day: Day, value: Count }).strict();
const MoneyPoint = z.object({ day: Day, value: Money }).strict();

/** One tile envelope. `as_of` = when the numbers were computed (snapshot time or now() for live reads). */
const tile = <K extends string, D extends z.ZodType>(key: K, data: D) =>
  z.discriminatedUnion("status", [
    z.object({ key: z.literal(key), status: z.literal("ok"), as_of: Iso, data }).strict(),
    z.object({ key: z.literal(key), status: z.literal("forbidden") }).strict(),
    z.object({ key: z.literal(key), status: z.literal("unavailable"), reason: z.enum(["not_connected", "read_failed", "stale"]) }).strict(),
  ]);

const Oldest = { oldest_at: Iso.nullable() };

export const DashboardResponse = z.object({
  market_id: z.string().min(2),
  range: z.enum(["7d", "30d", "90d"]),
  timezone: z.string(),            // markets-config, e.g. Africa/Cairo
  today: Day,
  generated_at: Iso,
  sections: z.object({
    today: z.object({
      orders_today: tile("orders_today", z.object({ count: Count, series_14d: z.array(Point).max(14) }).strict()),
      gmv_today: tile("gmv_today", z.object({ gmv: Money, refunded: Money, gmv_7d: Money }).strict()),
    }).strict(),
    sales: z.object({
      sales_series: tile("sales_series", z.object({
        orders: z.array(Point).nullable(),   // null when order.read is denied
        gmv: z.array(MoneyPoint).nullable(), // null when finance.summary.read is denied
        total_orders: Count.nullable(),
        total_gmv: Money.nullable(),
      }).strict()),
      orders_by_step: tile("orders_by_step", z.object({
        paid_awaiting_accept: Count, accepted: Count, packed: Count, in_transit: Count, delivery_failed: Count,
      }).strict()),
      top_stores: tile("top_stores", z.object({
        items: z.array(z.object({ store_id: z.uuid(), name_ar: z.string(), name_en: z.string().nullable(), orders: Count, gmv: Money }).strict()).max(5),
        other: z.object({ stores: Count, orders: Count, gmv: Money }).strict(),
      }).strict()),
      verified_discount_share: tile("verified_discount_share", z.object({ verified: Count, live_skus: Count }).strict()), // ratio computed in UI with integers
    }).strict(),
    orders: z.object({
      seller_sla_breaches: tile("seller_sla_breaches", z.object({ late_accept: Count, late_dispatch: Count.nullable(), // null until seller_orders.dispatch_by is populated (not a fabricated 0)
        ...Oldest }).strict()),
      cod_awaiting_confirmation: tile("cod_awaiting_confirmation", z.object({ count: Count, ...Oldest }).strict()),
      returns_pipeline: tile("returns_pipeline", z.object({ requested: Count, in_transit: Count, awaiting_inspection: Count, inspection_overdue: Count }).strict()),
      disputes_open: tile("disputes_open", z.object({ open: Count, past_sla: Count, ...Oldest }).strict()),
    }).strict(),
    money: z.object({
      refunds_waiting: tile("refunds_waiting", z.object({ count: Count, amount: Money, manual_review: Count, failed: Count, ...Oldest }).strict()),
      refunds_overdue: tile("refunds_overdue", z.object({ count: Count, amount: Money, oldest_due_at: Iso.nullable() }).strict()),
      payouts: tile("payouts", z.object({ due_count: Count, due_net: Money, on_hold_count: Count, on_hold_net: Money, failed: Count, open_holds: Count }).strict()),
      recon_unmatched: tile("recon_unmatched", z.object({ open: Count, escalated: Count, aged_over_3d: Count, ...Oldest }).strict()),
      cod_unremitted: tile("cod_unremitted", z.object({ parcels: Count, amount: Money }).strict()),
      ledger_integrity: tile("ledger_integrity", z.object({ balanced: z.boolean(), chain_ok: z.boolean(), checked_at: Iso }).strict()),
    }).strict(),
    trust: z.object({
      kyc_queue: tile("kyc_queue", z.object({ submitted: Count, needs_info: Count, ...Oldest }).strict()),
      stores_moderation: tile("stores_moderation", z.object({ pending_review: Count, suspended: Count }).strict()),
      price_enforcement: tile("price_enforcement", z.object({ active: Count, pending_review: Count, suspensions_awaiting_review: Count }).strict()),
      listings_by_status: tile("listings_by_status", z.object({ published: Count, in_review: Count, paused: Count, blocked: Count }).strict()),
    }).strict(),
    privacy: z.object({
      breaches_open: tile("breaches_open", z.object({ open: Count, next_pdpc_deadline_at: Iso.nullable(), next_subjects_deadline_at: Iso.nullable() }).strict()),
      dsar_queue: tile("dsar_queue", z.object({ open: Count, due_7d: Count, overdue: Count }).strict()),
    }).strict(),
    platform: z.object({
      attention_open: tile("attention_open", z.object({ open: Count, acked: Count, by_kind: z.record(z.string().regex(/^[a-z_.]{1,60}$/), Count), ...Oldest }).strict()),
      approvals_pending: tile("approvals_pending", z.object({ for_me: Count, soonest_expires_at: Iso.nullable() }).strict()),
      elevations_active: tile("elevations_active", z.object({ active: Count, pending: Count, scope: z.enum(["own", "market"]) }).strict()),
      kill_switches: tile("kill_switches", z.object({ engaged_money: z.array(z.string()), engaged_ui: z.array(z.string()) }).strict()),
    }).strict(),
  }).strict(),
}).strict();
export type DashboardResponse = z.infer<typeof DashboardResponse>;
```

Rules:
- Every tile key is always present (stable shape); hidden = `forbidden`.
- `as_of` for snapshot tiles is the snapshot time; the UI shows "Updated {relative}" and turns a tile `stale` when `as_of` is older than 2x its refresh (sales 10 min, snapshots 2 min). The API fails closed at 15 minutes (`unavailable/stale`, no numbers). Separately, the console marks a snapshot stale at 2 minutes (10 minutes for sales tiles) while still showing the numbers with "Stale since {time}".
- `series_14d`: max 14 points, days before the first rollup are absent (a short series is valid; the UI left-aligns it, newest last).
- Series: one point per market-local day, oldest first, missing days filled with 0 **only** inside the rollup's covered window; days before the first rollup run are absent (the UI starts the axis there), never invented.
- Money values in one tile share one currency; a multi-currency market returns one tile per currency later (out of scope for EG; `currency` kept for ADR-0006).
- `top_stores.name_*` come from `stores`; no seller PII.

## 4. BFF and app

- `apps/admin/src/server/bff.ts` routes: `{ pattern: /^dashboard$/, methods: ["GET"] }`, `{ pattern: /^attention$/, methods: ["GET"] }`, `{ pattern: new RegExp(\`^attention/${ID}/(ack|resolve)$\`), methods: ["POST"] }` (writes carry `Idempotency-Key`, same-origin check already applies).
- Home server component calls `adminGet(market, "dashboard", { range })` and parses with the shared Zod schema; a parse failure renders every tile "Could not load" (never partial guessing).

## 5. Tests the op must ship with

- Role matrix: for each of the 8 admin roles (super_admin with and without break-glass), assert exactly which tiles are `ok` vs `forbidden` (generated from `ADMIN_POLICY`, so a policy change breaks the test visibly).
- Negative: other market -> 404; shopper and seller tokens -> 403; missing session -> 401; `range=1y` -> 400.
- Forbidden tiles issue zero queries (query spy).
- Query count <= 10 for finance + ops (widest real role sets).
- A reader that throws -> that tile `unavailable/read_failed`, others `ok`.
- RLS: `outlet_worker` with job `admin.dashboard` reads only its market's rows of the three new tables; any other job or `outlet_app` reads none.
- Property (fast-check): `market_sales_daily` after rollup equals brute-force sums of random `order_groups` per market-local day, including the Cairo DST switch days (Egypt observes DST since 2023); amounts stay `bigint`.
