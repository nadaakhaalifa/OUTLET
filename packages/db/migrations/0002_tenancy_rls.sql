-- Tenancy and row-level security helpers (E-06, docs/data-model.md 2.5).
-- The tenant is set per transaction with set_config('app.current_store_id', $1, true)
-- (equivalent to SET LOCAL; never per session, PgBouncer transaction mode would leak it).
-- The application must connect as a non-owner role without BYPASSRLS; migrations run as the owner.

CREATE SCHEMA IF NOT EXISTS app;

-- NULL-safe: an unset or reset setting (empty string after commit) yields NULL, so no row matches.
CREATE OR REPLACE FUNCTION app.current_store_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_store_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_market_id() RETURNS text
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_market_id', true), '') $$;

-- Applies the standard store-isolation policy to a table in schema public that has a uuid store_id column.
-- Idempotent. Must be run by the table owner.
CREATE OR REPLACE FUNCTION app.enable_store_rls(tbl text) RETURNS void
LANGUAGE plpgsql AS
$$
DECLARE
  rel regclass := to_regclass(format('public.%I', tbl));
  pol text := tbl || '_store_isolation';
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'app.enable_store_rls: table public.% does not exist', tbl;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'store_id' AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'app.enable_store_rls: public.% needs a uuid store_id column', tbl;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', rel);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, rel);
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (store_id = app.current_store_id()) WITH CHECK (store_id = app.current_store_id())',
    pol, rel
  );
END
$$;

-- Canary tenant table: gives the RLS test suite and the rls-audit a real target before
-- real tenant tables exist. Holds no business data; safe to keep in every environment.
CREATE TABLE tenancy_rls_smoke (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  market_id text NOT NULL,
  note text NOT NULL DEFAULT ''
);
COMMENT ON TABLE tenancy_rls_smoke IS 'RLS canary: exercised by packages/db tests; no business data.';

SELECT app.enable_store_rls('tenancy_rls_smoke');
