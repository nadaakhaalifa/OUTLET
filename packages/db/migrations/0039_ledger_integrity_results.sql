-- migration: 0039_ledger_integrity_results
-- phase: expand (one nullable column, one grant, one SELECT policy)
-- Source: docs/adr/0015-admin-dashboard-aggregates.md, docs/plan/admin-dashboard-port.md (tile `ledger_integrity`).
-- The ledger integrity job (payouts IntegrityJob, worker job `finance.reconcile`, already granted on postings, journal_entries, reconciliation_runs and
-- reconciliation_exceptions by 0016/0018) now stores its full result on the run row: `details` jsonb = per-currency totals, chain head and verdict, the
-- signed-snapshot digest (sha256 over market, day, totals, chain head) and the per-check results. Mismatch items go to reconciliation_exceptions.
-- The dashboard tile never scans the ledger: job `admin.dashboard` gets a SELECT-only policy limited to source = 'ledger_integrity' rows of its market.
ALTER TABLE reconciliation_runs ADD COLUMN details jsonb;
GRANT UPDATE (details) ON reconciliation_runs TO outlet_worker;

CREATE POLICY reconciliation_runs__worker_admin_dashboard ON reconciliation_runs FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'admin.dashboard' AND market_id = app.current_market_id() AND source = 'ledger_integrity');
