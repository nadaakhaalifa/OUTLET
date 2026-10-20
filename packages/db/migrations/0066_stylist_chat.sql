-- migration: 0066_stylist_chat
-- phase: expand
--
-- Stylist chat (spec P3-07, docs/specs/phase-3/stylist-chat.md; spec 11 chat mode). Expand only:
-- two new tables, nothing existing changes.
--
--   * stylist_chat_sessions holds the structured session_state (occasion, scope, typed budget, rejected
--     item ids). It never holds free text. Owner scoped by RLS (P2).
--   * stylist_chat_turns holds one row per message. `text` is the shopper's PII-scrubbed message and is
--     NULL unless the shopper turned "save chat history" on (default off, spec Rules). Assistant turns
--     never store text: the reply is rendered from `reply_code` plus catalogue ids, so the LLM cannot
--     persist or invent a price, stock count or product claim (LLM05/LLM09).
--   * Prices are never stored here. outfit blocks reference outfits(id); prices are re-read at render.
--   * prompt_hash / tokens are the per-turn audit trail (T12); llm_audit_log (0039) stays the gateway
--     ledger and has no user column.
-- Retention: sessions follow support_chats (2 years, B1) by `updated_at`; turn text is nullified after
-- 30 days (spec Rules) by the retention module.

CREATE TABLE stylist_chat_sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id),
  state            jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  history_enabled  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stylist_chat_sessions_user_idx ON stylist_chat_sessions (user_id, updated_at DESC, id DESC);
CREATE INDEX stylist_chat_sessions_updated_idx ON stylist_chat_sessions (updated_at);

CREATE TABLE stylist_chat_turns (
  id                 uuid PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES stylist_chat_sessions (id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users (id),
  seq                integer NOT NULL CHECK (seq >= 1),
  role               text NOT NULL CHECK (role IN ('user', 'assistant')),
  client_message_id  uuid,
  text               text CHECK (text IS NULL OR char_length(text) <= 2000),
  reply_code         text CHECK (reply_code IS NULL OR char_length(reply_code) BETWEEN 1 AND 60),
  blocks             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks) = 'array'),
  intent             text CHECK (intent IS NULL OR char_length(intent) BETWEEN 1 AND 30),
  source             text CHECK (source IS NULL OR source IN ('llm', 'rules')),
  prompt_hash        text CHECK (prompt_hash IS NULL OR prompt_hash ~ '^[0-9a-f]{64}$'),
  tokens_in          integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out         integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  tool_calls         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stylist_chat_turns_seq UNIQUE (session_id, seq),
  -- Assistant text is never stored: it is rendered from reply_code (LLM05).
  CONSTRAINT stylist_chat_turns_assistant_no_text CHECK (role = 'user' OR text IS NULL),
  CONSTRAINT stylist_chat_turns_client_id_on_user CHECK (client_message_id IS NULL OR role = 'user')
);
CREATE UNIQUE INDEX stylist_chat_turns_client_msg_idx ON stylist_chat_turns (session_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX stylist_chat_turns_text_idx ON stylist_chat_turns (created_at) WHERE text IS NOT NULL;

ALTER TABLE stylist_chat_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON stylist_chat_sessions TO app_user;
CREATE POLICY stylist_chat_sessions_owner_select ON stylist_chat_sessions FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_sessions_owner_insert ON stylist_chat_sessions FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_sessions_owner_update ON stylist_chat_sessions FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_sessions_owner_delete ON stylist_chat_sessions FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE stylist_chat_turns ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON stylist_chat_turns TO app_user;
CREATE POLICY stylist_chat_turns_owner_select ON stylist_chat_turns FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_turns_owner_insert ON stylist_chat_turns FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_turns_owner_update ON stylist_chat_turns FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY stylist_chat_turns_owner_delete ON stylist_chat_turns FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');
