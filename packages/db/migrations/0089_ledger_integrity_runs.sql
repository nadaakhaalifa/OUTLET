-- migration: 0089_ledger_integrity_runs
-- phase: expand
--
-- Result store for the ledger integrity job (ADR-0046, docs/specs/dashboard-foundations.md section 3).
-- One immutable row per attempt start and one per outcome (completed, error, timeout); the capped
-- store-credit drift sample lives in a child table so it can follow its own retention (25 months,
-- user ids are P2) while run rows stay immutable (7 years, no user ids).
--
-- Tamper evidence has limits: the forbid_mutation triggers and the hash-chained audit_log row written
-- in the same transaction as each completed run are evidence only against roles that cannot disable
-- triggers or rewrite the chain. A database superuser can do both; the signed snapshot (ADR-0046) is
-- not built and is a launch blocker.
--
-- Expand-safe: new tables and one new function, no change to existing objects.

CREATE TABLE ledger_integrity_runs (
  id               uuid PRIMARY KEY,
  run_kind         text NOT NULL CHECK (run_kind IN ('nightly', 'intraday', 'manual')),
  outcome          text NOT NULL CHECK (outcome IN ('started', 'completed', 'error', 'timeout')),
  attempt_id       uuid NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  ok               boolean,
  trial_ok         boolean,
  trial_offenders  jsonb,
  chain_ok         boolean,
  chain_length     bigint,
  chain_head_hash  text CHECK (chain_head_hash IS NULL OR chain_head_hash ~ '^[0-9a-f]{64}$'),
  chain_failure    jsonb,
  drift_count      integer CHECK (drift_count IS NULL OR drift_count >= 0),
  negative_count   integer CHECK (negative_count IS NULL OR negative_count >= 0),
  sample_truncated boolean,
  error_code       text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  report_sha256    text CHECK (report_sha256 IS NULL OR report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT lir_completed_chk CHECK (
    outcome <> 'completed'
    OR (ok IS NOT NULL AND trial_ok IS NOT NULL AND chain_ok IS NOT NULL AND report_sha256 IS NOT NULL)
  )
);

CREATE INDEX lir_completed_idx ON ledger_integrity_runs (started_at DESC, id DESC) WHERE outcome = 'completed';
CREATE INDEX lir_started_idx   ON ledger_integrity_runs (started_at DESC, id DESC);
CREATE INDEX lir_attempt_idx   ON ledger_integrity_runs (attempt_id);

CREATE TRIGGER lir_immutable_trg
  BEFORE UPDATE OR DELETE ON ledger_integrity_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER lir_no_truncate_trg
  BEFORE TRUNCATE ON ledger_integrity_runs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ledger_integrity_drift_samples (
  run_id              uuid NOT NULL REFERENCES ledger_integrity_runs (id),
  ord                 smallint NOT NULL CHECK (ord BETWEEN 1 AND 50),
  user_id             uuid NOT NULL,
  sub                 text NOT NULL CHECK (char_length(sub) <= 32),
  projected_minor     bigint NOT NULL,
  from_postings_minor bigint NOT NULL,
  difference_minor    bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ord)
);

CREATE INDEX lids_created_idx ON ledger_integrity_drift_samples (created_at);

-- Rows are never updated; the retention job may DELETE them (system role only).
CREATE TRIGGER lids_no_update_trg
  BEFORE UPDATE ON ledger_integrity_drift_samples
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS with concrete roles (finding F1: 'admin' is not a valid app.role), mirroring ledger_entry_chain (0031).
ALTER TABLE ledger_integrity_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ledger_integrity_runs FROM PUBLIC;
GRANT SELECT, INSERT ON ledger_integrity_runs TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_integrity_runs FROM app_user;
CREATE POLICY ledger_integrity_runs_select ON ledger_integrity_runs FOR SELECT
  USING (app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY ledger_integrity_runs_insert ON ledger_integrity_runs FOR INSERT
  WITH CHECK (app_role() = 'system');

ALTER TABLE ledger_integrity_drift_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ledger_integrity_drift_samples FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON ledger_integrity_drift_samples TO app_user;
REVOKE UPDATE, TRUNCATE ON ledger_integrity_drift_samples FROM app_user;
CREATE POLICY ledger_integrity_drift_samples_select ON ledger_integrity_drift_samples FOR SELECT
  USING (app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY ledger_integrity_drift_samples_insert ON ledger_integrity_drift_samples FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY ledger_integrity_drift_samples_delete ON ledger_integrity_drift_samples FOR DELETE
  USING (app_role() = 'system');

-- audit_log is readable only by dpo, security and super_admin (0007), so the finance read path and the
-- metrics exporter cannot join it directly. This definer function answers one question only: which of
-- these runs have a matching audit row (same run id AND same report hash)? It returns ids, never audit
-- content, and nothing for roles outside the ledger readers.
CREATE FUNCTION ledger_integrity_audit_evidence(p_run_ids uuid[]) RETURNS TABLE (run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  SELECT r.id
  FROM ledger_integrity_runs r
  WHERE r.id = ANY (p_run_ids)
    AND r.outcome = 'completed'
    AND app_role() IN ('finance', 'super_admin', 'system')
    AND EXISTS (
      SELECT 1 FROM audit_log a
      WHERE a.target_type = 'ledger_integrity_run'
        AND a.target_id = r.id
        AND a.action = 'ledger.integrity.run'
        AND a.diff_redacted ->> 'run_id' = r.id::text
        AND a.diff_redacted ->> 'report_sha256' = r.report_sha256
    )
$$;
REVOKE ALL ON FUNCTION ledger_integrity_audit_evidence(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_integrity_audit_evidence(uuid[]) TO app_user;
