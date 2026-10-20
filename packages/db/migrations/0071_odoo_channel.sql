-- migration: 0071_odoo_channel
-- phase: expand
--
-- Odoo seller channel adapter (Phase 3 item 11, master prompt 9.2 and 19, docs/plan/phase-3-plan.md).
-- Reuses channel_connections (0043) for the channel itself and its opaque secret reference. This
-- migration adds only what that table cannot hold:
--
--   * odoo_channel_configs: non-secret connection settings (database name, numeric uid, optional
--     pricelist and stock location, poll interval) and per-channel poll state (circuit breaker,
--     last poll, last error code). There is NO credential column: the Odoo login and API key live
--     in the secret manager behind channel_connections.token_ref and never reach the database.
--   * odoo_product_links: Odoo product.product id -> Z-OUTLET SKU, with the last synced price and
--     stock source version so unchanged products cost no write.
--   * price_events.source gains 'odoo' so seller-channel evidence is distinguishable in the
--     immutable price ledger. The ledger itself is untouched (append-only triggers stay).
-- PII: none (ids, enums, integers, a database name). Seller identity is the store id (P1).

-- lint-allow: drop-constraint-or-index replaced in the same transaction by a strictly wider CHECK (adds odoo)
ALTER TABLE price_events DROP CONSTRAINT price_events_source_check;
ALTER TABLE price_events ADD CONSTRAINT price_events_source_check
  CHECK (source IN ('seller', 'import', 'channel_sync', 'admin', 'system', 'odoo'));

CREATE TABLE odoo_channel_configs (
  channel_id        uuid PRIMARY KEY REFERENCES channel_connections (id),
  store_id          uuid NOT NULL,
  target_id         uuid NOT NULL REFERENCES crawl_targets (id),
  db_name           text NOT NULL CHECK (char_length(db_name) BETWEEN 1 AND 63 AND db_name ~ '^[A-Za-z0-9_.-]+$'),
  odoo_uid          integer NOT NULL CHECK (odoo_uid > 0),
  pricelist_id      integer CHECK (pricelist_id IS NULL OR pricelist_id > 0),
  stock_location_id integer CHECK (stock_location_id IS NULL OR stock_location_id > 0),
  poll_interval_s   integer NOT NULL DEFAULT 900 CHECK (poll_interval_s BETWEEN 300 AND 86400),
  breaker_failures  integer NOT NULL DEFAULT 0 CHECK (breaker_failures >= 0),
  breaker_opened_at timestamptz,
  last_polled_at    timestamptz,
  last_error_code   text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX odoo_channel_configs_store_idx ON odoo_channel_configs (store_id, created_at DESC);
CREATE INDEX odoo_channel_configs_due_idx ON odoo_channel_configs (last_polled_at NULLS FIRST);

CREATE TABLE odoo_product_links (
  channel_id               uuid NOT NULL REFERENCES odoo_channel_configs (channel_id),
  odoo_product_id          bigint NOT NULL CHECK (odoo_product_id > 0),
  store_id                 uuid NOT NULL,
  sku_id                   uuid NOT NULL,
  last_price_amount        bigint CHECK (last_price_amount IS NULL OR last_price_amount > 0),
  last_stock_source_version bigint CHECK (last_stock_source_version IS NULL OR last_stock_source_version >= 0),
  last_stock_qty           integer CHECK (last_stock_qty IS NULL OR last_stock_qty >= 0),
  last_synced_at           timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, odoo_product_id),
  CONSTRAINT odoo_product_links_sku_uq UNIQUE (channel_id, sku_id)
);
CREATE INDEX odoo_product_links_store_idx ON odoo_product_links (store_id);

REVOKE ALL ON odoo_channel_configs, odoo_product_links FROM PUBLIC;

ALTER TABLE odoo_channel_configs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON odoo_channel_configs TO app_user;
CREATE POLICY odoo_channel_configs_select ON odoo_channel_configs FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY odoo_channel_configs_insert ON odoo_channel_configs FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY odoo_channel_configs_system_update ON odoo_channel_configs FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE odoo_product_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON odoo_product_links TO app_user;
CREATE POLICY odoo_product_links_select ON odoo_product_links FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY odoo_product_links_system_insert ON odoo_product_links FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY odoo_product_links_system_update ON odoo_product_links FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
