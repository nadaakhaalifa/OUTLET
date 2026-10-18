-- migration: 0061_student_verifications
-- phase: expand
--
-- Student plan eligibility (docs/specs/phase-3/family-student-plans.md, VR-P3-09). Expand only: one table.
--
--   * We keep the verifier name, the verifier's opaque reference and an expiry only. No ID image,
--     no university email, no student number is stored here (data minimisation, P2 class).
--   * (verifier, ref) is unique, so a replayed or duplicated callback finds the same row.
--   * One PENDING verification per user at a time (partial unique index).
--   * validity is at most 12 months (CHECK), notice_sent_at records the 30 day heads-up.
--   * Row level security: a user reads its own rows; writes run as app.role = 'system'.

CREATE TABLE student_verifications (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id),
  verifier       text NOT NULL CHECK (char_length(verifier) BETWEEN 1 AND 40),
  ref            text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 200),
  status         text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  verified_at    timestamptz,
  valid_until    timestamptz,
  notice_sent_at timestamptz,
  version        integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_verifications_ref_uq UNIQUE (verifier, ref),
  CONSTRAINT student_verifications_verified_has_window CHECK (
    status NOT IN ('VERIFIED', 'EXPIRED') OR (verified_at IS NOT NULL AND valid_until IS NOT NULL)
  ),
  CONSTRAINT student_verifications_window_max CHECK (
    valid_until IS NULL OR verified_at IS NULL OR valid_until <= verified_at + interval '12 months'
  )
);

CREATE UNIQUE INDEX student_verifications_one_pending_uq ON student_verifications (user_id) WHERE status = 'PENDING';
CREATE INDEX student_verifications_user_idx ON student_verifications (user_id, created_at DESC);
CREATE INDEX student_verifications_valid_until_idx ON student_verifications (valid_until) WHERE status = 'VERIFIED';

ALTER TABLE student_verifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON student_verifications TO app_user;
CREATE POLICY student_verifications_select ON student_verifications FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY student_verifications_system_insert ON student_verifications FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY student_verifications_system_update ON student_verifications FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
