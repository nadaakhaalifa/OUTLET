-- migration: 0098_payouts_status_updated_idx
-- phase: expand
--
-- Supports the finance payout summary (GET /v1/admin/finance/payouts/summary): grouping by status with the
-- 30 day window on updated_at for SETTLED and CANCELLED. Index only: no columns, no data change, no PII,
-- so data_inventory.yaml is unchanged.
-- Rollback: DROP INDEX payouts_status_updated_idx.

CREATE INDEX IF NOT EXISTS payouts_status_updated_idx ON payouts (status, updated_at);
