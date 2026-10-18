-- migration: 0067_stylist_chat_settings_quota
-- phase: expand
--
-- Stylist chat settings and fair-use counter (spec P3-07).
--   * stylist_chat_settings.history_enabled is "save chat history" (default OFF, set by the shopper).
--   * stylist_chat_quota counts answered chat turns per user per UTC day (30/day free, LLM10). It is
--     a separate counter so that fair use does not depend on keeping any turn row or text.

CREATE TABLE stylist_chat_settings (
  user_id          uuid PRIMARY KEY REFERENCES users (id),
  history_enabled  boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stylist_chat_quota (
  user_id  uuid NOT NULL REFERENCES users (id),
  day      date NOT NULL,
  turns    integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE stylist_chat_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON stylist_chat_settings TO app_user;
CREATE POLICY stylist_chat_settings_owner_select ON stylist_chat_settings FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_settings_owner_insert ON stylist_chat_settings FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_settings_owner_update ON stylist_chat_settings FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_settings_owner_delete ON stylist_chat_settings FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE stylist_chat_quota ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON stylist_chat_quota TO app_user;
CREATE POLICY stylist_chat_quota_owner_select ON stylist_chat_quota FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_quota_owner_insert ON stylist_chat_quota FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_quota_owner_update ON stylist_chat_quota FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_quota_owner_delete ON stylist_chat_quota FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');
