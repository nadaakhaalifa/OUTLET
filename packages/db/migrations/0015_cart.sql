-- migration: 0015_cart
-- phase: expand
--
-- Server-side bag (spec 6, docs/specs/cart.md, docs/data-model/cart.md).
-- carts: one per user. cart_lines: one line per SKU per bag (spec cap: 50 lines, 10 units).
-- sku_id and store_id are LOGICAL references: the catalog tables arrive in a later wave, and
-- an FK will be added by an expand migration then. Prices, availability and totals are NOT stored;
-- they are computed at read from the catalog (docs/data-model/cart.md). Money is BIGINT piastres.
-- Wishlists and product alerts from the same data-model file are a later migration.

CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES users (id),
  currency    char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  version     integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER carts_touch_updated_at_trg
  BEFORE UPDATE ON carts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE cart_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id                  uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  sku_id                   uuid NOT NULL,
  store_id                 uuid NOT NULL,
  qty                      integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  price_at_add_amount      bigint NOT NULL CHECK (price_at_add_amount >= 0),
  threshold_at_add_amount  bigint CHECK (threshold_at_add_amount IS NULL OR threshold_at_add_amount >= 0),
  state                    text NOT NULL DEFAULT 'IN_BAG' CHECK (state IN ('IN_BAG', 'SAVED_FOR_LATER')),
  source                   text CHECK (source IS NULL OR source IN
                             ('pdp', 'search', 'stylist', 'wishlist', 'feed', 'bag_suggestion', 'reorder')),
  source_ref               uuid,
  unavailable_since        timestamptz,
  added_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, sku_id)
);

CREATE INDEX cart_lines_sku_idx ON cart_lines (sku_id);

-- Hard cap of 50 lines per bag, serialised per cart by locking the parent row.
CREATE FUNCTION cart_lines_enforce_cap() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  PERFORM 1 FROM carts WHERE id = NEW.cart_id FOR UPDATE;
  SELECT count(*) INTO n FROM cart_lines WHERE cart_id = NEW.cart_id;
  IF n >= 50 THEN
    RAISE EXCEPTION 'cart % already holds 50 lines', NEW.cart_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cart_lines_cap_trg
  BEFORE INSERT ON cart_lines FOR EACH ROW EXECUTE FUNCTION cart_lines_enforce_cap();

-- RLS: class A (owner). Policies per verb; lines resolve ownership through the parent cart.
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON carts TO app_user;
CREATE POLICY carts_owner_select ON carts FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY carts_owner_insert ON carts FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY carts_owner_update ON carts FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY carts_owner_delete ON carts FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE cart_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON cart_lines TO app_user;
CREATE POLICY cart_lines_owner_select ON cart_lines FOR SELECT
  USING (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_lines.cart_id AND c.user_id = app_user_id()));
CREATE POLICY cart_lines_owner_insert ON cart_lines FOR INSERT
  WITH CHECK (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_lines.cart_id AND c.user_id = app_user_id()));
CREATE POLICY cart_lines_owner_update ON cart_lines FOR UPDATE
  USING (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_lines.cart_id AND c.user_id = app_user_id()))
  WITH CHECK (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_lines.cart_id AND c.user_id = app_user_id()));
CREATE POLICY cart_lines_owner_delete ON cart_lines FOR DELETE
  USING (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM carts c WHERE c.id = cart_lines.cart_id AND c.user_id = app_user_id()));
