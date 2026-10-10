-- migration: 0002_roles_and_helpers
-- phase: expand
--
-- Application role and shared helpers.
--
-- Roles
--   app_user : NOLOGIN group role the application connects as (via SET ROLE or
--              a LOGIN role that is a member). It owns nothing, so RLS applies
--              to it. NEVER connect the application as the table owner or a
--              superuser: both bypass RLS.
--
-- Request context (PgBouncer transaction-pooling safe: set per transaction)
--   SELECT set_config('app.user_id',   '<uuid>', true);
--   SELECT set_config('app.role',      'customer|seller|support|finance|dpo|security|super_admin|system', true);
--   SELECT set_config('app.store_ids', '<uuid>,<uuid>', true);
--   SELECT set_config('app.device_id', '<uuid>', true);
-- Unset or empty means "no identity", which every policy treats as deny.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOINHERIT;
  END IF;
END
$$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_device_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.device_id', true), '')::uuid
$$;

CREATE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.role', true), '')
$$;

CREATE FUNCTION app_store_ids() RETURNS text[]
LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN nullif(current_setting('app.store_ids', true), '') IS NULL THEN ARRAY[]::text[]
    ELSE string_to_array(current_setting('app.store_ids', true), ',')
  END
$$;

-- Generic append-only guard. Attached BEFORE UPDATE OR DELETE (row level) and
-- BEFORE TRUNCATE (statement level) on immutable tables.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Shared updated_at maintenance.
CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
