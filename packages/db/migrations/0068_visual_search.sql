-- migration: 0068_visual_search
-- phase: expand
--
-- Visual search (spec P3-08, ADR-0023). Expand only: three new tables, nothing existing changes.
--
--   * No image bytes and no embedding are ever stored. A query image lives in the private object
--     bucket from upload until the request finishes (deleted in a finally block); an upload that is
--     never searched is deleted by a sweeper once expires_at passes. visual_search_uploads holds only
--     the object key, the owner and the lifecycle timestamps (P2, purged 48h after expiry).
--   * visual_search_requests is P1 telemetry: no user id, no image, no embedding, no query text.
--   * visual_search_usage is the per-user and global daily counter behind the per-user cap and the
--     embedder cost cap (API4). subject is 'global' or a user id; rows are purged after 48h.

CREATE TABLE visual_search_uploads (
  id             text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 200),
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content_type   text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  deleted_at     timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX visual_search_uploads_sweep ON visual_search_uploads (expires_at)
  WHERE deleted_at IS NULL;

CREATE TABLE visual_search_requests (
  id             uuid PRIMARY KEY,
  ts             timestamptz NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('image', 'product')),
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'no_result', 'low_confidence', 'rejected', 'degraded')),
  latency_ms     integer NOT NULL CHECK (latency_ms >= 0),
  result_count   integer NOT NULL CHECK (result_count >= 0),
  category_guess text CHECK (category_guess IS NULL OR char_length(category_guess) BETWEEN 1 AND 60),
  model_version  text CHECK (model_version IS NULL OR char_length(model_version) BETWEEN 1 AND 60)
);
CREATE INDEX visual_search_requests_ts ON visual_search_requests (ts);

CREATE TABLE visual_search_usage (
  day       date NOT NULL,
  subject   text NOT NULL CHECK (subject = 'global' OR subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  used      integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (day, subject)
);

ALTER TABLE visual_search_uploads ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON visual_search_uploads TO app_user;
CREATE POLICY visual_search_uploads_select ON visual_search_uploads FOR SELECT
  USING (owner_id = app_user_id() OR app_role() = 'system');
CREATE POLICY visual_search_uploads_insert ON visual_search_uploads FOR INSERT
  WITH CHECK (owner_id = app_user_id() OR app_role() = 'system');
CREATE POLICY visual_search_uploads_update ON visual_search_uploads FOR UPDATE
  USING (owner_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (owner_id = app_user_id() OR app_role() = 'system');

ALTER TABLE visual_search_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON visual_search_requests TO app_user;
CREATE POLICY visual_search_requests_select ON visual_search_requests FOR SELECT
  USING (app_role() IN ('system', 'ops'));
CREATE POLICY visual_search_requests_insert ON visual_search_requests FOR INSERT WITH CHECK (true);
CREATE POLICY visual_search_requests_delete ON visual_search_requests FOR DELETE USING (app_role() = 'system');

ALTER TABLE visual_search_usage ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON visual_search_usage TO app_user;
CREATE POLICY visual_search_usage_select ON visual_search_usage FOR SELECT USING (true);
CREATE POLICY visual_search_usage_insert ON visual_search_usage FOR INSERT WITH CHECK (true);
CREATE POLICY visual_search_usage_update ON visual_search_usage FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY visual_search_usage_delete ON visual_search_usage FOR DELETE USING (app_role() = 'system');
