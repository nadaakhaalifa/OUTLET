-- migration: 0018_payouts_reconciliation
-- phase: expand (new tables, policies and grants only)
-- Source: master prompt section T4 (payouts, reconciliation), docs/specs/ledger-chart-of-accounts.md sections 3, 4.1, 4.3, 4.11, invariants I12, I21-I23,
--         docs/data-model.md sections 7.15 (settlement), 7.16 (reconciliation), 7.17 (payouts). TWO-KEY area (payouts, ledger).
--
-- Tenancy: payouts, payout_accruals, payout_lines, payout_holds carry store_id. Sellers read their own payouts, lines and accruals
-- through <tbl>_store_isolation (store context + market pin); outlet_app has SELECT only and no access to payout_holds (risk data).
-- Every write belongs to outlet_worker under the named jobs finance.payouts and finance.reconcile (ADR-0011): a FOR ALL (or SELECT)
-- exception policy <tbl>__worker_<job>, pinned to the market, with column-limited UPDATE grants (net, gross and keys are immutable).
-- Finance tables without a tenant key (batches, settlement, COD remittance, reconciliation) are worker-only: RLS forced, outlet_app has no grant.
--
-- Deviations from docs/data-model.md (reported to the owner):
--   * Tables are named per the P1-19 task: payout_lines (= payout_items), psp_settlement_files / psp_settlement_lines (= settlement_*),
--     cod_remittances / cod_remittance_lines, reconciliation_matches / reconciliation_exceptions (= reconciliation_items); payout_batches is new.
--   * payout_accruals is kept (eligibility needs a per-seller-order row). Statuses PENDING, AVAILABLE, SCHEDULED, SENT, PAID.
--   * payouts.journal_entry_id is split into sent_entry_id / settled_entry_id (the chart posts at SENT and at SETTLED, section 4.11).
--   * payouts.payout_instrument_id has no FK: the instrument is seller_bank_accounts (0015); the destination is resolved by a port at schedule and send time.
--   * psp_settlement_lines is not partitioned yet (data model: RANGE (id) monthly).
--   * No ledger_holds row for a scheduled payout: ledger_holds is user/order-group keyed and the chart has no payout hold kind. The accrual claim
--     (payout_accruals.payout_id) plus the balance re-check at SEND is the guard (I12).
--   * The 0007 outbox emit list is NOT edited (applied migrations are checksummed): separate INSERT policies for the two new jobs, as in 0016.

-- ---------------------------------------------------------------- payout_batches
CREATE TABLE payout_batches (
  id               uuid PRIMARY KEY,
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  cycle_start      date NOT NULL,
  cycle_end        date NOT NULL,
  currency         char(3) NOT NULL,
  status           text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'COMPLETED')),
  payout_count     int NOT NULL DEFAULT 0 CHECK (payout_count >= 0),
  total_net_minor  bigint NOT NULL DEFAULT 0 CHECK (total_net_minor >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CHECK (cycle_end >= cycle_start),
  UNIQUE (market_id, cycle_start, cycle_end)
);

-- ---------------------------------------------------------------- payouts
CREATE TABLE payouts (
  id                    uuid PRIMARY KEY,
  batch_id              uuid NOT NULL REFERENCES payout_batches (id),
  store_id              uuid NOT NULL REFERENCES stores (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  mode                  text NOT NULL DEFAULT 'transfer' CHECK (mode IN ('transfer', 'statement')),
  payout_instrument_id  uuid,
  cycle_start           date NOT NULL,
  cycle_end             date NOT NULL,
  gross_minor           bigint NOT NULL CHECK (gross_minor > 0),
  adjustments_minor     bigint NOT NULL,
  net_minor             bigint NOT NULL CHECK (net_minor > 0),
  currency              char(3) NOT NULL,
  status                text NOT NULL CHECK (status IN ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'SENT', 'SETTLED', 'FAILED', 'CANCELLED')),
  approval_request_id   uuid,
  approved_by           uuid,
  approved_at           timestamptz,
  hold_reason           text CHECK (hold_reason IS NULL OR length(hold_reason) BETWEEN 1 AND 100),
  provider              text,
  provider_ref          text,
  sent_entry_id         uuid REFERENCES journal_entries (id),
  settled_entry_id      uuid REFERENCES journal_entries (id),
  failure_code          text,
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  sent_at               timestamptz,
  settled_at            timestamptz,
  send_attempt          int NOT NULL DEFAULT 1 CHECK (send_attempt >= 1),   -- ledger and rail keys carry it: a retry after a failed send is a new transfer
  version               int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (net_minor = gross_minor + adjustments_minor),
  CHECK (cycle_end >= cycle_start),
  CHECK (status <> 'SETTLED' OR settled_at IS NOT NULL),
  UNIQUE (store_id, cycle_start, cycle_end),
  UNIQUE (idempotency_key)
);
CREATE UNIQUE INDEX payouts_provider_ref_uq ON payouts (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payouts_store_idx ON payouts (store_id, created_at DESC, id DESC);
CREATE INDEX payouts_open_idx ON payouts (store_id) WHERE status IN ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'FAILED');
CREATE INDEX payouts_status_idx ON payouts (market_id, status) WHERE status IN ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'SENT');

-- ---------------------------------------------------------------- payout_accruals (one per seller order)
CREATE TABLE payout_accruals (
  id               uuid PRIMARY KEY,
  seller_order_id  uuid NOT NULL UNIQUE REFERENCES seller_orders (id),
  store_id         uuid NOT NULL REFERENCES stores (id),
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL CHECK (status IN ('PENDING', 'AVAILABLE', 'SCHEDULED', 'SENT', 'PAID')),
  closed_at        timestamptz,
  eligible_at      timestamptz,
  payout_id        uuid REFERENCES payouts (id),
  move_entry_id    uuid REFERENCES journal_entries (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PENDING') = (closed_at IS NULL AND eligible_at IS NULL AND move_entry_id IS NULL)),
  CHECK ((status IN ('SCHEDULED', 'SENT', 'PAID')) = (payout_id IS NOT NULL))
);
CREATE INDEX payout_accruals_build_idx ON payout_accruals (store_id, eligible_at) WHERE status = 'AVAILABLE';
CREATE INDEX payout_accruals_payout_idx ON payout_accruals (payout_id) WHERE payout_id IS NOT NULL;

-- ---------------------------------------------------------------- payout_lines (composition of one payout; signed)
CREATE TABLE payout_lines (
  id           uuid PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payouts (id),
  store_id     uuid NOT NULL REFERENCES stores (id),
  market_id    text NOT NULL CHECK (length(market_id) > 0),
  kind         text NOT NULL CHECK (kind IN ('order', 'adjustment')),
  accrual_id   uuid REFERENCES payout_accruals (id),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  currency     char(3) NOT NULL,
  CHECK ((kind = 'order') = (accrual_id IS NOT NULL)),
  CHECK (kind <> 'order' OR amount_minor > 0),
  UNIQUE (payout_id, accrual_id)
);
CREATE INDEX payout_lines_payout_idx ON payout_lines (payout_id);

-- ---------------------------------------------------------------- payout_holds (risk, enforcement, kyc, dispute)
CREATE TABLE payout_holds (
  id               uuid PRIMARY KEY,
  store_id         uuid NOT NULL REFERENCES stores (id),
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  reason           text NOT NULL CHECK (reason IN ('risk', 'enforcement', 'kyc', 'dispute')),
  seller_order_id  uuid REFERENCES seller_orders (id),
  source_ref       text,
  starts_at        timestamptz NOT NULL,
  released_at      timestamptz,
  created_by       uuid
);
CREATE INDEX payout_holds_open_idx ON payout_holds (store_id) WHERE released_at IS NULL;
-- B2: one dispute hold per dispute id (dispute.opened re-emission is absorbed; a released row is a tombstone for a late opened).
CREATE UNIQUE INDEX payout_holds_dispute_key ON payout_holds (source_ref) WHERE reason = 'dispute';

-- ---------------------------------------------------------------- PSP settlement files and lines (docs/data-model.md settlement_*)
CREATE TABLE psp_settlement_files (
  id             uuid PRIMARY KEY,
  market_id      text NOT NULL CHECK (length(market_id) > 0),
  provider       text NOT NULL CHECK (length(provider) > 0),
  business_date  date NOT NULL,
  sha256         bytea NOT NULL CHECK (length(sha256) = 32),
  row_count      int NOT NULL CHECK (row_count >= 0),
  status         text NOT NULL CHECK (status IN ('received', 'parsed', 'reconciled', 'failed')),
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, business_date, sha256)
);

CREATE TABLE psp_settlement_lines (
  id                uuid PRIMARY KEY,
  file_id           uuid NOT NULL REFERENCES psp_settlement_files (id),
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  provider          text NOT NULL,
  line_no           int NOT NULL CHECK (line_no >= 1),
  provider_ref      text NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 200),
  kind              text NOT NULL CHECK (kind IN ('capture', 'refund', 'fee', 'chargeback', 'payout')),
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  fee_minor         bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency          char(3) NOT NULL,
  value_date        date NOT NULL,
  intent_id         uuid,
  matched_entry_id  uuid REFERENCES journal_entries (id),
  status            text NOT NULL CHECK (status IN ('unmatched', 'matched', 'mismatch')),
  detail            text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 200),
  UNIQUE (file_id, line_no),
  CHECK ((status = 'matched') = (matched_entry_id IS NOT NULL))
);
CREATE INDEX psp_settlement_lines_ref_idx ON psp_settlement_lines (provider, provider_ref);
CREATE INDEX psp_settlement_lines_open_idx ON psp_settlement_lines (value_date) WHERE status <> 'matched';

-- ---------------------------------------------------------------- COD courier remittances
CREATE TABLE cod_remittances (
  id                uuid PRIMARY KEY,
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  courier           text NOT NULL CHECK (length(courier) > 0),
  remittance_ref    text NOT NULL CHECK (length(remittance_ref) BETWEEN 1 AND 200),
  business_date     date NOT NULL,
  currency          char(3) NOT NULL,
  gross_minor       bigint NOT NULL CHECK (gross_minor >= 0),
  fee_minor         bigint NOT NULL CHECK (fee_minor >= 0),
  net_minor         bigint NOT NULL CHECK (net_minor >= 0),
  sha256            bytea NOT NULL CHECK (length(sha256) = 32),
  status            text NOT NULL CHECK (status IN ('received', 'reconciled', 'mismatch')),
  matched_entry_id  uuid REFERENCES journal_entries (id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (courier, remittance_ref)
);

CREATE TABLE cod_remittance_lines (
  id               uuid PRIMARY KEY,
  remittance_id    uuid NOT NULL REFERENCES cod_remittances (id),
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  line_no          int NOT NULL CHECK (line_no >= 1),
  awb              text NOT NULL CHECK (length(awb) BETWEEN 1 AND 100),
  seller_order_id  uuid,                      -- as reported by the courier; may be unknown to us, so no FK
  collected_minor  bigint NOT NULL CHECK (collected_minor >= 0),
  fee_minor        bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL CHECK (status IN ('unmatched', 'matched', 'mismatch')),
  detail           text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 200),
  UNIQUE (remittance_id, line_no)
);
CREATE INDEX cod_remittance_lines_order_idx ON cod_remittance_lines (seller_order_id) WHERE seller_order_id IS NOT NULL;

-- ---------------------------------------------------------------- reconciliation
CREATE TABLE reconciliation_runs (
  id               uuid PRIMARY KEY,
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  source           text NOT NULL CHECK (source IN ('psp_settlement', 'cod_remittance', 'bnpl_settlement', 'eta_submission', 'store_credit_projection', 'ledger_integrity')),
  counterparty     text NOT NULL CHECK (length(counterparty) > 0),
  business_date    date NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('nightly', 'intraday')),
  status           text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  matched_count    int,
  unmatched_count  int,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  UNIQUE (market_id, source, counterparty, business_date, mode)
);

CREATE TABLE reconciliation_matches (
  id            uuid PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES reconciliation_runs (id),
  market_id     text NOT NULL CHECK (length(market_id) > 0),
  source        text NOT NULL,
  ref_type      text NOT NULL CHECK (length(ref_type) > 0),
  ref_id        uuid NOT NULL,
  entry_id      uuid REFERENCES journal_entries (id),
  amount_minor  bigint NOT NULL,
  currency      char(3) NOT NULL,
  matched_at    timestamptz NOT NULL,
  UNIQUE (market_id, source, ref_type, ref_id)
);

CREATE TABLE reconciliation_exceptions (
  id             uuid PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES reconciliation_runs (id),
  market_id      text NOT NULL CHECK (length(market_id) > 0),
  source         text NOT NULL,
  counterparty   text NOT NULL,
  kind           text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  ref_type       text NOT NULL CHECK (length(ref_type) > 0),
  ref_id         uuid NOT NULL,
  entry_id       uuid REFERENCES journal_entries (id),
  expected_minor bigint,
  actual_minor   bigint,
  currency       char(3) NOT NULL,
  status         text NOT NULL CHECK (status IN ('OPEN', 'ESCALATED', 'RESOLVED')),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  escalated_at   timestamptz,
  resolved_at    timestamptz,
  ticket_ref     text,
  UNIQUE (market_id, source, kind, ref_type, ref_id),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK (status <> 'ESCALATED' OR escalated_at IS NOT NULL)
);
CREATE INDEX reconciliation_exceptions_open_idx ON reconciliation_exceptions (status, first_seen_at) WHERE status <> 'RESOLVED';

-- ---------------------------------------------------------------- RLS
-- Store-keyed tables: seller isolation (store context, market pin). Same shape as store_members / seller_orders.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payouts', 'payout_accruals', 'payout_lines', 'payout_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (market_id = app.current_market_id() AND store_id = app.current_store_id())
         WITH CHECK (market_id = app.current_market_id() AND store_id = app.current_store_id())',
      t || '_store_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO outlet_worker
         USING (app.ctx() = ''worker'' AND app.job() = ''finance.payouts'' AND market_id = app.current_market_id())
         WITH CHECK (app.ctx() = ''worker'' AND app.job() = ''finance.payouts'' AND market_id = app.current_market_id())',
      t || '__worker_finance_payouts', t);
  END LOOP;
END
$do$;

-- Worker-only finance tables (no tenant key): RLS forced, one FOR ALL policy per job.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payout_batches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO outlet_worker
         USING (app.ctx() = ''worker'' AND app.job() = ''finance.payouts'' AND market_id = app.current_market_id())
         WITH CHECK (app.ctx() = ''worker'' AND app.job() = ''finance.payouts'' AND market_id = app.current_market_id())',
      t || '__worker_finance_payouts', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['psp_settlement_files', 'psp_settlement_lines', 'cod_remittances', 'cod_remittance_lines',
                           'reconciliation_runs', 'reconciliation_matches', 'reconciliation_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO outlet_worker
         USING (app.ctx() = ''worker'' AND app.job() = ''finance.reconcile'' AND market_id = app.current_market_id())
         WITH CHECK (app.ctx() = ''worker'' AND app.job() = ''finance.reconcile'' AND market_id = app.current_market_id())',
      t || '__worker_finance_reconcile', t);
  END LOOP;
END
$do$;

-- Cross-module reads and the outbox, one named policy per job (ADR-0011 naming).
CREATE POLICY seller_orders__worker_finance_payouts ON seller_orders FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.payouts' AND market_id = app.current_market_id());
CREATE POLICY seller_orders__worker_finance_reconcile ON seller_orders FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.reconcile' AND market_id = app.current_market_id());
CREATE POLICY payment_intents__worker_finance_reconcile ON payment_intents FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.reconcile' AND market_id = app.current_market_id());
CREATE POLICY payouts__worker_finance_reconcile ON payouts FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'finance.reconcile' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_finance_payouts ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'finance.payouts' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_finance_reconcile ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'finance.reconcile' AND market_id = app.current_market_id());

-- ---------------------------------------------------------------- grants
REVOKE ALL ON payout_batches, payout_holds, psp_settlement_files, psp_settlement_lines, cod_remittances, cod_remittance_lines,
              reconciliation_runs, reconciliation_matches, reconciliation_exceptions FROM outlet_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON payouts, payout_accruals, payout_lines FROM outlet_app;   -- sellers read; only the worker writes
GRANT SELECT ON payouts, payout_accruals, payout_lines TO outlet_app;

GRANT SELECT, INSERT ON payout_batches, payout_lines, psp_settlement_files, cod_remittances, reconciliation_matches TO outlet_worker;
GRANT UPDATE (status, payout_count, total_net_minor, completed_at) ON payout_batches TO outlet_worker;
GRANT SELECT, INSERT ON payouts, payout_accruals TO outlet_worker;
GRANT UPDATE (status, approval_request_id, approved_by, approved_at, hold_reason, provider, provider_ref, sent_entry_id, settled_entry_id,
              failure_code, sent_at, settled_at, send_attempt, version, updated_at) ON payouts TO outlet_worker;
GRANT UPDATE (amount_minor, status, closed_at, eligible_at, payout_id, move_entry_id, updated_at) ON payout_accruals TO outlet_worker;
GRANT SELECT, INSERT ON payout_holds TO outlet_worker;
GRANT UPDATE (released_at) ON payout_holds TO outlet_worker;
GRANT UPDATE (status) ON psp_settlement_files TO outlet_worker;
GRANT SELECT, INSERT ON psp_settlement_lines, cod_remittance_lines, reconciliation_runs, reconciliation_exceptions TO outlet_worker;
GRANT UPDATE (status, intent_id, matched_entry_id, detail) ON psp_settlement_lines TO outlet_worker;
GRANT UPDATE (status, matched_entry_id) ON cod_remittances TO outlet_worker;
GRANT UPDATE (status, seller_order_id, detail) ON cod_remittance_lines TO outlet_worker;
GRANT UPDATE (status, matched_count, unmatched_count, started_at, finished_at) ON reconciliation_runs TO outlet_worker;
GRANT UPDATE (status, last_seen_at, escalated_at, resolved_at, ticket_ref, expected_minor, actual_minor, entry_id) ON reconciliation_exceptions TO outlet_worker;
