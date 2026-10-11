-- migration: 0023_search
-- phase: expand
--
-- Search (spec 4, docs/specs/search.md).
--   saved_searches   : per-user saved filter, owner RLS (class A, per verb).
--   search_documents : read model of the public catalog used by the Postgres FTS + trigram fallback
--                      (the documented Typesense-down path). Fed by outbox consumers under role 'system'
--                      with a 60 s staleness SLO. Price and stock are ALWAYS re-read from the catalog and
--                      inventory at request time; the values here only pre-filter and rank.
-- product_id, store_id and category_ids are LOGICAL references (catalog tables are owned elsewhere).
-- Money is BIGINT piastres. pg_trgm is optional (0001 feature-detects); its index is created only if present.

CREATE TABLE saved_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  query_text    text CHECK (query_text IS NULL OR char_length(query_text) <= 300),
  filter_json   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter_json) = 'object'),
  alert_enabled boolean NOT NULL DEFAULT false,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_searches_user_created_idx ON saved_searches (user_id, created_at DESC, id DESC);

CREATE TRIGGER saved_searches_touch_updated_at_trg
  BEFORE UPDATE ON saved_searches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- At most 50 saved searches per user, serialised per user with an advisory lock.
CREATE FUNCTION saved_searches_enforce_cap() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saved_searches:' || NEW.user_id::text, 0));
  SELECT count(*) INTO n FROM saved_searches WHERE user_id = NEW.user_id;
  IF n >= 50 THEN
    RAISE EXCEPTION 'user % already holds 50 saved searches', NEW.user_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER saved_searches_cap_trg
  BEFORE INSERT ON saved_searches FOR EACH ROW EXECUTE FUNCTION saved_searches_enforce_cap();

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_searches TO app_user;
CREATE POLICY saved_searches_owner_select ON saved_searches FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY saved_searches_owner_insert ON saved_searches FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY saved_searches_owner_update ON saved_searches FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY saved_searches_owner_delete ON saved_searches FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

CREATE TABLE search_documents (
  product_id             uuid PRIMARY KEY,
  store_id               uuid NOT NULL,
  world                  text NOT NULL CHECK (world IN ('local', 'global')),
  title_ar               text NOT NULL,
  title_en               text,
  -- Normalized (Arabic folding, ASCII digits, lower case) title + brand + keywords. Written by the indexer.
  search_text            text NOT NULL,
  tsv                    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  price_amount           bigint NOT NULL CHECK (price_amount >= 0),
  colors                 text[] NOT NULL DEFAULT '{}',
  materials              text[] NOT NULL DEFAULT '{}',
  condition              text NOT NULL CHECK (condition IN ('new_with_tags', 'new_without_tags', 'sample', 'minor_defect')),
  category_ids           uuid[] NOT NULL DEFAULT '{}',
  verified_discount_pct  integer CHECK (verified_discount_pct IS NULL OR verified_discount_pct BETWEEN 5 AND 100),
  lowest_30d             boolean NOT NULL DEFAULT false,
  free_delivery_eligible boolean NOT NULL DEFAULT false,
  rating                 numeric(2, 1) CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  sponsored              boolean NOT NULL DEFAULT false,
  in_stock               boolean NOT NULL DEFAULT true,
  listed_at              timestamptz NOT NULL DEFAULT now(),
  indexed_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX search_documents_store_idx ON search_documents (store_id);
CREATE INDEX search_documents_price_idx ON search_documents (price_amount);
CREATE INDEX search_documents_listed_idx ON search_documents (listed_at DESC, product_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX search_documents_trgm_idx ON search_documents USING gin (search_text gin_trgm_ops)';
  ELSE
    RAISE NOTICE 'pg_trgm not installed: trigram fallback disabled, FTS only';
  END IF;
END
$$;

-- Public catalog projection: every role may read; only the indexer (system) writes.
ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON search_documents TO app_user;
CREATE POLICY search_documents_public_select ON search_documents FOR SELECT USING (true);
GRANT INSERT, UPDATE, DELETE ON search_documents TO app_user;
CREATE POLICY search_documents_system_insert ON search_documents FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY search_documents_system_update ON search_documents FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY search_documents_system_delete ON search_documents FOR DELETE USING (app_role() = 'system');
