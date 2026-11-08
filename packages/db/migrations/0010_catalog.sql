-- migration: 0010_catalog
-- phase: expand (new tables only)
-- Source: docs/data-model.md 7.9 (Catalog), docs/adr/0009-defect-grading-and-defect-passport.md, docs/api/openapi.yaml.
--
-- Deviations from the ERD (reviewed in the report):
--   * market_id has no FK to markets, geo_areas and media_assets (those tables are not built yet).
--   * sellers is created here (minimal: legal identity per CPL 181/2018 art. shown on every listing); KYC tables are not.
--     The legal-identity columns are nullable while the seller is draft and CHECKed present once status = 'active'.
--     governorate is stored as governorate_code + governorate_name_ar until geo_areas exists.
--   * item_units stores passport_token_hash (SHA-256 of the 128-bit QR token) instead of the plain passport_code, so a
--     database read never reveals a working QR token; the token is shown once at issue (like gift-card codes).
--   * products.version (optimistic lock, C6) is added to the ERD columns.
--   * Public reads: the RLS audit (ADR-0011) only allows exception policies TO outlet_auth/outlet_worker, so a
--     "public read" policy on a tenant table is not possible without weakening it. Instead the published, P0-only read
--     model lives in catalog_public_* tables (no store_id column, no RLS, SELECT-only data, residency cell_publishable)
--     written in the same transaction as the source row by the catalog services. The tenant tables stay fully isolated.
--     Their store key column is named store_ref on purpose: it is a pointer to public data, not a tenant key.

-- ---------------------------------------------------------------- taxonomy (global, tenant none)
CREATE TABLE attribute_definitions (
  code        text PRIMARY KEY,
  data_type   text NOT NULL CHECK (data_type IN ('enum', 'text', 'number', 'boolean', 'size_run')),
  unit        text,
  enum_values jsonb,
  facetable   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (data_type <> 'enum' OR (enum_values IS NOT NULL AND jsonb_typeof(enum_values) = 'array' AND jsonb_array_length(enum_values) > 0))
);

CREATE TABLE attribute_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  version    int NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE attribute_set_items (
  attribute_set_id uuid NOT NULL REFERENCES attribute_sets (id),
  attribute_code   text NOT NULL REFERENCES attribute_definitions (code),
  required         boolean NOT NULL DEFAULT false,
  facet_rank       smallint,
  PRIMARY KEY (attribute_set_id, attribute_code)
);

CREATE TABLE categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id        uuid REFERENCES categories (id),
  code             text NOT NULL UNIQUE,
  path             text NOT NULL,
  depth            smallint NOT NULL CHECK (depth >= 0),
  vertical         text NOT NULL CHECK (vertical IN ('fashion', 'electronics', 'home', 'kitchen', 'toys', 'beauty', 'pantry')),
  attribute_set_id uuid REFERENCES attribute_sets (id),
  size_system      text,
  sort             int NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path)
);
CREATE INDEX categories_parent_sort_idx ON categories (parent_id, sort);
CREATE INDEX categories_path_idx ON categories (path text_pattern_ops);

CREATE TABLE category_labels (
  category_id uuid NOT NULL REFERENCES categories (id),
  locale      text NOT NULL CHECK (locale IN ('ar', 'en')),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  slug        text NOT NULL,
  PRIMARY KEY (category_id, locale)
);
CREATE INDEX category_labels_slug_idx ON category_labels (locale, slug);

-- Per-market visibility. A category is visible in a market only when a row with active = true exists.
CREATE TABLE market_categories (
  market_id   text NOT NULL,
  category_id uuid NOT NULL REFERENCES categories (id),
  active      boolean NOT NULL DEFAULT true,
  restriction jsonb,
  PRIMARY KEY (market_id, category_id)
);
CREATE INDEX market_categories_category_idx ON market_categories (category_id);

CREATE TABLE condition_grades (
  code                     text PRIMARY KEY,
  vertical                 text,
  label_ar                 text NOT NULL,
  label_en                 text NOT NULL,
  schema_org_condition     text NOT NULL,
  requires_defect_card     boolean NOT NULL,
  requires_condition_photo boolean NOT NULL,
  sort                     smallint NOT NULL,
  active                   boolean NOT NULL DEFAULT true
);

CREATE TABLE defect_types (
  code             text PRIMARY KEY,
  vertical         text,
  label_ar         text NOT NULL,
  label_en         text NOT NULL,
  default_severity text NOT NULL CHECK (default_severity IN ('minor', 'major')),
  is_critical      boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- sellers, brands, stores
-- Seller legal identity is published by legal duty (P0 by CPL 181/2018; V75 for sole traders).
CREATE TABLE sellers (
  id                     uuid PRIMARY KEY,
  home_market_id         text NOT NULL,
  market_id              text NOT NULL,
  legal_type             text NOT NULL CHECK (legal_type IN ('company', 'sole_trader')),
  legal_name_ar          text,
  legal_name_en          text,
  commercial_register_no text,
  tax_card_no            text,
  governorate_code       text,
  governorate_name_ar    text,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'kyc_pending', 'active', 'suspended', 'closed')),
  risk_tier              text NOT NULL DEFAULT 'normal' CHECK (risk_tier IN ('low', 'normal', 'high')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR (
    length(btrim(coalesce(legal_name_ar, ''))) > 0 AND length(btrim(coalesce(commercial_register_no, ''))) > 0
    AND length(btrim(coalesce(tax_card_no, ''))) > 0 AND length(btrim(coalesce(governorate_name_ar, ''))) > 0))
);
CREATE UNIQUE INDEX sellers_market_cr_uidx ON sellers (market_id, commercial_register_no) WHERE commercial_register_no IS NOT NULL;

CREATE TABLE brands (
  id               uuid PRIMARY KEY,
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  normalized_name  text NOT NULL UNIQUE,
  slug             text NOT NULL UNIQUE,
  logo_media_id    uuid,
  is_verified      boolean NOT NULL DEFAULT false,
  owner_seller_id  uuid REFERENCES sellers (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brands_owner_idx ON brands (owner_seller_id) WHERE owner_seller_id IS NOT NULL;

CREATE TABLE stores (
  id                    uuid PRIMARY KEY,
  seller_id             uuid NOT NULL REFERENCES sellers (id),
  market_id             text NOT NULL,
  slug                  text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name_ar       text NOT NULL CHECK (length(btrim(display_name_ar)) > 0),
  display_name_en       text,
  tagline_ar            text,
  tagline_en            text,
  kind                  text NOT NULL CHECK (kind IN ('local', 'global')),
  ships_from_country    char(2) NOT NULL,
  primary_category_id   uuid REFERENCES categories (id),
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'VACATION', 'SUSPENDED', 'CLOSED')),
  verified_badge        boolean NOT NULL DEFAULT false,
  health_score          smallint CHECK (health_score BETWEEN 0 AND 100),
  price_trust_score     smallint CHECK (price_trust_score BETWEEN 0 AND 100),
  discount_display_mode text NOT NULL DEFAULT 'public' CHECK (discount_display_mode IN ('public', 'member_only', 'hidden')),
  followers_count       int NOT NULL DEFAULT 0,
  version               int NOT NULL DEFAULT 1,
  launched_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, slug)
);
CREATE INDEX stores_seller_idx ON stores (seller_id);
CREATE INDEX stores_directory_idx ON stores (market_id, status, kind, health_score DESC, id);
CREATE INDEX stores_category_idx ON stores (market_id, primary_category_id, status);

-- stores has no store_id column: the tenant key is the row id (data-model 7.x). Same predicate shape as enable_store_rls.
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_store_isolation ON stores
  USING (id = app.current_store_id() AND market_id = app.current_market_id())
  WITH CHECK (id = app.current_store_id() AND market_id = app.current_market_id());

-- ---------------------------------------------------------------- products (listings), skus (variants)
CREATE TABLE products (
  id                      uuid PRIMARY KEY,
  store_id                uuid NOT NULL REFERENCES stores (id),
  market_id               text NOT NULL,
  brand_id                uuid REFERENCES brands (id),
  primary_category_id     uuid NOT NULL REFERENCES categories (id),
  status                  text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'PAUSED', 'SOLD_OUT', 'ARCHIVED', 'BLOCKED')),
  title_ar                text NOT NULL DEFAULT '',
  title_en                text,
  description_ar          text NOT NULL DEFAULT '',
  description_en          text,
  condition_grade_code    text NOT NULL REFERENCES condition_grades (code),
  stock_reason            text CHECK (stock_reason IN ('previous_season', 'overstock', 'end_of_line', 'customer_return', 'near_expiry')),
  defect_card_id          uuid,
  attributes              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  colour_code             text GENERATED ALWAYS AS (attributes ->> 'colour') STORED,
  size_chart_id           uuid,
  warranty_months         smallint,
  warranty_kind           text CHECK (warranty_kind IN ('seller', 'brand', 'none')),
  included_accessories_ar text,
  origin_country          char(2),
  search_version          bigint NOT NULL DEFAULT 1,
  version                 int NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  -- CPL 181/2018: Arabic title and description are mandatory on anything shoppers can see.
  CHECK (status IN ('DRAFT', 'ARCHIVED', 'BLOCKED') OR (length(btrim(title_ar)) > 0 AND length(btrim(description_ar)) > 0))
);
CREATE INDEX products_store_status_updated_idx ON products (store_id, status, updated_at DESC, id DESC);
CREATE INDEX products_store_updated_idx ON products (store_id, updated_at DESC, id DESC);
CREATE INDEX products_category_status_idx ON products (primary_category_id, status, id);
CREATE INDEX products_market_published_idx ON products (market_id, published_at DESC, id DESC) WHERE status = 'PUBLISHED';
CREATE INDEX products_store_published_idx ON products (store_id, published_at DESC, id DESC) WHERE status = 'PUBLISHED';
CREATE INDEX products_brand_status_idx ON products (brand_id, status) WHERE brand_id IS NOT NULL;
CREATE INDEX products_attributes_gin ON products USING gin (attributes jsonb_path_ops);
SELECT app.enable_store_rls('products');

CREATE TABLE product_categories (
  product_id  uuid NOT NULL REFERENCES products (id),
  category_id uuid NOT NULL REFERENCES categories (id),
  store_id    uuid NOT NULL REFERENCES stores (id),
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category_idx ON product_categories (category_id, product_id);
SELECT app.enable_store_rls('product_categories');

CREATE TABLE skus (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL REFERENCES products (id),
  store_id      uuid NOT NULL REFERENCES stores (id),
  market_id     text NOT NULL,
  seller_sku    text NOT NULL CHECK (length(btrim(seller_sku)) > 0),
  gtin          text,
  option_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(option_values) = 'object'),
  size_label    text GENERATED ALWAYS AS (option_values ->> 'size') STORED,
  -- Current VAT-inclusive price. compare_at is deliberately absent: a shown "was" price comes only from Price Watch (VRP).
  price_minor   bigint NOT NULL CHECK (price_minor > 0),
  currency      char(3) NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, seller_sku)
);
CREATE INDEX skus_product_idx ON skus (product_id, status);
CREATE INDEX skus_gtin_idx ON skus (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX skus_market_size_idx ON skus (market_id, size_label, status);
SELECT app.enable_store_rls('skus');

CREATE TABLE product_media (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products (id),
  store_id   uuid NOT NULL REFERENCES stores (id),
  media_id   uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('main', 'gallery', 'condition', 'defect', 'packaging', 'video')),
  position   smallint NOT NULL,
  alt_ar     text,
  alt_en     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, position)
);
SELECT app.enable_store_rls('product_media');

-- ---------------------------------------------------------------- defect cards (immutable versions), items, passports
CREATE TABLE defect_cards (
  id               uuid PRIMARY KEY,
  product_id       uuid NOT NULL REFERENCES products (id),
  store_id         uuid NOT NULL REFERENCES stores (id),
  market_id        text NOT NULL,
  version          int NOT NULL CHECK (version >= 1),
  grade_code       text NOT NULL REFERENCES condition_grades (code),
  stock_reason     text,
  summary_ar       text NOT NULL CHECK (length(btrim(summary_ar)) > 0),
  summary_en       text,
  affects_function boolean NOT NULL,
  defect_count     smallint NOT NULL CHECK (defect_count >= 0),
  inspected_by     text NOT NULL CHECK (inspected_by IN ('seller', 'hub')),
  inspected_at     timestamptz NOT NULL,
  ai_flag_status   text NOT NULL DEFAULT 'none' CHECK (ai_flag_status IN ('none', 'flagged_undeclared', 'cleared')),
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
CREATE INDEX defect_cards_store_idx ON defect_cards (store_id, product_id);
SELECT app.enable_store_rls('defect_cards');
ALTER TABLE products ADD CONSTRAINT products_defect_card_fk FOREIGN KEY (defect_card_id) REFERENCES defect_cards (id);

CREATE TABLE defect_items (
  id               uuid PRIMARY KEY,
  defect_card_id   uuid NOT NULL REFERENCES defect_cards (id),
  store_id         uuid NOT NULL REFERENCES stores (id),
  defect_type_code text NOT NULL REFERENCES defect_types (code),
  location_ar      text NOT NULL CHECK (length(btrim(location_ar)) > 0),
  location_en      text,
  size_mm          int CHECK (size_mm >= 0),
  severity         text NOT NULL CHECK (severity IN ('minor', 'major')),
  affects_function boolean NOT NULL,
  photo_media_id   uuid NOT NULL,
  hotspot_media_id uuid,
  hotspot_x_bp     int CHECK (hotspot_x_bp BETWEEN 0 AND 10000),
  hotspot_y_bp     int CHECK (hotspot_y_bp BETWEEN 0 AND 10000),
  note_ar          text,
  note_en          text,
  position         smallint NOT NULL,
  UNIQUE (defect_card_id, position)
);
SELECT app.enable_store_rls('defect_items');

-- Defect cards are immutable versions: only published_at may be set once; items are never edited or deleted.
CREATE FUNCTION catalog_defect_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_TABLE_NAME = 'defect_cards' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') OR OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'defect_cards are immutable versions; create a new version' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER defect_cards_immutable BEFORE UPDATE OR DELETE ON defect_cards FOR EACH ROW EXECUTE FUNCTION catalog_defect_immutable();
CREATE TRIGGER defect_items_immutable BEFORE UPDATE OR DELETE ON defect_items FOR EACH ROW EXECUTE FUNCTION catalog_defect_immutable();

-- Critical (safety) defect types can never be listed (ADR-0009, V69).
CREATE FUNCTION catalog_defect_not_critical() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM defect_types WHERE code = NEW.defect_type_code AND is_critical) THEN
    RAISE EXCEPTION 'critical defect type % cannot be listed', NEW.defect_type_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER defect_items_not_critical BEFORE INSERT ON defect_items FOR EACH ROW EXECUTE FUNCTION catalog_defect_not_critical();

CREATE TABLE item_units (
  id                  uuid PRIMARY KEY,
  store_id            uuid NOT NULL REFERENCES stores (id),
  market_id           text NOT NULL,
  product_id          uuid NOT NULL REFERENCES products (id),
  sku_id              uuid NOT NULL REFERENCES skus (id),
  defect_card_id      uuid NOT NULL REFERENCES defect_cards (id),
  passport_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(passport_token_hash) = 32),
  content_hash        bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  status              text NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'RETURNED', 'RELISTED', 'WRITTEN_OFF', 'DONATED')),
  inspected_at        timestamptz NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_units_sku_status_idx ON item_units (sku_id, status);
CREATE INDEX item_units_store_status_idx ON item_units (store_id, status, id);
SELECT app.enable_store_rls('item_units');

-- ---------------------------------------------------------------- published read model (P0 only, no tenant column)
CREATE TABLE catalog_public_stores (
  id                    uuid PRIMARY KEY,
  market_id             text NOT NULL,
  slug                  text NOT NULL,
  display_name_ar       text NOT NULL,
  display_name_en       text,
  tagline_ar            text,
  tagline_en            text,
  kind                  text NOT NULL,
  status                text NOT NULL CHECK (status IN ('ACTIVE', 'VACATION')),
  verified_badge        boolean NOT NULL,
  ships_from_country    char(2) NOT NULL,
  followers_count       int NOT NULL,
  discount_display_mode text NOT NULL,
  price_trust_score     smallint,
  legal_identity        jsonb NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (market_id, slug)
);

CREATE TABLE catalog_public_listings (
  id                   uuid PRIMARY KEY,
  store_ref            uuid NOT NULL,
  market_id            text NOT NULL,
  store                jsonb NOT NULL,
  status               text NOT NULL CHECK (status IN ('PUBLISHED', 'SOLD_OUT', 'PAUSED')),
  title_ar             text NOT NULL,
  title_en             text,
  description_ar       text NOT NULL,
  description_en       text,
  brand_id             uuid,
  brand_name           text,
  primary_category_id  uuid NOT NULL,
  condition_grade_code text NOT NULL,
  condition_grade      jsonb NOT NULL,
  stock_reason         text,
  colour_code          text,
  main_media_id        uuid,
  main_media_alt_ar    text,
  defect_count         smallint NOT NULL DEFAULT 0,
  min_price_minor      bigint NOT NULL,
  currency             char(3) NOT NULL,
  attributes           jsonb NOT NULL,
  variants             jsonb NOT NULL,
  defect_card          jsonb,
  version              int NOT NULL,
  published_at         timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
CREATE INDEX catalog_public_listings_store_idx ON catalog_public_listings (store_ref, published_at DESC, id DESC) WHERE status = 'PUBLISHED';
CREATE INDEX catalog_public_listings_category_idx ON catalog_public_listings (market_id, primary_category_id, published_at DESC, id DESC) WHERE status = 'PUBLISHED';

CREATE TABLE catalog_public_passports (
  token_hash     bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  market_id      text NOT NULL,
  product_id     uuid NOT NULL,
  title_ar       text NOT NULL,
  title_en       text,
  store_slug     text NOT NULL,
  store_name_ar  text NOT NULL,
  unit_status    text NOT NULL,
  condition_grade jsonb NOT NULL,
  defect_card    jsonb NOT NULL,
  content_hash   text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  inspections    jsonb NOT NULL,
  issued_at      timestamptz NOT NULL
);

-- ---------------------------------------------------------------- privileges
-- Reference data and sellers are read-only for the request path; brands may be created (never edited) by sellers.
REVOKE INSERT, UPDATE, DELETE ON attribute_definitions, attribute_sets, attribute_set_items, categories, category_labels,
  market_categories, condition_grades, defect_types, sellers FROM outlet_app;
REVOKE UPDATE, DELETE ON brands FROM outlet_app;
REVOKE DELETE ON stores, products, skus, defect_cards, defect_items, item_units FROM outlet_app;
REVOKE DELETE ON catalog_public_passports FROM outlet_app;

-- ---------------------------------------------------------------- seed: D6 launch categories (women's, modest, kids)
INSERT INTO attribute_definitions (code, data_type, unit, enum_values, facetable) VALUES
  ('colour', 'enum', NULL, '[{"code":"black","label_ar":"أسود","label_en":"Black"},{"code":"white","label_ar":"أبيض","label_en":"White"},{"code":"beige","label_ar":"بيج","label_en":"Beige"},{"code":"navy","label_ar":"كحلي","label_en":"Navy"},{"code":"red","label_ar":"أحمر","label_en":"Red"},{"code":"green","label_ar":"أخضر","label_en":"Green"},{"code":"pink","label_ar":"وردي","label_en":"Pink"},{"code":"blue","label_ar":"أزرق","label_en":"Blue"},{"code":"grey","label_ar":"رمادي","label_en":"Grey"},{"code":"multi","label_ar":"متعدد الألوان","label_en":"Multicolour"}]', true),
  ('material', 'enum', NULL, '[{"code":"cotton","label_ar":"قطن","label_en":"Cotton"},{"code":"linen","label_ar":"كتان","label_en":"Linen"},{"code":"polyester","label_ar":"بوليستر","label_en":"Polyester"},{"code":"viscose","label_ar":"فيسكوز","label_en":"Viscose"},{"code":"wool","label_ar":"صوف","label_en":"Wool"},{"code":"denim","label_ar":"جينز","label_en":"Denim"},{"code":"leather","label_ar":"جلد","label_en":"Leather"},{"code":"crepe","label_ar":"كريب","label_en":"Crepe"},{"code":"chiffon","label_ar":"شيفون","label_en":"Chiffon"}]', true),
  ('fit', 'enum', NULL, '[{"code":"slim","label_ar":"ضيق","label_en":"Slim"},{"code":"regular","label_ar":"عادي","label_en":"Regular"},{"code":"loose","label_ar":"واسع","label_en":"Loose"}]', true),
  ('sleeve_length', 'enum', NULL, '[{"code":"sleeveless","label_ar":"بدون أكمام","label_en":"Sleeveless"},{"code":"short","label_ar":"قصير","label_en":"Short"},{"code":"three_quarter","label_ar":"ثلاثة أرباع","label_en":"Three-quarter"},{"code":"long","label_ar":"طويل","label_en":"Long"}]', true),
  ('season', 'enum', NULL, '[{"code":"summer","label_ar":"صيفي","label_en":"Summer"},{"code":"winter","label_ar":"شتوي","label_en":"Winter"},{"code":"all_year","label_ar":"طوال العام","label_en":"All year"}]', true),
  ('coverage', 'enum', NULL, '[{"code":"full","label_ar":"تغطية كاملة","label_en":"Full coverage"},{"code":"semi","label_ar":"تغطية جزئية","label_en":"Semi coverage"}]', true),
  ('age_group', 'enum', NULL, '[{"code":"baby","label_ar":"رضع","label_en":"Baby"},{"code":"toddler","label_ar":"أطفال صغار","label_en":"Toddler"},{"code":"kids","label_ar":"أطفال","label_en":"Kids"},{"code":"teen","label_ar":"مراهقون","label_en":"Teen"}]', true),
  ('drawstring_free', 'boolean', NULL, NULL, true),
  ('care_notes_ar', 'text', NULL, NULL, false),
  ('size_run', 'size_run', 'cm', NULL, false);

INSERT INTO attribute_sets (id, code, version) VALUES
  ('00000000-0000-4000-8000-0000000a0001', 'fashion_women', 1),
  ('00000000-0000-4000-8000-0000000a0002', 'fashion_modest', 1),
  ('00000000-0000-4000-8000-0000000a0003', 'fashion_kids', 1);

INSERT INTO attribute_set_items (attribute_set_id, attribute_code, required, facet_rank) VALUES
  ('00000000-0000-4000-8000-0000000a0001', 'colour', true, 1),
  ('00000000-0000-4000-8000-0000000a0001', 'material', true, 2),
  ('00000000-0000-4000-8000-0000000a0001', 'size_run', true, NULL),
  ('00000000-0000-4000-8000-0000000a0001', 'fit', false, 3),
  ('00000000-0000-4000-8000-0000000a0001', 'sleeve_length', false, 4),
  ('00000000-0000-4000-8000-0000000a0001', 'season', false, 5),
  ('00000000-0000-4000-8000-0000000a0001', 'care_notes_ar', false, NULL),
  ('00000000-0000-4000-8000-0000000a0002', 'colour', true, 1),
  ('00000000-0000-4000-8000-0000000a0002', 'material', true, 2),
  ('00000000-0000-4000-8000-0000000a0002', 'size_run', true, NULL),
  ('00000000-0000-4000-8000-0000000a0002', 'coverage', true, 3),
  ('00000000-0000-4000-8000-0000000a0002', 'sleeve_length', true, 4),
  ('00000000-0000-4000-8000-0000000a0002', 'fit', false, 5),
  ('00000000-0000-4000-8000-0000000a0002', 'season', false, 6),
  ('00000000-0000-4000-8000-0000000a0002', 'care_notes_ar', false, NULL),
  ('00000000-0000-4000-8000-0000000a0003', 'colour', true, 1),
  ('00000000-0000-4000-8000-0000000a0003', 'material', true, 2),
  ('00000000-0000-4000-8000-0000000a0003', 'size_run', true, NULL),
  ('00000000-0000-4000-8000-0000000a0003', 'age_group', true, 3),
  ('00000000-0000-4000-8000-0000000a0003', 'drawstring_free', true, 4),
  ('00000000-0000-4000-8000-0000000a0003', 'season', false, 5),
  ('00000000-0000-4000-8000-0000000a0003', 'care_notes_ar', false, NULL);

-- Tree: fashion > {women, modest, kids} > leaves. The attribute set hangs on the level-2 node and leaves inherit it.
INSERT INTO categories (id, parent_id, code, path, depth, vertical, attribute_set_id, size_system, sort) VALUES
  ('00000000-0000-4000-8000-0000000c0001', NULL, 'fashion', 'fashion', 0, 'fashion', NULL, NULL, 10),
  ('00000000-0000-4000-8000-0000000c0010', '00000000-0000-4000-8000-0000000c0001', 'women', 'fashion/women', 1, 'fashion', '00000000-0000-4000-8000-0000000a0001', 'women_eu', 10),
  ('00000000-0000-4000-8000-0000000c0020', '00000000-0000-4000-8000-0000000c0001', 'modest', 'fashion/modest', 1, 'fashion', '00000000-0000-4000-8000-0000000a0002', 'women_eu', 20),
  ('00000000-0000-4000-8000-0000000c0030', '00000000-0000-4000-8000-0000000c0001', 'kids', 'fashion/kids', 1, 'fashion', '00000000-0000-4000-8000-0000000a0003', 'kids_age', 30),
  ('00000000-0000-4000-8000-0000000c0011', '00000000-0000-4000-8000-0000000c0010', 'women_dresses', 'fashion/women/dresses', 2, 'fashion', NULL, NULL, 10),
  ('00000000-0000-4000-8000-0000000c0012', '00000000-0000-4000-8000-0000000c0010', 'women_tops', 'fashion/women/tops', 2, 'fashion', NULL, NULL, 20),
  ('00000000-0000-4000-8000-0000000c0013', '00000000-0000-4000-8000-0000000c0010', 'women_bottoms', 'fashion/women/bottoms', 2, 'fashion', NULL, NULL, 30),
  ('00000000-0000-4000-8000-0000000c0014', '00000000-0000-4000-8000-0000000c0010', 'women_outerwear', 'fashion/women/outerwear', 2, 'fashion', NULL, NULL, 40),
  ('00000000-0000-4000-8000-0000000c0021', '00000000-0000-4000-8000-0000000c0020', 'modest_abayas', 'fashion/modest/abayas', 2, 'fashion', NULL, NULL, 10),
  ('00000000-0000-4000-8000-0000000c0022', '00000000-0000-4000-8000-0000000c0020', 'modest_hijabs', 'fashion/modest/hijabs', 2, 'fashion', NULL, NULL, 20),
  ('00000000-0000-4000-8000-0000000c0023', '00000000-0000-4000-8000-0000000c0020', 'modest_dresses', 'fashion/modest/dresses', 2, 'fashion', NULL, NULL, 30),
  ('00000000-0000-4000-8000-0000000c0031', '00000000-0000-4000-8000-0000000c0030', 'kids_girls', 'fashion/kids/girls', 2, 'fashion', NULL, NULL, 10),
  ('00000000-0000-4000-8000-0000000c0032', '00000000-0000-4000-8000-0000000c0030', 'kids_boys', 'fashion/kids/boys', 2, 'fashion', NULL, NULL, 20),
  ('00000000-0000-4000-8000-0000000c0033', '00000000-0000-4000-8000-0000000c0030', 'kids_baby', 'fashion/kids/baby', 2, 'fashion', NULL, NULL, 30);

INSERT INTO category_labels (category_id, locale, name, slug)
SELECT c.id, l.locale, l.name, l.slug
  FROM categories c
  JOIN (VALUES
    ('fashion', 'ar', 'أزياء', 'azyaa'), ('fashion', 'en', 'Fashion', 'fashion'),
    ('women', 'ar', 'أزياء نسائية', 'azyaa-nisaaiya'), ('women', 'en', 'Women', 'women'),
    ('modest', 'ar', 'أزياء محتشمة', 'azyaa-muhtashama'), ('modest', 'en', 'Modest fashion', 'modest'),
    ('kids', 'ar', 'أطفال', 'atfal'), ('kids', 'en', 'Kids', 'kids'),
    ('women_dresses', 'ar', 'فساتين', 'fasateen'), ('women_dresses', 'en', 'Dresses', 'dresses'),
    ('women_tops', 'ar', 'بلوزات وقمصان', 'bluzat'), ('women_tops', 'en', 'Tops', 'tops'),
    ('women_bottoms', 'ar', 'بناطيل وتنانير', 'banateel'), ('women_bottoms', 'en', 'Bottoms', 'bottoms'),
    ('women_outerwear', 'ar', 'جاكيتات ومعاطف', 'jaketat'), ('women_outerwear', 'en', 'Outerwear', 'outerwear'),
    ('modest_abayas', 'ar', 'عبايات', 'abayat'), ('modest_abayas', 'en', 'Abayas', 'abayas'),
    ('modest_hijabs', 'ar', 'حجابات', 'hijabat'), ('modest_hijabs', 'en', 'Hijabs', 'hijabs'),
    ('modest_dresses', 'ar', 'فساتين محتشمة', 'fasateen-muhtashama'), ('modest_dresses', 'en', 'Modest dresses', 'modest-dresses'),
    ('kids_girls', 'ar', 'بنات', 'banat'), ('kids_girls', 'en', 'Girls', 'girls'),
    ('kids_boys', 'ar', 'أولاد', 'awlad'), ('kids_boys', 'en', 'Boys', 'boys'),
    ('kids_baby', 'ar', 'رضع', 'rudda'), ('kids_baby', 'en', 'Baby', 'baby')
  ) AS l (code, locale, name, slug) ON l.code = c.code;

-- Launch market EG: every seeded category visible.
INSERT INTO market_categories (market_id, category_id, active) SELECT 'EG', id, true FROM categories;

-- ADR-0009 closed grade list. refurbished and pre_owned are disabled at launch (fashion categories, D6).
INSERT INTO condition_grades (code, vertical, label_ar, label_en, schema_org_condition, requires_defect_card, requires_condition_photo, sort, active) VALUES
  ('new_with_tags', NULL, 'جديد بالتيكت', 'New with tags', 'NewCondition', false, false, 10, true),
  ('new_with_imperfections', NULL, 'جديد مع عيوب بسيطة', 'New with imperfections', 'DamagedCondition', true, true, 20, true),
  ('sample', NULL, 'عينة', 'Sample', 'UsedCondition', false, true, 30, true),
  ('open_box', NULL, 'علبة مفتوحة', 'Open box', 'UsedCondition', true, true, 40, true),
  ('refurbished', 'electronics', 'مجدد', 'Refurbished', 'RefurbishedCondition', true, true, 50, false),
  ('pre_owned', NULL, 'مستعمل', 'Pre-owned', 'UsedCondition', true, true, 60, false);

INSERT INTO defect_types (code, vertical, label_ar, label_en, default_severity, is_critical) VALUES
  ('stain', 'fashion', 'بقعة أو تغير لون', 'Stain or discoloration', 'minor', false),
  ('hole_tear', 'fashion', 'خرم أو قطع', 'Hole or tear', 'major', false),
  ('missing_button', 'fashion', 'زرار ناقص أو تالف', 'Missing or damaged button', 'minor', false),
  ('broken_zip', 'fashion', 'سوستة مكسورة', 'Broken zip or hardware', 'major', false),
  ('open_seam', 'fashion', 'خياطة مفتوحة', 'Open seam or stitching flaw', 'minor', false),
  ('pilling', 'fashion', 'وبر على القماش', 'Pilling', 'minor', false),
  ('fading', 'fashion', 'بهتان اللون', 'Fading', 'minor', false),
  ('print_misaligned', 'fashion', 'طباعة غير مضبوطة', 'Print misalignment', 'minor', false),
  ('wrong_size_tag', 'fashion', 'تيكت مقاس غلط', 'Wrong size tag', 'minor', false),
  ('odour', 'fashion', 'رائحة', 'Odour', 'minor', false),
  ('packaging_damaged', NULL, 'تغليف تالف', 'Packaging damage', 'minor', false),
  ('drawstring_child', 'fashion', 'رباط عنق أو خصر في ملابس الأطفال', 'Drawstring on child clothing (safety)', 'major', true),
  ('loose_small_part', 'fashion', 'أجزاء صغيرة سائبة (خطر ابتلاع)', 'Loose small parts (choking hazard)', 'major', true);
