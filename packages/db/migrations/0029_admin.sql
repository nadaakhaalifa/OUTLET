-- migration: 0029_admin
-- phase: expand
--
-- Admin essentials (spec 23, docs/specs/admin-essentials.md). Expand only: three new tables.
--
--   * admin_approval_requests is the dual-approval RECORD. It never executes money; the owning
--     module checks it. requester <> approver is a CHECK, so it holds even if application code
--     is wrong. Amounts are integer piastres.
--   * admin_elevations are just-in-time role overlays (and break-glass sessions). expires_at is
--     compared against the application clock on every use; a row is never trusted by state alone.
--   * kyc_suspension_reviews tracks the human review owed for every seller suspension (due in
--     5 business days, Africa/Cairo calendar, computed by the application).
--   * Every PII view and state change is also appended to audit_log (0005) by the application;
--     reason_code travels in audit_log.reason_code.
-- Row level security: app.role carries the admin role (ops, finance, ...), app.user_id the staff
-- user. Shoppers and sellers have neither role, so they see no rows.

CREATE TABLE admin_approval_requests (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN
                  ('role_grant', 'plan_price_change', 'data_export', 'refund', 'payout', 'role_elevation', 'break_glass')),
  subject_type  text NOT NULL CHECK (char_length(subject_type) BETWEEN 1 AND 40),
  subject_id    text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 80),
  amount_minor  bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency      char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  reason_code   text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 40),
  requester_id  uuid NOT NULL REFERENCES users (id),
  state         text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED')),
  approver_id   uuid REFERENCES users (id),
  requested_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  CONSTRAINT admin_approval_expiry_chk CHECK (expires_at > requested_at),
  CONSTRAINT admin_approval_no_self_chk CHECK (approver_id IS NULL OR approver_id <> requester_id OR state = 'REJECTED'),
  CONSTRAINT admin_approval_approved_has_approver_chk CHECK (state <> 'APPROVED' OR approver_id IS NOT NULL),
  CONSTRAINT admin_approval_decided_chk CHECK ((state = 'REQUESTED') = (decided_at IS NULL))
);
CREATE INDEX admin_approval_state_idx ON admin_approval_requests (state, requested_at DESC);
CREATE INDEX admin_approval_requester_idx ON admin_approval_requests (requester_id, requested_at DESC);
CREATE INDEX admin_approval_subject_idx ON admin_approval_requests (kind, subject_type, subject_id);

CREATE TABLE admin_elevations (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id),
  role              text NOT NULL CHECK (role IN
                      ('ops', 'finance', 'trust_safety', 'support', 'marketing', 'dpo', 'security', 'super_admin')),
  reason_code       text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 40),
  approval_id       uuid NOT NULL REFERENCES admin_approval_requests (id),
  requested_ttl_ms  bigint NOT NULL CHECK (requested_ttl_ms BETWEEN 60000 AND 14400000),
  state             text NOT NULL DEFAULT 'PENDING_APPROVAL'
                      CHECK (state IN ('PENDING_APPROVAL', 'ACTIVE', 'DENIED', 'REVOKED', 'EXPIRED')),
  requested_at      timestamptz NOT NULL,
  activated_at      timestamptz,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users (id),
  CONSTRAINT admin_elevations_window_chk CHECK (
    (state NOT IN ('PENDING_APPROVAL', 'DENIED') OR activated_at IS NULL)
    AND (state <> 'ACTIVE' OR activated_at IS NOT NULL)),
  CONSTRAINT admin_elevations_activated_chk CHECK ((activated_at IS NULL) = (expires_at IS NULL)),
  CONSTRAINT admin_elevations_approval_uq UNIQUE (approval_id)
);
CREATE INDEX admin_elevations_user_idx ON admin_elevations (user_id, state, expires_at);

CREATE TABLE kyc_suspension_reviews (
  id            uuid PRIMARY KEY,
  seller_id     uuid NOT NULL,
  suspended_by  uuid REFERENCES users (id),           -- NULL: automatic suspension
  suspended_at  timestamptz NOT NULL,
  due_at        timestamptz NOT NULL,
  reason_code   text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 40),
  state         text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'UPHELD', 'REINSTATED')),
  reviewed_by   uuid REFERENCES users (id),
  reviewed_at   timestamptz,
  CONSTRAINT kyc_suspension_due_chk CHECK (due_at > suspended_at),
  CONSTRAINT kyc_suspension_reviewed_chk CHECK ((state = 'OPEN') = (reviewed_by IS NULL AND reviewed_at IS NULL)),
  CONSTRAINT kyc_suspension_reviewer_not_suspender_chk CHECK (reviewed_by IS NULL OR suspended_by IS NULL OR reviewed_by <> suspended_by)
);
CREATE UNIQUE INDEX kyc_suspension_one_open_uq ON kyc_suspension_reviews (seller_id) WHERE state = 'OPEN';
CREATE INDEX kyc_suspension_due_idx ON kyc_suspension_reviews (state, due_at);

-- Row level security -------------------------------------------------------------------------
ALTER TABLE admin_approval_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON admin_approval_requests TO app_user;
CREATE POLICY admin_approval_select ON admin_approval_requests FOR SELECT
  USING (
    requester_id = app_user_id()
    OR app_role() IN ('finance', 'dpo', 'security', 'super_admin', 'system'));
CREATE POLICY admin_approval_insert ON admin_approval_requests FOR INSERT
  WITH CHECK (
    (requester_id = app_user_id()
      AND app_role() IN ('ops', 'finance', 'trust_safety', 'support', 'marketing', 'dpo', 'security', 'super_admin'))
    OR app_role() = 'system');
CREATE POLICY admin_approval_update ON admin_approval_requests FOR UPDATE
  USING (
    requester_id = app_user_id()
    OR app_role() IN ('finance', 'dpo', 'security', 'super_admin', 'system'))
  WITH CHECK (
    requester_id = app_user_id()
    OR app_role() IN ('finance', 'dpo', 'security', 'super_admin', 'system'));

ALTER TABLE admin_elevations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON admin_elevations TO app_user;
CREATE POLICY admin_elevations_select ON admin_elevations FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('security', 'super_admin', 'system'));
CREATE POLICY admin_elevations_insert ON admin_elevations FOR INSERT
  WITH CHECK (
    (user_id = app_user_id()
      AND app_role() IN ('ops', 'finance', 'trust_safety', 'support', 'marketing', 'dpo', 'security', 'super_admin'))
    OR app_role() = 'system');
CREATE POLICY admin_elevations_update ON admin_elevations FOR UPDATE
  USING (user_id = app_user_id() OR app_role() IN ('security', 'super_admin', 'system'))
  WITH CHECK (user_id = app_user_id() OR app_role() IN ('security', 'super_admin', 'system'));

ALTER TABLE kyc_suspension_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON kyc_suspension_reviews TO app_user;
CREATE POLICY kyc_suspension_select ON kyc_suspension_reviews FOR SELECT
  USING (app_role() IN ('ops', 'trust_safety', 'support', 'security', 'super_admin', 'system'));
CREATE POLICY kyc_suspension_insert ON kyc_suspension_reviews FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY kyc_suspension_update ON kyc_suspension_reviews FOR UPDATE
  USING (app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'))
  WITH CHECK (app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
