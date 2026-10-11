-- migration: 0043_price_crawler
-- phase: expand
--
-- Price integrity v2: crawler targets, channel connections, daily snapshots, product matches,
-- labelled pairs and the matching threshold config (spec docs/specs/phase2/08-crawler-price-integrity-v2.md,
-- master prompt 9.2, ADR-0013, ADR-0027). Expand only: new tables, nothing existing changes.
--
--   * crawl_targets: a seller-verified domain. Only `verified` targets may be fetched; robots.txt is
--     cached on the row (24 h). Circuit-breaker state lives here so a blocked site backs off per domain.
--   * channel_connections: OAuth integrations. There is NO secret column: `token_ref` is an opaque
--     KMS/secret-manager reference (the crawler and the DB never hold the token itself).
--   * channel_snapshots: partitioned by UTC day (RANGE on fetched_day), append-only. Dedupe happens
--     in the application (ETag, DOM hash). Partitions are created by channel_snapshots_ensure_partition.
--   * product_matches: scored link between a Z-OUTLET SKU and an external product. `gate` records
--     whether it fed the VRP (live), was recorded only (shadow, until the labelled set exists, VR-13)
--     or rejected (below tau). Money is BIGINT piastres, VAT-inclusive.
--   * match_labels: the labelled Egyptian pair set used to choose tau (2,000 pairs, kappa >= 0.8).
--   * matching_config: a single row holding tau and the shadow flag; every change is appended to
--     matching_config_changes with two distinct approvers (dual approval, enforced by CHECK).
--   * crawl_incidents: refusals (SSRF, robots, rebinding) and parser dead letters. URLs are stored
--     as a hash plus host only.
-- PII: none. Seller identity is the store id (P1). Sellers can read their own rows; every write runs
-- as app.role = 'system' except the seller-initiated registration of their own target/connection.

CREATE TABLE crawl_targets (
  id                  uuid PRIMARY KEY,
  store_id            uuid NOT NULL,
  domain              text NOT NULL
                        CHECK (domain = lower(domain) AND char_length(domain) BETWEEN 4 AND 253 AND domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  kind                text NOT NULL DEFAULT 'seller' CHECK (kind IN ('seller', 'brand_rrp')),
  status              text NOT NULL DEFAULT 'pending_verification'
                        CHECK (status IN ('pending_verification', 'verified', 'unreachable', 'blocked', 'revoked')),
  verification_method text NOT NULL CHECK (verification_method IN ('dns_txt', 'file')),
  verification_token_hash text NOT NULL CHECK (char_length(verification_token_hash) = 64),
  consent_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  robots_txt          text CHECK (robots_txt IS NULL OR char_length(robots_txt) <= 512000),
  robots_status       integer,
  robots_fetched_at   timestamptz,
  breaker_failures    integer NOT NULL DEFAULT 0 CHECK (breaker_failures >= 0),
  breaker_opened_at   timestamptz,
  last_etag           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crawl_targets_store_domain_uq UNIQUE (store_id, domain),
  CONSTRAINT crawl_targets_verified_ck CHECK (status IN ('pending_verification', 'revoked') OR verified_at IS NOT NULL)
);

CREATE INDEX crawl_targets_store_idx ON crawl_targets (store_id, created_at DESC);
CREATE INDEX crawl_targets_due_idx ON crawl_targets (status, robots_fetched_at) WHERE status = 'verified';

CREATE TABLE channel_connections (
  id           uuid PRIMARY KEY,
  store_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('shopify', 'woocommerce', 'odoo', 'google_sheets', 'crawler')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  token_ref    text NOT NULL CHECK (char_length(token_ref) BETWEEN 8 AND 256 AND token_ref !~ '\s'),
  kms_key_ref  text NOT NULL CHECK (char_length(kms_key_ref) BETWEEN 8 AND 256),
  target_id    uuid REFERENCES crawl_targets (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT channel_connections_revoked_ck CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX channel_connections_store_idx ON channel_connections (store_id, created_at DESC);

CREATE TABLE channel_snapshots (
  id            uuid NOT NULL,
  target_id     uuid NOT NULL,
  store_id      uuid NOT NULL,
  sku_ref       text NOT NULL CHECK (char_length(sku_ref) BETWEEN 1 AND 200),
  price_amount  bigint NOT NULL CHECK (price_amount > 0),
  available     boolean NOT NULL,
  dom_hash      text NOT NULL CHECK (char_length(dom_hash) BETWEEN 8 AND 128),
  etag          text,
  fetched_at    timestamptz NOT NULL,
  fetched_day   date NOT NULL,
  PRIMARY KEY (id, fetched_day)
) PARTITION BY RANGE (fetched_day);

CREATE TABLE channel_snapshots_default PARTITION OF channel_snapshots DEFAULT;
CREATE INDEX channel_snapshots_ref_idx ON channel_snapshots (target_id, sku_ref, fetched_at DESC);
CREATE INDEX channel_snapshots_store_idx ON channel_snapshots (store_id, fetched_at DESC);

CREATE FUNCTION channel_snapshots_forbid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'UPDATE on channel_snapshots is not allowed: snapshots are append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER channel_snapshots_no_update_trg BEFORE UPDATE ON channel_snapshots
  FOR EACH ROW EXECUTE FUNCTION channel_snapshots_forbid_update();

-- Creates the child partition for one UTC day (idempotent). SECURITY DEFINER so the application role
-- needs no DDL right; the name is built from a date, never from input text.
CREATE FUNCTION channel_snapshots_ensure_partition(day date) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  part text := 'channel_snapshots_' || to_char(day, 'YYYYMMDD');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF channel_snapshots FOR VALUES FROM (%L) TO (%L)', part, day, day + 1);
  END IF;
  RETURN part;
END
$$;

-- Retention: drops whole daily partitions older than the cutoff (cheap, no row deletes).
CREATE FUNCTION channel_snapshots_drop_older_than(cutoff date) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r record;
  dropped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'channel_snapshots' AND c.relname ~ '^channel_snapshots_[0-9]{8}$'
  LOOP
    IF to_date(right(r.relname, 8), 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;

REVOKE ALL ON FUNCTION channel_snapshots_drop_older_than(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_snapshots_ensure_partition(date) TO app_user;

CREATE TABLE product_matches (
  id             uuid PRIMARY KEY,
  sku_id         uuid NOT NULL,
  store_id       uuid NOT NULL,
  target_id      uuid NOT NULL REFERENCES crawl_targets (id),
  external_ref   text NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 200),
  method         text NOT NULL CHECK (method IN ('gtin', 'seller_sku', 'image_hash', 'embedding', 'image_and_embedding')),
  raw_bp         integer NOT NULL CHECK (raw_bp BETWEEN 0 AND 10000),
  conf_bp        integer NOT NULL CHECK (conf_bp BETWEEN 0 AND 10000),
  cap_reason     text,
  model_version  text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 60),
  gate           text NOT NULL CHECK (gate IN ('live', 'shadow', 'rejected')),
  scored_at      timestamptz NOT NULL,
  CONSTRAINT product_matches_uq UNIQUE (sku_id, target_id, external_ref)
);

CREATE INDEX product_matches_sku_idx ON product_matches (sku_id, gate);
CREATE INDEX product_matches_store_idx ON product_matches (store_id, scored_at DESC);

CREATE TABLE match_labels (
  pair_id        uuid PRIMARY KEY,
  sku_id         uuid NOT NULL,
  external_ref   text NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 200),
  category       text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 60),
  brand          text NOT NULL CHECK (char_length(brand) BETWEEN 1 AND 80),
  hard_negative  boolean NOT NULL DEFAULT false,
  label_a        boolean NOT NULL,
  label_b        boolean NOT NULL,
  adjudicated    boolean,
  split          text NOT NULL CHECK (split IN ('train', 'validation', 'test')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A disagreement needs an adjudicated label before the pair can be used.
  CONSTRAINT match_labels_adjudicated_ck CHECK (label_a = label_b OR adjudicated IS NOT NULL)
);

CREATE INDEX match_labels_split_idx ON match_labels (split);

CREATE TABLE matching_config (
  id           smallint PRIMARY KEY CHECK (id = 1),
  tau_bp       integer NOT NULL CHECK (tau_bp BETWEEN 5000 AND 10000),
  shadow_only  boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO matching_config (id, tau_bp, shadow_only) VALUES (1, 9200, true);

CREATE TABLE matching_config_changes (
  id            uuid PRIMARY KEY,
  old_tau_bp    integer NOT NULL,
  new_tau_bp    integer NOT NULL CHECK (new_tau_bp BETWEEN 5000 AND 10000),
  old_shadow    boolean NOT NULL,
  new_shadow    boolean NOT NULL,
  proposed_by   uuid NOT NULL,
  approved_by   uuid NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matching_config_dual_ck CHECK (proposed_by <> approved_by)
);

CREATE TABLE crawl_incidents (
  id          uuid PRIMARY KEY,
  target_id   uuid,
  store_id    uuid,
  kind        text NOT NULL
                CHECK (kind IN ('ssrf_refused', 'dns_rebinding', 'robots_disallowed', 'blocked', 'parser_error', 'size_exceeded', 'redirect_refused', 'kill_switch')),
  host        text NOT NULL CHECK (char_length(host) <= 253),
  url_hash    text NOT NULL CHECK (char_length(url_hash) = 64),
  detail      text CHECK (detail IS NULL OR char_length(detail) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crawl_incidents_target_idx ON crawl_incidents (target_id, created_at DESC);
CREATE INDEX crawl_incidents_kind_idx ON crawl_incidents (kind, created_at DESC);

CREATE TRIGGER matching_config_changes_no_mutation_trg BEFORE UPDATE OR DELETE ON matching_config_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER crawl_incidents_no_mutation_trg BEFORE UPDATE OR DELETE ON crawl_incidents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Row level security --------------------------------------------------------------------
ALTER TABLE crawl_targets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON crawl_targets TO app_user;
CREATE POLICY crawl_targets_select ON crawl_targets FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY crawl_targets_insert ON crawl_targets FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY crawl_targets_system_update ON crawl_targets FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON channel_connections TO app_user;
CREATE POLICY channel_connections_select ON channel_connections FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY channel_connections_insert ON channel_connections FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY channel_connections_system_update ON channel_connections FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE channel_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON channel_snapshots TO app_user;
CREATE POLICY channel_snapshots_select ON channel_snapshots FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY channel_snapshots_system_insert ON channel_snapshots FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE product_matches ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON product_matches TO app_user;
CREATE POLICY product_matches_select ON product_matches FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY product_matches_system_insert ON product_matches FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY product_matches_system_update ON product_matches FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE match_labels ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON match_labels TO app_user;
CREATE POLICY match_labels_system_select ON match_labels FOR SELECT USING (app_role() = 'system');
CREATE POLICY match_labels_system_insert ON match_labels FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE matching_config ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON matching_config TO app_user;
CREATE POLICY matching_config_select ON matching_config FOR SELECT USING (true);
CREATE POLICY matching_config_system_update ON matching_config FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE matching_config_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON matching_config_changes TO app_user;
CREATE POLICY matching_config_changes_system_select ON matching_config_changes FOR SELECT USING (app_role() = 'system');
CREATE POLICY matching_config_changes_system_insert ON matching_config_changes FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE crawl_incidents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON crawl_incidents TO app_user;
CREATE POLICY crawl_incidents_select ON crawl_incidents FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY crawl_incidents_system_insert ON crawl_incidents FOR INSERT WITH CHECK (app_role() = 'system');
