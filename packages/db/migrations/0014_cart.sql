-- migration: 0014_cart
-- phase: expand (new tables, one additive index on catalog_public_listings)
-- Source: docs/haul-master-prompt-v3.md section 6, docs/data-model.md carts / cart_lines, docs/api/openapi.yaml cart paths, ADR-0011.
--
-- RLS: carts and cart_lines are user-owned (app.enable_user_rls, FORCE RLS on user_id). cart_lines carries user_id denormalised so
-- the policy needs no join. No exception policy is added. The shopper request path runs as outlet_app in a user context.
-- cart_store_thresholds is public configuration (free-delivery threshold per store): keyed by store_ref (a pointer, not a tenant
-- key, like catalog_public_*), no personal data, so every shopper can read it; writes are authorised in the service
-- through @outlet/policy store.write.
--
-- Deviations from the ERD (reported): cart_lines.store_id is named store_ref (see below); saved_for_later and defect_ack_* are not built yet (later bag step); product_id is stored
-- (public listing key, needed to read live prices in one keyed lookup); last_state remembers the previous line state only to
-- emit cart.line_unavailable once (it is never shown and never replaces the live price/stock read).

CREATE TABLE carts (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id),
  market_id  text NOT NULL CHECK (length(market_id) > 0),
  currency   char(3) NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned')),
  version    int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- (id, user_id) is the target of the cart_lines composite FK: a line can never point at another user's cart (C2).
ALTER TABLE carts ADD CONSTRAINT carts_id_user_uq UNIQUE (id, user_id);
CREATE UNIQUE INDEX carts_one_active_uq ON carts (user_id, market_id) WHERE status = 'active';
SELECT app.enable_user_rls('carts');

CREATE TABLE cart_lines (
  id                 uuid PRIMARY KEY,
  cart_id            uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES users (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  sku_id             uuid NOT NULL REFERENCES skus (id),
  product_id         uuid NOT NULL REFERENCES products (id),
  -- store_ref, not store_id: the RLS audit treats a store_id column as a tenant key; this is a grouping pointer only (data-model: "not a tenant key").
  store_ref          uuid NOT NULL REFERENCES stores (id),
  qty                smallint NOT NULL CHECK (qty BETWEEN 1 AND 10),
  price_at_add_minor bigint NOT NULL CHECK (price_at_add_minor > 0),
  currency           char(3) NOT NULL,
  source             text NOT NULL DEFAULT 'pdp' CHECK (source IN ('pdp', 'quick_add', 'shelf', 'wishlist', 'drop', 'stylist')),
  last_state         text NOT NULL DEFAULT 'ok' CHECK (last_state IN ('ok', 'price_dropped', 'price_rose', 'unavailable', 'store_locked')),
  version            int NOT NULL DEFAULT 1 CHECK (version >= 1),
  added_at           timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, sku_id),
  FOREIGN KEY (cart_id, user_id) REFERENCES carts (id, user_id)
);
CREATE INDEX cart_lines_cart_store_idx ON cart_lines (cart_id, store_ref, added_at);
CREATE INDEX cart_lines_sku_idx ON cart_lines (sku_id);
SELECT app.enable_user_rls('cart_lines');

-- Free-delivery settings: the WRITE side. Store-isolated (FORCE RLS on store_id, app.enable_store_rls); a user or anonymous context
-- cannot write it. Bounds: 0..1,000,000 minor; 0 means free delivery for everyone and needs an explicit allow_free_for_all (C1).
CREATE TABLE store_free_delivery_settings (
  store_id           uuid PRIMARY KEY REFERENCES stores (id),
  market_id          text NOT NULL,
  threshold_minor    bigint NOT NULL CHECK (threshold_minor BETWEEN 0 AND 1000000),
  allow_free_for_all boolean NOT NULL DEFAULT false,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (threshold_minor > 0 OR allow_free_for_all)
);
SELECT app.enable_store_rls('store_free_delivery_settings');

-- Public read projection of the settings (same pattern as catalog_public_*): keyed by store_ref (a pointer, not a tenant key),
-- no personal data, shopper-readable. It is only ever written by the service in the SAME transaction as the settings row.
CREATE TABLE cart_store_thresholds (
  store_ref       uuid PRIMARY KEY REFERENCES stores (id),
  market_id       text NOT NULL,
  threshold_minor bigint NOT NULL CHECK (threshold_minor BETWEEN 0 AND 1000000),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
REVOKE DELETE ON cart_store_thresholds FROM outlet_app;

-- Add-to-bag resolves a sku inside the published listing variants with a containment lookup.
-- (The GIN stays here: a sku_ids uuid[] column would belong to catalog's projection, not this migration.)
CREATE INDEX catalog_public_listings_variants_gin ON catalog_public_listings USING gin (variants jsonb_path_ops);
