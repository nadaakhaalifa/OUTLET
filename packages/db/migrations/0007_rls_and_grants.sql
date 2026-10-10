-- migration: 0007_rls_and_grants
-- phase: expand
--
-- RLS skeleton and least-privilege grants (spec T3: guard AND Postgres RLS,
-- deny by default). packages/policy/RLS.md did not exist when this was written;
-- this follows the session-variable contract in 0002 and must be reconciled.
--
-- Model
--   * RLS is ENABLED (not FORCED) on every tenant table. The owner / migrator
--     bypasses it, which lets SECURITY DEFINER integrity triggers see all rows.
--     The application connects as a member of app_user, which owns nothing.
--   * A table with RLS and no matching policy returns no rows: deny by default.
--   * An object that is not visible is indistinguishable from one that does not
--     exist, so the API layer maps it to 404 (API1/API3/API5).
--   * UPDATE/DELETE on immutable tables are never granted (and are triggers too).

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- users ---------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON users TO app_user;
CREATE POLICY users_self_select ON users FOR SELECT
  USING (id = app_user_id() OR app_role() IN ('support', 'dpo', 'super_admin', 'system'));
CREATE POLICY users_system_insert ON users FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app_user_id() OR app_role() = 'system')
  WITH CHECK (id = app_user_id() OR app_role() = 'system');

-- user-scoped auth tables ---------------------------------------------------
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON identities TO app_user;
CREATE POLICY identities_owner ON identities FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON devices TO app_user;
CREATE POLICY devices_owner ON devices FOR ALL
  USING (user_id = app_user_id() OR id = app_device_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR id = app_device_id() OR app_role() = 'system');

ALTER TABLE session_families ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON session_families TO app_user;
CREATE POLICY session_families_owner ON session_families FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON sessions TO app_user;
CREATE POLICY sessions_owner ON sessions FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

-- consent -------------------------------------------------------------------
ALTER TABLE consent_text_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON consent_text_versions TO app_user;
CREATE POLICY consent_text_versions_read ON consent_text_versions FOR SELECT USING (true);
CREATE POLICY consent_text_versions_write ON consent_text_versions FOR INSERT
  WITH CHECK (app_role() IN ('dpo', 'super_admin', 'system'));

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON consent_records TO app_user;
GRANT SELECT ON consents_current TO app_user;
CREATE POLICY consent_records_subject_select ON consent_records FOR SELECT
  USING (
    (subject_type = 'user'   AND subject_id = app_user_id())
    OR (subject_type = 'device' AND subject_id = app_device_id())
    OR app_role() IN ('dpo', 'system'));
CREATE POLICY consent_records_subject_insert ON consent_records FOR INSERT
  WITH CHECK (
    (subject_type = 'user'   AND subject_id = app_user_id())
    OR (subject_type = 'device' AND subject_id = app_device_id())
    OR app_role() = 'system');

-- ledger (tenant = store / user owner) -----------------------------------------
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ledger_accounts TO app_user;
CREATE POLICY ledger_accounts_select ON ledger_accounts FOR SELECT
  USING (
    (owner_type = 'store' AND owner_id = ANY (app_store_ids()))
    OR (owner_type = 'user' AND owner_id = app_user_id()::text)
    OR app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY ledger_accounts_insert ON ledger_accounts FOR INSERT
  WITH CHECK (app_role() IN ('finance', 'system'));
CREATE POLICY ledger_accounts_close ON ledger_accounts FOR UPDATE
  USING (app_role() IN ('finance', 'system'))
  WITH CHECK (app_role() IN ('finance', 'system'));

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON journal_entries TO app_user;
CREATE POLICY journal_entries_select ON journal_entries FOR SELECT
  USING (
    app_role() IN ('finance', 'super_admin', 'system')
    OR EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = journal_entries.id));
CREATE POLICY journal_entries_insert ON journal_entries FOR INSERT
  WITH CHECK (app_role() IN ('finance', 'system'));

ALTER TABLE postings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON postings TO app_user;
GRANT SELECT ON ledger_balances, ledger_trial_balance TO app_user;
-- visible when the posting's account is visible (ledger_accounts policy applies)
CREATE POLICY postings_select ON postings FOR SELECT
  USING (
    app_role() IN ('finance', 'super_admin', 'system')
    OR EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.id = postings.account_id));
CREATE POLICY postings_insert ON postings FOR INSERT
  WITH CHECK (app_role() IN ('finance', 'system'));

-- platform tables -----------------------------------------------------------
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO app_user;
CREATE POLICY outbox_events_system ON outbox_events FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE inbox_processed ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON inbox_processed TO app_user;
CREATE POLICY inbox_processed_system ON inbox_processed FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;
CREATE POLICY idempotency_keys_actor ON idempotency_keys FOR ALL
  USING (actor_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (actor_id = app_user_id() OR app_role() = 'system');

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit_log TO app_user;
-- anyone with an identity may append; only privacy/security staff may read
CREATE POLICY audit_log_append ON audit_log FOR INSERT
  WITH CHECK (app_role() IS NOT NULL);
CREATE POLICY audit_log_read ON audit_log FOR SELECT
  USING (app_role() IN ('dpo', 'security', 'super_admin'));

ALTER TABLE audit_chain_checkpoints ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit_chain_checkpoints TO app_user;
CREATE POLICY audit_chain_checkpoints_staff ON audit_chain_checkpoints FOR ALL
  USING (app_role() IN ('security', 'super_admin', 'system'))
  WITH CHECK (app_role() IN ('security', 'super_admin', 'system'));

-- EXECUTE on the integrity helpers is explicit; the default PUBLIC grant is removed.
REVOKE ALL ON FUNCTION audit_log_verify(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_chain_checkpoint(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_verify(text) TO app_user;
GRANT EXECUTE ON FUNCTION audit_chain_checkpoint(text) TO app_user;
