-- migration: 0065_forecast_runs
-- phase: expand
--
-- One row per (store, as-of day) batch run: the idempotency key of the nightly forecasting job and
-- the per-run model metrics (spec "Metrics emitted per model": WAPE, pinball loss, interval
-- coverage, bias). A `completed` run is immutable; a `failed` run may be retried and is what marks
-- the previous forecast stale for the seller. Expand only: new table.
--
-- No personal data: counts and aggregate error metrics only. RLS follows 0064.

CREATE TABLE forecast_runs (
  store_id           uuid NOT NULL,
  as_of_date         date NOT NULL,
  status             text NOT NULL CHECK (status IN ('completed', 'failed')),
  series_total       integer NOT NULL DEFAULT 0 CHECK (series_total >= 0),
  ok_count           integer NOT NULL DEFAULT 0 CHECK (ok_count >= 0),
  insufficient_count integer NOT NULL DEFAULT 0 CHECK (insufficient_count >= 0),
  suppressed_count   integer NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
  served_models      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(served_models) = 'object'),
  mean_wape_bps      integer,
  mean_baseline_wape_bps integer,
  mean_pinball_milli integer CHECK (mean_pinball_milli IS NULL OR mean_pinball_milli >= 0),
  mean_coverage_bps  integer CHECK (mean_coverage_bps IS NULL OR mean_coverage_bps BETWEEN 0 AND 10000),
  mean_bias_bps      integer,
  error_code         text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  PRIMARY KEY (store_id, as_of_date),
  CONSTRAINT forecast_runs_counts_chk CHECK (ok_count + insufficient_count + suppressed_count = series_total)
);

ALTER TABLE forecast_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON forecast_runs TO app_user;
CREATE POLICY forecast_runs_select ON forecast_runs FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY forecast_runs_insert ON forecast_runs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY forecast_runs_update ON forecast_runs FOR UPDATE
  USING (app_role() = 'system' AND status = 'failed') WITH CHECK (app_role() = 'system');
