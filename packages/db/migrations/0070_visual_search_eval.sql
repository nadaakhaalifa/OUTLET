-- migration: 0070_visual_search_eval
-- phase: expand
--
-- Offline evaluation records for visual search (spec P3-08 quality gate). Written only by the
-- evaluation job (system role); never read by the request path.
--   * visual_search_eval_pairs: labelled query -> expected products. A query is referenced by
--     catalog image id or by an opaque consented-sample id; the bytes are never stored here.
--     basis records why the sample may be used ('catalog_image' | 'user_consented'). The real
--     Egyptian labelled set is an owner/data task (VR-P3-13); the synthetic set lives in code.
--   * visual_search_eval_runs: metrics per run, used to gate enabling the feature per model version.

CREATE TABLE visual_search_eval_pairs (
  id            uuid PRIMARY KEY,
  set_name      text NOT NULL CHECK (char_length(set_name) BETWEEN 1 AND 60),
  query_ref     text NOT NULL CHECK (char_length(query_ref) BETWEEN 1 AND 200),
  expected_ids  uuid[] NOT NULL CHECK (cardinality(expected_ids) BETWEEN 1 AND 50),
  category      text CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 60),
  basis         text NOT NULL CHECK (basis IN ('catalog_image', 'user_consented')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_name, query_ref)
);

CREATE TABLE visual_search_eval_runs (
  id              uuid PRIMARY KEY,
  set_name        text NOT NULL CHECK (char_length(set_name) BETWEEN 1 AND 60),
  model_version   text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 60),
  k               integer NOT NULL CHECK (k BETWEEN 1 AND 100),
  queries         integer NOT NULL CHECK (queries >= 0),
  recall_at_k     numeric(6, 5) NOT NULL CHECK (recall_at_k BETWEEN 0 AND 1),
  mrr             numeric(6, 5) NOT NULL CHECK (mrr BETWEEN 0 AND 1),
  coverage        numeric(6, 5) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  passed          boolean NOT NULL,
  ran_at          timestamptz NOT NULL
);

ALTER TABLE visual_search_eval_pairs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON visual_search_eval_pairs TO app_user;
CREATE POLICY visual_search_eval_pairs_select ON visual_search_eval_pairs FOR SELECT USING (app_role() IN ('system', 'ops'));
CREATE POLICY visual_search_eval_pairs_insert ON visual_search_eval_pairs FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE visual_search_eval_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON visual_search_eval_runs TO app_user;
CREATE POLICY visual_search_eval_runs_select ON visual_search_eval_runs FOR SELECT USING (app_role() IN ('system', 'ops'));
CREATE POLICY visual_search_eval_runs_insert ON visual_search_eval_runs FOR INSERT WITH CHECK (app_role() = 'system');
