-- migration: 0079_ranking_v2_shadow
-- phase: expand
--
-- Shadow deployment of the v2 ranker (master prompt 20.5, docs/specs/phase-3 LTR ranking v2).
-- v1 is served; v2 scores are only logged here so the offline pipeline can compare them. Expand
-- only: new tables, nothing existing changes.
--
--   * No user id and no session id is stored: a run records the request shape (personalized or
--     not, candidate count) and per-item ranks and scores only. Personalization-off requests are
--     logged with personalized = false and zero affinity features.
--   * `features` can hold only the closed ranking feature names. The CHECK refuses budget,
--     affordability, installment and measurement words, mirroring user_features (0040): a budget
--     value can never be persisted as a ranking feature or become seller visible.
--   * System role only: written by the serving path, read by internal admin routes (which run as
--     the system role after the policy guard). Shoppers and sellers have no grant.
--   * Retention: 30 days (retention job; data_inventory.yaml).

CREATE TABLE ranking_shadow_runs (
  id                     uuid PRIMARY KEY,
  module                 text NOT NULL CHECK (module IN ('feed', 'similar', 'similar_for_less', 'goes_with', 'restock', 'price_drop', 'exploration')),
  served_model_version   text NOT NULL CHECK (char_length(served_model_version) BETWEEN 1 AND 40),
  shadow_model_version   text NOT NULL CHECK (char_length(shadow_model_version) BETWEEN 1 AND 40),
  personalized           boolean NOT NULL,
  bot_filtered           boolean NOT NULL DEFAULT false,
  candidate_count        integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 1000),
  k                      integer NOT NULL CHECK (k BETWEEN 1 AND 100),
  overlap_permille       integer NOT NULL CHECK (overlap_permille BETWEEN 0 AND 1000),
  top1_same              boolean NOT NULL,
  mean_rank_shift_milli  integer NOT NULL CHECK (mean_rank_shift_milli >= 0),
  created_at             timestamptz NOT NULL
);

CREATE INDEX ranking_shadow_runs_created_idx ON ranking_shadow_runs (created_at DESC, id);

CREATE TABLE ranking_shadow_items (
  run_id          uuid NOT NULL REFERENCES ranking_shadow_runs (id) ON DELETE CASCADE,
  product_id      uuid NOT NULL,
  v1_rank         integer NOT NULL CHECK (v1_rank >= 1),
  v2_rank         integer NOT NULL CHECK (v2_rank >= 1),
  v2_score_milli  bigint NOT NULL,
  features        jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  PRIMARY KEY (run_id, product_id),
  CONSTRAINT ranking_shadow_items_no_budget CHECK (
    features::text !~* '(budget|afford|installment|payday|measurement|size_profile|income|waist|bust|height|weight)'
  )
);

REVOKE ALL ON ranking_shadow_runs, ranking_shadow_items FROM PUBLIC;

ALTER TABLE ranking_shadow_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON ranking_shadow_runs TO app_user;
CREATE POLICY ranking_shadow_runs_system ON ranking_shadow_runs FOR SELECT USING (app_role() = 'system');
CREATE POLICY ranking_shadow_runs_insert ON ranking_shadow_runs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ranking_shadow_runs_delete ON ranking_shadow_runs FOR DELETE USING (app_role() = 'system');

ALTER TABLE ranking_shadow_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON ranking_shadow_items TO app_user;
CREATE POLICY ranking_shadow_items_system ON ranking_shadow_items FOR SELECT USING (app_role() = 'system');
CREATE POLICY ranking_shadow_items_insert ON ranking_shadow_items FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ranking_shadow_items_delete ON ranking_shadow_items FOR DELETE USING (app_role() = 'system');
