-- 0046 retention: purge run ledger and legal holds (spec B1 nightly purge jobs, A2.9 audit).
-- Additive only. purge_runs records WHAT each nightly rule did (counts, never row content), so it holds
-- no personal data (P1). legal_holds names a subject whose rows every purge rule must skip.

CREATE TABLE retention_purge_runs (
  id              uuid PRIMARY KEY,
  rule_id         text NOT NULL CHECK (rule_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  target_id       text NOT NULL CHECK (target_id ~ '^[a-z][a-z0-9_.]{1,95}$'),
  dry_run         boolean NOT NULL,
  cutoff_at       timestamptz NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  status          text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  rows_purged     bigint NOT NULL DEFAULT 0 CHECK (rows_purged >= 0),
  rows_eligible   bigint CHECK (rows_eligible IS NULL OR rows_eligible >= 0),
  rows_held       bigint NOT NULL DEFAULT 0 CHECK (rows_held >= 0),
  batches         integer NOT NULL DEFAULT 0 CHECK (batches >= 0),
  oldest_eligible_at timestamptz,
  error_code      text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  CONSTRAINT retention_purge_runs_finished_chk CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);

CREATE INDEX retention_purge_runs_rule_idx ON retention_purge_runs (rule_id, started_at DESC);

CREATE TABLE retention_legal_holds (
  id            uuid PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'store')),
  subject_id    uuid NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  placed_at     timestamptz NOT NULL,
  released_at   timestamptz,
  CONSTRAINT retention_legal_holds_release_chk CHECK (released_at IS NULL OR released_at >= placed_at)
);

CREATE INDEX retention_legal_holds_active_idx ON retention_legal_holds (subject_type, subject_id) WHERE released_at IS NULL;

ALTER TABLE retention_purge_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON retention_purge_runs TO app_user;
CREATE POLICY retention_purge_runs_system ON retention_purge_runs FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE retention_legal_holds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON retention_legal_holds TO app_user;
CREATE POLICY retention_legal_holds_system ON retention_legal_holds FOR ALL
  USING (app_role() IN ('system', 'dpo', 'super_admin')) WITH CHECK (app_role() IN ('system', 'dpo', 'super_admin'));
