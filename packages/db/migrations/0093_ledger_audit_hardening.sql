-- migration: 0093_ledger_audit_hardening
-- phase: expand
--
-- Follow-up to chief-reviewer findings on 0005/0007 (audit chain) and 0089 (ledger integrity runs).
--
--   audit_log
--     * INSERT policy tightened from "any identity" to app_role() = 'system'. Every application writer
--       (admin:, authz:, seller-analytics:, ledger-integrity: chains) already sets app.role = 'system' in
--       the writing transaction; a shopper or seller session can no longer append audit rows.
--     * audit_log_verify(NULL) (all chains, unbounded scan) is callable by system only; a named chain only
--       by dpo, security, super_admin or system. Any other caller gets an error, never an empty result,
--       because an empty result means "chain verifies".
--
--   ledger_integrity_runs / ledger_integrity_drift_samples
--     * lir_attempt_final_uq: at most one final (non-started) row per attempt, so a retry after an
--       ambiguous commit cannot produce a second completed row or a second audit row.
--     * lir_completed_chk now also requires finished_at for every final outcome.
--     * Drift samples no longer persist the raw user id: user_id is replaced by account_id, the ledger
--       account (ledger_accounts.id) the drift belongs to, NULL when the projection row has no ledger
--       account. The table is new (0089), written only by the system job and holds no production data
--       (nothing runs against real data yet), so dropping the column loses nothing.
--
-- Rollback: restore the 0007 policy and the 0005 function body; drop the index; re-add user_id.

-- ---------------------------------------------------------------- audit_log
-- lint-allow: drop-constraint-or-index the policy is recreated in the next statement with a strictly narrower WITH CHECK
DROP POLICY audit_log_append ON audit_log;
CREATE POLICY audit_log_append ON audit_log FOR INSERT
  WITH CHECK (app_role() = 'system');

CREATE OR REPLACE FUNCTION audit_log_verify(p_chain_id text DEFAULT NULL)
RETURNS TABLE (chain_id text, seq bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF p_chain_id IS NULL THEN
    IF app_role() IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'audit_log_verify(NULL) is restricted to the system role' USING ERRCODE = '42501';
    END IF;
  ELSIF app_role() IS NULL OR app_role() NOT IN ('dpo', 'security', 'super_admin', 'system') THEN
    RAISE EXCEPTION 'audit_log_verify is restricted to dpo, security, super_admin and system' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH rows AS (
    SELECT a.*,
           lag(a.seq) OVER w AS prev_seq,
           lag(a.hash) OVER w AS prev_row_hash
    FROM audit_log a
    WHERE p_chain_id IS NULL OR a.chain_id = p_chain_id
    WINDOW w AS (PARTITION BY a.chain_id ORDER BY a.seq)
  ),
  row_problems AS (
    SELECT r.chain_id, r.seq,
      CASE
        WHEN r.prev_seq IS NULL AND r.seq <> 1 THEN 'chain does not start at seq 1 (rows removed from the head)'
        WHEN r.prev_seq IS NOT NULL AND r.seq <> r.prev_seq + 1 THEN 'gap in seq (rows removed)'
        WHEN r.prev_seq IS NULL AND r.prev_hash <> decode(repeat('00', 32), 'hex') THEN 'bad genesis prev_hash'
        WHEN r.prev_seq IS NOT NULL AND r.prev_hash <> r.prev_row_hash THEN 'prev_hash does not match previous row hash'
        WHEN r.hash <> sha256(r.prev_hash || audit_log_canonical(
              r.chain_id, r.seq, r.occurred_at, r.actor_type, r.actor_id, r.action, r.target_type,
              r.target_id, r.diff_redacted, r.ip_hash, r.device_id, r.request_id, r.reason_code))
          THEN 'row content does not match its hash (row modified)'
      END AS problem
    FROM rows r
  ),
  checkpoint_problems AS (
    SELECT c.chain_id, c.last_seq AS seq,
      CASE
        WHEN a.hash IS NULL THEN 'checkpoint refers to a row that no longer exists (tail truncated)'
        WHEN a.hash <> c.last_hash THEN 'row hash differs from checkpoint'
      END AS problem
    FROM audit_chain_checkpoints c
    LEFT JOIN audit_log a ON a.chain_id = c.chain_id AND a.seq = c.last_seq
    WHERE p_chain_id IS NULL OR c.chain_id = p_chain_id
  )
  SELECT p.chain_id, p.seq, p.problem FROM row_problems p WHERE p.problem IS NOT NULL
  UNION ALL
  SELECT p.chain_id, p.seq, p.problem FROM checkpoint_problems p WHERE p.problem IS NOT NULL
  ORDER BY 1, 2;
END
$$;
REVOKE ALL ON FUNCTION audit_log_verify(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_verify(text) TO app_user;

-- ------------------------------------------------------ ledger_integrity_runs
CREATE UNIQUE INDEX lir_attempt_final_uq ON ledger_integrity_runs (attempt_id) WHERE outcome <> 'started';

-- lint-allow: drop-constraint-or-index replaced in the same migration by a stricter CHECK of the same name
ALTER TABLE ledger_integrity_runs DROP CONSTRAINT lir_completed_chk;
ALTER TABLE ledger_integrity_runs ADD CONSTRAINT lir_completed_chk CHECK (
  (outcome = 'started' OR finished_at IS NOT NULL)
  AND (outcome <> 'completed'
       OR (ok IS NOT NULL AND trial_ok IS NOT NULL AND chain_ok IS NOT NULL AND report_sha256 IS NOT NULL))
) NOT VALID;
ALTER TABLE ledger_integrity_runs VALIDATE CONSTRAINT lir_completed_chk;

-- lint-allow: drop-column new table, system-written, no production data; the raw user id must not persist (P2)
ALTER TABLE ledger_integrity_drift_samples DROP COLUMN user_id;
ALTER TABLE ledger_integrity_drift_samples ADD COLUMN account_id uuid;
