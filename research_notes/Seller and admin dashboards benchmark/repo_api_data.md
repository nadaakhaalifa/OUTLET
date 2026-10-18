# Z-OUTLET API and data layer: what seller and admin dashboards can use today

Audit date 2026-10-16, read-only, ~35 tool calls. Sources are repo files (no web). Line numbers are for the files as of the working tree. "Not found" means a grep of controllers/modules returned nothing; it is not proof of absence in code I did not open.

## 1. OpenAPI inventory (seller and admin paths, shapes, analytics ingest, gap docs)

### Takeaway
The contract has 131 `/v1/seller*` and 113 `/v1/admin*` path lines (grep count of `docs/api/openapi.yaml`), but almost all are lists, single entities or commands. True aggregates exist only for seller analytics (9 routes + CSV export), subscriptions metrics, reconciliation summary, drops ops, ledger balances and ads reports. No time-series endpoint exists for admin, and no analytics ingestion endpoint exists in the API at all. Several OpenAPI paths have no controller in the code (listed below), so a dashboard built on them would get 404.

### Cited Findings
Seller aggregates (all behind `seller:analytics.read`/store policy):
- `GET /v1/seller/analytics/summary` (`docs/api/openapi.yaml:9406`, schema `SellerAnalyticsSummary` at `:37963`): range, gmv, net_after_commission, orders, units, aov, return_rate_bp, funnel{impressions,views,purchases}, freshness_at. Single aggregate object, no series. NO controller found: `grep` of `apps/api/src/modules/**` for `analytics/summary` or a `@Get("summary")` in seller-analytics returned nothing (only `analytics.controller.ts` with `@Controller("seller/stores/:storeId/analytics")`, `apps/api/src/modules/seller-analytics/adapters/analytics.controller.ts:58`, and `seller-me.controller.ts:8-10` for `GET /v1/seller/me`). The mobile Brand mode calls this operation (`docs/plan/api-client-gap.md`, "Brand mode"), so it is likely 404 in the API.
- `GET /v1/seller/stores/{storeId}/analytics/{traffic,funnel,sales,sell-through,size-curve,aging,returns,search-terms,geography}` (openapi `:13977-:14491`; controller methods `analytics.controller.ts:71,81,93,103,113,124,134,144,154`) and `POST .../analytics/exports` (`openapi:14033`, watermarked CSV). Shapes per `docs/specs/seller-analytics.md`: traffic (views, unique visitors, by_source buckets), funnel per product with bps conversion, sales (GMV, commission, net, units, orders, AOV, repeat rate), sell-through per SKU, size-curve, aging alerts + markdown recommendation, returns per SKU/reason, search terms, geography cells. All are aggregates over a date window; none is a day-by-day time series (windows snapped to whole UTC days, max 366 days, spec "Differencing defence").
- `GET /v1/seller/stores/{storeId}/forecasts` (`openapi:21714`; `apps/api/src/modules/forecasting/adapters/forecast.controller.ts:32`): list of forecasts.
- `GET /v1/seller/ads/reports` (`openapi:23882`; `apps/api/src/modules/ads/adapters/ads.controller.ts:306-326`): `{from,to,total{stats},campaigns[{campaign_id,name,...stats}]}`; aggregate per campaign, no series. Also `GET /v1/seller/ads/balance` (`:293`), campaigns list/detail.
- `GET /v1/seller/price-trust` (`openapi:9214`; `price-integrity.controller.ts:140`), `/v1/seller/price-evidence`, `/v1/seller/price-claims`: lists/entities.
- `/v1/seller/payouts`, `/v1/seller/payouts/{id}`, `/v1/seller/stores/{id}/statements` (`payouts.controller.ts:115,137,156`): lists and entities. `GET /v1/seller/balance` (`openapi:9259`) and `GET /v1/seller/statements` (`:9356`): no matching `@Get("balance")` controller found.
- Lists/entities: `/v1/seller/orders` (+`/{id}`, accept/reject/pack), `/v1/seller/shipments`, `/v1/seller/returns`, `/v1/seller/reviews`, `/v1/seller/questions`, `/v1/seller/products`, `/v1/seller/size-demand`, `/v1/seller/invoices`, `/v1/seller/drops`, `/v1/seller/promotions`, `/v1/seller/channels`, `/v1/seller/team`, `/v1/seller/hub/consolidations`, `/v1/seller/stores/{storeId}/resale/listings`.

Admin aggregates:
- `GET /v1/admin/subscriptions/metrics` (`openapi:17284`; `apps/api/src/modules/subscriptions/adapters/controller.ts:310-328`): `{window_days, active, trialing, past_due, paused, cancelled_at_period_end, expired, new_in_window, live_at_window_start, ended_in_window, churn_bps}`. Aggregate, single window.
- `GET /v1/admin/finance/reconciliation/summary` (`openapi:15665`; `recon.controller.ts:99-113`): `{open, escalated, by_severity, by_source, oldest_item_at, rejected_files, last_run}`. Plus `/tickets`, `/tickets/{id}`, `/runs`, `/files` (`:116,134,144,152`).
- `GET /v1/admin/ledger/balances` (`openapi:14611`; `ledger.controller.ts:68-82`, filters type/owner_type/owner_id/limit, finance role) and `GET /v1/admin/ledger/entries/{id}` (`:85`). Account balances list; NO trial balance, hash-chain or integrity endpoint (the IntegrityJob result is not exposed over HTTP; see section 6).
- `GET /v1/admin/drops/ops` (`openapi:21469`; `drops.controller.ts:301-325`): per-drop live ops (queue_depth, admitted_last_minute, admitted_per_sec, bot_block_rate_bps, waitlist_size, admission_health). Closest thing to a live operational gauge.
- Finance: `/v1/admin/finance/payouts` (+approve/hold/cancel; `payouts.controller.ts:203-251`), `/v1/admin/tax/{categories,documents,exemption-audit,reconciliation}` (`tax-eta.controller.ts:131,203,211,228,238`), `/v1/admin/tax/submissions/{documentId}/requeue`.
- Approvals/RBAC: `/v1/admin/approvals*`, `/elevations*`, `/pii-views` (`admin.controller.ts:206-375`).
- Flags: `/v1/admin/flags`, `/flags/{key}`, `/kill-switches` (`admin.controller.ts:395-422`).
- KYC: `/v1/admin/kyc/queue`, `/sellers/{id}`, suspension-reviews (`admin.controller.ts:446-526`).
- Privacy/DPO: `/v1/admin/privacy/requests`, `/breaches*` (`dpo.controller.ts:88,103,112,140-171`). Consents stats and transfer register: no endpoint found.
- Other lists: `/v1/admin/promotions`, `/calendar`, `/plus/plans`, `/gift-cards/{pots,throttle-events}`, `/rewards/config`, `/games/{game}/odds`, `/rewards/challenges`, `/ads/config`, `/ads/invalid-clicks`, `/moderation/queue` (`reviews.controller.ts:415`), `/price-crawler/incidents`, `/resale/listings`, `/hub/consolidations`, `/auto-buy/manual-review`, `/creators`, `/creator-payouts`, `/brand-applications/*`.
- In OpenAPI but NO controller found (grep over `apps/api/src/modules`): `/v1/admin/audit-log` (`openapi:10224`), `/v1/admin/reconciliation/breaks` (`:10393`), `/v1/admin/price-integrity/actions` (`:10443`) and `/config` (`:10493`), `/v1/admin/sellers` (`:9708`) and its kyc/suspend children, `/v1/admin/order-groups/{id}` (`:9962`; only the shopper `order-groups/:id` exists, `orders.controller.ts:124`), `/v1/admin/disputes/{id}/resolve`, `/v1/admin/refunds/{id}/approval`, `/v1/admin/payouts/{id}/approval`, `/v1/admin/tax/invoices` (`:11080`). The admin-web proxy/status doc also says Admin needs `GET /v1/admin/me` (VR-AC-01, `docs/plan/status-2026-10.md`). Treat these as legacy/early contract entries until proven otherwise (I did not open each module; the confidence is moderate).
- Analytics ingestion: no `/v1/events` or `/v1/analytics/*` ingest path exists in OpenAPI (grep `analytics/(events|ingest|batch)` and `/v1/(events|analytics)` found nothing). Client events are defined in `packages/analytics` (tracker + `ports.ts`) but the sink is a port, not an endpoint. The only analytics-adjacent write routes are `POST /v1/ads/click` (`ads.controller.ts:329`) and `/v1/products/{id}/price-reports`.
- `docs/plan/api-client-gap.md` items affecting dashboards: Brand mode dashboard lacks server "now", held-payout reasons, next payout date, store health score, dispatch/cancellation rates ("shown as Not enough data"); `listStores` lacks `newest_drop_at`, `delivery_days`, trending rank; `SellerOrder` lacks e-receipt UUID/QR; no ready-for-pickup transition; `getMyBudgetSummary` lacks next-cycle installments. Seller settings routes are now in OpenAPI and the client.
- `docs/plan/production-boot-gap.md` items: `/v1/ready` reports 24 providers all `unconfigured` including `analytics.warehouse`; 36 composed modules at the 2026-10-11 run (status doc later says 54 of 57 directories composed; 3 blocked); dozens of cross-module ports are bound to `internal.wiring` (503), including "seller-analytics product store", "orders store lookup", "reviews purchases/sellers/products/profiles", "payouts source, statement source, bank, risk", "reconciliation eta, alerts", "ads enforcement/eligibility/ledger/attribution", "subscriptions ledger/refunds". "Outbox events with no in-process consumer are acknowledged and counted; only `payment.*` has a consumer" (ADR-0029). Rate limiter is per process.

### Inferences
- A seller/admin dashboard can render KPI tiles and top-N tables today, but anything with a trend line (GMV per day, refunds per week, DAU) has no endpoint.
- The mobile and seller summary endpoint must be built (or the client repointed to the nine per-store routes).

### Gaps
- I did not open every one of the 244 path definitions' response schemas; shapes above come from controllers, the spec doc and the sampled schema.
- Whether admin-web's OpenAPI-only paths are served by another app layer (e.g. a BFF) was not checked.

## 2. Modules: read models, tables, migrations, writers

### Takeaway
Tables are rich (87 migrations, 0001-0087, 294 `ENABLE ROW LEVEL SECURITY` occurrences) but there are zero materialized views and no summary/rollup tables except `seller_analytics_*`, `ad_daily_spend` and `retention_purge_runs`. Dashboards must aggregate from operational tables or event facts at query time. In the production composition, the only real data are what real traffic writes; nothing real exists yet, and the analytics fact table has no producer (see 3).

### Cited Findings
- Migrations: `packages/db/migrations/0009_outbox_indexes.sql` ... `0087_product_media_versions.sql`; `0058` and `0073` are `RESERVED`/unused. `grep -l "MATERIALIZED VIEW" packages/db/migrations/*.sql` returned no files; `CREATE VIEW` also absent from the migrations I grepped (0028, 0029, 0045, 0046).
- Orders: `0019_orders.sql`; read: `GET /v1/seller/orders`, shopper order-groups; no admin order list/aggregate. Jobs: `orders.close-delivered`, `orders.expire-unaccepted` (`apps/api/src/workers/registry.ts:53-54`).
- Fulfillment (shipments, courier events): `0022_fulfillment.sql`, `0044_hub_resale.sql`; routes under `@Controller("seller")` (`fulfillment.controller.ts:51`); job `fulfillment.awb-worker` (`registry.ts:87`). No COD remittance/RTO/courier SLA aggregate endpoint found; Bosta/Aramex unconfigured.
- Returns: `0020_returns.sql`; `GET /v1/seller/returns` (`returns.controller.ts:238`); seller return stats exist only through seller analytics `returns`.
- Refunds: `0034_refunds_store_credit.sql`; job `refunds.sweep` (`registry.ts:63`); metric `outlet.refund.sla`; approval route in OpenAPI has no controller.
- Payments: `0032_payments.sql`, `0033_checkout.sql`; PSP `psp.paymob` unconfigured; webhook allow-list deny-all (`production/ports.ts` `DenyAllWebhookIps`).
- Ledger: `0031_ledger_posting.sql` (+0010, 0011, 0074); admin `balances`, `entries/{id}`. Jobs `ledger.integrity.nightly` (Cairo 02:30) and `ledger.integrity.intraday` (30 min, event mode only) (`registry.ts:57-58`); `IntegrityJob.run()` returns `{ok, trialBalance, chain, storeCredit{drift,negative}}` (`apps/api/src/modules/ledger/application/integrity-job.ts:17-23`) but no HTTP route exposes it ("writes only alerts and the signed snapshot" per registry text; alert sink `reconciliation alerts` is `internal.wiring`).
- Payouts/reconciliation: `0035_payouts_reconciliation.sql`; jobs `payouts.weekly-cycle`, `recover-orphans`, `advance-sent`, `reconciliation.tick` (`registry.ts:59-62`); `FinanceReconReadModel` (`recon.controller.ts` `FINANCE_RECON_READ`). Payout rail, settlement files, bank name-match unconfigured, so reconciliation inputs are empty.
- Price integrity: `0024_price_integrity.sql`, crawler `0043_price_crawler.sql`; `GET /v1/seller/price-trust`; admin `/v1/admin/price-crawler/incidents` (`crawler`, `incidents.controller.ts`). Enforcement action log and config endpoints: OpenAPI only. Crawler egress unconfigured; claims rest on the internal ledger (`production-boot-gap.md`).
- Ads: `0045_ads.sql` has `ad_daily_spend` (`:96`), partitioned `ad_impressions` (`:103-115`), `ad_clicks` (`:121`), `ad_balances`; `0048_ad_click_reviews.sql`; seller reports and admin config/invalid-clicks; jobs `ads.post-click-spend`, `ads.end-expired-campaigns` (`registry.ts:88-89`). Bound ports for ads enforcement/eligibility/ledger/attribution are `internal.wiring`.
- Fraud: no `fraud` module directory in `apps/api/src/modules` (listing shows none). Fraud signals appear as `gift-cards throttle-events`, `ads invalid-clicks`, `auto-buy manual-review`, checkout `risk` port (`internal.wiring`). No fraud dashboard data source.
- Promotions: `0021_promotions.sql`, `0049_admin_calendar.sql`; admin/seller CRUD (`promotions.controllers.ts:260,355`), calendar. Promotion ROI/abuse metrics: not found.
- Rewards: `0041_rewards.sql`; admin config/odds/challenges; jobs `rewards.expire-coins`, `rewards.settle-pending`.
- Reviews: `0030_reviews.sql`, `0048`; `GET /v1/seller/reviews`, `questions`, `admin/moderation/queue`; jobs `reviews.sweep-qa-sla`, `moderation-backlog`. Review purchase/seller/product ports are `internal.wiring`.
- Stores/worlds: `0013_stores.sql`. I searched for `store_directory_stats` by name only via the gap doc (`listStores` lacks trending rank/newest_drop_at/delivery_days: "need new store read models"); no such table confirmed.
- Sellers/health score: `0051_sellers_applications.sql`, `0053`, `0055_seller_settings.sql`; "store health score ... not on the wire" (`api-client-gap.md`). No health-score endpoint.
- Subscriptions (Plus): `0036_subscriptions.sql`, `0059-0061`; `GetSubscriptionMetrics` (`subscriptions/application/metrics.ts`); jobs `renewal-sweep`, `recognize-revenue`, `family-sweep`, `student-sweep` (`registry.ts:67-70`).
- Privacy: `0025_privacy_requests.sql`; DPO requests list and breach register (`dpo.controller.ts`); jobs process-exports/expire-exports/process-deletions (`registry.ts:76-78`). `kms.envelope` and `object.store` unconfigured so exports stay `requested`.
- Flags/kill switches: `GET /v1/admin/flags`, `/kill-switches` (`admin.controller.ts:395-412`), backed by `FlagBackendOverRegistry` (`production/ports.ts`, `flags.provider` unconfigured, default-blocked switches).
- Notifications: `0018_notifications.sql`; `/v1/me/notifications` shopper-only; no admin delivery stats route found; providers Unconfigured, so attempts are recorded FAILED.
- Retention: `0046_retention.sql` (`retention_purge_runs` `:5`, `retention_legal_holds` `:25`); jobs in `apps/api/src/workers/retention-jobs.ts`; no HTTP endpoint found.
- Inventory: `0016_inventory.sql`; jobs `inventory.sweep-reservations` (30 s), `replenish-pools` (1 min); metric `outlet.reserve.duration`. No admin stock/aging endpoint (seller `aging`/`sell-through` only).
- Catalog quality: `0012_catalog.sql`, `0086_product_department`; no catalog quality score endpoint found.
- Worker registry (`apps/api/src/workers/registry.ts:51-98`): about 45 jobs with cadence, criticality and idempotency notes. Waiting-room and drops jobs are gated by capability `drops` (blocked by default).
- Other writers: seller analytics facts are written only by `ConsumeSellerAnalytics.ingest` from an `EventSourcePort` (see 3). `price_events`, `ad_daily_spend` and `retention_purge_runs` are written by real application code/jobs, but no data exists because no provider/traffic is live.

### Inferences
- With no MV/rollup layer, admin KPI queries (GMV, refunds, take rate) would hit OLTP tables; fine at pilot size, needs a read-model plan before scale.
- No dev seed was inspected in this audit beyond noting `DEV_FIXTURES` flag in the production-boot doc; fixture vs real data per area is therefore inferred from what writers exist.

### Gaps
- Per-module table lists (names beyond those cited) and exact `store_directory_stats` existence were not verified (budget of calls).
- Dev seed contents (`DEV_FIXTURES`) not read.

## 3. Analytics foundation

### Takeaway
Taxonomy and Zod schemas are mature; the sink is not. The production event source for seller analytics is explicitly `unconfigured("analytics.warehouse")`, there is no ClickHouse/dbt code, and the producers of the facts (impression, per-store checkout/purchase, stock snapshot) are not wired. Seller analytics endpoints exist and are tested on PGlite, but return empty data in production.

### Cited Findings
- Taxonomy: `docs/analytics/events.md` (generated from `packages/analytics`, ~33 client/server events with version, origin, consent gate, flat P0/P1 properties; e.g. `order_placed` server, strictly necessary, `order_group_id, seller_order_count, line_count, total_minor, payment_method`). Domain events: `packages/analytics/src/domain-events.ts`; tracker `tracker.ts`; PII guard `pii.ts`; pseudonym `pseudonym.ts`; retention `retention.ts`.
- Production sink: `apps/api/src/production/ports.ts:163-168`: `sellerAnalytics = { ...pg.sellerAnalytics, audit: new KyselyExportAudit(pg.db), source: unconfigured("analytics.warehouse"), productStore: internal() }`. `apps/api/src/production/unconfigured.ts:32`: `"analytics.warehouse": { kind: "external", note: "ClickHouse event source" }`. `bindings.ts:73`: `"seller-analytics": { status: "composed" }` (composed, but source fails closed).
- Storage: `0028_seller_analytics.sql`: `seller_analytics_facts` (`:12`), `seller_analytics_stock` (`:44`), `seller_analytics_freshness` (`:56`). Append-only facts + query-time aggregation chosen over rollups (spec section "Algorithm choice").
- Spec rules (`docs/specs/seller-analytics.md`): freshness SLO 15 min via ingest lag only, `meta.freshness` on every response; k-anonymity `K_ANONYMITY_MIN = 50` on distinct `shopper_key`, no parameter to lower; `kAnonymizeAdditive` differencing defence merges suppressed cells into smallest released cell (`includes_suppressed: true`); windows snapped to UTC days, max 366 days; strict Zod ingest (no `user_id`, `measurements`, `budget_*`); CSV export watermarked per export with formula guard and audit-first fail-closed; owner/manager only.
- Spec gaps (same doc): `impression` not in the taxonomy; `checkout_started`/`order_placed` carry no store id so orders module must publish per-store SourceEvents (`sellerOrderId, skuId, grossMinor, commissionMinor, governorate`); `stock_snapshot` must come from inventory; no demographics; elasticity markdown and ClickHouse serving out of scope (markdown is `heuristic_v1`).
- Outbox consumers: only `payment.*` has an in-process consumer (`production-boot-gap.md`, ADR-0029), so order/return/refund events are not turned into analytics rows.
- dbt/warehouse: no `dbt_project.yml` or dbt models directory found (find over repo excluding node_modules returned only unrelated Python package dirs); no ClickHouse client code found beyond the unconfigured note. A grep for `ClickHouse` in `apps/api/src` matched only `unconfigured.ts` among the files I opened (the grep output for other hits was cut by a shell error; low-to-moderate confidence).
- Ingest endpoints: none (see section 1). Admin/engineering analytics (take rate, cohorts, LTV, CAC) have no module or table.

### Inferences
- Realistic first step for dashboards: either implement an `EventSourcePort` that reads the Postgres outbox (cheap, same ACID store) or accept empty seller analytics until ClickHouse is chosen.

### Gaps
- Exact ClickHouse mentions elsewhere (docs/adr) were not searched.

## 4. Observability, SLOs, DORA, SCI/FinOps

### Takeaway
SLOs, burn-rate rules and Grafana JSON exist as code and are promtool-tested on paper, but nothing runs against live telemetry. DORA is a CI-generated JSON report, not an API. SCI/FinOps has no data source.

### Cited Findings
- OTel: dependencies in `apps/api/package.json:21-27` (api, sdk-node, OTLP metrics/trace exporters); setup in `apps/api/src/platform/telemetry/{bootstrap,tracing,metrics,http.interceptor,logger,attributes}.ts`; convention doc `infra/observability/otel-conventions.md`.
- Instrument registry `platform/telemetry/metrics.ts:17-33`: `http.server.request.duration`, `outlet.checkout.attempts`, `outlet.reserve.duration`, `outlet.search.duration`, `outlet.payment.confirmation.duration`, `outlet.refund.sla`, `outlet.reconciliation.unmatched_lines`, `outlet.mobile.sessions`, `outlet.outbox.lag`, `outlet.worker.job.{runs,duration}`, `outlet.worker.{last_success,consecutive_failures}`, `outlet.provider.{calls,call.duration,ready}`, `outlet.db.query.duration`. No business KPI metrics (GMV, orders, refunds amount).
- SLOs as code: `infra/observability/slos/slos.yaml` (header: "no service emits them yet (no backend exists, ADR-0006), so every SLI is a proposal until instrumented"; tiers fast 1h/5m budgetFraction 0.02 burn 13.44, slow 6h/30m 0.05 burn 5.6; first SLO checkout-success objective 0.995, reserve-latency 0.95 under 150 ms, payment-confirmation, api-read-latency ...). Generated Prometheus rules `infra/observability/prometheus/rules/slo-*.rules.yaml` (8 files: checkout-success, reserve-latency, payment-confirmation-latency, api-read-latency, search-latency, refund-initiation, reconciliation-unmatched, mobile-crash-free) with promtool tests in `prometheus/tests/*.test.yaml`.
- Dashboards as code: `infra/observability/grafana/dashboards/{api,reconciliation,search,checkout,mobile,payments,reservation}.json` and `infra/observability/dashboards/{worker-health,checkout-funnel,provider-readiness,inventory-reserve,outbox-lag,slo-overview}.json` with `validate.mjs`.
- Health: `GET /v1/ready` reports database, provider readiness and outbox `{pending, oldest_age_seconds, dead_lettered}` (`production-boot-gap.md`). Status doc: promtool and any cloud account not verified.
- DORA: `tooling/dora/dora.mjs` (+`lib.mjs`) computes the report from git and optional GitHub deployments/issues; `.github/workflows/dora.yml` runs weekly Monday 03:17 UTC and emits JSON schema `outlet.dora.report/v1` ("the JSON the Admin engineering dashboard ingests"); sample `tooling/e2e/dora-report.sample.json`. Admin-web parses it client-side: `apps/admin-web/src/components/dora-loader.tsx:12` ("Parses the DORA report in the browser (Zod). Nothing is uploaded"), `view-models/dora.ts`. No `/v1/admin/dora` API (grep of openapi for "dora" found nothing). Without GitHub access it falls back to "offline" git-log mode.
- SCI/FinOps: `docs/specs`/`tooling` grep for `gco2e|SCI` found only unrelated hits in hub-consolidation; no sustainability/FinOps metric, table or doc under `docs/sustainability` (directory not present). Seller carbon (P2) not found.

### Inferences
- Infra/SLO and DORA dashboards are the most "ready" admin surfaces, but need an actual Prometheus/Grafana environment (ADR-0016/0002 say none exists); an in-app admin SLO panel would need a Prometheus proxy endpoint that does not exist.

### Gaps
- Grafana panel contents and exact alert routing not read.

## 5. Access control for aggregates

### Takeaway
Tenant isolation and admin controls are deep and well tested; aggregates inherit them (policy resolver + RLS + 404-on-foreign-store, k-anonymity, audit-first CSV). Gaps are missing roles/resources for finer analytics scopes.

### Cited Findings
- Policy package `packages/policy`; seller-analytics authorization: resolver returns the addressed store, policy compares brand grants; foreign/missing/malformed store ids are 404 with identical bodies; dashboards use resource `store_order` read (owner, manager, warehouse, support, finance), export uses `store_settings` read (owner, manager); a dedicated `store_analytics` resource is a listed follow-up (`docs/specs/seller-analytics.md`, "Authorization", "Gaps").
- RLS: policy on all three analytics tables by `app_store_ids()`; only role `system` writes; reads set `app.role=seller`, `app.store_ids` and still repeat `store_id = $1` (same doc). Repo-wide: 294 `ENABLE ROW LEVEL SECURITY` lines in migrations.
- Tests: `apps/api/src/authz-matrix.test.ts`, `adversarial.wave1..4*.test.ts`, `adversarial.wave3-tax-analytics.test.ts`, `modules/seller-analytics/test/analytics.http.test.ts`, `kysely-store.pglite.test.ts`.
- Admin RBAC: `@Authorize({audience:"admin_api", resourceType:"admin_console"...})` + role check (e.g. drops ops `drops.controller.ts:301-306`, subscriptions `controller.ts:305-322`); finance gate `ledger.controller.ts` `gate()` writes an access audit and fails closed with `audit_unavailable`; reconciliation `ReconAccess` (`recon.controller.ts:95`).
- Dual approval and elevation: `0029_admin.sql` `admin_approval_requests` (`:18`), `admin_elevations` (`:43`), `kyc_suspension_reviews` (`:66`); routes `/v1/admin/approvals*`, `/elevations*`, `/pii-views` (`admin.controller.ts:206-375`).
- Audit hash chain: `audit_log_verify()` ran with 0 problems in the Postgres 16 boot test (`production-boot-gap.md`); chains per domain e.g. `seller-analytics:YYYY-MM` (`production/platform-adapters.ts:166-180`); `KyselyExportAudit` writes it. No HTTP endpoint lists or verifies the audit log (OpenAPI `/v1/admin/audit-log` has no controller).
- CSV watermarking: seller analytics export only (seller id, report, time, per-export watermark on every row, formula guard, audit before content). No admin-side export endpoint found (dual approval for "data exports" is specified in master prompt but I found no export route).

### Inferences
- A new admin aggregate must add its own resource/role; budget/measurement tables are barred from analytics/ads/promotions by boundary tests (`seller-analytics/test/boundaries.test.ts`), so any "customer segments" dashboard must avoid them.

### Gaps
- DPO role scoping on aggregates and `admin/me` (VR-AC-01) not examined.

## 6. Where AI features live and real versus fake

### Takeaway
All AI modules exist as code with Postgres stores, but their intelligence and providers are fakes or Unconfigured in production; the only ml-service in the repo is background removal.

### Cited Findings
- `apps/ml-services` contains only `bg-removal` (directory listing); no stylist/recommendation/fit/forecast Python service.
- LLM gateway: `apps/api/src/modules/llm-gateway`; production provider `unconfigured("llm.gateway-provider")` (`production/ports.ts:222-224`); `llm cache` is `internal.wiring`.
- Stylist (outfits, chat, inclusion): `apps/api/src/modules/stylist/adapters/{stylist,chat,inclusion}.controller.ts`, Kysely stores `0039_stylist.sql`, `0066/0067`; production ports `candidates/live/bag/personalization/budget` are `internal()` i.e. 503 (`production/ports.ts:314-322`); chat needs LLM provider. Status doc: chat blocked by ADR-0025 / VR-P3-15.
- Recommendations: `0040_recommendations_history.sql`; ports catalog/ranker/personalization/sizes `internal.wiring`; ranking v2 shadow `0079/0080`, flag `kill.ranking_v2_shadow` (`ports.ts:419-421`).
- Wardrobe `0081/0082` and visual search `0068-0070`: visual search not composed (embedder, object store, classifier, index, consent unbound); wardrobe vision blocked VR-P3-13.
- Outfit calendar `0062/0063`: job `calendar.process-reminders`.
- Demand forecasting: `modules/forecasting` (`0064_demand_forecasting.sql`, `0065_forecast_runs.sql`), `GET /v1/seller/stores/{storeId}/forecasts`, nightly job `forecasting.nightly-batch` (Cairo 03:15, capability `forecasting`, `registry.ts:93`), gated by `kill.demand_forecasting` (`ports.ts:403-406`, default blocked). Model is an in-repo statistical build (`application/build.ts`); quantile intervals per spec; no ML service.
- Seller copilot: grep for "copilot" in `apps/api/src` and `docs/specs` matched only hub-consolidation files (false positives); no seller copilot module exists. Markdown advice is the heuristic `recommendMarkdown` (`heuristic_v1`).
- Stylist inclusion rate: `inclusion.controller.ts` (seller-facing); data requires stylist generation, which is blocked.

### Inferences
- AI dashboards (stylist GMV share, forecast accuracy) can show only flag state and synthetic outputs today.

### Gaps
- Real versus synthetic content of `build.ts` model and test fixtures not verified line by line.

## 7. Dashboard area matrix

Legend: Tables = tables exist; Read = read-model/endpoint exists; Prod data = produces real data in the production composition (today: nothing runs against real money, personal data or providers per `CLAUDE.md` and `status-2026-10.md`, so "fixtures/fakes only" means data arrives only from dev/test seed and fakes; "empty-by-design" means composed but upstream provider Unconfigured).

| Area | Tables | Read model / endpoint | Prod data | Gap to build |
|---|---|---|---|---|
| Orders | yes (0019) | seller list/detail, shopper order-group; no admin list/aggregate (`/v1/admin/order-groups/{id}` has no controller) | real writes once checkout runs; checkout needs PSP (unconfigured) | admin order search + counts by state, time series |
| Refunds | yes (0034) | none for listing; approval path OpenAPI-only | refund sweep composed; PSP unconfigured | refunds list/aggregate (volume, SLA met/missed), the `outlet.refund.sla` metric exists but no endpoint |
| Payouts | yes (0035) | seller list/detail/statements; admin list/approve/hold/cancel; `/v1/seller/balance` no controller | payout rail unconfigured; payouts source/statement source ports `internal.wiring` | seller balance, held reasons, next payout date, aggregate exposure by status |
| Ledger | yes (0031) | admin balances, entry; IntegrityJob exists | integrity job runs (nightly/intraday) but result not exposed | trial balance + chain status + drift endpoint, daily balance series |
| Inventory | yes (0016) | seller stock write, seller `sell-through`/`aging` (analytics) | analytics stock snapshots have no producer | admin stock-out/reservation stats, `stock_snapshot` publisher |
| Catalog quality | yes (0012) | none | catalog composed, images need object store (unconfigured) | quality score model + endpoint |
| Price integrity | yes (0024, 0043) | seller price-trust/evidence/claims; admin crawler incidents; actions/config no controller | internal-ledger claims only; crawler egress unconfigured | admin action log/trends/appeal stats |
| Promotions / ads | yes (0021, 0045, 0048) | admin/seller promotions CRUD; ads reports (per-campaign aggregate), admin ads config/invalid-clicks | ads ports `internal.wiring` | promo ROI/abuse, ads time series, admin-wide ads spend |
| Customers / cohorts | `user_events` (history, 0040) | none (no cohorts/LTV/CAC anywhere) | no real users | warehouse cohorts, segment endpoint (must avoid budget/measurement tables) |
| Finance / VAT / ETA | yes (0027) | admin tax documents, reconciliation, exemption audit, categories; seller invoices; `/v1/admin/tax/invoices` no controller | ETA portal unconfigured; daily reconciliation job composed | submitted/accepted/rejected time series, VAT summary |
| Couriers / COD | yes (0022, 0044) | seller shipments only | couriers unconfigured | courier SLA, COD remittance, RTO aggregates; `cod_clearing` view |
| Fraud | no dedicated module | gift-card throttle events, ads invalid clicks, auto-buy manual review lists | fakes | risk score/decision aggregates, COD refusal rate |
| Support | not found | none | none | whole domain (tickets, macros) missing |
| Reviews | yes (0030) | seller reviews/questions lists, admin moderation queue | inputs `internal.wiring` | rating/sentiment aggregates, backlog and SLA stats |
| Notifications | yes (0018) | shopper inbox only | providers Unconfigured, contacts `internal.wiring`: nothing sends | delivery/failed attempt stats for admin |
| Privacy / DPO | yes (0025) | DPO requests + breach register + actions | exports/erasure partly unconfigured (kms, object store) | consent stats, transfer register, SLA aging counts |
| Flags / kill switches | via registry | admin flags/kill-switches list + PUT | real, flags provider unconfigured (registry-backed) | change history view (audit-log route missing) |
| Infra / SLO | n/a | `/v1/ready`, Prometheus rules, Grafana JSON | no running telemetry backend | Prometheus-fed in-app panel or link-out, `outlet.*` business metrics |
| DORA | n/a | CI JSON report, admin-web parser | weekly workflow (unverified on Actions) | optional ingest endpoint/history store |
| Cost / carbon | none | none | none | SCI/FinOps metrics and storage |
| AI | stylist/forecast/etc. (0039, 0064-0070, 0079-0082) | forecasts, stylist inclusion | fakes/Unconfigured; features dark behind kill switches | provider contracts; AI-specific KPIs |
| Seller analytics (cross-cutting) | yes (0028) | nine routes + export; summary missing controller | no producer, source Unconfigured | event source implementation, summary route, time series |

Not found: any materialized view or rollup for platform KPIs; any support module; any admin time-series endpoint.
