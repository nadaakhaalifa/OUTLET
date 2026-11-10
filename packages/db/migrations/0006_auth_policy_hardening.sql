-- migration: 0006_auth_policy_hardening
-- phase: expand (one tightening: otp_challenges.device_id becomes NOT NULL + FK; pre-launch, challenges are ephemeral)
-- Chief-review findings H1, M2, M8, L7.
--
-- NOTE for the application layer: with FORCE RLS on the identity tables, any code path that runs
-- before a user is known (OTP verify, device registration, refresh-token rotation) cannot run as the
-- plain app role. Those paths need a dedicated narrow-privilege role/SECURITY DEFINER functions;
-- that is deliberately NOT created here (see the report). refresh_tokens has no user_id and is
-- reachable only by token hash through its session family, so it carries no user policy.

-- H1: a challenge is bound to a registered device.
DELETE FROM otp_challenges WHERE device_id IS NULL;
ALTER TABLE otp_challenges ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_device_fk FOREIGN KEY (device_id) REFERENCES devices (id);

-- M2: absolute family expiry is a revoke reason.
ALTER TABLE session_families DROP CONSTRAINT session_families_revoke_reason_check;
ALTER TABLE session_families ADD CONSTRAINT session_families_revoke_reason_check
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('logout', 'reuse_detected', 'admin', 'password_change', 'absolute_expiry'));

-- M8: user-scoped tenancy.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

-- Applies the standard user-isolation policy to public.<tbl>, keyed on <col> (default user_id, uuid).
-- Idempotent. Must be run by the table owner.
CREATE OR REPLACE FUNCTION app.enable_user_rls(tbl text, col text DEFAULT 'user_id') RETURNS void
LANGUAGE plpgsql AS
$$
DECLARE
  rel regclass := to_regclass(format('public.%I', tbl));
  pol text := tbl || '_user_isolation';
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'app.enable_user_rls: table public.% does not exist', tbl;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = col AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'app.enable_user_rls: public.% needs a uuid % column', tbl, col;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', rel);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, rel);
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (%I = app.current_user_id()) WITH CHECK (%I = app.current_user_id())',
    pol, rel, col, col
  );
END
$$;

-- L7: store policy also pins the market when the table has a market_id column.
CREATE OR REPLACE FUNCTION app.enable_store_rls(tbl text) RETURNS void
LANGUAGE plpgsql AS
$$
DECLARE
  rel regclass := to_regclass(format('public.%I', tbl));
  pol text := tbl || '_store_isolation';
  cond text := 'store_id = app.current_store_id()';
BEGIN
  IF rel IS NULL THEN
    RAISE EXCEPTION 'app.enable_store_rls: table public.% does not exist', tbl;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'store_id' AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'app.enable_store_rls: public.% needs a uuid store_id column', tbl;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'market_id' AND NOT attisdropped
  ) THEN
    cond := cond || ' AND market_id = app.current_market_id()';
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', rel);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, rel);
  EXECUTE format('CREATE POLICY %I ON %s USING (%s) WITH CHECK (%s)', pol, rel, cond, cond);
END
$$;

SELECT app.enable_store_rls('tenancy_rls_smoke');

SELECT app.enable_user_rls('users', 'id');
SELECT app.enable_user_rls('user_identities');
SELECT app.enable_user_rls('session_families');
SELECT app.enable_user_rls('age_attestations');

-- Known gap until 0007 (ADR-0011): pre-auth paths and workers run only as superuser in tests;
-- production requires 0007 before any deploy.
-- devices (user_id NULL before sign-in) and consent_records (user_id NULL for a visitor banner) are
-- deliberately NOT given user RLS here: they must stay reachable pre-auth. 0007 adds role-scoped policies.
-- The DO block below never touches a table whose key column is nullable (attnotnull filter).
-- Tables it applies to today (user_id uuid NOT NULL, no store_id, no policy yet), per 0003/0004:
--   consent_state (0004), privacy_requests (0004). Explicit calls above cover users,
--   user_identities, session_families, age_attestations.
-- Every other table that exists now and is keyed by a uuid user_id (consent and privacy tables from 0004)
-- is closed by default too, so the rls-audit passes; they are not store tables.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND a.atttypid = 'uuid'::regtype AND a.attnotnull AND NOT a.attisdropped)
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped)
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  LOOP
    PERFORM app.enable_user_rls(t.name);
  END LOOP;
END
$$;
