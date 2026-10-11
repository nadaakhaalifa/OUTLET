-- migration: 0040_recommendations_history
-- phase: expand
--
-- Shopper history, personalization settings, derived features, recently viewed, item-item
-- co-occurrence, ranking model registry and exploration counters (spec 13, 20.5, 20.6;
-- docs/specs/phase2/05-recommendations-history.md). Expand only: new tables, nothing existing changes.
--
--   * user_events is range partitioned by `at` (monthly partitions are cut by the retention job;
--     a DEFAULT partition catches everything until then). Primary key includes the partition key.
--   * Clear history = delete user_events, user_features, recently_viewed in one transaction and
--     record a history_clear_requests row; a sweeper re-deletes anything a batch job rebuilt before
--     the 24h deadline and raises a metric when a request is overdue.
--   * user_features can hold only affinity maps. A CHECK refuses budget, affordability,
--     installment and measurement words so a budget value can never be persisted as a feature.
--   * Embeddings are NOT created here: the vector table belongs to the embeddings pipeline
--     (ADR-0023, product_embeddings). The retrieval adapter reads it when pgvector is present.
--   * Row level security: shoppers see and delete only their own rows; writes of derived data and
--     all aggregate tables run as app.role = 'system'.

CREATE TABLE user_events (
  id           uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type         text NOT NULL
                 CHECK (type IN ('viewed', 'searched', 'saved', 'bought', 'returned', 'outfit_generated')),
  item_id      uuid,
  store_id     uuid,
  category_id  text CHECK (category_id IS NULL OR char_length(category_id) BETWEEN 1 AND 60),
  price_minor  bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  detail       text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 120),
  at           timestamptz NOT NULL,
  PRIMARY KEY (id, at),
  CONSTRAINT user_events_item_needed CHECK (type IN ('searched') OR item_id IS NOT NULL)
) PARTITION BY RANGE (at);

CREATE TABLE user_events_default PARTITION OF user_events DEFAULT;

CREATE INDEX user_events_user_idx ON user_events (user_id, at DESC, id DESC);
CREATE INDEX user_events_user_type_idx ON user_events (user_id, type, at DESC, id DESC);

CREATE TABLE user_features (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  features       jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  model_version  text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 40),
  built_at       timestamptz NOT NULL,
  CONSTRAINT user_features_no_budget CHECK (
    features::text !~* '(budget|afford|installment|payday|measurement|size_profile|income)'
  )
);

CREATE TABLE personalization_settings (
  user_id          uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  personalization  boolean NOT NULL DEFAULT true,
  history_paused   boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recently_viewed (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  price_minor  bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  viewed_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX recently_viewed_user_idx ON recently_viewed (user_id, viewed_at DESC);

CREATE TABLE history_clear_requests (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_at  timestamptz NOT NULL,
  deadline_at   timestamptz NOT NULL,
  completed_at  timestamptz,
  CONSTRAINT history_clear_deadline_after CHECK (deadline_at > requested_at)
);

CREATE INDEX history_clear_requests_pending_idx ON history_clear_requests (deadline_at)
  WHERE completed_at IS NULL;
CREATE INDEX history_clear_requests_user_idx ON history_clear_requests (user_id, requested_at DESC);

CREATE TABLE item_cooccurrence (
  item_a       uuid NOT NULL,
  item_b       uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('co_view', 'co_buy')),
  score        integer NOT NULL CHECK (score > 0),
  window_days  smallint NOT NULL CHECK (window_days BETWEEN 1 AND 365),
  computed_at  timestamptz NOT NULL,
  PRIMARY KEY (item_a, item_b, kind),
  CONSTRAINT item_cooccurrence_distinct CHECK (item_a <> item_b)
);

CREATE INDEX item_cooccurrence_lookup_idx ON item_cooccurrence (item_a, kind, score DESC);

CREATE TABLE ranking_models (
  version       text PRIMARY KEY CHECK (char_length(version) BETWEEN 1 AND 40),
  status        text NOT NULL CHECK (status IN ('shadow', 'active', 'retired')),
  metrics       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  model_card    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ranking_models_one_active_idx ON ranking_models ((true)) WHERE status = 'active';

CREATE TABLE recommendation_item_stats (
  product_id   uuid NOT NULL,
  module       text NOT NULL CHECK (module IN ('feed', 'similar', 'similar_for_less', 'goes_with', 'restock', 'price_drop', 'exploration')),
  impressions  bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks       bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, module),
  CONSTRAINT recommendation_item_stats_clicks_le CHECK (clicks <= impressions)
);

-- Row level security --------------------------------------------------------------------
REVOKE ALL ON user_events, user_events_default, user_features, personalization_settings, recently_viewed,
  history_clear_requests, item_cooccurrence, ranking_models, recommendation_item_stats FROM PUBLIC;

ALTER TABLE user_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON user_events TO app_user;
CREATE POLICY user_events_select ON user_events FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_events_insert ON user_events FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_events_delete ON user_events FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE user_features ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_features TO app_user;
CREATE POLICY user_features_select ON user_features FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_features_system_write ON user_features FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY user_features_system_update ON user_features FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY user_features_delete ON user_features FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE personalization_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON personalization_settings TO app_user;
CREATE POLICY personalization_settings_select ON personalization_settings FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY personalization_settings_insert ON personalization_settings FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY personalization_settings_update ON personalization_settings FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE recently_viewed ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON recently_viewed TO app_user;
CREATE POLICY recently_viewed_select ON recently_viewed FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY recently_viewed_insert ON recently_viewed FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY recently_viewed_update ON recently_viewed FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY recently_viewed_delete ON recently_viewed FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE history_clear_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON history_clear_requests TO app_user;
CREATE POLICY history_clear_requests_select ON history_clear_requests FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY history_clear_requests_insert ON history_clear_requests FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY history_clear_requests_system_update ON history_clear_requests FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- Aggregate, non personal tables: readable by the app, written by system jobs only.
ALTER TABLE item_cooccurrence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON item_cooccurrence TO app_user;
CREATE POLICY item_cooccurrence_select ON item_cooccurrence FOR SELECT USING (true);
CREATE POLICY item_cooccurrence_system_insert ON item_cooccurrence FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY item_cooccurrence_system_update ON item_cooccurrence FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY item_cooccurrence_system_delete ON item_cooccurrence FOR DELETE USING (app_role() = 'system');

ALTER TABLE ranking_models ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ranking_models TO app_user;
CREATE POLICY ranking_models_select ON ranking_models FOR SELECT USING (app_role() IN ('system', 'ops'));
CREATE POLICY ranking_models_system_insert ON ranking_models FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY ranking_models_system_update ON ranking_models FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE recommendation_item_stats ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON recommendation_item_stats TO app_user;
CREATE POLICY recommendation_item_stats_select ON recommendation_item_stats FOR SELECT USING (true);
CREATE POLICY recommendation_item_stats_system_insert ON recommendation_item_stats FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY recommendation_item_stats_system_update ON recommendation_item_stats FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
