-- migration: 0026_price_watch_channels
-- phase: expand (new tables only)
-- Source: docs/specs/price-watch.md sections 2-6, master prompt 9.2-9.7, data_inventory.yaml (price_watch tables), ADR-0011.
-- Deviations (reported): channel_snapshots is NOT partitioned yet (daily RANGE (fetched_at) deferred like 0012: a partitioned PK
-- must include fetched_at; expand migration before ~5M rows). price_evidence / price_claim_evidence are not built: findings and
-- claims carry evidence_ids uuid[] pointing at channel_snapshots / price_events ids. price_claims is a log (one 'active' row per sku).
-- oauth_token_ref and webhook_secret_ref are KMS REFERENCES only (CHECK '^kms:'); a token is never stored.
-- Tenancy: store isolation (store_id + market pin) for seller-facing access as outlet_app; the scanner/scorer run as outlet_worker
-- under job 'pricing.channels' through named exception policies (market pinned) at the end of this file.

CREATE TABLE channel_connections (
  id                    uuid PRIMARY KEY,
  store_id              uuid NOT NULL REFERENCES stores (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  type                  text NOT NULL CHECK (type IN ('shopify', 'woocommerce', 'feed', 'website', 'meta_commerce')),
  domain                text NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  base_url              text NOT NULL CHECK (base_url ~ '^https://'),
  verify_method         text NOT NULL CHECK (verify_method IN ('dns_txt', 'meta_tag', 'file', 'oauth')),
  verify_token_hash     bytea CHECK (verify_token_hash IS NULL OR length(verify_token_hash) = 32),
  verified_at           timestamptz,
  oauth_token_ref       text CHECK (oauth_token_ref IS NULL OR oauth_token_ref ~ '^kms:'),
  webhook_secret_ref    text CHECK (webhook_secret_ref IS NULL OR webhook_secret_ref ~ '^kms:'),
  scopes                text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'revoked', 'disconnected')),
  risk_tier             text NOT NULL DEFAULT 'normal' CHECK (risk_tier IN ('trusted', 'normal', 'watched')),
  next_check_at         timestamptz,
  last_sync_at          timestamptz,
  last_webhook_at       timestamptz,
  consent_acceptance_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, domain),
  CHECK (status <> 'active' OR verified_at IS NOT NULL)
);
CREATE INDEX channel_connections_due_idx ON channel_connections (market_id, next_check_at) WHERE status = 'active';

CREATE TABLE external_products (
  id                   uuid PRIMARY KEY,
  connection_id        uuid NOT NULL REFERENCES channel_connections (id),
  store_id             uuid NOT NULL REFERENCES stores (id),
  market_id            text NOT NULL CHECK (length(market_id) > 0),
  external_ref         text NOT NULL,
  external_variant_ref text,
  url                  text,
  title                text,
  gtin                 text,
  image_phash          bytea CHECK (image_phash IS NULL OR length(image_phash) = 8),
  last_price_minor     bigint CHECK (last_price_minor IS NULL OR last_price_minor > 0),
  currency             char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX external_products_ref_uidx ON external_products (connection_id, external_ref, COALESCE(external_variant_ref, ''));

CREATE TABLE channel_snapshots (
  id                  uuid PRIMARY KEY,
  fetched_at          timestamptz NOT NULL,
  connection_id       uuid NOT NULL REFERENCES channel_connections (id),
  external_product_id uuid NOT NULL REFERENCES external_products (id),
  store_id            uuid NOT NULL REFERENCES stores (id),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  price_minor         bigint NOT NULL CHECK (price_minor > 0),
  compare_at_minor    bigint CHECK (compare_at_minor IS NULL OR compare_at_minor > 0),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  in_stock            boolean NOT NULL,
  evidence_class      text NOT NULL DEFAULT 'list_price' CHECK (evidence_class IN ('list_price', 'coupon_price')),
  method              text NOT NULL CHECK (method IN ('api', 'feed', 'crawler', 'webhook')),
  http_status         smallint,
  dom_hash            bytea,
  screenshot_media_id uuid,
  parser_version      text
);
CREATE INDEX channel_snapshots_product_idx ON channel_snapshots (external_product_id, fetched_at DESC);

CREATE TABLE product_matches (
  id                  uuid PRIMARY KEY,
  sku_id              uuid NOT NULL,
  store_id            uuid NOT NULL REFERENCES stores (id),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  external_product_id uuid NOT NULL REFERENCES external_products (id),
  method              text NOT NULL CHECK (method IN ('gtin', 'phash', 'embedding', 'llm', 'classifier', 'seller')),
  confidence_bp       int NOT NULL CHECK (confidence_bp BETWEEN 0 AND 10000),
  model_version       text NOT NULL,
  status              text NOT NULL CHECK (status IN ('auto', 'needs_confirmation', 'seller_confirmed', 'rejected')),
  confirmed_by        uuid,
  confirmed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, external_product_id)
);

CREATE TABLE price_claims (
  id              uuid PRIMARY KEY,
  sku_id          uuid NOT NULL,
  store_id        uuid NOT NULL REFERENCES stores (id),
  market_id       text NOT NULL CHECK (length(market_id) > 0),
  price_minor     bigint NOT NULL CHECK (price_minor > 0),
  vrp_minor       bigint CHECK (vrp_minor IS NULL OR vrp_minor > 0),
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_class text NOT NULL CHECK (reference_class IN ('internal', 'external', 'none')),
  discount_bp     int NOT NULL DEFAULT 0 CHECK (discount_bp >= 0),
  claim_type      text NOT NULL CHECK (claim_type IN ('verified_discount', 'lowest_30d', 'launch_price', 'plain')),
  display_allowed boolean NOT NULL,
  trust_score     smallint NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  status          text NOT NULL CHECK (status IN ('active', 'superseded')),
  rule_version    text NOT NULL,
  reason          text NOT NULL,
  evidence_ids    uuid[] NOT NULL DEFAULT '{}',
  scored_at       timestamptz NOT NULL,
  valid_until     timestamptz,
  CHECK (display_allowed = false OR (vrp_minor IS NOT NULL AND claim_type = 'verified_discount'))
);
CREATE UNIQUE INDEX price_claims_active_uidx ON price_claims (sku_id, market_id) WHERE status = 'active';

CREATE TABLE price_findings (
  id           uuid PRIMARY KEY,
  store_id     uuid NOT NULL REFERENCES stores (id),
  market_id    text NOT NULL CHECK (length(market_id) > 0),
  sku_id       uuid,
  rule         text NOT NULL CHECK (rule IN ('fake_reference', 'pre_discount_inflation', 'parity_breach', 'channel_disconnected', 'ping_pong', 'duplicate_reset', 'image_reuse', 'sudden_discount')),
  severity     text NOT NULL CHECK (severity IN ('info', 'violation', 'severe')),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'appealed', 'upheld')),
  action_taken text,
  detected_at  timestamptz NOT NULL,
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX price_findings_open_uidx ON price_findings (store_id, COALESCE(sku_id, '00000000-0000-0000-0000-000000000000'::uuid), rule) WHERE status IN ('open', 'appealed');
CREATE INDEX price_findings_store_idx ON price_findings (store_id, detected_at DESC);

CREATE TABLE enforcement_actions (
  id                    uuid PRIMARY KEY,
  store_id              uuid NOT NULL REFERENCES stores (id),
  market_id             text NOT NULL CHECK (length(market_id) > 0),
  finding_id            uuid NOT NULL REFERENCES price_findings (id),
  sku_id                uuid,
  action                text NOT NULL CHECK (action IN ('autocorrect_display', 'remove_badge', 'rank_penalty', 'demote', 'pause_sku', 'remove_all_pct', 'lose_verified', 'commission_surcharge', 'block_drops', 'suspend_store')),
  starts_at             timestamptz NOT NULL,
  expires_at            timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'lifted', 'pending_review')),
  human_review_required boolean NOT NULL DEFAULT false,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (finding_id, action)
);

CREATE TABLE price_appeals (
  id                uuid PRIMARY KEY,
  finding_id        uuid NOT NULL REFERENCES price_findings (id),
  store_id          uuid NOT NULL REFERENCES stores (id),
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  submitted_by      uuid,
  evidence_media_id uuid,
  claimed_reference_minor bigint CHECK (claimed_reference_minor IS NULL OR claimed_reference_minor > 0),
  connection_id     uuid REFERENCES channel_connections (id),
  status            text NOT NULL DEFAULT 'pending_rescore' CHECK (status IN ('pending_rescore', 'upheld', 'rejected', 'ops_queue')),
  idempotency_key   uuid NOT NULL UNIQUE,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement log: no DELETE/TRUNCATE; the only UPDATE allowed changes status / review columns / expiry.
CREATE FUNCTION enforcement_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'status' - 'reviewed_by' - 'reviewed_at' - 'expires_at') = (to_jsonb(OLD) - 'status' - 'reviewed_by' - 'reviewed_at' - 'expires_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'enforcement_actions is append-only: % is not allowed', TG_OP USING ERRCODE = '55000';
END
$fn$;
CREATE TRIGGER enforcement_actions_no_change BEFORE UPDATE OR DELETE ON enforcement_actions FOR EACH ROW EXECUTE FUNCTION enforcement_actions_guard();
CREATE TRIGGER enforcement_actions_no_truncate BEFORE TRUNCATE ON enforcement_actions FOR EACH STATEMENT EXECUTE FUNCTION enforcement_actions_guard();
ALTER TABLE enforcement_actions ENABLE ALWAYS TRIGGER enforcement_actions_no_change;
ALTER TABLE enforcement_actions ENABLE ALWAYS TRIGGER enforcement_actions_no_truncate;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_connections', 'external_products', 'channel_snapshots', 'product_matches', 'price_claims', 'price_findings', 'enforcement_actions', 'price_appeals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (store_id = app.current_store_id() AND market_id = app.current_market_id()) WITH CHECK (store_id = app.current_store_id() AND market_id = app.current_market_id())', t || '_store_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO outlet_worker USING (app.ctx() = ''worker'' AND app.job() = ''pricing.channels'' AND market_id = app.current_market_id()) WITH CHECK (app.ctx() = ''worker'' AND app.job() = ''pricing.channels'' AND market_id = app.current_market_id())', t || '__worker_pricing_channels', t);
  END LOOP;
END
$do$;
CREATE POLICY outbox_events__worker_pricing_channels ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'pricing.channels' AND market_id = app.current_market_id());

-- Grants: seller side (outlet_app) manages connections, reads evidence and appeals; the worker writes snapshots, matches, claims, findings.
REVOKE ALL ON channel_connections, external_products, channel_snapshots, product_matches, price_claims, price_findings, enforcement_actions, price_appeals FROM outlet_app;
GRANT SELECT, INSERT, UPDATE ON channel_connections TO outlet_app;
GRANT SELECT ON external_products, channel_snapshots, price_claims, price_findings, enforcement_actions TO outlet_app;
GRANT SELECT ON product_matches TO outlet_app;
GRANT UPDATE (status, confirmed_by, confirmed_at, method) ON product_matches TO outlet_app;
GRANT SELECT, INSERT ON price_appeals TO outlet_app;
GRANT SELECT, UPDATE ON channel_connections TO outlet_worker;
GRANT SELECT, INSERT, UPDATE ON external_products, product_matches, price_claims, price_findings, price_appeals TO outlet_worker;
GRANT SELECT, INSERT ON channel_snapshots TO outlet_worker;
GRANT SELECT, INSERT ON enforcement_actions TO outlet_worker;
GRANT UPDATE (status, reviewed_by, reviewed_at, expires_at) ON enforcement_actions TO outlet_worker;
