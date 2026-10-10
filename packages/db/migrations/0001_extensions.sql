-- migration: 0001_extensions
-- phase: expand
--
-- Optional extensions, installed only where the server offers them (spec T3).
-- Nothing in later migrations may depend on these: core code uses built-ins
-- (gen_random_uuid() and sha256() are in core since PostgreSQL 13 / 11).
--   pgcrypto  : convenience digests / HMAC helpers for ops scripts
--   pg_trgm   : fuzzy admin search later
--   citext    : case-insensitive text where needed later
--   vector    : pgvector, for the Phase 1+ semantic search / recommendations
--   pg_cron   : scheduled purge and integrity jobs (production only; it must be
--               created in the database named by cron.database_name)
-- A missing extension is reported as a NOTICE, never as a failure. The
-- application must feature-detect via pg_extension.

DO $$
DECLARE
  ext text;
BEGIN
  FOREACH ext IN ARRAY ARRAY['pgcrypto', 'pg_trgm', 'citext', 'vector', 'pg_cron']
  LOOP
    BEGIN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I', ext);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'extension % not installed: % (%)', ext, SQLERRM, SQLSTATE;
    END;
  END LOOP;
END
$$;
