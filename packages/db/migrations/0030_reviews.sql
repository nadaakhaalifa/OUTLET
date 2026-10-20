-- migration: 0030_reviews
-- phase: expand
--
-- Verified-purchase reviews, seller replies, Q&A and abuse reports (spec 5, 27;
-- docs/specs/reviews.md). Expand only: six new tables, nothing existing changes.
--
--   * One review per order line (UNIQUE order_line_id). order_line_id, store_id and product_id are
--     logical references (orders and catalog own those tables); user_id is a real FK.
--   * Every user generated item carries the moderation state machine
--     SUBMITTED -> AUTO_CHECKED -> PUBLISHED | HELD | REJECTED and a hold reason.
--   * No rating dependent reward column exists: reward_intent_at only records that the one,
--     rating independent, reward intent was emitted (no incentivized review bias, spec 27).
--   * Reporters are stored per item (UNIQUE per reporter) so a report storm from one account counts once.
--   * moderation_log is append only (no UPDATE or DELETE grant).
--   * Row level security: published items are world readable, authors see their own, writes by
--     authors on their own reviews; replies, answers, questions' SLA fields and moderation run as
--     app.role = 'system' (the policy guard authorizes sellers and moderators).

CREATE TABLE reviews (
  id                uuid PRIMARY KEY,
  order_line_id     uuid NOT NULL,
  user_id           uuid NOT NULL REFERENCES users (id),
  store_id          uuid NOT NULL,
  product_id        uuid NOT NULL,
  rating            smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title             text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 80),
  body              text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 2000),
  purchased_size    text CHECK (purchased_size IS NULL OR char_length(purchased_size) BETWEEN 1 AND 20),
  fit               text CHECK (fit IS NULL OR fit IN ('too_small', 'ok', 'too_large')),
  fit_area          text CHECK (fit_area IS NULL OR char_length(fit_area) BETWEEN 1 AND 30),
  photo_ids         jsonb NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(photo_ids) = 'array' AND jsonb_array_length(photo_ids) <= 5),
  status            text NOT NULL
                      CHECK (status IN ('SUBMITTED', 'AUTO_CHECKED', 'PUBLISHED', 'HELD', 'REJECTED')),
  hold_reason       text CHECK (hold_reason IS NULL OR hold_reason IN
                      ('toxicity', 'image_flagged', 'classifier_unavailable', 'contact_info', 'reported', 'moderator')),
  reward_intent_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  CONSTRAINT reviews_order_line_uq UNIQUE (order_line_id),
  CONSTRAINT reviews_fit_area_needs_fit CHECK (fit_area IS NULL OR fit IS NOT NULL),
  CONSTRAINT reviews_reason_when_blocked CHECK (status NOT IN ('HELD', 'REJECTED') OR hold_reason IS NOT NULL),
  CONSTRAINT reviews_published_at_set CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE INDEX reviews_product_published_idx ON reviews (product_id, published_at DESC, id DESC)
  WHERE status = 'PUBLISHED';
CREATE INDEX reviews_user_created_idx ON reviews (user_id, created_at DESC, id DESC);
CREATE INDEX reviews_store_created_idx ON reviews (store_id, created_at DESC, id DESC);
CREATE INDEX reviews_moderation_idx ON reviews (created_at, id)
  WHERE status IN ('SUBMITTED', 'AUTO_CHECKED', 'HELD');

CREATE TABLE review_replies (
  review_id        uuid PRIMARY KEY REFERENCES reviews (id) ON DELETE CASCADE,
  store_id         uuid NOT NULL,
  author_user_id   uuid NOT NULL REFERENCES users (id),
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status           text NOT NULL
                     CHECK (status IN ('SUBMITTED', 'AUTO_CHECKED', 'PUBLISHED', 'HELD', 'REJECTED')),
  hold_reason      text CHECK (hold_reason IS NULL OR hold_reason IN
                     ('toxicity', 'image_flagged', 'classifier_unavailable', 'contact_info', 'reported', 'moderator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_replies_reason_when_blocked CHECK (status NOT IN ('HELD', 'REJECTED') OR hold_reason IS NOT NULL)
);

CREATE TABLE questions (
  id               uuid PRIMARY KEY,
  product_id       uuid NOT NULL,
  store_id         uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users (id),
  body             text NOT NULL CHECK (char_length(body) BETWEEN 5 AND 500),
  status           text NOT NULL
                     CHECK (status IN ('SUBMITTED', 'AUTO_CHECKED', 'PUBLISHED', 'HELD', 'REJECTED')),
  hold_reason      text CHECK (hold_reason IS NULL OR hold_reason IN
                     ('toxicity', 'image_flagged', 'classifier_unavailable', 'contact_info', 'reported', 'moderator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  sla_due_at       timestamptz,
  answered_at      timestamptz,
  sla_breached_at  timestamptz,
  CONSTRAINT questions_reason_when_blocked CHECK (status NOT IN ('HELD', 'REJECTED') OR hold_reason IS NOT NULL),
  CONSTRAINT questions_sla_pair CHECK ((published_at IS NULL) = (sla_due_at IS NULL))
);

CREATE INDEX questions_product_published_idx ON questions (product_id, published_at DESC, id DESC)
  WHERE status = 'PUBLISHED';
CREATE INDEX questions_user_idx ON questions (user_id, created_at DESC);
CREATE INDEX questions_store_open_idx ON questions (store_id, sla_due_at)
  WHERE status = 'PUBLISHED' AND answered_at IS NULL;
CREATE INDEX questions_moderation_idx ON questions (created_at, id)
  WHERE status IN ('SUBMITTED', 'AUTO_CHECKED', 'HELD');

CREATE TABLE answers (
  id               uuid PRIMARY KEY,
  question_id      uuid NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  store_id         uuid NOT NULL,
  author_user_id   uuid NOT NULL REFERENCES users (id),
  body             text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 1000),
  status           text NOT NULL
                     CHECK (status IN ('SUBMITTED', 'AUTO_CHECKED', 'PUBLISHED', 'HELD', 'REJECTED')),
  hold_reason      text CHECK (hold_reason IS NULL OR hold_reason IN
                     ('toxicity', 'image_flagged', 'classifier_unavailable', 'contact_info', 'reported', 'moderator')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answers_question_store_uq UNIQUE (question_id, store_id),
  CONSTRAINT answers_reason_when_blocked CHECK (status NOT IN ('HELD', 'REJECTED') OR hold_reason IS NOT NULL)
);

CREATE INDEX answers_moderation_idx ON answers (created_at, id)
  WHERE status IN ('SUBMITTED', 'AUTO_CHECKED', 'HELD');

CREATE TABLE ugc_reports (
  id           uuid PRIMARY KEY,
  target_type  text NOT NULL CHECK (target_type IN ('review', 'review_reply', 'question', 'answer')),
  target_id    uuid NOT NULL,
  reporter_id  uuid NOT NULL REFERENCES users (id),
  reason       text NOT NULL CHECK (reason IN ('spam', 'offensive', 'off_topic', 'fake', 'personal_info', 'other')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ugc_reports_once_uq UNIQUE (target_type, target_id, reporter_id)
);

CREATE INDEX ugc_reports_reporter_idx ON ugc_reports (reporter_id, created_at DESC);

CREATE TABLE moderation_log (
  id           uuid PRIMARY KEY,
  target_type  text NOT NULL CHECK (target_type IN ('review', 'review_reply', 'question', 'answer')),
  target_id    uuid NOT NULL,
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('system', 'moderator', 'author', 'reports')),
  actor_id     uuid,
  reason       text CHECK (reason IS NULL OR char_length(reason) <= 60),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_log_target_idx ON moderation_log (target_type, target_id, created_at);

-- Row level security --------------------------------------------------------------------
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON reviews TO app_user;
CREATE POLICY reviews_select ON reviews FOR SELECT
  USING (status = 'PUBLISHED' OR user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY reviews_author_insert ON reviews FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY reviews_author_update ON reviews FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY reviews_author_delete ON reviews FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE review_replies ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON review_replies TO app_user;
CREATE POLICY review_replies_select ON review_replies FOR SELECT
  USING (status = 'PUBLISHED' OR author_user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY review_replies_system_insert ON review_replies FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY review_replies_system_update ON review_replies FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON questions TO app_user;
CREATE POLICY questions_select ON questions FOR SELECT
  USING (status = 'PUBLISHED' OR user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY questions_author_insert ON questions FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY questions_system_update ON questions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON answers TO app_user;
CREATE POLICY answers_select ON answers FOR SELECT
  USING (status = 'PUBLISHED' OR author_user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY answers_system_insert ON answers FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY answers_system_update ON answers FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE ugc_reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ugc_reports TO app_user;
CREATE POLICY ugc_reports_select ON ugc_reports FOR SELECT
  USING (reporter_id = app_user_id() OR app_role() = 'system');
CREATE POLICY ugc_reports_insert ON ugc_reports FOR INSERT
  WITH CHECK (reporter_id = app_user_id() OR app_role() = 'system');

ALTER TABLE moderation_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON moderation_log TO app_user;
CREATE POLICY moderation_log_system_select ON moderation_log FOR SELECT USING (app_role() = 'system');
CREATE POLICY moderation_log_system_insert ON moderation_log FOR INSERT WITH CHECK (app_role() = 'system');
