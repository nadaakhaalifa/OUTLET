-- migration: 0022_search_index
-- phase: expand (new table only)
-- Source: docs/adr/0010-search-engine-bake-off.md (Postgres FTS is the kill-switch fallback), master prompt section 4,
--         BUILD-PROMPT section 3 (keyset, p95 < 150 ms). Package: @outlet/search.
--
-- search_documents is a PUBLIC (P0) read model, like catalog_public_listings: published listing fields only, no store_id /
-- user_id tenant key (store_ref and product_id are pointers), no personal data, so there is no RLS to enforce. The write path is the
-- search.sync worker job (inbox consumer); shoppers only SELECT. Stock and price are re-checked from Postgres on the PDP and bag.
--
-- Extensions: unaccent and pg_trgm are used when the server has them (managed Postgres does). When missing (bare PGlite) the
-- arabic_simple config degrades to plain 'simple' and the trigram index is skipped; the migration never fails on that.
-- Text is normalised by the application (Arabic folding, digits to ASCII) before it is stored, exactly as at query time.

DO $do$
BEGIN
  BEGIN CREATE EXTENSION IF NOT EXISTS unaccent; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm;  EXCEPTION WHEN OTHERS THEN NULL; END;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'arabic_simple') THEN
    CREATE TEXT SEARCH CONFIGURATION arabic_simple (COPY = pg_catalog.simple);
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
      ALTER TEXT SEARCH CONFIGURATION arabic_simple
        ALTER MAPPING FOR asciiword, word, numword, asciihword, hword, numhword WITH unaccent, simple;
    END IF;
  END IF;
END
$do$;

CREATE TABLE search_documents (
  product_id        uuid NOT NULL,
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  store_ref         uuid NOT NULL,
  category_id       uuid,
  world             text NOT NULL DEFAULT 'local' CHECK (world IN ('local', 'global')),
  title_ar          text NOT NULL,                        -- normalised
  title_en          text NOT NULL DEFAULT '',             -- normalised
  search_text       text NOT NULL,                        -- normalised titles + brand + AR/EN/Franco synonyms of resolved concepts
  tsv               tsvector NOT NULL,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- P0 listing attributes only
  price_minor       bigint NOT NULL CHECK (price_minor >= 0),
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  condition_grade   text NOT NULL,
  sizes             text[] NOT NULL DEFAULT '{}',
  verified_discount boolean NOT NULL DEFAULT false,
  lowest_30d        boolean NOT NULL DEFAULT false,
  in_stock          boolean NOT NULL DEFAULT true,
  is_published      boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL,
  -- Monotonic version: microseconds since epoch of the source event. An older event never overwrites a newer one.
  seq               bigint NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (market_id, product_id)
);
CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX search_documents_sizes_idx ON search_documents USING gin (sizes);
CREATE INDEX search_documents_browse_idx ON search_documents (market_id, product_id) WHERE is_published;
CREATE INDEX search_documents_store_idx ON search_documents (market_id, store_ref) WHERE is_published;
CREATE INDEX search_documents_updated_idx ON search_documents (updated_at);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX search_documents_trgm_idx ON search_documents USING gin (search_text gin_trgm_ops);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON search_documents FROM outlet_app;
    GRANT SELECT ON search_documents TO outlet_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_worker') THEN
    REVOKE ALL ON search_documents FROM outlet_worker;
    GRANT SELECT, INSERT, UPDATE ON search_documents TO outlet_worker;
    GRANT SELECT ON catalog_public_listings TO outlet_worker;
    GRANT SELECT ON sku_price_windows TO outlet_worker;
  END IF;
END
$do$;
