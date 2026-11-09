# Admin dashboard port: Tatreezh Home -> Outlex Admin Console

Status: **Proposed** (architect, 2026-11-10). Contract: `docs/api/admin-dashboard-contract.md`.
Two-key areas touched: `policy` (new actions), RLS (new worker-job policies), `ledger`/finance aggregates. Those PRs carry `needs-human`.

## 0. Inputs read

- Tatreezh (`apps/admin`, Next 16, next-intl, CSS modules, lucide-react): `components/shell/*` (AdminShell, NavList, MobileTabBar, MobileNav, SkipLink, navigation.ts groups), `components/dashboard/*` (Dashboard.tsx "All checks" grid, PhoneHome.tsx Today + Sales and orders, AttentionPanel, Tile, lib/{dashboard,attention,phone}.ts, server/{data,phone,visual}.ts), `components/charts/*` (ChartFrame, ColumnsChart, BarList, KpiCard, Sparkline, ChartTableToggle, format/scale/path), `components/common/*`, `app/(admin)/{layout,page}.tsx`, `docs/resume/polish-admin-dashboard-phone.md`, ADR-0018, shots `home-1440-en.png`, `home-390-ar.png`.
- Outlex: `docs/BUILD-PROMPT.md`, `docs/design/ui-reference-spec.md` (**no mock-up covers the Admin Console**: the 5 images are shopper web and Seller Center; the console takes only the palette and type from §0 via `@outlet/ui-tokens`, no 3D storefront art), `apps/admin/**`, `apps/admin/src/server/{bff,session,admin-get}.ts`, `apps/api/src/modules/admin/**`, `docs/api/openapi.yaml` admin paths + `apps/api/openapi.todo.json`, `packages/ops-attention/README.md`, `packages/policy/src/policies.ts`, ADR-0011, migrations 0008-0033.

## 1. What is kept from Tatreezh (structure and behaviour)

| Tatreezh | Outlex port | Notes |
|---|---|---|
| Sidebar with collapsible groups (`navigation.ts` NAV_GROUPS), top bar (account, language, sign out), MobileTabBar + MobileNav sheet, SkipLink | Same components under `apps/admin/src/components/shell/` | Items filtered by `can(profile, action)` (display only; API enforces). Groups: **Overview** (Home), **Sellers** (KYC, Stores), **Trust** (Price integrity, Disputes), **Money** (Reconciliation, Refunds, Payouts), **Privacy** (DPO), **Platform** (Attention, Approvals, Access/elevations, Kill switches, Audit). Tab bar on phones: Home, Attention, Approvals, More. |
| Home = "Today" cards, one per row on phones (2 cols >= 48rem, 3 cols >= 80rem), each opens a pop page `/today/<card>` (pushed page, Back to Home, max 50 rows, "Open the full list") | `/[segment]/(console)/page.tsx` + `/[segment]/(console)/today/[card]/page.tsx` | A card and its pop page need the same action; pop page answers 404 (not 403, BUILD-PROMPT deny-by-default) for an unknown card, 403 for a forbidden one. |
| "Needs you today" (AttentionPanel): only rows with count > 0, urgent first, a count that failed to load is left out and the panel says "some checks could not be read" instead of "all clear" | Same rules, rows built from the dashboard response (no extra reads) | Pure `lib/attention.ts`, unit-tested. |
| "Sales and orders": 7/30/90 switch (44 px pills), single-hue columns (1/day up to 14 days, weekly above, weeks anchored at newest day), direct labels on highest + newest column, text summary, **Show as table** toggle (`aria-pressed`), open-orders-by-step bars (each bar a 44 px link), best sellers, low stock | Columns + table kept; bars kept for seller-order steps; **best sellers -> Top stores**; **low stock -> Verified-discount share** | Low stock / best products are a seller concern (Seller Center) in a marketplace. |
| "All checks" tile grid by section, tile status `alert`/`ok`, failure note per tile | Kept, sections re-cut for the marketplace (§3) | |
| Re-theme | `@outlet/ui-tokens` (cream page, paper surface, green 800 primary, lime 400 focus ring, amber/red status); chart hue `green.700 #2B5239` on paper, `green.300 #8FC29E` on dark (`night.*`) | **Not** Tatreezh rose `#c72b5a`. Re-run the dataviz validator (3:1 against surface, both themes). Outlex has a dark theme; Tatreezh did not, so every component gets dark tokens. |

Licences: Plex Sans Arabic/Latin already ship in `apps/admin/src/fonts` (OFL), nothing to copy from Tatreezh. Icons: Tatreezh uses `lucide-react` (ISC). Adding it to `apps/admin/package.json` is a new dependency: ADR-lite note (BUILD-PROMPT dependency rule) + a THIRD_PARTY notice entry. Code copied from Tatreezh is the owner's own; keep a one-line provenance comment per ported file.

## 2. Honest numbers rule

- A tile with no backing read renders **"Not connected yet"** (`status: "unavailable"`, reason `not_connected`), never 0 and never a placeholder.
- A tile the caller may not see is not computed (`status: "forbidden"`, no `data`) and not rendered.
- A read that failed renders "Could not load" (`unavailable`, reason `read_failed`) and removes the "all clear" claim from Needs you today.
- Every aggregate carries `as_of`; a snapshot older than 2x its refresh interval renders "Stale since {time}".
- Money is `{ amount_minor: string, currency }` (bigint in transit as decimal string) formatted by `@outlet/money`; counts are integers; no float maths anywhere in the UI.
- Discount claims are never shown on the dashboard except the verified-discount share (a ratio of counts from Price Watch output).

## 3. Tile map

Legend - **Served**: `yes` = the API already returns this (reuse the reader); `contract` = in `openapi.yaml` but listed in `openapi.todo.json` (not served); `no` = new reader. **Gate** = policy action (existing unless marked NEW).

### 3.1 Tatreezh tiles -> Outlex

| Tatreezh key | Outlex tile key | Source read | Gate | Served |
|---|---|---|---|---|
| newOrders (today + 14-day sparkline) | `orders_today` | `market_sales_daily` rollup (NEW table, §5) | `order.read` | no |
| money (in today) | `gmv_today` (order basis, VAT-incl., before refunds; refunds shown beside) | `market_sales_daily` | `finance.summary.read` NEW | no |
| codToCall | `cod_awaiting_confirmation` | snapshot: `order_groups` status `AWAITING_COD_CONFIRMATION` | `order.read` | no |
| lateOrders | `seller_sla_breaches` (PAID past `accept_by`, ACCEPTED past `dispatch_by`) | snapshot: `seller_orders` | `order.read` | no |
| ordersToPrepare / readyToShip | folded into `orders_by_step` bars (PAID, ACCEPTED, PACKED, SHIPPED+OUT_FOR_DELIVERY, DELIVERY_FAILED) | snapshot: `seller_orders` | `order.read` | no |
| board (production) | - | **no equivalent, drop** | | |
| codUnsettled | `cod_unremitted` | `cod_remittances` / `cod_clearing` | `finance.summary.read` NEW | no: renders **Not connected yet** until a courier adapter is configured (ADR-0029 Unconfigured) |
| returns | `returns_pipeline` (REQUESTED, in transit, RECEIVED awaiting inspection, inspection overdue) | snapshot: `return_requests` | `return.read` | no |
| refundApprovals | `refunds_waiting` (REQUESTED, MANUAL_REVIEW, FAILED; count + amount) | snapshot: `refunds` | `refund.approve` | no |
| overdueRefunds | `refunds_overdue` (not COMPLETED and `due_at < now`) | snapshot: `refunds` | `refund.approve` | no |
| giftCardLiability | - | **no equivalent, drop** (gift cards Phase 2; store-credit liability can come later from ledger) | | |
| reconciliation | `recon_unmatched` (OPEN + ESCALATED exceptions, oldest age, count aged > 3 days) | `reconciliation_exceptions` | `finance.summary.read` NEW | partly: runs/items served via `PgReconciliationReader` (needs reason code); count is no |
| drift (balance check) | `ledger_integrity` (latest integrity-job result: trial balance per currency, hash chain ok) | integrity job output (none persisted today) | `finance.summary.read` NEW | no: **Not connected yet** until the integrity job stores results. Never computed live on request (full `postings` scan). |
| lowStock / soldOut | - | **drop** (Seller Center concern); replaced by `verified_discount_share` | | |
| products | `listings_by_status` (PUBLISHED, IN_REVIEW, PAUSED, BLOCKED) | snapshot: `products` | `listing.read` | no |
| attention: nearDeadline, proofs, requests, intlDelayed, needsReview, newCountry, lowStock | - | **drop** (single-shop / cross-border / production concepts) | | |
| attention: paymentsToConfirm | `cod_awaiting_confirmation` | as above | `order.read` | no |
| phone cards toMake, abroad; design chats, cash-outs, gift cards, personalisation, marketing studio | - | **drop** | | |

### 3.2 Marketplace tiles (new)

| Tile key | Shows | Source read | Gate | Served |
|---|---|---|---|---|
| `kyc_queue` | cases SUBMITTED/AUTO_CHECKS/NEEDS_INFO, oldest submitted age | `PgKycAdmin` (+ new `count()` on the same worker ctx `seller.kyc`) | `seller_kyc.review` | list yes, count no |
| `price_enforcement` | active actions by type, `pending_review` count, suspensions awaiting human review (5-day SLA) | `enforcement_actions` | `price_integrity.read` | contract (`price-integrity/enforcement-actions` in todo) |
| `verified_discount_share` | active published SKUs with `price_claims.display_allowed` and `claim_type='verified_discount'` / active published SKUs | snapshot: `price_claims`, `skus`, `products` | `price_integrity.read` | no |
| `recon_unmatched` | see 3.1 | | | |
| `refunds_waiting`, `refunds_overdue` | see 3.1 | | | |
| `payouts` | SCHEDULED due this cycle (count + net), ON_HOLD (count + net), FAILED, open `payout_holds` | snapshot: `payouts`, `payout_holds` | `payout.read` | no |
| `attention_open` | OPEN + ACKED ops-attention items by kind (refund / promotions settle / shipment cancel), oldest age | `PgAttentionReader` (+ new `countOpen()`) | `attention.read` NEW (ops, finance) | no (README: intended routes, not wired) |
| `kill_switches` | engaged switches (row with `enabled=false`), money vs ui class | `FlagAdmin.list` + `KILL_SWITCHES` | `kill_switch.read` | yes (`GET feature-flags`) |
| `approvals_pending` | PENDING requests the caller may decide (not own), soonest `expires_at` | `PgApprovalReader` (+ `countPending(principal)`) | `approval.read` | list yes, count no |
| `elevations_active` | APPROVED and `now() between starts_at and expires_at`; PENDING for approvers | `PgElevationReader` (+ `countActive`) | `elevation.request` (own) / `elevation.approve` (all) | list yes, count no |
| `breaches_open` | non-CLOSED breaches, earliest `pdpc_deadline_at` (72 h clock), subjects deadline | snapshot: `breach_records` | `breach.manage` | contract (`privacy/breaches` in todo) |
| `dsar_queue` | open `privacy_requests` by kind, due within 7 days, overdue | snapshot: `privacy_requests` | `breach.manage` (same gate as the DPO section today) | contract (`privacy/requests` in todo) |
| `disputes_open` | OPEN/UNDER_REVIEW, past `sla_due_at` | snapshot: `disputes` (index `disputes_queue_idx`) | `dispute.decide` | no |
| `stores_moderation` | stores PENDING_REVIEW, SUSPENDED | snapshot: `stores` | `store.read` | no |
| `top_stores` | top 5 stores by GMV in range (+ "Other stores"), with order counts | `store_sales_daily` rollup + `stores.name` | `finance.summary.read` NEW | no |
| `sales_series` | GMV per day and paid orders per day for 7/30/90 | `market_sales_daily` | GMV: `finance.summary.read`; orders: `order.read` | no |

### 3.3 Home layout (top to bottom)

1. **Today** cards (order fixed; only allowed ones): `orders_today`, `gmv_today`, `attention_open`, `approvals_pending`, `kyc_queue`, `refunds_waiting`, `recon_unmatched`, `breaches_open`, `dsar_queue`.
2. **Needs you today** (urgent first): breach PDPC deadline < 24 h, DSAR overdue, refunds overdue, recon aged > 3 days, disputes past SLA, then ops-attention open, approvals for me, KYC waiting, enforcement `pending_review`, seller SLA breaches, COD awaiting confirmation, payouts on hold. Info row: kill switches engaged.
3. **Sales and orders** (`finance.summary.read` or `order.read`): range pills, GMV columns (finance) or orders columns (others), `orders_by_step` bars, `top_stores` (finance), `verified_discount_share` (price_integrity.read). Streams behind a Suspense skeleton.
4. **All checks** sections: Orders (`orders_by_step`, `seller_sla_breaches`, `cod_awaiting_confirmation`, `returns_pipeline`, `disputes_open`), Money (`refunds_waiting`, `refunds_overdue`, `payouts`, `recon_unmatched`, `cod_unremitted`, `ledger_integrity`), Trust (`kyc_queue`, `stores_moderation`, `price_enforcement`, `listings_by_status`), Privacy (`breaches_open`, `dsar_queue`), Platform (`attention_open`, `approvals_pending`, `elevations_active`, `kill_switches`).

Role coverage check (display): support sees orders, returns, approvals; marketing sees approvals/elevations only (Home shows "Nothing to show for your role" EmptyState, as today's `admin.overview.none`); super_admin sees money tiles only while break-glass is live (same `can()`).

### 3.4 Pop pages (`/today/<card>`)

Reuse served list endpoints through the BFF where they exist: `kyc_queue` -> `GET kyc-cases`, `approvals_pending` -> `GET approval-requests`, `elevations_active` -> `GET elevations`, `kill_switches` -> `GET feature-flags`, `attention_open` -> new `GET attention` (README route, market-scoped as `/v1/{market}/admin/attention`). Money/order cards whose list endpoint does not exist yet show the count, the `as_of`, and "Full list not connected yet" (no fake list).

## 4. Decisions (ADR-lite, record in `docs/adr/0015-admin-dashboard-aggregates.md`)

**D1. How the API gets market-wide counts.** Options: (A) live `COUNT(*)` per tile per request through new `outlet_worker` job-scoped SELECT policies on ~15 tenant tables; (B) a worker rollup (`reporting.rollup`) writes per-market snapshots every 60 s and daily sales rows every 5 min; the API reads 2-3 small tables; (C) Postgres materialized views. **Choice B**: request cost is O(1) at 4M users and drop spikes, the request path needs only two new SELECT policies, and staleness is shown honestly via `as_of`; C is rejected because materialized views cannot carry RLS (ADR-0011 requires market-pinned, role-scoped policies), A multiplies exception policies and puts heavy counts on the request pool. Queue tables already read in place (approvals, elevations, KYC, attention, flags) stay live (small, indexed, and the caller-specific "for me" filter cannot be precomputed).

**D2. New policy actions** (`packages/policy/src/policies.ts`, bump `POLICY_VERSION`): `dashboard.read` (all admin roles), `finance.summary.read` (finance; super_admin via break-glass), `attention.read` (ops, finance). `finance.summary.read` returns market totals only, no per-account or per-person rows, so it is deliberately **not** in `REQUIRES_REASON_CODE` (unlike `ledger.read`/`reconciliation.read`, which open per-entity records). Needs chief-reviewer + owner approval (two-key).

**D3. GMV definition.** `gmv_minor` = sum of `order_groups.total_minor` (VAT-inclusive, after discounts, incl. shipping) for groups that reached PAID (by `paid_at`) or CONFIRMED_COD (by confirmation time; until a column exists, `placed_at` of CONFIRMED_COD groups, documented), bucketed by market-local day (`markets-config` timezone, `Africa/Cairo`). Not net of refunds; `refunded_minor` is a separate column (by `refunds.completed_at`). Not cash basis; the tile tooltip says so (Tatreezh had the same two-definition caveat).

## 5. Data changes (wave B, migration `0035_admin_dashboard_rollups.sql`, expand-only)

- `market_sales_daily(market_id, day date, currency char(3), orders_paid int, gmv_minor bigint, refunded_minor bigint, refreshed_at timestamptz, PK(market_id, day, currency))`.
- `store_sales_daily(market_id, store_id, day, currency, orders_paid, gmv_minor, refreshed_at, PK(market_id, store_id, day, currency))`, index `(market_id, day)`.
- `admin_dashboard_snapshots(market_id, tile_key text, as_of timestamptz, payload jsonb, version int, PK(market_id, tile_key))`; payload Zod-validated on read (DB JSON boundary).
- All three: RLS enabled + forced; policies `<tbl>__worker_reporting_rollup` (outlet_worker, `app.job()='reporting.rollup'`, INSERT/UPDATE/SELECT, market pin) and `<tbl>__worker_admin_dashboard` (outlet_worker, `app.job()='admin.dashboard'`, SELECT, market pin). Add both jobs to `WORKER_JOBS` (`packages/db/src/context.ts`) and to `packages/db/test/fixtures/rls-exceptions.json`.
- Rollup source reads: SELECT-only policies for job `reporting.rollup` on `order_groups, seller_orders, refunds, payouts, payout_holds, return_requests, disputes, privacy_requests, breach_records, enforcement_actions, price_claims, products, skus, stores, reconciliation_exceptions, cod_remittances` (market pin). Snapshot-tested exception list, CODEOWNERS security.
- Indexes: `order_groups (market_id, paid_at) WHERE paid_at IS NOT NULL`; `seller_orders (market_id, status) WHERE status IN ('PAID','ACCEPTED','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERY_FAILED')`; `refunds (market_id, status, due_at) WHERE status <> 'COMPLETED'`; `privacy_requests (market_id, status, due_at)`; `breach_records (market_id, pdpc_deadline_at) WHERE status <> 'CLOSED'`.
- Rollup job (`apps/api/src/worker-consumers.ts` scheduler, package `packages/reporting` NEW or `packages/orders/src/application/sales-rollup.ts`): every 5 min upserts sales for the last 3 market days (late cancellations/refunds), nightly recompute of 90 days; every 60 s upserts snapshots. Idempotent upserts; one transaction per market. `data_inventory.yaml`: P1 aggregates, retention 25 months (sales), snapshots overwritten.

## 6. Waves

| Wave | Tier | Scope | Files | Done when |
|---|---|---|---|---|
| **A** (in progress, other builder) | builder (Sonnet) | Shell + component port, re-themed | `apps/admin/src/components/shell/{AdminShell,NavList,MobileTabBar,MobileNav,SkipLink,navigation}.tsx/.ts`, `apps/admin/src/components/kit/{Tile,KpiCard,Sparkline,ChartFrame,ColumnsChart,BarList,ChartTableToggle,PageHeader,EmptyState,Dialog,ConfirmDialog}.tsx` + `*.module.css`, `apps/admin/src/lib/charts/{columnsModel,format,models,path,scale}.ts` (started), `apps/admin/test/charts/*` (started), `apps/admin/package.json` (lucide-react + ADR-lite note), i18n keys `admin.shell.*`, `admin.dashboard.*` in `packages/i18n/src/catalogs/{ar-EG,en-EG}.json` | Unit tests for chart models green; no hard-coded strings; tokens only (no hex in CSS except via `@outlet/ui-tokens` vars); light + dark. |
| A test | tester | Component tests | `apps/admin/test/components-kit.test.tsx`, `apps/admin/test/shell.test.tsx` | Nav filters by `can()`; table toggle `aria-pressed`; RTL mirroring of columns. |
| **B** (two-key) | builder; reviewer = chief-reviewer for D1/D2 | API op + readers + migration + rollup | `packages/policy/src/policies.ts` (+ test), `packages/db/migrations/0035_admin_dashboard_rollups.sql`, `packages/db/src/context.ts`, `packages/db/test/fixtures/rls-exceptions.json`, `packages/db/test/admin-dashboard-rls.test.ts`, rollup `packages/reporting/src/{rollup,snapshots,schemas}.ts` + tests, `apps/api/src/modules/admin/dashboard.ts` (service: tile registry, per-tile `authorize`, `Promise.allSettled`), `apps/api/src/modules/admin/dashboard-readers.ts` (`PgDashboardReader`), `apps/api/src/modules/admin/dto-dashboard.ts` (Zod from the contract), counts added to `pg-readers.ts` (`PgKycAdmin.count`, `PgApprovalReader.countPending`), `ops-services.ts` (`PgElevationReader.countActive`), `packages/ops-attention/src/reader.ts` (`countOpen`), route in `admin.controller.ts`, `apps/api/src/platform/rate-limit/budgets.ts` (`adminDashboard`), `docs/api/openapi.yaml`, `apps/api/openapi.generated.yaml`, fixtures `apps/api/test/admin-fixtures.ts`, `data_inventory.yaml` | Contract test; negative authZ per role (each role gets exactly its tiles `ok`, others `forbidden`; other market -> 404; shopper/seller token -> 403); RLS test per new table and policy; query-count assertion (<= budget); property test: rollup sums equal a brute-force sum over random orders; `bigint` money only. |
| B test | tester | | `apps/api/test/admin-dashboard.test.ts`, `packages/reporting/test/*.test.ts` | as above, plus "unavailable" when a reader throws (no zero). |
| **C** | builder | Home + pop pages + attention via BFF | `apps/admin/src/server/bff.ts` (allow `GET dashboard`, `GET attention`, `POST attention/{id}/(ack|resolve)`), `apps/admin/src/lib/dashboard/{schemas,attention,tiles,cards}.ts` (Zod parse of the response, pure shaping), `apps/admin/src/app/[segment]/(console)/page.tsx` (Home), `.../(console)/today/[card]/page.tsx`, `.../(console)/attention/page.tsx`, `apps/admin/src/components/dashboard/{TodayCards,AttentionPanel,SalesAndOrders,AllChecks,TileBody}.tsx`, `apps/admin/src/server/session.ts` (sections for new nav), `apps/admin/e2e/mock-api.mjs` (fixtures incl. forbidden/unavailable) | Unit tests on shaping (unknown -> no "all clear"; forbidden not rendered; unavailable shows "Not connected yet"); server components only, no client fetch except range switch (URL param `range`). |
| **D** | tester | E2E + screenshots | `apps/admin/e2e/dashboard.spec.ts`, `apps/admin/playwright.config.ts` (projects `admin-1440`, `admin-390-webkit`, `admin-390-chromium`), shots `docs/design/admin-dashboard-shots/{home,pop,attention}-{390,1440}-{ar,en}-{light,dark}.png` | AR + EN, no sideways scroll at 390, every link/button >= 44x44, axe WCAG 2.2 AA no serious/critical, per-role fixture shows only allowed tiles, "Not connected yet" visible for unconnected tiles, Show-as-table holds every value. |

Order: A || B, then C (needs A components + B contract fixtures; can start on mock-api fixtures from the contract), then D. Chief-reviewer checkpoint after B (money + RLS + policy).
