-- migration: 0009_admin_access
-- phase: expand (additive only)
-- Source: master prompt section 23 "Admin security", docs/security/threat-models.md ADM-T02/T03/T06,
--         docs/data-model.md staff_role_assignments + approval_requests (extended below).
--
-- RUNTIME ROLE / CONTEXT: ADR-0011 has no 'admin' context, so admin code runs as outlet_app with ctx 'user'
-- (userId = the admin's account id) and these tables are keyed by MARKET ONLY (no store_id or user_id column,
-- so the RLS audit does not classify them as tenant tables). Authorization (who may grant, approve, elevate) is
-- enforced in @outlet/admin-access via @outlet/policy, not by RLS. RLS here only pins rows to the market.
-- The policy is named <tbl>_user_isolation ONLY so the rls-audit treats it as the plain isolation policy (any other name is an
-- "exception" that must be TO outlet_auth/outlet_worker and snapshot-reviewed); it pins the MARKET, not the user.
-- Market pin is inlined (USING market_id = app.current_market_id()); a shared helper
-- (app.enable_market_rls(regclass)) should be added to packages/db later and these policies migrated to it.
--
-- Deviations from docs/data-model.md:
--   * staff_accounts is not built yet, so staff_id / granted_by / requested_by / decided_by carry no FK.
--   * staff_role_assignments.expires_at is NOT NULL (default grant life 90 days, set by the app); role_code has no
--     FK to roles (table not built) and is CHECKed against the admin role list instead.
--   * approval_requests gains payload (jsonb, no PII: ids and amounts as strings), required_approvals and executed_at
--     (idempotent execution claim). decided_by/decided_at record the final decision; every individual vote is in
--     approval_decisions (UNIQUE per approver).
--   * elevation_requests and approval_decisions are new.
-- History is append-only for outlet_app: DELETE is revoked on all four tables; status changes use UPDATE.

CREATE TABLE staff_role_assignments (
  id                  uuid PRIMARY KEY,
  staff_id            uuid NOT NULL,
  role_code           text NOT NULL CHECK (role_code IN ('ops','finance','trust_safety','support','marketing','dpo','security','super_admin')),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  granted_by          uuid NOT NULL,
  approval_request_id uuid,
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  starts_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by          uuid,
  created_at          timestamptz NOT NULL,
  CHECK (expires_at > starts_at)
);
CREATE INDEX staff_role_assignments_live_idx ON staff_role_assignments (market_id, staff_id) WHERE revoked_at IS NULL;

CREATE TABLE elevation_requests (
  id            uuid PRIMARY KEY,
  market_id     text NOT NULL CHECK (length(market_id) > 0),
  staff_id      uuid NOT NULL,
  role_code     text NOT NULL CHECK (role_code IN ('ops','finance','trust_safety','support','marketing','dpo','security','super_admin')),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  ttl_minutes   integer NOT NULL CHECK (ttl_minutes BETWEEN 1 AND 60),
  status        text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  approved_by   uuid,
  decided_at    timestamptz,
  starts_at     timestamptz,
  expires_at    timestamptz,             -- end of the active window once APPROVED
  pending_until timestamptz NOT NULL,    -- after this a PENDING request can no longer be approved
  created_at    timestamptz NOT NULL,
  CHECK (approved_by IS NULL OR approved_by <> staff_id),
  CHECK ((status = 'APPROVED') = (starts_at IS NOT NULL AND expires_at IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE INDEX elevation_requests_active_idx ON elevation_requests (market_id, staff_id) WHERE status = 'APPROVED';

CREATE TABLE approval_requests (
  id                 uuid PRIMARY KEY,
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  action             text NOT NULL CHECK (length(action) > 0),
  target_type        text NOT NULL,
  target_id          text NOT NULL,
  payload            jsonb NOT NULL,
  payload_hash       bytea NOT NULL CHECK (length(payload_hash) = 32),
  requested_by       uuid NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  required_approvals integer NOT NULL DEFAULT 2 CHECK (required_approvals >= 2),
  decided_by         uuid,
  decided_at         timestamptz,
  reason             text,
  expires_at         timestamptz NOT NULL,
  executed_at        timestamptz,
  created_at         timestamptz NOT NULL,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (executed_at IS NULL OR status = 'APPROVED')
);
CREATE INDEX approval_requests_pending_idx ON approval_requests (market_id, status, created_at) WHERE status = 'PENDING';

CREATE TABLE approval_decisions (
  id                  uuid PRIMARY KEY,
  approval_request_id uuid NOT NULL REFERENCES approval_requests (id),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  approver_id         uuid NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  note                text,
  created_at          timestamptz NOT NULL,
  UNIQUE (approval_request_id, approver_id)
);

-- Defence in depth: an approver can never be the requester, even if the application is bypassed.
CREATE OR REPLACE FUNCTION app.approval_decisions_not_requester() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM approval_requests r WHERE r.id = NEW.approval_request_id AND r.requested_by = NEW.approver_id) THEN
    RAISE EXCEPTION 'approver must differ from requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decisions_not_requester BEFORE INSERT ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION app.approval_decisions_not_requester();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_role_assignments','elevation_requests','approval_requests','approval_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO outlet_app USING (market_id = app.current_market_id()) WITH CHECK (market_id = app.current_market_id())',
      t || '_user_isolation', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_app') THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM outlet_app', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO outlet_app', t);
    END IF;
  END LOOP;
END $$;
-- approval_decisions are immutable votes: no UPDATE either.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_app') THEN REVOKE UPDATE ON approval_decisions FROM outlet_app; END IF;
END $$;
