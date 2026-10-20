-- migration: 0080_ranking_v2_eval_runs
-- phase: expand
--
-- Offline evaluation results of ranking v2 candidates on synthetic or logged impressions
-- (NDCG@k, MAP, regression-gate verdict) and A/B guardrail evaluations (return rate, complaints).
-- Expand only: new tables. Aggregates only, no personal data. System role only (internal routes).
--
--   * ranking_eval_runs is append only (idempotent by `request_key`): a completed verdict is
--     never rewritten, a re-run is a new row.
--   * Metrics are stored as integers (NDCG and MAP in basis points) so nothing compares floats.

CREATE TABLE ranking_eval_runs (
  id                  uuid PRIMARY KEY,
  request_key         text NOT NULL UNIQUE CHECK (char_length(request_key) BETWEEN 8 AND 80),
  candidate_version   text NOT NULL CHECK (char_length(candidate_version) BETWEEN 1 AND 40),
  baseline_version    text NOT NULL CHECK (char_length(baseline_version) BETWEEN 1 AND 40),
  dataset             text NOT NULL CHECK (dataset IN ('synthetic', 'shadow_logs')),
  seed                bigint,
  requests            integer NOT NULL CHECK (requests >= 0),
  k                   integer NOT NULL CHECK (k BETWEEN 1 AND 100),
  candidate_ndcg_bps  integer NOT NULL CHECK (candidate_ndcg_bps BETWEEN 0 AND 10000),
  candidate_map_bps   integer NOT NULL CHECK (candidate_map_bps BETWEEN 0 AND 10000),
  baseline_ndcg_bps   integer NOT NULL CHECK (baseline_ndcg_bps BETWEEN 0 AND 10000),
  baseline_map_bps    integer NOT NULL CHECK (baseline_map_bps BETWEEN 0 AND 10000),
  passed              boolean NOT NULL,
  reasons             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  created_at          timestamptz NOT NULL
);

CREATE INDEX ranking_eval_runs_created_idx ON ranking_eval_runs (created_at DESC, id);

REVOKE ALL ON ranking_eval_runs FROM PUBLIC;
ALTER TABLE ranking_eval_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ranking_eval_runs TO app_user;
CREATE POLICY ranking_eval_runs_select ON ranking_eval_runs FOR SELECT USING (app_role() = 'system');
CREATE POLICY ranking_eval_runs_insert ON ranking_eval_runs FOR INSERT WITH CHECK (app_role() = 'system');
