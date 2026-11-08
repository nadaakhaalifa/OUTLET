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
CREATE UNIQUE INDEX carts_one_active_uq ON carts (user_id, market_id) WHERE status = 'active';
SELECT app.enable_user_rls('carts');

CREATE TABLE cart_lines (
  id                 uuid PRIMARY KEY,
  cart_id            uuid NOT NULL REFERENCES carts (id),
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
  UNIQUE (cart_id, sku_id)
);
CREATE INDEX cart_lines_cart_store_idx ON cart_lines (cart_id, store_ref, added_at);
CREATE INDEX cart_lines_sku_idx ON cart_lines (sku_id);
SELECT app.enable_user_rls('cart_lines');

CREATE TABLE cart_store_thresholds (
  store_ref       uuid PRIMARY KEY REFERENCES stores (id),
  market_id       text NOT NULL,
  threshold_minor bigint NOT NULL CHECK (threshold_minor >= 0),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Add-to-bag resolves a sku inside the published listing variants with a containment lookup.
CREATE INDEX catalog_public_listings_variants_gin ON catalog_public_listings USING gin (variants jsonb_path_ops);
