-- migration: 0039_stylist
-- phase: expand
--
-- AI stylist v1 and llm-gateway audit (spec 11, T12; docs/specs/phase2/04-ai-stylist.md). Expand
-- only: seven new tables, nothing existing changes.
--
--   * product_attributes / product_embeddings are catalogue derived (P0). Embeddings are stored as
--     a jsonb array so that no later migration depends on the optional pgvector extension (0001);
--     a conditional migration may add a vector column and an ANN index when the extension exists.
--   * outfits / stylist_feedback / user_style_vectors are personal (P2), owner scoped by RLS and
--     deleted on history clear or consent withdrawal (retention personalization_data).
--   * llm_audit_log holds the prompt HASH, model, tokens and latency only. It has no user column and
--     no text column on purpose (T12: no raw P2/P3 in audit). Append only (no UPDATE or DELETE grant).
--   * llm_token_usage is the per-user daily token budget ledger (LLM10).
--   * Money in outfits is integer piastres (BIGINT). The LLM never writes a price: prices are
--     copied from the catalogue at generation time and re-validated at add-to-bag.

CREATE TABLE product_attributes (
  product_id     uuid PRIMARY KEY,
  attrs          jsonb NOT NULL CHECK (jsonb_typeof(attrs) = 'object'),
  model_version  text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 60),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_embeddings (
  product_id     uuid PRIMARY KEY,
  vec            jsonb NOT NULL CHECK (jsonb_typeof(vec) = 'array' AND jsonb_array_length(vec) BETWEEN 1 AND 768),
  model_version  text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 60),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outfits (
  id               uuid PRIMARY KEY,
  -- One generation request yields 3-5 outfits; fair use counts generations, not rows.
  generation_id    uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users (id),
  request          jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  items            jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 12),
  scores           jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'object'),
  source           text NOT NULL CHECK (source IN ('ml', 'rules')),
  complete         boolean NOT NULL,
  total_piastres   bigint NOT NULL CHECK (total_piastres >= 0),
  budget_piastres  bigint CHECK (budget_piastres IS NULL OR budget_piastres >= 0),
  kind             text NOT NULL CHECK (kind IN ('outfit', 'complete_look', 'capsule', 'wishlist')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  added_to_bag_at  timestamptz,
  CONSTRAINT outfits_budget_holds CHECK (budget_piastres IS NULL OR total_piastres <= budget_piastres)
);
CREATE INDEX outfits_user_created_idx ON outfits (user_id, created_at DESC, id DESC);

CREATE TABLE stylist_feedback (
  id          uuid PRIMARY KEY,
  outfit_id   uuid NOT NULL REFERENCES outfits (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  item_id     uuid NOT NULL,
  signal      text NOT NULL CHECK (signal IN ('like', 'dislike', 'swap_in', 'swap_out')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stylist_feedback_one_per_item UNIQUE (outfit_id, item_id)
);

CREATE TABLE user_style_vectors (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  vec         jsonb NOT NULL CHECK (jsonb_typeof(vec) = 'array' AND jsonb_array_length(vec) BETWEEN 1 AND 768),
  version     integer NOT NULL CHECK (version >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_audit_log (
  id           uuid PRIMARY KEY,
  feature      text NOT NULL CHECK (char_length(feature) BETWEEN 1 AND 60),
  prompt_id    text NOT NULL CHECK (char_length(prompt_id) BETWEEN 1 AND 80),
  prompt_hash  text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  model        text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
  tokens_in    integer NOT NULL CHECK (tokens_in >= 0),
  tokens_out   integer NOT NULL CHECK (tokens_out >= 0),
  latency_ms   integer NOT NULL CHECK (latency_ms >= 0),
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'cached', 'invalid_output', 'provider_error', 'timeout', 'blocked')),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_audit_log_feature_time_idx ON llm_audit_log (feature, occurred_at DESC);

CREATE TABLE llm_token_usage (
  -- A budget bucket key: a user id, or a reserved nil-style id for anonymous or system buckets, so no FK.
  user_id  uuid NOT NULL,
  day      date NOT NULL,
  feature  text NOT NULL CHECK (char_length(feature) BETWEEN 1 AND 60),
  tokens   bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  PRIMARY KEY (user_id, day, feature)
);

-- Row level security ---------------------------------------------------------------------
ALTER TABLE product_attributes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON product_attributes TO app_user;
CREATE POLICY product_attributes_read ON product_attributes FOR SELECT USING (true);
CREATE POLICY product_attributes_system_insert ON product_attributes FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY product_attributes_system_update ON product_attributes FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE product_embeddings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON product_embeddings TO app_user;
CREATE POLICY product_embeddings_read ON product_embeddings FOR SELECT USING (true);
CREATE POLICY product_embeddings_system_insert ON product_embeddings FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY product_embeddings_system_update ON product_embeddings FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE outfits ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON outfits TO app_user;
CREATE POLICY outfits_owner_select ON outfits FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY outfits_owner_insert ON outfits FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY outfits_owner_update ON outfits FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY outfits_owner_delete ON outfits FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE stylist_feedback ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON stylist_feedback TO app_user;
CREATE POLICY stylist_feedback_owner_select ON stylist_feedback FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_feedback_owner_insert ON stylist_feedback FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_feedback_owner_update ON stylist_feedback FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_feedback_owner_delete ON stylist_feedback FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE user_style_vectors ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_style_vectors TO app_user;
CREATE POLICY user_style_vectors_owner_select ON user_style_vectors FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_style_vectors_owner_insert ON user_style_vectors FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_style_vectors_owner_update ON user_style_vectors FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_style_vectors_owner_delete ON user_style_vectors FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE llm_audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON llm_audit_log TO app_user;
CREATE POLICY llm_audit_log_system_select ON llm_audit_log FOR SELECT USING (app_role() = 'system');
CREATE POLICY llm_audit_log_system_insert ON llm_audit_log FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE llm_token_usage ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON llm_token_usage TO app_user;
CREATE POLICY llm_token_usage_system_select ON llm_token_usage FOR SELECT USING (app_role() = 'system');
CREATE POLICY llm_token_usage_system_insert ON llm_token_usage FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY llm_token_usage_system_update ON llm_token_usage FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
