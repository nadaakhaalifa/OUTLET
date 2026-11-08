-- migration: 0019_returns_refunds
-- phase: expand (new tables only)
-- Source: master prompt section 22 (returns), 15.6 (RefundRouter), B5 (CPL 181/2018); docs/data-model.md 7.19;
--         docs/specs/ledger-chart-of-accounts.md 4.5, 4.6, I7-I13; docs/compliance/verify-register.md V7, V19.
--
-- Tenancy: every table carries user_id AND store_id ("both" tables, same pattern as seller_orders in 0016): one PUBLIC policy named
-- <tbl>_store_isolation, shopper branch OR'd in for ctx user/worker (a worker is narrowed to the shopper before it acts).
-- Worker job `finance.refunds` (WORKER_JOBS in packages/db/src/context.ts): named exception policies only to SCAN across tenants
-- (due auto-approvals, retryable refunds, the T&S dispute queue, outbox emit); every write happens narrowed to one shopper.
-- Money columns are write-once for outlet_app (no UPDATE on refunds, no INSERT on refunds / refund_allocations): refunds are created
-- only by the finance.refunds worker (ledger-first), never from the request path. Nothing is deleted (tax-record retention).
-- Deviations from data-model 7.19: return_lines is named return_items (caller's spec); refund_attempts is not built (attempts / next_attempt_at /
-- last_error live on refunds); refunds.destinations jsonb carries the split-tender route legs; return_evidence.media_id is a logical
-- reference (shopper uploads are not a media_assets kind yet, so no FK); extra columns are listed in data_inventory.yaml.

CREATE TABLE return_requests (
  id                    uuid PRIMARY KEY,
  seller_order_id       uuid NOT NULL REFERENCES seller_orders (id),
  order_group_id        uuid NOT NULL REFERENCES order_groups (id),
  user_id               uuid NOT NULL REFERENCES users (id),
  store_id              uuid NOT NULL REFERENCES stores (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  status                text NOT NULL CHECK (status IN (
                          'REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'IN_TRANSIT', 'RECEIVED', 'ACCEPTED', 'REJECTED', 'DISPUTED', 'CANCELLED', 'CLOSED')),
  reason_code           text NOT NULL CHECK (reason_code IN (
                          'too_small', 'too_large', 'not_as_described', 'defect_undisclosed', 'defect_worse_than_shown', 'changed_mind', 'late', 'wrong_item')),
  fault                 text NOT NULL CHECK (fault IN ('shopper', 'seller', 'courier', 'none')),
  window_basis          text NOT NULL CHECK (window_basis IN ('no_reason_14d', 'defect_30d')),
  delivered_at_snapshot timestamptz NOT NULL,
  window_ends_at        timestamptz NOT NULL,
  method                text NOT NULL CHECK (method IN ('pickup', 'dropoff')),
  resolution            text NOT NULL CHECK (resolution IN ('refund', 'exchange', 'store_credit')),
  refund_choice         text CHECK (refund_choice IN ('original', 'store_credit')),   -- shopper's choice where both are legal (15.6)
  return_shipping_payer text NOT NULL DEFAULT 'shopper' CHECK (return_shipping_payer IN ('seller', 'shopper', 'free')),
  serial_returner       boolean NOT NULL DEFAULT false,   -- published policy flag at request time (free returns removed)
  received_at           timestamptz,
  inspection_due_at     timestamptz,
  refund_due_at         timestamptz,                      -- legal deadline, V7 open: configurable days from receipt
  idempotency_key       uuid NOT NULL,
  version               int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (window_ends_at > delivered_at_snapshot)
);
CREATE INDEX return_requests_store_idx ON return_requests (store_id, status, created_at DESC, id DESC);
CREATE INDEX return_requests_user_idx ON return_requests (user_id, created_at DESC, id DESC);
CREATE INDEX return_requests_seller_order_idx ON return_requests (seller_order_id, status);
CREATE INDEX return_requests_inspection_idx ON return_requests (market_id, inspection_due_at) WHERE status = 'RECEIVED';

CREATE TABLE return_items (
  id                 uuid PRIMARY KEY,
  return_request_id  uuid NOT NULL REFERENCES return_requests (id),
  order_line_id      uuid NOT NULL REFERENCES order_lines (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  store_id           uuid NOT NULL REFERENCES stores (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  qty                smallint NOT NULL CHECK (qty BETWEEN 1 AND 10),
  condition_received text CHECK (condition_received IN ('as_new', 'used', 'damaged', 'defective', 'missing')),
  restock_decision   text CHECK (restock_decision IN ('restock', 'relist_open_box', 'write_off', 'donate')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_request_id, order_line_id)
);
CREATE INDEX return_items_line_idx ON return_items (order_line_id);

CREATE TABLE return_evidence (
  id                 uuid PRIMARY KEY,
  return_request_id  uuid NOT NULL REFERENCES return_requests (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  store_id           uuid NOT NULL REFERENCES stores (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  uploaded_by_type   text NOT NULL CHECK (uploaded_by_type IN ('shopper', 'seller', 'courier', 'hub')),
  media_id           uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('defect_photo', 'packaging', 'inspection')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_request_id, media_id)
);

CREATE TABLE return_inspections (
  id                 uuid PRIMARY KEY,
  return_request_id  uuid NOT NULL REFERENCES return_requests (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  store_id           uuid NOT NULL REFERENCES stores (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  inspector_type     text NOT NULL CHECK (inspector_type IN ('seller', 'hub', 'system')),   -- system = 48 h silence auto-approve
  result             text NOT NULL CHECK (result IN ('accepted', 'rejected')),
  reason_code        text,                                                                   -- required for a rejection
  notes              text,
  inspected_by       uuid,
  inspected_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_request_id),
  CHECK (result <> 'rejected' OR reason_code IS NOT NULL)
);

CREATE TABLE disputes (
  id                 uuid PRIMARY KEY,
  return_request_id  uuid NOT NULL UNIQUE REFERENCES return_requests (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  store_id           uuid NOT NULL REFERENCES stores (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  status             text NOT NULL CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED_SHOPPER', 'RESOLVED_SELLER', 'WITHDRAWN')),
  reason_code        text NOT NULL CHECK (reason_code IN ('item_was_defective', 'item_not_as_described', 'rejection_unjustified', 'item_not_received_by_seller', 'other')),
  shopper_note       text CHECK (shopper_note IS NULL OR length(shopper_note) <= 2000),
  assigned_staff_id  uuid,
  sla_due_at         timestamptz NOT NULL,    -- 5 business days (T&S human review)
  resolution_note    text,
  resolved_at        timestamptz,
  sla_breach_notified_at timestamptz,         -- set once when dispute.sla_breached is emitted
  version            int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_queue_idx ON disputes (market_id, status, sla_due_at);

CREATE TABLE refunds (
  id                      uuid PRIMARY KEY,
  order_group_id          uuid NOT NULL REFERENCES order_groups (id),
  seller_order_id         uuid NOT NULL REFERENCES seller_orders (id),
  return_request_id       uuid REFERENCES return_requests (id),
  user_id                 uuid NOT NULL REFERENCES users (id),
  store_id                uuid NOT NULL REFERENCES stores (id),
  market_id               text NOT NULL CHECK (length(market_id) > 0),
  reason                  text NOT NULL CHECK (reason IN ('return', 'seller_rejected', 'goodwill')),
  route                   text NOT NULL CHECK (route IN ('psp_original', 'bnpl_provider', 'store_credit', 'bank_transfer', 'fawry_voucher', 'mixed')),
  shopper_choice          text CHECK (shopper_choice IN ('original', 'store_credit')),
  currency                char(3) NOT NULL,
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  goods_minor             bigint NOT NULL CHECK (goods_minor >= 0),
  delivery_fee_minor      bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  delivery_vat_minor      bigint NOT NULL DEFAULT 0 CHECK (delivery_vat_minor >= 0 AND delivery_vat_minor <= delivery_fee_minor),
  commission_minor        bigint NOT NULL CHECK (commission_minor >= 0),          -- 4.5: C(remaining before) - C(remaining after)
  commission_vat_minor    bigint NOT NULL CHECK (commission_vat_minor >= 0),
  seller_minor            bigint NOT NULL CHECK (seller_minor >= 0),              -- goods - commission - commission VAT
  seller_account          text NOT NULL CHECK (seller_account IN ('seller_pending', 'seller_available')),   -- I11: closed lines come out of available
  destinations            jsonb NOT NULL CHECK (jsonb_typeof(destinations) = 'array'),
  status                  text NOT NULL CHECK (status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW')),
  provider_ref            text,
  journal_entry_id        uuid REFERENCES journal_entries (id),
  idempotency_key         text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  approval_request_id     uuid,                                                  -- dual approval of the refund itself (A1)
  resolution_approval_request_id uuid,                                           -- dual approval of a manual resolution (A1)
  manual_ref              text CHECK (manual_ref IS NULL OR length(manual_ref) BETWEEN 1 AND 100),  -- bank transfer reference of a manual payout (A3)
  attempts                smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at         timestamptz,
  last_error              text,
  due_at                  timestamptz,                                           -- legal payment deadline (V7)
  initiated_at            timestamptz,
  completed_at            timestamptz,
  version                 int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor = goods_minor + delivery_fee_minor),
  CHECK (goods_minor = seller_minor + commission_minor + commission_vat_minor)
);
CREATE INDEX refunds_user_idx ON refunds (user_id, created_at DESC, id DESC);
CREATE INDEX refunds_seller_order_idx ON refunds (seller_order_id);
CREATE INDEX refunds_retry_idx ON refunds (market_id, next_attempt_at) WHERE status = 'FAILED';

CREATE TABLE refund_allocations (
  refund_id             uuid NOT NULL REFERENCES refunds (id),
  line_no               smallint NOT NULL CHECK (line_no >= 1),
  order_line_id         uuid REFERENCES order_lines (id),                      -- NULL for the delivery-fee component
  user_id               uuid NOT NULL REFERENCES users (id),
  store_id              uuid NOT NULL REFERENCES stores (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  component             text NOT NULL CHECK (component IN ('goods', 'delivery_fee')),
  qty                   smallint NOT NULL DEFAULT 0 CHECK (qty >= 0),
  gross_minor           bigint NOT NULL CHECK (gross_minor >= 0),
  discount_share_minor  bigint NOT NULL DEFAULT 0 CHECK (discount_share_minor >= 0),   -- proportional voucher share given back
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),               -- gross - discount share
  commission_minor      bigint NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  commission_vat_minor  bigint NOT NULL DEFAULT 0 CHECK (commission_vat_minor >= 0),
  currency              char(3) NOT NULL,
  PRIMARY KEY (refund_id, line_no),
  CHECK ((component = 'goods') = (order_line_id IS NOT NULL)),
  CHECK (amount_minor = gross_minor - discount_share_minor)
);
CREATE INDEX refund_allocations_line_idx ON refund_allocations (order_line_id) WHERE order_line_id IS NOT NULL;

-- "both" policy (see header and 0016).
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['return_requests', 'return_items', 'return_evidence', 'return_inspections', 'disputes', 'refunds', 'refund_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- The worker branch is job-pinned: only the finance.refunds job may act as a shopper-scoped worker on these tables.
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (market_id = app.current_market_id() AND (store_id = app.current_store_id()
                OR (app.ctx() = ''user'' AND user_id = app.current_user_id())
                OR (app.ctx() = ''worker'' AND app.job() = ''finance.refunds'' AND user_id = app.current_user_id())))
         WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id()
                OR (app.ctx() = ''user'' AND user_id = app.current_user_id())
                OR (app.ctx() = ''worker'' AND app.job() = ''finance.refunds'' AND user_id = app.current_user_id())))',
      t || '_store_isolation', t);
  END LOOP;
END
$do$;

-- Request-path grants (outlet_app = shopper and seller requests). No DELETE anywhere; refunds are read-only for the app.
REVOKE ALL ON return_requests, return_items, return_evidence, return_inspections, disputes, refunds, refund_allocations FROM outlet_app;
GRANT SELECT, INSERT ON return_requests, return_items, return_evidence, return_inspections, disputes TO outlet_app;
GRANT UPDATE (status, resolution, refund_choice, received_at, inspection_due_at, refund_due_at, version, updated_at) ON return_requests TO outlet_app;
GRANT UPDATE (condition_received, restock_decision) ON return_items TO outlet_app;
GRANT UPDATE (status, shopper_note, version, updated_at) ON disputes TO outlet_app;
GRANT SELECT ON refunds, refund_allocations TO outlet_app;

-- Worker grants (finance.refunds). Ledger and order-table grants already exist from 0016.
REVOKE ALL ON return_requests, return_items, return_evidence, return_inspections, disputes, refunds, refund_allocations FROM outlet_worker;
GRANT SELECT ON return_requests, return_items, return_evidence, return_inspections, disputes, refund_allocations TO outlet_worker;
GRANT UPDATE (status, received_at, inspection_due_at, refund_due_at, version, updated_at) ON return_requests TO outlet_worker;
GRANT UPDATE (condition_received, restock_decision) ON return_items TO outlet_worker;
GRANT INSERT ON return_inspections TO outlet_worker;
GRANT UPDATE (status, assigned_staff_id, resolution_note, resolved_at, sla_breach_notified_at, version, updated_at) ON disputes TO outlet_worker;
GRANT SELECT, INSERT ON refunds TO outlet_worker;
GRANT UPDATE (status, seller_account, provider_ref, journal_entry_id, approval_request_id, resolution_approval_request_id, manual_ref, attempts, next_attempt_at, last_error, initiated_at, completed_at, version, updated_at) ON refunds TO outlet_worker;
GRANT INSERT ON refund_allocations TO outlet_worker;
GRANT SELECT ON ledger_holds TO outlet_worker;

-- Named exception policies (ADR-0011): scan-only SELECTs plus the outbox emit. Writes happen narrowed to one shopper.
CREATE POLICY return_requests__worker_finance_refunds ON return_requests FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.refunds' AND market_id = app.current_market_id());
CREATE POLICY refunds__worker_finance_refunds ON refunds FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.refunds' AND market_id = app.current_market_id());
CREATE POLICY disputes__worker_finance_refunds ON disputes FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.refunds' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_finance_refunds ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'finance.refunds' AND market_id = app.current_market_id());
