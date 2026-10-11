-- migration: 0018_notifications
-- phase: expand
--
-- Notifications core (spec section 24, docs/specs/notifications.md, docs/data-model/notifications.md).
-- Expand only: new tables, no change to existing ones.
--
--   * Consent is owned by privacy (consent_records / consents_current). Nothing here duplicates it.
--   * Push tokens: devices (0006) has no push_token column, so tokens live in notification_push_tokens
--     keyed (user_id, install_id); no user can overwrite another user's row.
--   * notification_log is not partitioned here (see spec Deviations).
--   * Row level security: user-owned tables follow packages/policy/RLS.md class A, per verb.
--     Dispatch, release and consumer jobs run with app.role = 'system'.
--     Templates and providers are configuration: readable by the app, written by marketing/super_admin/system.

CREATE TABLE notification_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  version               integer NOT NULL CHECK (version >= 1),
  channel               text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email', 'in_app')),
  category              text NOT NULL CHECK (category IN ('transactional', 'marketing', 'security')),
  type                  text NOT NULL CHECK (type IN ('ORDER_UPDATES', 'REFUNDS', 'ACCOUNT_SECURITY', 'PRICE_DROPS',
                                                      'BACK_IN_SIZE', 'STYLIST', 'BUDGET', 'PROMOTIONS', 'REWARDS', 'PLUS')),
  subject_ar            text,
  subject_en            text,
  body_ar               text NOT NULL,
  body_en               text,
  provider_template_id  text,
  approval_status       text NOT NULL DEFAULT 'DRAFT'
                          CHECK (approval_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  active                boolean NOT NULL DEFAULT false,
  alert_type            text CHECK (alert_type IS NULL OR alert_type IN ('price_drop', 'back_in_size', 'low_stock', 'date_approaching')),
  valid_from            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_templates_key_version_channel_uq UNIQUE (key, version, channel),
  -- Arabic is mandatory for an active template (spec A2.15, section 24).
  CONSTRAINT notification_templates_arabic_required CHECK (NOT active OR char_length(btrim(body_ar)) > 0),
  CONSTRAINT notification_templates_whatsapp_approved CHECK (
    NOT (active AND channel = 'whatsapp') OR (provider_template_id IS NOT NULL AND approval_status = 'APPROVED'))
);

CREATE UNIQUE INDEX notification_templates_active_uq ON notification_templates (key, channel) WHERE active;

CREATE TABLE channel_providers (
  channel            text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email')),
  provider_code      text NOT NULL CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  priority           integer NOT NULL CHECK (priority >= 0),
  enabled            boolean NOT NULL DEFAULT true,
  webhook_secret_ref text,            -- a KMS reference, never the secret
  PRIMARY KEY (channel, provider_code)
);

CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES users (id),
  type        text NOT NULL CHECK (type IN ('PRICE_DROPS', 'BACK_IN_SIZE', 'STYLIST', 'BUDGET', 'PROMOTIONS', 'REWARDS', 'PLUS')),
  channel     text NOT NULL CHECK (channel IN ('*', 'push', 'whatsapp', 'sms', 'email', 'in_app')),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE notification_suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  channel     text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email')),
  reason      text NOT NULL CHECK (reason IN ('UNSUBSCRIBED', 'BOUNCE', 'COMPLAINT', 'INVALID_TOKEN')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_suppressions_uq UNIQUE (user_id, channel, reason)
);

CREATE TABLE notification_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  template_key        text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  ref                 text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 128),
  category            text NOT NULL CHECK (category IN ('transactional', 'marketing', 'security')),
  type                text NOT NULL,
  payload             jsonb NOT NULL,   -- flat placeholder values, validated, no P3
  template_versions   jsonb NOT NULL,   -- channel -> version rendered with
  status              text NOT NULL CHECK (status IN ('ACCEPTED', 'SUPPRESSED', 'SCHEDULED', 'SENT', 'FAILED', 'CANCELLED')),
  suppressed_reason   text CHECK (suppressed_reason IS NULL OR suppressed_reason IN
                        ('NO_CONSENT', 'FREQUENCY_CAP', 'QUIET_HOURS', 'PREFERENCE', 'SUPPRESSION_LIST')),
  pending_channel     text CHECK (pending_channel IS NULL OR pending_channel IN ('push', 'whatsapp', 'sms', 'email')),
  scheduled_for       timestamptz,
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at          timestamptz NOT NULL,
  deep_link           text CHECK (deep_link IS NULL OR char_length(deep_link) <= 200),
  locale              text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_requests_identity_uq UNIQUE (user_id, template_key, ref),
  CONSTRAINT notification_requests_scheduled_chk CHECK ((status = 'SCHEDULED') = (scheduled_for IS NOT NULL)),
  CONSTRAINT notification_requests_suppressed_chk CHECK (status <> 'SUPPRESSED' OR suppressed_reason IS NOT NULL)
);

CREATE INDEX notification_requests_due_idx ON notification_requests (scheduled_for) WHERE status = 'SCHEDULED';
CREATE INDEX notification_requests_user_idx ON notification_requests (user_id, created_at DESC);

CREATE TRIGGER notification_requests_touch_updated_at_trg
  BEFORE UPDATE ON notification_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE notification_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES notification_requests (id),
  user_id           uuid NOT NULL REFERENCES users (id),
  channel           text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'sms', 'email', 'in_app')),
  template_key      text NOT NULL,
  template_version  integer NOT NULL CHECK (template_version >= 1),
  category          text NOT NULL CHECK (category IN ('transactional', 'marketing', 'security')),
  provider_code     text NOT NULL,
  provider_ref      text,
  status            text NOT NULL CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED')),
  failure_code      text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{1,47}$'),
  sent_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  CONSTRAINT notification_log_failure_chk CHECK (status NOT IN ('FAILED', 'BOUNCED') OR failure_code IS NOT NULL)
);

CREATE INDEX notification_log_user_idx ON notification_log (user_id, sent_at DESC);
CREATE INDEX notification_log_provider_idx ON notification_log (provider_code, provider_ref);
CREATE INDEX notification_log_request_idx ON notification_log (request_id);

CREATE TABLE inbox_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  request_id  uuid NOT NULL REFERENCES notification_requests (id),
  type        text NOT NULL,
  title_ar    text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 2000),
  title_en    text CHECK (title_en IS NULL OR char_length(title_en) <= 2000),
  body_ar     text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 2000),
  body_en     text CHECK (body_en IS NULL OR char_length(body_en) <= 2000),
  deep_link   text CHECK (deep_link IS NULL OR char_length(deep_link) <= 200),
  read_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_messages_request_uq UNIQUE (request_id)
);

CREATE INDEX inbox_messages_user_idx ON inbox_messages (user_id, created_at DESC, id DESC);

CREATE TABLE notification_frequency_counters (
  user_id          uuid NOT NULL REFERENCES users (id),
  channel          text NOT NULL CHECK (channel IN ('push', 'whatsapp', 'email')),
  day              date NOT NULL,   -- Africa/Cairo calendar day
  marketing_count  integer NOT NULL DEFAULT 0 CHECK (marketing_count >= 0),
  PRIMARY KEY (user_id, channel, day)
);

CREATE TABLE notification_push_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  install_id      uuid NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios', 'android')),
  token           text NOT NULL CHECK (char_length(token) BETWEEN 8 AND 512),   -- P2, never logged or returned
  deactivated_at  timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_push_tokens_user_install_uq UNIQUE (user_id, install_id)
);

CREATE UNIQUE INDEX notification_push_tokens_active_token_uq ON notification_push_tokens (md5(token)) WHERE deactivated_at IS NULL;
CREATE INDEX notification_push_tokens_user_idx ON notification_push_tokens (user_id) WHERE deactivated_at IS NULL;

-- Row level security -----------------------------------------------------------------------
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_templates TO app_user;
CREATE POLICY notification_templates_read ON notification_templates FOR SELECT USING (true);
CREATE POLICY notification_templates_insert ON notification_templates FOR INSERT
  WITH CHECK (app_role() IN ('marketing', 'super_admin', 'system'));
CREATE POLICY notification_templates_update ON notification_templates FOR UPDATE
  USING (app_role() IN ('marketing', 'super_admin', 'system'))
  WITH CHECK (app_role() IN ('marketing', 'super_admin', 'system'));

ALTER TABLE channel_providers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON channel_providers TO app_user;
CREATE POLICY channel_providers_read ON channel_providers FOR SELECT USING (true);
CREATE POLICY channel_providers_insert ON channel_providers FOR INSERT
  WITH CHECK (app_role() IN ('super_admin', 'system'));
CREATE POLICY channel_providers_update ON channel_providers FOR UPDATE
  USING (app_role() IN ('super_admin', 'system'))
  WITH CHECK (app_role() IN ('super_admin', 'system'));

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO app_user;
CREATE POLICY notification_preferences_owner_select ON notification_preferences FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_preferences_owner_insert ON notification_preferences FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_preferences_owner_update ON notification_preferences FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_preferences_owner_delete ON notification_preferences FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE notification_suppressions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON notification_suppressions TO app_user;
CREATE POLICY notification_suppressions_owner_select ON notification_suppressions FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_suppressions_owner_insert ON notification_suppressions FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_suppressions_owner_delete ON notification_suppressions FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE notification_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_requests TO app_user;
CREATE POLICY notification_requests_select ON notification_requests FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_requests_insert ON notification_requests FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY notification_requests_update ON notification_requests FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_log TO app_user;
CREATE POLICY notification_log_select ON notification_log FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_log_insert ON notification_log FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY notification_log_update ON notification_log FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON inbox_messages TO app_user;
CREATE POLICY inbox_messages_owner_select ON inbox_messages FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY inbox_messages_system_insert ON inbox_messages FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY inbox_messages_owner_update ON inbox_messages FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE notification_frequency_counters ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_frequency_counters TO app_user;
CREATE POLICY notification_frequency_counters_select ON notification_frequency_counters FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_frequency_counters_insert ON notification_frequency_counters FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY notification_frequency_counters_update ON notification_frequency_counters FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE notification_push_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notification_push_tokens TO app_user;
CREATE POLICY notification_push_tokens_owner_select ON notification_push_tokens FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_push_tokens_owner_insert ON notification_push_tokens FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY notification_push_tokens_owner_update ON notification_push_tokens FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
