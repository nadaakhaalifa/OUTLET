-- migration: 0064_demand_forecasting
-- phase: expand
--
-- Demand forecasting baseline (docs/specs/phase-3/demand-forecasting.md, master prompt 20.8 and 19.1).
-- Two tables: the daily demand series the batch learns from, and the served forecasts.
--
-- PRIVACY / SAFETY
--   * No shopper identity, measurement or budget column exists. `shoppers` is a per-day DISTINCT
--     count used only for the k-anonymity >= 50 release gate on geographic cells; it is never summed.
--   * A forecast row that is not `ok` cannot carry a number (CHECK), and an `ok` row always carries an
--     ordered integer interval (CHECK). The API therefore cannot serve a bare point estimate or a
--     number for an insufficient or suppressed cell.
--   * Store ids are LOGICAL references (stores belong to another module). Units are integers.
--   * RLS follows 0028: a seller reads only its own store rows, only the `system` role writes.

CREATE TABLE forecast_demand_series (
  store_id       uuid NOT NULL,
  sku_id         uuid NOT NULL,
  category_code  text NOT NULL CHECK (category_code ~ '^[a-z0-9_.-]{1,32}$'),
  size_label     text NOT NULL CHECK (char_length(size_label) BETWEEN 1 AND 16 AND size_label !~ '[|]'),
  governorate    text NOT NULL DEFAULT 'unknown'
                   CHECK (char_length(governorate) BETWEEN 2 AND 40 AND governorate !~ '[|]'),
  day            date NOT NULL,
  units_gross    integer NOT NULL CHECK (units_gross BETWEEN 0 AND 100000),
  units_net      integer NOT NULL CHECK (units_net >= 0 AND units_net <= units_gross),
  censored       boolean NOT NULL DEFAULT false,
  flagged        boolean NOT NULL DEFAULT false,
  shoppers       integer NOT NULL DEFAULT 0 CHECK (shoppers >= 0 AND shoppers <= units_gross),
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, sku_id, governorate, day)
);
CREATE INDEX forecast_series_store_day_idx ON forecast_demand_series (store_id, day);

CREATE TABLE demand_forecasts (
  id                 uuid PRIMARY KEY,
  store_id           uuid NOT NULL,
  scope              text NOT NULL CHECK (scope IN ('sku', 'category', 'category_size', 'category_governorate')),
  scope_key          text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 100),
  horizon_days       smallint NOT NULL CHECK (horizon_days IN (7, 14, 28)),
  as_of_date         date NOT NULL,
  model              text CHECK (model IS NULL OR model IN ('seasonal_naive', 'ets_seasonal', 'croston_sba')),
  model_version      text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 40),
  status             text NOT NULL CHECK (status IN ('ok', 'insufficient_history', 'suppressed')),
  p10                integer CHECK (p10 IS NULL OR p10 >= 0),
  p50                integer CHECK (p50 IS NULL OR p50 >= 0),
  p90                integer CHECK (p90 IS NULL OR p90 >= 0),
  reason_codes       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  comparable_units   integer NOT NULL CHECK (comparable_units >= 0),
  observed_days      integer NOT NULL CHECK (observed_days >= 0),
  backtest_origins   integer NOT NULL DEFAULT 0 CHECK (backtest_origins >= 0),
  wape_bps           integer,
  baseline_wape_bps  integer,
  pinball_milli      integer CHECK (pinball_milli IS NULL OR pinball_milli >= 0),
  coverage_bps       integer CHECK (coverage_bps IS NULL OR coverage_bps BETWEEN 0 AND 10000),
  bias_bps           integer,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demand_forecasts_unique UNIQUE (store_id, scope, scope_key, horizon_days, as_of_date),
  CONSTRAINT demand_forecasts_numbers_chk CHECK (
    (status = 'ok' AND model IS NOT NULL AND p10 IS NOT NULL AND p50 IS NOT NULL AND p90 IS NOT NULL
       AND p10 <= p50 AND p50 <= p90 AND backtest_origins >= 1)
    OR
    (status <> 'ok' AND model IS NULL AND p10 IS NULL AND p50 IS NULL AND p90 IS NULL)
  )
);
CREATE INDEX demand_forecasts_store_asof_idx ON demand_forecasts (store_id, as_of_date DESC);

-- RLS ----------------------------------------------------------------------------------
ALTER TABLE forecast_demand_series ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON forecast_demand_series TO app_user;
CREATE POLICY forecast_series_select ON forecast_demand_series FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY forecast_series_insert ON forecast_demand_series FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY forecast_series_update ON forecast_demand_series FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE demand_forecasts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON demand_forecasts TO app_user;
CREATE POLICY demand_forecasts_select ON demand_forecasts FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY demand_forecasts_insert ON demand_forecasts FOR INSERT WITH CHECK (app_role() = 'system');
