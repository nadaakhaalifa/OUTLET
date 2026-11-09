-- migration: 0035_admin_dashboard_rollups
-- phase: expand (3 new tables, 2 worker jobs, 14 market-pinned source SELECT policies + 6 job policies on the new tables, a few column grants, 7 indexes)
-- Admin dashboard (docs/plan/admin-dashboard-port.md section 5, docs/api/admin-dashboard-contract.md). Home needs market-wide totals that have no cheap
-- aggregate today (order_groups is indexed by user, seller_orders by store). Choice B of ADR-0015: a worker job writes small rollup tables, the API reads those.
-- Plain tables, not materialized views: a view cannot carry the RLS that ADR-0011 requires.
--
-- Worker jobs (WORKER_JOBS in packages/db/src/context.ts):
--   * `reporting.rollup`   (RollupService in @outlet/reporting): reads the source tables below (SELECT only, market pinned) and upserts the three tables here
--                          (SELECT, INSERT, UPDATE; no DELETE). It also writes the inbox row of its trigger event (inbox_processed is granted to every worker by 0007).
--   * `admin.dashboard`    (PgDashboardReader in apps/api, request path): SELECT only on the three tables here, market pinned. Nothing else.
-- Source tables read by `reporting.rollup` (one SELECT policy each, named <table>__worker_reporting_rollup, USING ctx='worker' AND job AND market pin):
--   order_groups, seller_orders, refunds, payouts, payout_holds, return_requests, disputes, privacy_requests, enforcement_actions, price_claims,
--   products, skus, stores, reconciliation_exceptions. A table-level or column grant already existed for all of them (0007, 0015, 0016, 0018, 0019, 0026, 0034);
--   the one new grant is SELECT (status) ON stores (the rollup counts PENDING_REVIEW / SUSPENDED) and SELECT (status, market_id) on products and skus.
--   breach_records has NO RLS by design (0028: market column only, no personal data) and no policy can be added; it gets a COLUMN-limited SELECT grant
--   to outlet_worker instead (no summary text, no counts of subjects) and the rollup pins the market in SQL. cod_remittances is not read (cod_unremitted is
--   "not connected" until a courier adapter exists).
-- GMV definition (plan D3): order_groups.total_minor, VAT-inclusive, after discounts, including shipping, NOT net of refunds, bucketed by market-local day
-- (markets-config timezone, Africa/Cairo). A group counts once: by paid_at when it has one; else a COD group that was confirmed by placed_at
-- (no confirmation timestamp column exists yet). Refunds are separate (refunded_minor, by refunds.completed_at). Store rows sum seller_orders.total_minor of the same groups.
-- Money is bigint minor units plus currency. All three tables hold P1 aggregates (no person); retention 25 months for sales, snapshots are overwritten.

CREATE TABLE market_sales_daily (
  market_id     text          NOT NULL CHECK (length(market_id) > 0),
  day           date          NOT NULL,
  currency      char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  orders_paid   integer       NOT NULL CHECK (orders_paid >= 0),
  gmv_minor     bigint        NOT NULL CHECK (gmv_minor >= 0),
  refunded_minor bigint       NOT NULL CHECK (refunded_minor >= 0),
  refreshed_at  timestamptz(3) NOT NULL,
  PRIMARY KEY (market_id, day, currency)
);

CREATE TABLE store_sales_daily (
  market_id     text          NOT NULL CHECK (length(market_id) > 0),
  store_id      uuid          NOT NULL REFERENCES stores (id),
  day           date          NOT NULL,
  currency      char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  orders_paid   integer       NOT NULL CHECK (orders_paid >= 0),
  gmv_minor     bigint        NOT NULL CHECK (gmv_minor >= 0),
  -- Public store names, copied at rollup time so the request path needs no read of `stores`.
  store_name_ar text          NOT NULL,
  store_name_en text,
  refreshed_at  timestamptz(3) NOT NULL,
  PRIMARY KEY (market_id, store_id, day, currency)
);
CREATE INDEX store_sales_daily_day_idx ON store_sales_daily (market_id, day);

CREATE TABLE admin_dashboard_snapshots (
  market_id text           NOT NULL CHECK (length(market_id) > 0),
  tile_key  text           NOT NULL CHECK (tile_key ~ '^[a-z_]{1,60}$'),
  as_of     timestamptz(3) NOT NULL,
  payload   jsonb          NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  version   integer        NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (market_id, tile_key)
);

ALTER TABLE market_sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_sales_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE store_sales_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_sales_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_dashboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_dashboard_snapshots FORCE ROW LEVEL SECURITY;

-- store_sales_daily carries a store_id column, so the tenant audit wants its store_isolation policy. It is inert: outlet_app has no grant on the table
-- (the revoke below), so no shopper, seller or staff request can read these rows except through the admin.dashboard job.
CREATE POLICY store_sales_daily_store_isolation ON store_sales_daily TO outlet_app
  USING (store_id = app.current_store_id() AND market_id = app.current_market_id())
  WITH CHECK (store_id = app.current_store_id() AND market_id = app.current_market_id());

CREATE POLICY market_sales_daily__worker_reporting_rollup ON market_sales_daily FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY market_sales_daily__worker_admin_dashboard ON market_sales_daily FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'admin.dashboard' AND market_id = app.current_market_id());
CREATE POLICY store_sales_daily__worker_reporting_rollup ON store_sales_daily FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY store_sales_daily__worker_admin_dashboard ON store_sales_daily FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'admin.dashboard' AND market_id = app.current_market_id());
CREATE POLICY admin_dashboard_snapshots__worker_reporting_rollup ON admin_dashboard_snapshots FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY admin_dashboard_snapshots__worker_admin_dashboard ON admin_dashboard_snapshots FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'admin.dashboard' AND market_id = app.current_market_id());

REVOKE ALL ON market_sales_daily, store_sales_daily, admin_dashboard_snapshots FROM PUBLIC, outlet_app, outlet_auth, outlet_worker;
GRANT SELECT, INSERT, UPDATE ON market_sales_daily, store_sales_daily, admin_dashboard_snapshots TO outlet_worker;

-- Source reads of `reporting.rollup`: SELECT only, market pinned.
CREATE POLICY order_groups__worker_reporting_rollup ON order_groups FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY seller_orders__worker_reporting_rollup ON seller_orders FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY refunds__worker_reporting_rollup ON refunds FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY payouts__worker_reporting_rollup ON payouts FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY payout_holds__worker_reporting_rollup ON payout_holds FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY return_requests__worker_reporting_rollup ON return_requests FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY disputes__worker_reporting_rollup ON disputes FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY privacy_requests__worker_reporting_rollup ON privacy_requests FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY enforcement_actions__worker_reporting_rollup ON enforcement_actions FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY price_claims__worker_reporting_rollup ON price_claims FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY products__worker_reporting_rollup ON products FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY skus__worker_reporting_rollup ON skus FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY stores__worker_reporting_rollup ON stores FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());
CREATE POLICY reconciliation_exceptions__worker_reporting_rollup ON reconciliation_exceptions FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'reporting.rollup' AND market_id = app.current_market_id());

-- Columns the rollup needs that no worker grant covered yet (column-limited, never the row).
GRANT SELECT (status, market_id) ON stores TO outlet_worker;
GRANT SELECT (id, product_id, store_id, market_id, status) ON skus TO outlet_worker;
GRANT SELECT (id, store_id, market_id, status, deleted_at) ON products TO outlet_worker;
GRANT SELECT (market_id, status, pdpc_deadline_at, pdpc_notified_at, subjects_deadline_at, subjects_notified_at) ON breach_records TO outlet_worker;

-- Indexes (CREATE INDEX plain, like every migration here; the tables are small at this phase and the runner is transactional).
CREATE INDEX order_groups_paid_at_idx ON order_groups (market_id, paid_at) WHERE paid_at IS NOT NULL;
-- Not in the plan: the COD branch of the GMV day (no paid_at yet) and the refunds-by-completion-day read would otherwise scan the market.
CREATE INDEX order_groups_cod_placed_idx ON order_groups (market_id, placed_at) WHERE paid_at IS NULL AND payment_method = 'cod';
CREATE INDEX refunds_completed_at_idx ON refunds (market_id, completed_at) WHERE status = 'COMPLETED';
CREATE INDEX seller_orders_pipeline_idx ON seller_orders (market_id, status) WHERE status IN ('PAID', 'CONFIRMED_COD', 'ACCEPTED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED');
-- The COD-awaiting-confirmation snapshot count reads only these rows (order_groups is the hottest table; no other index leads with market and status).
CREATE INDEX order_groups_cod_awaiting_idx ON order_groups (market_id, placed_at) WHERE status = 'AWAITING_COD_CONFIRMATION';
CREATE INDEX refunds_waiting_idx ON refunds (market_id, status, due_at) WHERE status <> 'COMPLETED';
CREATE INDEX privacy_requests_market_due_idx ON privacy_requests (market_id, status, due_at);
-- breach_records_open_idx (market_id, pdpc_deadline_at) WHERE status <> 'CLOSED' already exists (0028): the plan's fifth index is not repeated.
