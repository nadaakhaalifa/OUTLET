-- Runs once, on first volume init, as superuser `postgres`. Local-only passwords.
-- Roles: outlet_migrator owns schema/DDL; outlet_app is the runtime role (RLS applies to it).
CREATE ROLE outlet_migrator LOGIN PASSWORD 'migrator_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE outlet_app      LOGIN PASSWORD 'app_local_only'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE outlet_dev OWNER outlet_migrator;
ALTER DATABASE outlet_dev SET statement_timeout = '10s';
-- The 2 s reserve-path timeout is NOT a database default: set it per pool/connection
-- (e.g. SET LOCAL statement_timeout = '2s' in the checkout.reserve transaction, or via the checkout pool's options).
ALTER ROLE outlet_app SET search_path = public;

\connect outlet_dev

-- Extensions need superuser (pgcrypto/pg_trgm are trusted, pg_stat_statements is not). pgvector: not in this image, skipped.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO outlet_migrator;
GRANT USAGE ON SCHEMA public TO outlet_app;
-- Tables the migrator creates later are usable by the app role; RLS (ENABLE + FORCE) is added per table in migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE outlet_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO outlet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE outlet_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO outlet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE outlet_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO outlet_app;
