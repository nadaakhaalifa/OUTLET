-- migration: 0041_integrity_exception_reopen
-- phase: expand (one column grant)
-- The ledger integrity job (worker job `finance.reconcile`) reopens a RESOLVED exception that recurs and points it at the latest run:
-- ON CONFLICT ... DO UPDATE SET status, run_id. status and resolved_at were already granted (0018); run_id was not.
GRANT UPDATE (run_id) ON reconciliation_exceptions TO outlet_worker;
