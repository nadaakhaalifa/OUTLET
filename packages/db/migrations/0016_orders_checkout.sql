-- migration: 0016_orders_checkout
-- phase: expand (new tables, new policies, new grants; nothing dropped or rewritten)
-- Source: docs/haul-master-prompt-v3.md section 7, 20.1, 15.6; docs/data-model.md 7.14 / 7.15 / 7.16 (ledger_holds);
--         docs/api/openapi.yaml checkout, order-groups and webhooks/psp paths; ADR-0011; packages/checkout/README.md (design).
--
-- RLS design (ADR-0011, audit unchanged):
--   * checkout_sessions, order_groups, payment_intents, ledger_holds: user-owned (app.enable_user_rls).
--   * seller_orders, order_lines: "both" tables. The RLS audit accepts exactly one PUBLIC policy per tenant table and
--     requires <tbl>_store_isolation to use app.current_store_id() and app.current_market_id(). A second PUBLIC policy
--     would fail the audit (exception policies must be TO outlet_auth / outlet_worker), so the shopper branch is OR'd
--     into the single store-isolation policy:
--        market pin AND ( store_id = app.current_store_id()                                   -- seller staff, store ctx
--                         OR (app.ctx() IN ('user','worker') AND user_id = app.current_user_id()) )  -- owning shopper
--     The ctx guard stops a store context that also carries the acting staff user id from reading that staff member's
--     own shopper orders of OTHER stores through the user branch.
--   * payment_events_raw: no tenant column. RLS forced, reachable only by outlet_worker in job payments.webhook (and the
--     generated privacy.retention policy); REVOKED from outlet_app (default privileges would otherwise grant it).
--   * Worker jobs (packages/db/src/context.ts WORKER_JOBS):
--       payments.webhook  resolve the intent by provider reference (SELECT exception on payment_intents), then
--                         narrowContext(user) and act under the normal user / both policies (claim + ledger + outbox).
--       checkout.expiry   find expired PENDING_PAYMENT / AWAITING_COD_CONFIRMATION groups (SELECT exception on
--                         order_groups), then narrow to each owner and compensate.
--     Both get an INSERT-only outbox policy. All other worker access is grants + the PUBLIC isolation policies after
--     narrowing ("narrow, then act"); no BYPASSRLS, no policy without app.ctx()/app.job()/market pin.
--
-- Grants: outlet_app keeps INSERT/SELECT; UPDATE is column-limited (money columns are write-once); DELETE/TRUNCATE are
-- revoked on every order and payment table (tax-record retention). outlet_worker gets explicit narrow grants, including
-- on inventory and ledger tables it must touch inside the webhook transaction (claimIn + Ledger.post): REVIEW (two-key).
--
-- Deviations from docs/data-model.md (reported in packages/checkout/README.md section 10):
--   order_groups: + idempotency_key, payment_method, payment_expires_at, reservation_id, shipping_vat_minor;
--                 states + AWAITING_COD_CONFIRMATION, REFUND_PENDING, REFUNDED.
--   seller_orders: + commission_vat_minor, seller_net_minor, shipping_vat_minor; states + VOIDED.
--   order_lines: + evidence_ids_snapshot uuid[] (instead of the order_line_evidence join table).
--   payment_events_raw: not partitioned in Phase 1 (DM-12 trigger applies); dedup by UNIQUE (market_id, provider,
--                 provider_event_id) instead of dedup_keys; + body_sha256, failure_reason.
--   ledger_holds: + user_id (user isolation; the data model had tenant none). Owned by the ledger module, created here
--                 because checkout is its first user.
--   checkout_sessions: created at placement (quote stays pure and returns a signed quote token); + quote_hash,
--                 reservation_id, payment_method; status submitted | completed | expired.

-- 1. checkout_sessions: the price-lock snapshot that a placement committed to.
CREATE TABLE checkout_sessions (
  id                    uuid PRIMARY KEY,                -- = quote token id (jti): one session per signed quote
  user_id               uuid NOT NULL REFERENCES users (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  currency              char(3) NOT NULL,
  quote                 jsonb NOT NULL,                  -- lines, prices, VRP, fees, totals as shown (no P3)
  quote_hash            bytea NOT NULL CHECK (length(quote_hash) = 32),
  payment_method        text NOT NULL CHECK (payment_method IN ('card', 'apple_pay', 'meeza', 'wallet', 'instapay', 'fawry', 'bnpl', 'cod', 'store_credit')),
  address_ref           uuid,                            -- logical ref; addresses table not built yet
  price_lock_expires_at timestamptz NOT NULL,
  reservation_id        uuid,
  order_group_id        uuid,
  status                text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'completed', 'expired')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_sessions_user_idx ON checkout_sessions (user_id, id DESC);
SELECT app.enable_user_rls('checkout_sessions');

-- 2. order_groups: one payment for many stores.
CREATE TABLE order_groups (
  id                     uuid PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES users (id),
  market_id              text NOT NULL CHECK (length(market_id) > 0),
  currency               char(3) NOT NULL,
  status                 text NOT NULL CHECK (status IN (
                           'PENDING_PAYMENT', 'AWAITING_COD_CONFIRMATION', 'PAID', 'CONFIRMED_COD', 'PAYMENT_FAILED', 'EXPIRED',
                           'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_FULFILLED', 'COMPLETED', 'CANCELLED')),
  funds_flow             text NOT NULL CHECK (funds_flow IN ('psp_split', 'collect_payout')),
  checkout_session_id    uuid NOT NULL UNIQUE REFERENCES checkout_sessions (id),
  idempotency_key        uuid NOT NULL,
  payment_method         text NOT NULL CHECK (payment_method IN ('card', 'apple_pay', 'meeza', 'wallet', 'instapay', 'fawry', 'bnpl', 'cod', 'store_credit')),
  items_subtotal_minor   bigint NOT NULL CHECK (items_subtotal_minor >= 0),
  discount_minor         bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  shipping_minor         bigint NOT NULL CHECK (shipping_minor >= 0),
  shipping_vat_minor     bigint NOT NULL CHECK (shipping_vat_minor >= 0 AND shipping_vat_minor <= shipping_minor),
  vat_minor              bigint NOT NULL CHECK (vat_minor >= 0),          -- VAT included in total (goods + delivery), informational
  store_credit_minor     bigint NOT NULL DEFAULT 0 CHECK (store_credit_minor >= 0),
  total_minor            bigint NOT NULL CHECK (total_minor > 0),          -- owed by the shopper in total, VAT-inclusive
  risk_decision          text CHECK (risk_decision IN ('allow', 'require_confirmation', 'require_prepayment', 'prepaid_only', 'limit_value', 'block')),
  reservation_id         uuid,
  payment_expires_at     timestamptz,
  placed_at              timestamptz NOT NULL,
  paid_at                timestamptz,
  version                int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = items_subtotal_minor - discount_minor + shipping_minor),
  CHECK (store_credit_minor <= total_minor),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX order_groups_user_idx ON order_groups (user_id, created_at DESC, id DESC);
CREATE INDEX order_groups_expiry_idx ON order_groups (market_id, payment_expires_at)
  WHERE status IN ('PENDING_PAYMENT', 'AWAITING_COD_CONFIRMATION');
SELECT app.enable_user_rls('order_groups');

-- 3. seller_orders: one per store in the group.
CREATE TABLE seller_orders (
  id                       uuid PRIMARY KEY,
  order_group_id           uuid NOT NULL REFERENCES order_groups (id),
  store_id                 uuid NOT NULL REFERENCES stores (id),
  user_id                  uuid NOT NULL REFERENCES users (id),
  market_id                text NOT NULL CHECK (length(market_id) > 0),
  currency                 char(3) NOT NULL,
  status                   text NOT NULL CHECK (status IN (
                             'PENDING_PAYMENT', 'PAID', 'CONFIRMED_COD', 'VOIDED', 'ACCEPTED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY',
                             'DELIVERED', 'CLOSED', 'CANCELLED', 'REJECTED_BY_SELLER', 'DELIVERY_FAILED', 'RTO', 'RETURNED_TO_SELLER', 'DISPUTED')),
  funds_flow               text NOT NULL CHECK (funds_flow IN ('psp_split', 'collect_payout')),
  items_subtotal_minor     bigint NOT NULL CHECK (items_subtotal_minor >= 0),
  platform_discount_minor  bigint NOT NULL DEFAULT 0 CHECK (platform_discount_minor >= 0),
  seller_discount_minor    bigint NOT NULL DEFAULT 0 CHECK (seller_discount_minor >= 0),
  shipping_minor           bigint NOT NULL CHECK (shipping_minor >= 0),
  shipping_vat_minor       bigint NOT NULL CHECK (shipping_vat_minor >= 0 AND shipping_vat_minor <= shipping_minor),
  vat_minor                bigint NOT NULL CHECK (vat_minor >= 0),
  total_minor              bigint NOT NULL CHECK (total_minor >= 0),
  commission_bp_snapshot   int NOT NULL CHECK (commission_bp_snapshot BETWEEN 0 AND 10000),
  commission_minor         bigint NOT NULL CHECK (commission_minor >= 0),
  commission_vat_minor     bigint NOT NULL CHECK (commission_vat_minor >= 0),
  seller_net_minor         bigint NOT NULL CHECK (seller_net_minor >= 0),    -- I13 residual: base - commission - commission VAT
  plan_id_snapshot         uuid,
  shipping_quote_ref       jsonb,
  accept_by                timestamptz,
  dispatch_by              timestamptz,
  delivered_at             timestamptz,
  return_window_ends_at    timestamptz,
  closed_at                timestamptz,
  cancel_reason            text,
  version                  int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = items_subtotal_minor - platform_discount_minor - seller_discount_minor + shipping_minor),
  UNIQUE (order_group_id, store_id)
);
CREATE INDEX seller_orders_store_idx ON seller_orders (store_id, status, created_at DESC, id DESC);
CREATE INDEX seller_orders_user_idx ON seller_orders (user_id, created_at DESC, id DESC);
CREATE INDEX seller_orders_accept_by_idx ON seller_orders (accept_by) WHERE status = 'PAID';
CREATE INDEX seller_orders_close_idx ON seller_orders (return_window_ends_at) WHERE status = 'DELIVERED';

-- 4. order_lines: snapshots for the CPA evidence trail.
CREATE TABLE order_lines (
  id                        uuid PRIMARY KEY,
  seller_order_id           uuid NOT NULL REFERENCES seller_orders (id),
  order_group_id            uuid NOT NULL REFERENCES order_groups (id),
  store_id                  uuid NOT NULL REFERENCES stores (id),
  user_id                   uuid NOT NULL REFERENCES users (id),
  market_id                 text NOT NULL CHECK (length(market_id) > 0),
  sku_id                    uuid NOT NULL REFERENCES skus (id),
  product_id                uuid NOT NULL REFERENCES products (id),
  title_ar_snapshot         text NOT NULL CHECK (length(btrim(title_ar_snapshot)) > 0),   -- CPL 181/2018: Arabic invoice data
  title_en_snapshot         text,
  condition_grade_snapshot  text NOT NULL,
  defect_card_id_snapshot   uuid REFERENCES defect_cards (id),
  defect_ack_at             timestamptz,
  qty                       smallint NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price_minor          bigint NOT NULL CHECK (unit_price_minor > 0),
  currency                  char(3) NOT NULL,
  platform_discount_minor   bigint NOT NULL DEFAULT 0 CHECK (platform_discount_minor >= 0),
  seller_discount_minor     bigint NOT NULL DEFAULT 0 CHECK (seller_discount_minor >= 0),
  tax_category              text NOT NULL CHECK (tax_category IN ('standard', 'zero_rated', 'exempt', 'reduced')),
  vat_rate_bp               int NOT NULL CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  vat_minor                 bigint NOT NULL CHECK (vat_minor >= 0),
  price_claim_id_snapshot   uuid,
  vrp_minor_snapshot        bigint CHECK (vrp_minor_snapshot IS NULL OR vrp_minor_snapshot > 0),
  claim_type_snapshot       text NOT NULL CHECK (claim_type_snapshot IN ('verified_discount', 'lowest_30d', 'launch_price', 'plain')),
  evidence_ids_snapshot     uuid[] NOT NULL DEFAULT '{}',
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'return_requested', 'returned', 'refunded')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- a verified-discount claim must carry its reference (no strike-through without evidence, master prompt section 5)
  CHECK (claim_type_snapshot <> 'verified_discount' OR (vrp_minor_snapshot IS NOT NULL AND vrp_minor_snapshot > unit_price_minor))
);
CREATE INDEX order_lines_seller_order_idx ON order_lines (seller_order_id);
CREATE INDEX order_lines_group_idx ON order_lines (order_group_id);
CREATE INDEX order_lines_sku_idx ON order_lines (sku_id, created_at);

-- "both" policy for seller_orders and order_lines (see header).
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seller_orders', 'order_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (market_id = app.current_market_id() AND (store_id = app.current_store_id()
                OR (app.ctx() IN (''user'', ''worker'') AND user_id = app.current_user_id())))
         WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id()
                OR (app.ctx() IN (''user'', ''worker'') AND user_id = app.current_user_id())))',
      t || '_store_isolation', t);
  END LOOP;
END
$do$;

-- 5. payment_intents: exactly one per order group.
CREATE TABLE payment_intents (
  id              uuid PRIMARY KEY,                       -- also the merchant reference sent to the PSP
  order_group_id  uuid NOT NULL UNIQUE REFERENCES order_groups (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  market_id       text NOT NULL CHECK (length(market_id) > 0),
  provider        text NOT NULL CHECK (provider IN ('paymob', 'kashier', 'fawry', 'fake', 'none')),
  provider_ref    text,
  method          text NOT NULL CHECK (method IN ('card', 'apple_pay', 'meeza', 'wallet', 'instapay', 'fawry', 'bnpl', 'cod', 'store_credit')),
  bnpl_provider   text,
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),   -- external tender only (0 for store-credit-only / COD)
  currency        char(3) NOT NULL,
  status          text NOT NULL CHECK (status IN ('CREATED', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'NOT_REQUIRED')),
  client_action   jsonb,                                   -- redirect URL, iframe, SDK token ref, Fawry reference; never card data
  three_ds        boolean,
  failure_code    text,
  expires_at      timestamptz,
  version         int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (bnpl_provider IS NULL OR method = 'bnpl')
);
CREATE UNIQUE INDEX payment_intents_provider_ref_uq ON payment_intents (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payment_intents_expiry_idx ON payment_intents (status, expires_at) WHERE status IN ('CREATED', 'REQUIRES_ACTION');
SELECT app.enable_user_rls('payment_intents');

-- 6. payment_events_raw: every inbound PSP webhook, stored before processing (signature good or bad).
CREATE TABLE payment_events_raw (
  id                 uuid PRIMARY KEY,
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  provider           text NOT NULL CHECK (provider IN ('paymob', 'kashier', 'fawry', 'fake')),
  provider_event_id  text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),  -- 'unverified:<sha256>' when the signature failed
  event_type         text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  signature_ok       boolean NOT NULL,
  body_ct            bytea NOT NULL,                                     -- FieldCipher, aad 'payment_events_raw.body_ct'
  body_sha256        bytea NOT NULL CHECK (length(body_sha256) = 32),
  payment_intent_id  uuid REFERENCES payment_intents (id),
  processing_status  text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed', 'rejected')),
  failure_reason     text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (market_id, provider, provider_event_id)
);
CREATE INDEX payment_events_raw_intent_idx ON payment_events_raw (payment_intent_id, id);
CREATE INDEX payment_events_raw_failed_idx ON payment_events_raw (processing_status, id) WHERE processing_status = 'failed';
ALTER TABLE payment_events_raw ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events_raw FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_events_raw__worker_payments_webhook ON payment_events_raw FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'payments.webhook' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'payments.webhook' AND market_id = app.current_market_id());

-- 7. ledger_holds: store credit held during checkout (a row, not a pending posting; postings stay immutable).
CREATE TABLE ledger_holds (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id),
  account_id         uuid NOT NULL REFERENCES ledger_accounts (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  currency           char(3) NOT NULL,
  ref_type           text NOT NULL CHECK (ref_type IN ('order_group')),
  ref_id             uuid NOT NULL,
  status             text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CAPTURED', 'RELEASED', 'EXPIRED')),
  captured_entry_id  uuid REFERENCES journal_entries (id),
  idempotency_key    text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  CHECK ((status = 'CAPTURED') = (captured_entry_id IS NOT NULL))
);
CREATE INDEX ledger_holds_expiry_idx ON ledger_holds (expires_at) WHERE status = 'HELD';
CREATE INDEX ledger_holds_account_idx ON ledger_holds (account_id) WHERE status = 'HELD';
CREATE INDEX ledger_holds_ref_idx ON ledger_holds (ref_type, ref_id);
SELECT app.enable_user_rls('ledger_holds');

-- 8. Request-path grants (outlet_app). Money columns are write-once; nothing is deleted (tax records).
REVOKE ALL ON payment_events_raw FROM outlet_app;
REVOKE UPDATE, DELETE, TRUNCATE ON checkout_sessions, order_groups, seller_orders, order_lines, payment_intents, ledger_holds FROM outlet_app;
GRANT SELECT, INSERT ON checkout_sessions, order_groups, seller_orders, order_lines, payment_intents, ledger_holds TO outlet_app;
GRANT UPDATE (status, order_group_id, reservation_id, updated_at) ON checkout_sessions TO outlet_app;
GRANT UPDATE (status, risk_decision, reservation_id, payment_expires_at, paid_at, version, updated_at) ON order_groups TO outlet_app;
GRANT UPDATE (status, accept_by, dispatch_by, delivered_at, return_window_ends_at, closed_at, cancel_reason, version, updated_at) ON seller_orders TO outlet_app;
GRANT UPDATE (status) ON order_lines TO outlet_app;
GRANT UPDATE (status, provider, provider_ref, client_action, three_ds, failure_code, expires_at, version, updated_at) ON payment_intents TO outlet_app;
GRANT UPDATE (status, captured_entry_id, settled_at) ON ledger_holds TO outlet_app;

-- 9. Worker grants (payments.webhook, checkout.expiry). Narrow, then act: the PUBLIC isolation policies still apply.
GRANT SELECT, INSERT ON payment_events_raw TO outlet_worker;
GRANT UPDATE (processing_status, failure_reason, payment_intent_id, processed_at) ON payment_events_raw TO outlet_worker;
GRANT SELECT ON checkout_sessions, order_groups, seller_orders, order_lines, payment_intents TO outlet_worker;
GRANT UPDATE (status, updated_at) ON checkout_sessions TO outlet_worker;
GRANT UPDATE (status, paid_at, version, updated_at) ON order_groups TO outlet_worker;
GRANT UPDATE (status, accept_by, cancel_reason, version, updated_at) ON seller_orders TO outlet_worker;
GRANT UPDATE (status) ON order_lines TO outlet_worker;
GRANT UPDATE (status, provider_ref, failure_code, three_ds, version, updated_at) ON payment_intents TO outlet_worker;
GRANT SELECT, INSERT ON ledger_holds TO outlet_worker;
GRANT UPDATE (status, captured_entry_id, settled_at) ON ledger_holds TO outlet_worker;
-- Ledger (append-only, same as outlet_app) and inventory claim/release inside the webhook / expiry transaction.
GRANT SELECT, INSERT ON ledger_accounts, journal_entries, postings TO outlet_worker;
-- B4: the ledger INSERT grant is not job-agnostic. journal_entries / postings carry no RLS (the app role reads and writes them without a
-- tenant key, and ENABLE RLS would need app-role policies the ADR-0011 audit does not allow), so the job allow-list is enforced by a
-- BEFORE INSERT guard that applies to outlet_worker only: a worker outside the five money jobs cannot post, whatever its grants.
CREATE OR REPLACE FUNCTION app.ledger_worker_post_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user = 'outlet_worker' AND (app.ctx() IS DISTINCT FROM 'worker'
     OR app.job() IS NULL OR app.job() <> ALL (ARRAY['payments.webhook', 'checkout.expiry', 'finance.payouts', 'finance.reconcile', 'finance.refunds'])) THEN
    RAISE EXCEPTION 'worker job % may not post to the ledger (%)', COALESCE(app.job(), '<none>'), TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_entries__worker_post BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION app.ledger_worker_post_guard();
CREATE TRIGGER postings__worker_post BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION app.ledger_worker_post_guard();
GRANT SELECT ON reservations, inventory_units, inventory_levels TO outlet_worker;
-- C3: UPDATE is column-limited to exactly what claim and release write (state, timestamps, counters), never keys or money-bearing identity.
GRANT UPDATE (state, claimed_at, released_at) ON reservations TO outlet_worker;
GRANT UPDATE (state, expires_at, reservation_id) ON inventory_units TO outlet_worker;
GRANT UPDATE (committed, pool_target, version, updated_at) ON inventory_levels TO outlet_worker;
GRANT SELECT ON reservation_lines TO outlet_worker;
GRANT SELECT, DELETE ON inventory_expiry_index TO outlet_worker;

-- 10. Worker exception policies (ADR-0011 naming: <tbl>__worker_<job>).
CREATE POLICY payment_intents__worker_payments_webhook ON payment_intents FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'payments.webhook' AND market_id = app.current_market_id());
CREATE POLICY order_groups__worker_checkout_expiry ON order_groups FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'checkout.expiry' AND market_id = app.current_market_id()
         AND status IN ('PENDING_PAYMENT', 'AWAITING_COD_CONFIRMATION') AND payment_expires_at < now());
CREATE POLICY outbox_events__worker_payments_webhook ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'payments.webhook' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_checkout_expiry ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'checkout.expiry' AND market_id = app.current_market_id());

-- 11. Retention: raw_webhooks_financial (0004) now has its table; generate its worker policy.
SELECT app.enable_retention_policy('raw_webhooks_financial');
