-- migration: 0012_price_events
-- phase: expand (new tables only)
-- Source: docs/specs/price-watch.md section 6, master prompt section 9.2/9.3, docs/data-model.md price_events (line ~2897), ADR-0006 (market_id).
-- Scope P1-03a: internal price evidence only (external channels / crawler are P1-03b+ and reuse these tables via `source`).
--
-- Deviations from the ERD (reported):
--   * price_events is public P0 price data. It carries store_ref (a pointer, not a tenant key: the RLS audit, ADR-0011, only
--     matches `store_id` / `user_id`) and has NO tenant RLS. Writes go through the pricing-integrity service only: outlet_app and
--     outlet_worker are the service's own roles, so the safeguard is the trigger below plus column-level grants, not a role split.
--   * actor_type / actor_id from the ERD are kept (actor_id is a seller user id: P2, never returned by the public evidence endpoint).
--     compare_at_minor and external_product_id are not created yet (P1-03b); store_id is named store_ref.
--   * source_event_id (the outbox event id) is UNIQUE: a second idempotency belt under the inbox row.
--   * Monthly RANGE partitioning (ERD) is deferred like the outbox/inbox: a partitioned PK must include valid_from and would
--     block the single-open-row unique index. Expand migration later.
--   * sku_price_windows is a maintained table, not a MATERIALIZED VIEW: a matview refreshes all rows; the read path (4M users,
--     shelf and PDP) needs one targeted row update per price event, in the same transaction as the event.

CREATE TABLE price_events (
  id              uuid PRIMARY KEY,
  sku_id          uuid NOT NULL,
  store_ref       uuid,
  market_id       text NOT NULL CHECK (length(market_id) > 0),
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor     bigint NOT NULL CHECK (price_minor > 0),
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  source          text NOT NULL CHECK (source IN ('internal', 'seller_api', 'crawler', 'document')),
  actor_type      text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('seller_user', 'channel_sync', 'system', 'admin')),
  actor_id        uuid,
  evidence_ref    text,
  source_event_id uuid UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX price_events_sku_from_idx ON price_events (sku_id, valid_from DESC);
-- At most one open row per sku, market and source; also the lookup for "close the open row".
CREATE UNIQUE INDEX price_events_open_idx ON price_events (sku_id, market_id, source) WHERE valid_to IS NULL;

-- Append-only: the only legal UPDATE closes the open row by setting valid_to; nothing else changes.
CREATE FUNCTION price_events_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.valid_to IS NULL
       AND NEW.valid_to IS NOT NULL
       AND (to_jsonb(NEW) - 'valid_to') = (to_jsonb(OLD) - 'valid_to') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'price_events is append-only: only valid_to of the open row may be set' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'price_events is append-only: % is not allowed', TG_OP USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER price_events_no_update BEFORE UPDATE ON price_events
  FOR EACH ROW EXECUTE FUNCTION price_events_guard();
CREATE TRIGGER price_events_no_delete BEFORE DELETE ON price_events
  FOR EACH ROW EXECUTE FUNCTION price_events_guard();
CREATE TRIGGER price_events_no_truncate BEFORE TRUNCATE ON price_events
  FOR EACH STATEMENT EXECUTE FUNCTION price_events_guard();
ALTER TABLE price_events ENABLE ALWAYS TRIGGER price_events_no_update;
ALTER TABLE price_events ENABLE ALWAYS TRIGGER price_events_no_delete;
ALTER TABLE price_events ENABLE ALWAYS TRIGGER price_events_no_truncate;

-- Per sku and market: the incrementally maintained window (exact as of updated_at; readers needing "now" recompute from events).
CREATE TABLE sku_price_windows (
  sku_id             uuid NOT NULL,
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_price_minor bigint NOT NULL CHECK (current_price_minor > 0),
  low_30d_minor      bigint NOT NULL CHECK (low_30d_minor > 0),
  low_30d_from       timestamptz NOT NULL,
  first_seen_at      timestamptz NOT NULL,
  last_increase_at   timestamptz,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (sku_id, market_id)
);
CREATE INDEX sku_price_windows_updated_idx ON sku_price_windows (updated_at);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON price_events FROM outlet_app;
    GRANT SELECT, INSERT ON price_events TO outlet_app;
    GRANT UPDATE (valid_to) ON price_events TO outlet_app;
    GRANT SELECT, INSERT, UPDATE ON sku_price_windows TO outlet_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_worker') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON price_events FROM outlet_worker;
    GRANT SELECT, INSERT ON price_events TO outlet_worker;
    GRANT UPDATE (valid_to) ON price_events TO outlet_worker;
    GRANT SELECT, INSERT, UPDATE ON sku_price_windows TO outlet_worker;
  END IF;
END
$do$;
