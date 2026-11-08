-- migration: 0007_db_roles_and_contexts
-- phase: expand (policies and grants only; no table or column changes)
-- Source: docs/adr/0011-database-roles-and-rls-contexts.md.
--
-- Roles are cluster-level and created by IaC (infra/local/postgres/init/001-roles.sql locally, the
-- testing bootstrap in packages/db/src/testing.ts for PGlite). This migration refuses to run without them.
-- Exception policies are TO exactly one role, named <tbl>__auth_<purpose> or <tbl>__worker_<job>, gated on
-- app.ctx() (and app.job() for workers) and pinned to app.current_market_id() where the table has market_id.
-- RELAY REQUIREMENT: the outbox relay must run PER MARKET (one worker context per market, ctx market pin), because the
-- relay policies are pinned to app.current_market_id(); a market-less relay would see zero rows.
-- OTP delete (B2): the failed-SMS rollback in auth-core still DELETEs the unverified challenge, so outlet_auth is
-- granted DELETE on otp_challenges (policy otp_challenges__auth_phone is FOR ALL: phone + market pinned). The
-- alternative (UPDATE consumed_at) was not chosen because that column does not exist and the existing test pins the delete.
-- user_identities: outlet_auth keeps SELECT/INSERT/UPDATE for the future Apple/Google/passkey login; auth-core does not
-- use it yet and the table is user-isolated by app.enable_user_rls, so access needs the narrowed user context.
-- Deviations (reviewed in the report): outbox_events gets an outlet_app INSERT policy (<tbl>__app_insert) and
-- worker emit policy so RLS can gate the relay by job; consent_records gets a visitor INSERT for outlet_auth;
-- outlet_auth gets INSERT-only on outbox_events (ctx auth, market-pinned) for the user.registered emit at OTP verify.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['outlet_app', 'outlet_auth', 'outlet_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'migration 0007 requires database role % to exist (created by infra/IaC, see ADR-0011 and infra/local/postgres/init/001-roles.sql)', r;
    END IF;
  END LOOP;
END
$$;

-- Context helpers: NULL-safe (unset or '' reads as NULL, so no row matches).
CREATE OR REPLACE FUNCTION app.ctx() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.ctx', true), '') $$;
CREATE OR REPLACE FUNCTION app.job() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.job', true), '') $$;
CREATE OR REPLACE FUNCTION app.auth_phone_bidx() RETURNS bytea
LANGUAGE sql STABLE AS $$ SELECT decode(NULLIF(current_setting('app.auth_phone_bidx', true), ''), 'hex') $$;
CREATE OR REPLACE FUNCTION app.auth_install_hash() RETURNS bytea
LANGUAGE sql STABLE AS $$ SELECT decode(NULLIF(current_setting('app.auth_install_hash', true), ''), 'hex') $$;
CREATE OR REPLACE FUNCTION app.auth_token_hash() RETURNS bytea
LANGUAGE sql STABLE AS $$ SELECT decode(NULLIF(current_setting('app.auth_token_hash', true), ''), 'hex') $$;
CREATE OR REPLACE FUNCTION app.auth_device_hash() RETURNS bytea
LANGUAGE sql STABLE AS $$ SELECT decode(NULLIF(current_setting('app.auth_device_hash', true), ''), 'hex') $$;
CREATE OR REPLACE FUNCTION app.auth_device_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.auth_device_id', true), '')::uuid $$;

GRANT USAGE ON SCHEMA app TO outlet_app, outlet_auth, outlet_worker;

-- Retention: SELECT + DELETE (or UPDATE for pseudonymise/aggregate) only on rows older than the cutoff.
CREATE OR REPLACE FUNCTION app.enable_retention_policy(p_code text) RETURNS void
LANGUAGE plpgsql AS
$$
DECLARE
  r record;
  rel regclass;
  cond text;
  base text;
BEGIN
  SELECT * INTO r FROM public.retention_policies WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app.enable_retention_policy: no retention policy %', p_code;
  END IF;
  rel := to_regclass(format('public.%I', r.table_name));
  IF rel IS NULL THEN
    RAISE NOTICE 'app.enable_retention_policy: table % does not exist yet, skipped', r.table_name;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = r.timestamp_column AND NOT attisdropped) THEN
    RAISE EXCEPTION 'app.enable_retention_policy: public.% has no column %', r.table_name, r.timestamp_column;
  END IF;
  cond := format('app.ctx() = %L AND app.job() = %L', 'worker', 'privacy.retention');
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'market_id' AND NOT attisdropped) THEN
    cond := cond || ' AND market_id = app.current_market_id()';
  END IF;
  cond := cond || format(' AND %I < now() - %L::interval', r.timestamp_column, r.retain_for::text);
  base := r.table_name || '__worker_privacy_retention';
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', rel);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', base || '_select', rel);
  EXECUTE format('CREATE POLICY %I ON %s FOR SELECT TO outlet_worker USING (%s)', base || '_select', rel, cond);
  IF r.action = 'delete' THEN
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', base || '_delete', rel);
    EXECUTE format('CREATE POLICY %I ON %s FOR DELETE TO outlet_worker USING (%s)', base || '_delete', rel, cond);
    EXECUTE format('GRANT SELECT, DELETE ON %s TO outlet_worker', rel);
  ELSE
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', base || '_update', rel);
    EXECUTE format('CREATE POLICY %I ON %s FOR UPDATE TO outlet_worker USING (%s) WITH CHECK (%s)', base || '_update', rel, cond, cond);
    EXECUTE format('GRANT SELECT, UPDATE ON %s TO outlet_worker', rel);
  END IF;
END
$$;

-- 1. Close the four auth-only tables and devices / consent_records.
ALTER TABLE otp_challenges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenges  FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens  FORCE ROW LEVEL SECURITY;
ALTER TABLE age_blocks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE age_blocks      FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_hits FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events   FORCE ROW LEVEL SECURITY;
ALTER TABLE dlq_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlq_messages    FORCE ROW LEVEL SECURITY;

SELECT app.enable_user_rls('devices');
SELECT app.enable_user_rls('consent_records');

-- 2. Privileges. outlet_app: no access to auth-only tables; INSERT-only on outbox_events; no dlq.
REVOKE ALL ON otp_challenges, refresh_tokens, age_blocks, rate_limit_hits, dlq_messages, outbox_events FROM outlet_app;
GRANT INSERT ON outbox_events TO outlet_app;

-- outlet_auth (explicit grants only)
GRANT SELECT (id, market_id, status, phone_bidx, phone_verified_at) ON users TO outlet_auth;   -- phone_verified_at: COALESCE keeps the first verification time
GRANT INSERT ON users TO outlet_auth;
GRANT UPDATE (phone_ct, phone_bidx, phone_verified_at, age_band, limited_capacity, dob_ct, locale, updated_at) ON users TO outlet_auth;
GRANT SELECT, INSERT, UPDATE ON user_identities, devices TO outlet_auth;
GRANT SELECT, INSERT ON age_attestations, age_blocks, rate_limit_hits TO outlet_auth;
GRANT SELECT, INSERT, UPDATE ON otp_challenges, refresh_tokens TO outlet_auth;
GRANT DELETE ON otp_challenges TO outlet_auth;
GRANT SELECT, INSERT ON session_families TO outlet_auth;
GRANT UPDATE (revoked_at, revoke_reason) ON session_families TO outlet_auth;
GRANT INSERT ON consent_records TO outlet_auth;
GRANT INSERT ON outbox_events TO outlet_auth;

-- outlet_worker (explicit grants only; never INSERT on users/devices/session_families)
GRANT SELECT, DELETE ON otp_challenges, refresh_tokens, age_blocks, rate_limit_hits TO outlet_worker;
GRANT SELECT, UPDATE ON outbox_events TO outlet_worker;
GRANT INSERT ON outbox_events TO outlet_worker;
GRANT SELECT, INSERT, UPDATE ON dlq_messages TO outlet_worker;
GRANT SELECT, INSERT ON inbox_processed TO outlet_worker;
GRANT SELECT ON retention_policies TO outlet_worker;
GRANT SELECT (id, user_id, market_id, kind, status, due_at, cooling_until) ON privacy_requests TO outlet_worker;
GRANT UPDATE (status, completed_at, updated_at, blocked_reason, export_media_id, export_object_key, export_expires_at) ON privacy_requests TO outlet_worker;
GRANT SELECT, UPDATE, DELETE ON users, user_identities, devices, session_families, age_attestations, consent_state TO outlet_worker;
GRANT SELECT ON consent_records TO outlet_worker;

-- 3. outlet_auth exception policies (pre-auth: no user yet).
CREATE POLICY users__auth_lookup ON users FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND phone_bidx = app.auth_phone_bidx());
CREATE POLICY users__auth_register ON users FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id());

CREATE POLICY devices__auth_register ON devices FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id() AND user_id IS NULL);
CREATE POLICY devices__auth_lookup ON devices FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id()
         AND (id = app.auth_device_id() OR install_id_hash = app.auth_install_hash()));
CREATE POLICY devices__auth_bind ON devices FOR UPDATE TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id()
         AND (id = app.auth_device_id() OR install_id_hash = app.auth_install_hash()))
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id()
              AND (user_id IS NULL OR user_id = app.current_user_id()));

CREATE POLICY session_families__auth_by_token ON session_families FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = app.auth_token_hash()));
-- Rebind: revoke the previous owner's families on a device. Column grant limits UPDATE to revoked_at/revoke_reason.
CREATE POLICY session_families__auth_device_rebind_select ON session_families FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND device_id = app.auth_device_id());
CREATE POLICY session_families__auth_device_rebind ON session_families FOR UPDATE TO outlet_auth
  USING (app.ctx() = 'auth' AND device_id = app.auth_device_id())
  WITH CHECK (app.ctx() = 'auth' AND device_id = app.auth_device_id());

-- B2: reuse / wrong-device presentation revokes the family that owns the presented token, whatever device is presented.
CREATE POLICY session_families__auth_revoke_by_token ON session_families FOR UPDATE TO outlet_auth
  USING (app.ctx() = 'auth' AND id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = app.auth_token_hash()))
  WITH CHECK (app.ctx() = 'auth' AND id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = app.auth_token_hash()));

CREATE POLICY refresh_tokens__auth_token ON refresh_tokens FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND token_hash = app.auth_token_hash());
CREATE POLICY refresh_tokens__auth_rotate ON refresh_tokens FOR UPDATE TO outlet_auth
  USING (app.ctx() = 'auth' AND token_hash = app.auth_token_hash())
  WITH CHECK (app.ctx() = 'auth');
-- B3: the family must be visible to this context (own device via session_families__auth_device_rebind_select, or the
-- narrowed user), so a token cannot be planted in another device's family.
CREATE POLICY refresh_tokens__auth_issue ON refresh_tokens FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND family_id IN (SELECT id FROM session_families));

CREATE POLICY otp_challenges__auth_phone ON otp_challenges FOR ALL TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND phone_bidx = app.auth_phone_bidx())
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id() AND phone_bidx = app.auth_phone_bidx());

CREATE POLICY age_blocks__auth_device ON age_blocks FOR ALL TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND device_hash = app.auth_device_hash())
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id() AND device_hash = app.auth_device_hash());

-- rate_limit_hits has neither market_id nor an identity column; it holds HMAC keys only.
CREATE POLICY rate_limit_hits__auth_limiter ON rate_limit_hits FOR ALL TO outlet_auth
  USING (app.ctx() = 'auth') WITH CHECK (app.ctx() = 'auth');

CREATE POLICY consent_records__auth_visitor ON consent_records FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id() AND user_id IS NULL);

-- user.registered emitted by auth-core at OTP verify. INSERT only; SELECT/UPDATE stay with the worker.
CREATE POLICY outbox_events__auth_emit ON outbox_events FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id());

-- 4. outlet_worker exception policies.
CREATE POLICY outbox_events__worker_outbox_relay ON outbox_events FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'outbox.relay' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_outbox_relay_update ON outbox_events FOR UPDATE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'outbox.relay' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'outbox.relay' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_emit ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() IN ('privacy.deletion', 'privacy.retention', 'outbox.relay')
              AND market_id = app.current_market_id());
-- Request-path writers (outlet_app) keep INSERT only; the market pin is the only condition.
CREATE POLICY outbox_events__app_insert ON outbox_events FOR INSERT TO outlet_app
  WITH CHECK (market_id = app.current_market_id());

CREATE POLICY dlq_messages__worker_outbox_relay ON dlq_messages FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'outbox.relay')
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'outbox.relay');

CREATE POLICY privacy_requests__worker_privacy_deletion ON privacy_requests FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'privacy.deletion' AND market_id = app.current_market_id());

-- auth.purge: grace periods mirror packages/auth-core/src/purge.ts.
CREATE POLICY otp_challenges__worker_auth_purge ON otp_challenges FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND expires_at < now() - interval '24 hours');
CREATE POLICY otp_challenges__worker_auth_purge_delete ON otp_challenges FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND expires_at < now() - interval '24 hours');
CREATE POLICY refresh_tokens__worker_auth_purge ON refresh_tokens FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND expires_at < now() - interval '7 days');
CREATE POLICY refresh_tokens__worker_auth_purge_delete ON refresh_tokens FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND expires_at < now() - interval '7 days');
CREATE POLICY age_blocks__worker_auth_purge ON age_blocks FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND blocked_until < now());
CREATE POLICY age_blocks__worker_auth_purge_delete ON age_blocks FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND blocked_until < now());
CREATE POLICY rate_limit_hits__worker_auth_purge ON rate_limit_hits FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND hit_at < now() - interval '48 hours');
CREATE POLICY rate_limit_hits__worker_auth_purge_delete ON rate_limit_hits FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND hit_at < now() - interval '48 hours');

-- 5. Retention worker policies for every retention_policies row whose table exists today.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT code FROM retention_policies ORDER BY code LOOP
    PERFORM app.enable_retention_policy(c);
  END LOOP;
END
$$;
