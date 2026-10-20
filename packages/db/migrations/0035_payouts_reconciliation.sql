-- migration: 0035_payouts_reconciliation
-- phase: expand
--
-- Seller payouts (spec T4, 22; docs/specs/payouts.md) and reconciliation (spec T4;
-- docs/specs/reconciliation.md). Expand only: new tables, no existing object is touched.
--
--   * payouts            one per (store, cycle) while not CANCELLED; the amount and the frozen line set
--                        can never change after insert (trigger), terminal states are never left.
--   * payout_lines       the seller orders and clawbacks a payout consumed. A source can be in at most
--                        one ACTIVE payout (partial unique index), so it can never be paid twice.
--                        Clawbacks may be applied in parts and are summed by the application.
--   * payout_attempts    append-only provider call log (idempotent by payout id at the provider).
--   * payout_status_history append-only, unique per (payout, command key) for replay detection.
--   * settlement_files / settlement_file_lines   parsed provider files (FIXTURE FORMAT, VERIFY). The file
--                        checksum is unique, so re-uploading a file is a no-op. Lines are immutable.
--   * recon_runs / recon_tickets   run log and finding tickets, one ticket per dedupe key.
--
-- store_id is a LOGICAL reference (stores is another module). No IBAN, holder name or card data
-- exists in these tables: only an opaque account_token and the last four digits (seller KYC owns
-- the encrypted IBAN). Money is BIGINT piastres, EGP only. Depends on 0001-0007 (users, helpers, RLS).

CREATE TABLE payouts (
  id               uuid PRIMARY KEY,
  store_id         uuid NOT NULL,
  cycle_key        text NOT NULL CHECK (cycle_key ~ '^\d{4}-\d{2}-\d{2}$'),
  cutoff_at        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN
                     ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'SENT', 'SETTLED', 'FAILED', 'CANCELLED')),
  currency         char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  amount           bigint NOT NULL CHECK (amount > 0),
  eligible_total   bigint NOT NULL CHECK (eligible_total > 0),
  netted_total     bigint NOT NULL DEFAULT 0 CHECK (netted_total >= 0),
  carry_forward    bigint NOT NULL DEFAULT 0 CHECK (carry_forward >= 0),
  line_count       integer NOT NULL CHECK (line_count > 0),
  account_token    text CHECK (account_token IS NULL OR char_length(account_token) BETWEEN 1 AND 128),
  iban_last4       char(4) CHECK (iban_last4 IS NULL OR iban_last4 ~ '^[0-9A-Z]{4}$'),
  hold_reason      text CHECK (hold_reason IS NULL OR hold_reason IN
                     ('no_bank_details', 'iban_name_mismatch', 'name_check_unavailable', 'risk_review',
                      'exceeds_ledger_balance', 'open_dispute', 'manual_hold')),
  approval_id      uuid,
  approved_by      uuid REFERENCES users (id),
  approved_at      timestamptz,
  ledger_ref       text CHECK (ledger_ref IS NULL OR char_length(ledger_ref) BETWEEN 1 AND 160),
  provider_ref     text CHECK (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 128),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code     text CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
  sent_at          timestamptz,
  settled_at       timestamptz,
  version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payouts_net_chk CHECK (amount = eligible_total - netted_total),
  CONSTRAINT payouts_hold_chk CHECK (status <> 'ON_HOLD' OR hold_reason IS NOT NULL),
  CONSTRAINT payouts_approved_chk CHECK (status NOT IN ('SENT', 'SETTLED') OR approved_by IS NOT NULL),
  CONSTRAINT payouts_settled_chk CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL))
);

-- Idempotent scheduling: one live payout per store and cycle. A cancelled one can be replaced.
CREATE UNIQUE INDEX payouts_store_cycle_uq ON payouts (store_id, cycle_key) WHERE status <> 'CANCELLED';
CREATE INDEX payouts_store_idx ON payouts (store_id, created_at DESC, id);
CREATE INDEX payouts_status_idx ON payouts (status, created_at, id);

CREATE TRIGGER payouts_touch_updated_at_trg
  BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Defence in depth behind the domain machine and the use cases.
CREATE FUNCTION payouts_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('SETTLED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'payout % is in terminal state %', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'payout version must not decrease' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.store_id, NEW.cycle_key, NEW.cutoff_at, NEW.amount, NEW.eligible_total, NEW.netted_total,
      NEW.carry_forward, NEW.line_count, NEW.currency)
     IS DISTINCT FROM
     (OLD.id, OLD.store_id, OLD.cycle_key, OLD.cutoff_at, OLD.amount, OLD.eligible_total, OLD.netted_total,
      OLD.carry_forward, OLD.line_count, OLD.currency) THEN
    RAISE EXCEPTION 'payout amount, lines and ownership are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payouts_guard_trg
  BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_guard();

CREATE TABLE payout_lines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payouts (id),
  store_id     uuid NOT NULL,
  source_type  text NOT NULL CHECK (source_type IN ('seller_order', 'clawback')),
  source_id    text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 80),
  amount       bigint NOT NULL CHECK (amount > 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_lines_payout_source_uq UNIQUE (payout_id, source_type, source_id)
);
-- A seller order can sit in at most one ACTIVE payout, so it can never be paid twice. A clawback may be
-- applied in parts across payouts (oldest first, partial application), so it is not unique here: the
-- application sums its active lines and the outstanding amount is amount minus that sum.
CREATE UNIQUE INDEX payout_lines_active_order_uq ON payout_lines (source_id)
  WHERE active AND source_type = 'seller_order';
CREATE INDEX payout_lines_payout_idx ON payout_lines (payout_id, id);

CREATE FUNCTION payout_lines_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on payout_lines is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.payout_id, NEW.store_id, NEW.source_type, NEW.source_id, NEW.amount)
     IS DISTINCT FROM (OLD.id, OLD.payout_id, OLD.store_id, OLD.source_type, OLD.source_id, OLD.amount) THEN
    RAISE EXCEPTION 'payout lines are immutable (only active may change)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.active = false AND NEW.active = true THEN
    RAISE EXCEPTION 'a released payout line cannot be re-activated' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payout_lines_guard_trg
  BEFORE UPDATE OR DELETE ON payout_lines FOR EACH ROW EXECUTE FUNCTION payout_lines_guard();

CREATE TABLE payout_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payouts (id),
  attempt_no   integer NOT NULL CHECK (attempt_no >= 1),
  outcome      text NOT NULL CHECK (outcome IN ('accepted', 'settled', 'rejected', 'unavailable')),
  code         text CHECK (code IS NULL OR char_length(code) <= 64),
  provider_ref text CHECK (provider_ref IS NULL OR char_length(provider_ref) <= 128),
  at           timestamptz NOT NULL
);
CREATE INDEX payout_attempts_payout_idx ON payout_attempts (payout_id, id);
CREATE TRIGGER payout_attempts_immutable_trg
  BEFORE UPDATE OR DELETE ON payout_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payout_status_history (
  id           uuid PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payouts (id),
  store_id     uuid NOT NULL,
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  event        text NOT NULL CHECK (event ~ '^[A-Z_]{1,40}$'),
  actor_type   text NOT NULL CHECK (actor_type IN ('SYSTEM', 'FINANCE')),
  actor_id     uuid REFERENCES users (id),
  reason_code  text CHECK (reason_code IS NULL OR char_length(reason_code) <= 64),
  command_key  text NOT NULL CHECK (char_length(command_key) BETWEEN 1 AND 160),
  occurred_at  timestamptz NOT NULL,
  CONSTRAINT payout_status_history_command_uq UNIQUE (payout_id, command_key)
);
CREATE INDEX payout_status_history_payout_idx ON payout_status_history (payout_id, occurred_at, id);
CREATE TRIGGER payout_status_history_immutable_trg
  BEFORE UPDATE OR DELETE ON payout_status_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reconciliation ------------------------------------------------------------------------------

CREATE TABLE settlement_files (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('psp', 'cod', 'bnpl')),
  provider       text NOT NULL CHECK (provider ~ '^[a-z0-9_.-]{1,40}$'),
  settlement_id  text CHECK (settlement_id IS NULL OR char_length(settlement_id) BETWEEN 1 AND 64),
  checksum       char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status         text NOT NULL CHECK (status IN ('parsed', 'rejected')),
  line_count     integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  gross_total    bigint,
  fee_total      bigint,
  net_total      bigint,
  error_codes    text[] NOT NULL DEFAULT '{}',
  received_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_files_checksum_uq UNIQUE (checksum),
  CONSTRAINT settlement_files_parsed_chk CHECK (
    (status = 'parsed') = (settlement_id IS NOT NULL AND gross_total IS NOT NULL AND fee_total IS NOT NULL AND net_total IS NOT NULL)),
  CONSTRAINT settlement_files_totals_chk CHECK (status <> 'parsed' OR gross_total - fee_total = net_total)
);
-- The same settlement id can only be parsed once per provider (a changed re-upload is a conflict for humans).
CREATE UNIQUE INDEX settlement_files_settlement_uq ON settlement_files (kind, provider, settlement_id) WHERE status = 'parsed';
CREATE INDEX settlement_files_received_idx ON settlement_files (received_at DESC, id);
CREATE TRIGGER settlement_files_immutable_trg
  BEFORE UPDATE OR DELETE ON settlement_files FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE settlement_file_lines (
  file_id       uuid NOT NULL REFERENCES settlement_files (id),
  line_no       integer NOT NULL CHECK (line_no >= 1),
  kind          text NOT NULL CHECK (kind IN ('capture', 'refund', 'chargeback', 'remittance', 'adjustment')),
  provider_ref  text NOT NULL CHECK (provider_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  gross         bigint NOT NULL,
  fee           bigint NOT NULL CHECK (fee >= 0),
  net           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL,
  PRIMARY KEY (file_id, line_no),
  CONSTRAINT settlement_file_lines_arith_chk CHECK (gross - fee = net)
);
CREATE INDEX settlement_file_lines_ref_idx ON settlement_file_lines (provider_ref);
CREATE TRIGGER settlement_file_lines_immutable_trg
  BEFORE UPDATE OR DELETE ON settlement_file_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE recon_runs (
  id            uuid PRIMARY KEY,
  mode          text NOT NULL CHECK (mode IN ('nightly', 'intraday')),
  nightly_key   text CHECK (nightly_key IS NULL OR nightly_key ~ '^\d{4}-\d{2}-\d{2}$'),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  window_from   timestamptz NOT NULL,
  window_to     timestamptz NOT NULL,
  finding_count integer NOT NULL CHECK (finding_count >= 0),
  opened        integer NOT NULL CHECK (opened >= 0),
  escalated     integer NOT NULL CHECK (escalated >= 0),
  resolved      integer NOT NULL CHECK (resolved >= 0),
  ok            boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recon_runs_window_chk CHECK (window_to >= window_from AND finished_at >= started_at)
);
-- One nightly run per Cairo date, so a double tick cannot run twice.
CREATE UNIQUE INDEX recon_runs_nightly_uq ON recon_runs (nightly_key) WHERE mode = 'nightly';
CREATE INDEX recon_runs_started_idx ON recon_runs (started_at DESC, id);
CREATE TRIGGER recon_runs_immutable_trg
  BEFORE UPDATE OR DELETE ON recon_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE recon_tickets (
  id             uuid PRIMARY KEY,
  dedupe_key     text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 400),
  source         text NOT NULL CHECK (source IN
                   ('psp_settlement', 'cod_remittance', 'bnpl_settlement', 'eta_submission', 'store_credit',
                    'trial_balance', 'run')),
  kind           text NOT NULL CHECK (kind ~ '^[a-z_]{1,48}$'),
  severity       text NOT NULL CHECK (severity IN ('critical', 'high', 'medium')),
  ref            text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 160),
  detail         text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 200),
  amount_delta   bigint NOT NULL,
  item_at        timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN ('open', 'escalated', 'resolved')),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  escalated_at   timestamptz,
  resolved_at    timestamptz,
  last_run_id    uuid REFERENCES recon_runs (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recon_tickets_dedupe_uq UNIQUE (dedupe_key),
  CONSTRAINT recon_tickets_escalated_chk CHECK (status <> 'escalated' OR escalated_at IS NOT NULL),
  CONSTRAINT recon_tickets_resolved_chk CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX recon_tickets_status_idx ON recon_tickets (status, severity, item_at, id);
CREATE INDEX recon_tickets_source_idx ON recon_tickets (source, status);
CREATE TRIGGER recon_tickets_touch_updated_at_trg
  BEFORE UPDATE ON recon_tickets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS: sellers read their own payouts only (the central policy then checks the staff role);
-- reconciliation data is staff only. Writes are the module adapter under app.role = 'system'. ----

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payouts TO app_user;
CREATE POLICY payouts_select ON payouts FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY payouts_insert ON payouts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY payouts_update ON payouts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE payout_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payout_lines TO app_user;
CREATE POLICY payout_lines_select ON payout_lines FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY payout_lines_insert ON payout_lines FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY payout_lines_update ON payout_lines FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE payout_attempts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON payout_attempts TO app_user;
CREATE POLICY payout_attempts_select ON payout_attempts FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY payout_attempts_insert ON payout_attempts FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE payout_status_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON payout_status_history TO app_user;
CREATE POLICY payout_status_history_select ON payout_status_history FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY payout_status_history_insert ON payout_status_history FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE settlement_files ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON settlement_files TO app_user;
CREATE POLICY settlement_files_select ON settlement_files FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY settlement_files_insert ON settlement_files FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE settlement_file_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON settlement_file_lines TO app_user;
CREATE POLICY settlement_file_lines_select ON settlement_file_lines FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY settlement_file_lines_insert ON settlement_file_lines FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE recon_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON recon_runs TO app_user;
CREATE POLICY recon_runs_select ON recon_runs FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY recon_runs_insert ON recon_runs FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE recon_tickets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON recon_tickets TO app_user;
CREATE POLICY recon_tickets_select ON recon_tickets FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY recon_tickets_insert ON recon_tickets FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY recon_tickets_update ON recon_tickets FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
