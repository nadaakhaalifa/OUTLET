-- migration: 0012_catalog
-- phase: expand
--
-- Catalog core (spec section 4, 5, 19, B5; docs/specs/catalog.md; docs/data-model/catalog.md):
-- brands, categories, products, skus, product_media, product_defects, plus the bulk-import
-- bookkeeping tables. Expand-only: new tables, no changes to existing ones.
--
-- Decisions recorded here (see docs/specs/catalog.md section 4):
--   * Enumerations use the lowercase wire form (ADR-0018), not the data model's upper case.
--   * products.status adds 'auto_paused_price_parity' (OpenAPI SellerProduct, spec 9.5).
--   * store_id is a LOGICAL reference to stores: that table is created by 0013_stores, which runs
--     after this file. A later expand migration adds FOREIGN KEY (store_id) REFERENCES stores (id)
--     (and the FKs from wishlists, cart and inventory to products/skus that those files defer here).
--   * size_chart_id (sizing) and media_asset_id (platform) are logical references too.
--   * There is deliberately NO column for a "was" price, reference price, discount or badge:
--     those exist only in pricing-integrity output (spec 5 acceptance, 9.1).
--   * Price here is the seller-set VAT-inclusive selling price in piastres (BIGINT, never float).
--   * All catalog content is P0 (public). Seller text is untrusted and is never P2/P3.
--   * Tenant tables follow packages/policy/RLS.md class B: guard AND RLS, deny by default.

-- brands and categories ---------------------------------------------------------------------

CREATE TABLE brands (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  name_ar                text NOT NULL CHECK (length(btrim(name_ar)) > 0 AND length(name_ar) <= 200),
  name_en                text CHECK (name_en IS NULL OR length(name_en) <= 200),
  origin                 text NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'global')),
  authorization_required boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_slug_uq UNIQUE (slug)
);

CREATE TRIGGER brands_touch_updated_at_trg
  BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE categories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id            uuid REFERENCES categories (id),
  slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  name_ar              text NOT NULL CHECK (length(btrim(name_ar)) > 0 AND length(name_ar) <= 200),
  name_en              text CHECK (name_en IS NULL OR length(name_en) <= 200),
  product_type         text NOT NULL CHECK (product_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  tax_category_code    text CHECK (tax_category_code IS NULL OR tax_category_code ~ '^[A-Z0-9_]{1,32}$'),
  return_class         text NOT NULL DEFAULT 'standard'
                         CHECK (return_class IN ('standard', 'hygiene', 'personalized', 'non_returnable')),
  requires_size_chart  boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL DEFAULT 0,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_slug_uq UNIQUE (slug),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX categories_parent_idx ON categories (parent_id, sort_order);

CREATE TRIGGER categories_touch_updated_at_trg
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- products ----------------------------------------------------------------------------------

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL,                                  -- logical FK to stores (tenancy)
  brand_id        uuid REFERENCES brands (id),
  category_id     uuid NOT NULL REFERENCES categories (id),
  -- Arabic is mandatory (spec B5, A2.15): not blank AND at least one Arabic-script letter.
  title_ar        text NOT NULL
                    CHECK (length(btrim(title_ar)) BETWEEN 1 AND 200
                           AND title_ar ~ '[ؠ-يٮ-ۓەۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]'),
  title_en        text CHECK (title_en IS NULL OR length(title_en) <= 200),
  description_ar  text CHECK (description_ar IS NULL
                              OR (length(btrim(description_ar)) BETWEEN 1 AND 2000
                                  AND description_ar ~ '[ؠ-يٮ-ۓەۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]')),
  description_en  text CHECK (description_en IS NULL OR length(description_en) <= 2000),
  condition       text NOT NULL
                    CHECK (condition IN ('new_with_tags', 'new_without_tags', 'sample', 'minor_defect')),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'paused', 'auto_paused_price_parity', 'delisted')),
  material        text CHECK (material IS NULL OR length(material) <= 120),
  size_chart_id   uuid,                                           -- logical FK to sizing
  offer_group_id  uuid,                                           -- Phase 2 (Buy Box), logical
  facets          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facets) = 'object'),
  modest          boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Published products carry an Arabic description (publish gate, spec section 2.4).
  CONSTRAINT products_active_has_description CHECK (status <> 'active' OR description_ar IS NOT NULL),
  -- Composite key so child rows can prove they carry the parent's tenant.
  CONSTRAINT products_id_store_uq UNIQUE (id, store_id)
);

CREATE INDEX products_store_status_idx ON products (store_id, status);
CREATE INDEX products_category_status_idx ON products (category_id, status);
CREATE INDEX products_facets_gin_idx ON products USING gin (facets);
CREATE INDEX products_offer_group_idx ON products (offer_group_id) WHERE offer_group_id IS NOT NULL;
CREATE INDEX products_store_created_idx ON products (store_id, created_at DESC, id DESC);

CREATE TRIGGER products_touch_updated_at_trg
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- skus --------------------------------------------------------------------------------------

CREATE TABLE skus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid NOT NULL,
  store_id           uuid NOT NULL,                                -- denormalised for RLS, proven by the FK below
  seller_sku         text CHECK (seller_sku IS NULL OR length(seller_sku) BETWEEN 1 AND 64),
  gtin               text CHECK (gtin IS NULL OR gtin ~ '^([0-9]{8}|[0-9]{12,14})$'),
  color_code         text NOT NULL DEFAULT '' CHECK (length(color_code) <= 40),
  size_label         text NOT NULL CHECK (length(btrim(size_label)) BETWEEN 1 AND 20),
  list_price_amount  bigint NOT NULL CHECK (list_price_amount > 0 AND list_price_amount <= 999999999),
  currency           char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'sold_out', 'delisted')),
  weight_grams       integer CHECK (weight_grams IS NULL OR weight_grams BETWEEN 0 AND 100000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skus_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id)
);

-- One variant per colour and size within a product (case-insensitive).
CREATE UNIQUE INDEX skus_variant_uq ON skus (product_id, lower(color_code), lower(btrim(size_label)));
CREATE UNIQUE INDEX skus_store_seller_sku_uq ON skus (store_id, seller_sku) WHERE seller_sku IS NOT NULL;
CREATE UNIQUE INDEX skus_store_gtin_variant_uq
  ON skus (store_id, gtin, lower(color_code), lower(btrim(size_label))) WHERE gtin IS NOT NULL;
CREATE INDEX skus_product_idx ON skus (product_id);

CREATE TRIGGER skus_touch_updated_at_trg
  BEFORE UPDATE ON skus
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- product_media and product_defects ------------------------------------------------------------

CREATE TABLE product_media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL,
  store_id        uuid NOT NULL,
  sku_id          uuid REFERENCES skus (id),
  media_asset_id  uuid NOT NULL,                                   -- logical FK to platform media_assets
  kind            text NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'video')),
  position        integer NOT NULL CHECK (position >= 0 AND position < 50),
  blurhash        text CHECK (blurhash IS NULL OR length(blurhash) BETWEEN 6 AND 100),
  image_version   integer NOT NULL DEFAULT 1 CHECK (image_version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_media_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id),
  CONSTRAINT product_media_position_uq UNIQUE (product_id, position)
);

CREATE INDEX product_media_product_idx ON product_media (product_id, position);

CREATE TABLE product_defects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL,
  store_id        uuid NOT NULL,
  sku_id          uuid REFERENCES skus (id),
  description_ar  text CHECK (description_ar IS NULL OR length(description_ar) <= 1000),
  description_en  text CHECK (description_en IS NULL OR length(description_en) <= 1000),
  media_asset_id  uuid NOT NULL,                                   -- a defect row always has a photo
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_defects_product_store_fk FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id)
);

CREATE INDEX product_defects_product_idx ON product_defects (product_id);

-- Lifecycle guards ------------------------------------------------------------------------------
-- Mirrors packages/domain/src/catalog/listing.ts so the invariant holds even if the application
-- guard is bypassed (A2.6). SECURITY INVOKER: they read only OLD/NEW and, for the publish gate,
-- tables the caller can already read through RLS.

CREATE FUNCTION products_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a product is created as draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'delisted' AND NEW.status <> 'delisted' THEN
    RAISE EXCEPTION 'delisted is terminal' USING ERRCODE = 'check_violation';
  END IF;

  -- The price-parity pause is system-only, in both directions (spec 2.4).
  IF app_role() = 'seller' THEN
    IF NEW.status = 'auto_paused_price_parity' AND OLD.status <> 'auto_paused_price_parity' THEN
      RAISE EXCEPTION 'only the system may auto-pause a listing' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'auto_paused_price_parity' AND NEW.status IN ('draft', 'active', 'paused') THEN
      RAISE EXCEPTION 'only the system may clear a price-parity pause' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF NEW.description_ar IS NULL THEN
      RAISE EXCEPTION 'publish requires an Arabic description' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM product_media m WHERE m.product_id = NEW.id AND m.kind = 'image') THEN
      RAISE EXCEPTION 'publish requires at least one image' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM skus s WHERE s.product_id = NEW.id AND s.status = 'active') THEN
      RAISE EXCEPTION 'publish requires at least one active priced SKU' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.condition = 'minor_defect'
       AND NOT EXISTS (SELECT 1 FROM product_defects d WHERE d.product_id = NEW.id) THEN
      RAISE EXCEPTION 'a minor_defect product needs a defect photo' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.published_at IS NULL THEN
      NEW.published_at := clock_timestamp();
    END IF;
  END IF;

  -- Changing condition to minor_defect on a live listing needs the photo first.
  IF NEW.status = 'active' AND NEW.condition = 'minor_defect' AND OLD.condition <> 'minor_defect'
     AND NOT EXISTS (SELECT 1 FROM product_defects d WHERE d.product_id = NEW.id) THEN
    RAISE EXCEPTION 'a minor_defect product needs a defect photo' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'version must increase on every update' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER products_lifecycle_guard_trg
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_lifecycle_guard();

-- Tenant and store of a product never change.
CREATE FUNCTION products_immutable_tenant() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION 'store_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER products_immutable_tenant_trg
  BEFORE UPDATE OF store_id ON products
  FOR EACH ROW EXECUTE FUNCTION products_immutable_tenant();

-- Bulk import bookkeeping -------------------------------------------------------------------------

CREATE TABLE catalog_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL,                                     -- logical FK to stores
  actor_id      uuid NOT NULL,                                     -- logical FK to users
  upload_id     uuid NOT NULL,                                     -- logical FK to media_assets (the CSV)
  status        text NOT NULL
                  CHECK (status IN ('queued', 'validating', 'dry_run_complete', 'applying', 'completed', 'failed')),
  dry_run       boolean NOT NULL DEFAULT true,
  rows_total    integer NOT NULL DEFAULT 0 CHECK (rows_total >= 0 AND rows_total <= 5000),
  rows_ok       integer NOT NULL DEFAULT 0 CHECK (rows_ok >= 0),
  rows_failed   integer NOT NULL DEFAULT 0 CHECK (rows_failed >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_imports_counts_ck CHECK (rows_ok + rows_failed = rows_total),
  -- A dry run can only finish as a dry run (or fail): it never reaches applying/completed.
  CONSTRAINT catalog_imports_dry_run_status_ck
    CHECK (NOT dry_run OR status IN ('queued', 'validating', 'dry_run_complete', 'failed')),
  CONSTRAINT catalog_imports_id_store_uq UNIQUE (id, store_id)
);

CREATE INDEX catalog_imports_store_created_idx ON catalog_imports (store_id, created_at DESC);

CREATE TRIGGER catalog_imports_touch_updated_at_trg
  BEFORE UPDATE ON catalog_imports
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Per-row error report. Row numbers, column names and machine codes only: never cell contents.
CREATE TABLE catalog_import_errors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id    uuid NOT NULL,
  store_id     uuid NOT NULL,
  row_number   integer NOT NULL CHECK (row_number >= 0),
  column_name  text CHECK (column_name IS NULL OR column_name ~ '^[a-z_]{1,40}$'),
  code         text NOT NULL CHECK (code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT catalog_import_errors_import_fk FOREIGN KEY (import_id, store_id) REFERENCES catalog_imports (id, store_id)
);

CREATE INDEX catalog_import_errors_import_idx ON catalog_import_errors (import_id, row_number);

-- Which products a real run created: makes the apply step idempotent and resumable.
CREATE TABLE catalog_import_products (
  import_id    uuid NOT NULL,
  store_id     uuid NOT NULL,
  product_ref  text NOT NULL CHECK (product_ref ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- NULL between the claim and the product insert (claim-first keeps the apply step idempotent).
  product_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, product_ref),
  CONSTRAINT catalog_import_products_import_fk FOREIGN KEY (import_id, store_id) REFERENCES catalog_imports (id, store_id),
  CONSTRAINT catalog_import_products_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products (id, store_id)
);

-- A dry run never creates products: refuse the claim at the database too.
CREATE FUNCTION catalog_import_products_no_dry_run() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog_imports i WHERE i.id = NEW.import_id AND i.dry_run) THEN
    RAISE EXCEPTION 'a dry-run import cannot create products' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER catalog_import_products_no_dry_run_trg
  BEFORE INSERT ON catalog_import_products
  FOR EACH ROW EXECUTE FUNCTION catalog_import_products_no_dry_run();

-- RLS and grants (RLS.md class B) -------------------------------------------------------------------
-- app_role() 'seller' acts on app_store_ids(). Public catalogue reads are `active` rows for any
-- identified caller. ops/trust_safety may read everything and system is the worker identity.

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON brands TO app_user;
CREATE POLICY brands_read ON brands FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY brands_ops_insert ON brands FOR INSERT WITH CHECK (app_role() IN ('ops', 'system'));
CREATE POLICY brands_ops_update ON brands FOR UPDATE
  USING (app_role() IN ('ops', 'system')) WITH CHECK (app_role() IN ('ops', 'system'));

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON categories TO app_user;
CREATE POLICY categories_read ON categories FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY categories_ops_insert ON categories FOR INSERT WITH CHECK (app_role() IN ('ops', 'system'));
CREATE POLICY categories_ops_update ON categories FOR UPDATE
  USING (app_role() IN ('ops', 'system')) WITH CHECK (app_role() IN ('ops', 'system'));

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON products TO app_user;
CREATE POLICY products_select ON products FOR SELECT
  USING (
    (status = 'active' AND app_role() IS NOT NULL)
    OR store_id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY products_seller_insert ON products FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY products_seller_update ON products FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() IN ('trust_safety', 'system'))
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() IN ('trust_safety', 'system'));

ALTER TABLE skus ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON skus TO app_user;
CREATE POLICY skus_select ON skus FOR SELECT
  USING (
    store_id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system')
    OR (app_role() IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = skus.product_id AND p.status = 'active')));
CREATE POLICY skus_seller_insert ON skus FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY skus_seller_update ON skus FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() IN ('trust_safety', 'system'))
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() IN ('trust_safety', 'system'));

ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media TO app_user;
CREATE POLICY product_media_select ON product_media FOR SELECT
  USING (
    store_id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system')
    OR (app_role() IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_media.product_id AND p.status = 'active')));
CREATE POLICY product_media_seller_insert ON product_media FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY product_media_seller_update ON product_media FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system')
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

ALTER TABLE product_defects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_defects TO app_user;
CREATE POLICY product_defects_select ON product_defects FOR SELECT
  USING (
    store_id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system')
    OR (app_role() IS NOT NULL AND EXISTS (SELECT 1 FROM products p WHERE p.id = product_defects.product_id AND p.status = 'active')));
CREATE POLICY product_defects_seller_insert ON product_defects FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY product_defects_seller_update ON product_defects FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system')
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

ALTER TABLE catalog_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON catalog_imports TO app_user;
CREATE POLICY catalog_imports_select ON catalog_imports FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));
CREATE POLICY catalog_imports_insert ON catalog_imports FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY catalog_imports_update ON catalog_imports FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system')
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

ALTER TABLE catalog_import_errors ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON catalog_import_errors TO app_user;
CREATE POLICY catalog_import_errors_select ON catalog_import_errors FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));
CREATE POLICY catalog_import_errors_insert ON catalog_import_errors FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

ALTER TABLE catalog_import_products ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON catalog_import_products TO app_user;
CREATE POLICY catalog_import_products_select ON catalog_import_products FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));
CREATE POLICY catalog_import_products_insert ON catalog_import_products FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

-- Wave 2 (persistence adapter): the gallery is replaced as a whole when a seller edits images, and an
-- import claim is completed with the product id once the product exists.
CREATE POLICY product_media_seller_delete ON product_media FOR DELETE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY product_defects_seller_delete ON product_defects FOR DELETE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
CREATE POLICY catalog_import_products_update ON catalog_import_products FOR UPDATE
  USING ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system')
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');
