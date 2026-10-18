-- migration: 0088_analytics_rollups
-- phase: expand
--
-- Dashboard foundations, track 6 (docs/specs/dashboard-foundations.md section 6, ADR-0045):
-- hourly rollups by Africa/Cairo hour for seller analytics and platform metrics.
--
--   * Outbox consumers add additive deltas inside the inbox transaction (advisory lock per key, sorted).
--   * The reconciliation job repairs drift by version compare-and-set (existing keys) and by advisory lock
--     plus recompute (new keys). rollup_key_hash() is the single lock-key function for both.
--   * Rows are monthly range partitions on hour_utc plus a DEFAULT partition (M2). The migration creates
--     the current month and the next five; analytics_rollup_maintain_partitions() keeps at least three
--     months ahead, moves rows out of DEFAULT and drops partitions older than the retention.
--
-- PRIVACY: rollups hold no shopper key (P1 aggregates). Distinct-shopper and k-gated metrics never read them.
-- Money is BIGINT piastres. RLS uses concrete roles: seller by store; platform tables ops, finance, system.
-- Writes are system only. No contract step: rollback is drop-only.

CREATE FUNCTION rollup_key_hash(p_store uuid, p_metric text, p_hour timestamptz) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hashtextextended(
    coalesce(p_store::text, 'platform') || '|' || p_metric || '|' || floor(extract(epoch FROM p_hour))::bigint::text, 0)
$$;

CREATE TABLE seller_analytics_hourly (
  store_id        uuid NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('gmv_minor', 'commission_minor', 'orders', 'units', 'store_views', 'product_views',
                    'impressions', 'saves', 'bags', 'checkouts', 'purchases', 'returned_units')),
  hour_utc        timestamptz NOT NULL CHECK (hour_utc = date_trunc('hour', hour_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  cairo_date      date NOT NULL,
  cairo_hour      smallint NOT NULL CHECK (cairo_hour BETWEEN 0 AND 23),
  utc_offset_min  smallint NOT NULL CHECK (utc_offset_min IN (120, 180)),
  value           bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  held_value      bigint NOT NULL DEFAULT 0 CHECK (held_value >= 0),
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, metric, hour_utc)
) PARTITION BY RANGE (hour_utc);
CREATE TABLE seller_analytics_hourly_default PARTITION OF seller_analytics_hourly DEFAULT;
CREATE INDEX sah_store_metric_date_idx ON seller_analytics_hourly (store_id, metric, cairo_date);

CREATE TABLE platform_metrics_hourly (
  metric          text NOT NULL CHECK (metric IN ('orders_placed', 'seller_orders_placed', 'orders_purchased', 'units_purchased', 'gmv_purchased_minor')),
  hour_utc        timestamptz NOT NULL CHECK (hour_utc = date_trunc('hour', hour_utc AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  cairo_date      date NOT NULL,
  cairo_hour      smallint NOT NULL CHECK (cairo_hour BETWEEN 0 AND 23),
  utc_offset_min  smallint NOT NULL CHECK (utc_offset_min IN (120, 180)),
  value           bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, hour_utc)
) PARTITION BY RANGE (hour_utc);
CREATE TABLE platform_metrics_hourly_default PARTITION OF platform_metrics_hourly DEFAULT;
CREATE INDEX pmh_metric_date_idx ON platform_metrics_hourly (metric, cairo_date);

CREATE TABLE analytics_rollup_watermarks (
  consumer        text PRIMARY KEY CHECK (char_length(consumer) BETWEEN 1 AND 64),
  applied_through timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_rollup_reconciliations (
  id                 uuid PRIMARY KEY,
  scope              text NOT NULL CHECK (scope IN ('seller', 'platform')),
  window_from        timestamptz NOT NULL,
  window_to          timestamptz NOT NULL CHECK (window_to > window_from),
  checked_rows       integer NOT NULL CHECK (checked_rows >= 0),
  mismatches         integer NOT NULL CHECK (mismatches >= 0),
  corrected          integer NOT NULL CHECK (corrected >= 0),
  skipped_concurrent integer NOT NULL DEFAULT 0 CHECK (skipped_concurrent >= 0),
  outcome            text NOT NULL CHECK (outcome IN ('ok', 'corrected', 'error')),
  ran_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arr_ran_at_idx ON analytics_rollup_reconciliations (ran_at);

-- Partitions: the current month and the next five (M2), created here so the first deploy never writes to DEFAULT.
DO $$
DECLARE
  v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_from  date;
BEGIN
  FOR i IN 0..5 LOOP
    v_from := (v_month + make_interval(months => i))::date;
    EXECUTE format('CREATE TABLE seller_analytics_hourly_p%s PARTITION OF seller_analytics_hourly FOR VALUES FROM (%L) TO (%L)',
      to_char(v_from, 'YYYYMM'), v_from::timestamp AT TIME ZONE 'UTC', (v_from + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    EXECUTE format('CREATE TABLE platform_metrics_hourly_p%s PARTITION OF platform_metrics_hourly FOR VALUES FROM (%L) TO (%L)',
      to_char(v_from, 'YYYYMM'), v_from::timestamp AT TIME ZONE 'UTC', (v_from + interval '1 month')::timestamp AT TIME ZONE 'UTC');
  END LOOP;
END
$$;

-- Partition job (worker `analytics.maintain-rollup-partitions`). SECURITY DEFINER so the runtime role keeps
-- SELECT, INSERT and UPDATE only (the same pattern as creators_maintain_click_partitions, migration 0078).
--   * creates missing months from the current one through p_ahead months ahead, for both tables;
--   * when a month is created while the DEFAULT partition holds rows for it, moves them in the same transaction
--     (detach DEFAULT, create the month, move rows, re-attach DEFAULT);
--   * drops whole monthly partitions that end at or before now - p_retain_months;
--   * deletes reconciliation rows older than 2 years.
CREATE FUNCTION analytics_rollup_maintain_partitions(p_now timestamptz, p_ahead integer, p_retain_months integer)
RETURNS TABLE (created integer, moved_rows bigint, dropped integer, default_rows_after bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month  date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
  v_cutoff timestamptz := (date_trunc('month', p_now AT TIME ZONE 'UTC') - make_interval(months => p_retain_months)) AT TIME ZONE 'UTC';
  v_parent text;
  v_from   date;
  v_name   text;
  v_lo     timestamptz;
  v_hi     timestamptz;
  v_n      bigint;
  r        record;
BEGIN
  IF p_ahead < 3 OR p_ahead > 12 OR p_retain_months < 3 OR p_retain_months > 120 THEN
    RAISE EXCEPTION 'invalid partition maintenance arguments';
  END IF;
  created := 0; moved_rows := 0; dropped := 0;
  FOREACH v_parent IN ARRAY ARRAY['seller_analytics_hourly', 'platform_metrics_hourly'] LOOP
    FOR i IN 0..p_ahead LOOP
      v_from := (v_month + make_interval(months => i))::date;
      v_name := format('%s_p%s', v_parent, to_char(v_from, 'YYYYMM'));
      v_lo := v_from::timestamp AT TIME ZONE 'UTC';
      v_hi := (v_from + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN CONTINUE; END IF;
      EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', v_parent, v_parent || '_default');
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', v_name, v_parent, v_lo, v_hi);
      EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE hour_utc >= %L AND hour_utc < %L', v_name, v_parent || '_default', v_lo, v_hi);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      EXECUTE format('DELETE FROM %I WHERE hour_utc >= %L AND hour_utc < %L', v_parent || '_default', v_lo, v_hi);
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I DEFAULT', v_parent, v_parent || '_default');
      created := created + 1;
      moved_rows := moved_rows + v_n;
    END LOOP;
    FOR r IN
      SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = v_parent AND c.relname ~ '_p[0-9]{6}$'
    LOOP
      IF (regexp_match(r.bound, 'TO \(''([^'']+)''\)'))[1]::timestamptz <= v_cutoff THEN
        EXECUTE format('DROP TABLE %I', r.name);
        dropped := dropped + 1;
      END IF;
    END LOOP;
  END LOOP;
  DELETE FROM analytics_rollup_reconciliations WHERE ran_at < p_now - interval '2 years';
  default_rows_after := (SELECT count(*) FROM seller_analytics_hourly_default) + (SELECT count(*) FROM platform_metrics_hourly_default);
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION analytics_rollup_maintain_partitions(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_rollup_maintain_partitions(timestamptz, integer, integer) TO app_user;

-- Gauge source for outlet.analytics.rollup_default_partition_rows{table} (M2): rows that fell into a DEFAULT
-- partition mean the partition job is behind.
CREATE FUNCTION analytics_rollup_default_partition_rows() RETURNS TABLE (table_name text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'seller_analytics_hourly'::text, count(*) FROM seller_analytics_hourly_default
  UNION ALL
  SELECT 'platform_metrics_hourly'::text, count(*) FROM platform_metrics_hourly_default
$$;
REVOKE ALL ON FUNCTION analytics_rollup_default_partition_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_rollup_default_partition_rows() TO app_user;

-- RLS (concrete roles; 'admin' is not a valid app.role) -------------------------------------------
ALTER TABLE seller_analytics_hourly ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON seller_analytics_hourly TO app_user;
CREATE POLICY sah_select ON seller_analytics_hourly FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY sah_insert ON seller_analytics_hourly FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY sah_update ON seller_analytics_hourly FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE platform_metrics_hourly ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON platform_metrics_hourly TO app_user;
CREATE POLICY pmh_select ON platform_metrics_hourly FOR SELECT
  USING (app_role() IN ('ops', 'finance', 'system'));
CREATE POLICY pmh_insert ON platform_metrics_hourly FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY pmh_update ON platform_metrics_hourly FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE analytics_rollup_watermarks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON analytics_rollup_watermarks TO app_user;
CREATE POLICY arw_select ON analytics_rollup_watermarks FOR SELECT
  USING (app_role() IN ('ops', 'finance', 'security', 'system'));
CREATE POLICY arw_insert ON analytics_rollup_watermarks FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY arw_update ON analytics_rollup_watermarks FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE analytics_rollup_reconciliations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON analytics_rollup_reconciliations TO app_user;
CREATE POLICY arr_select ON analytics_rollup_reconciliations FOR SELECT
  USING (app_role() IN ('ops', 'finance', 'security', 'system'));
CREATE POLICY arr_insert ON analytics_rollup_reconciliations FOR INSERT WITH CHECK (app_role() = 'system');
