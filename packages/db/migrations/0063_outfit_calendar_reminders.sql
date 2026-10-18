-- migration: 0063_outfit_calendar_reminders
-- phase: expand
--
-- Outfit calendar reminders (spec P3-02 Flow, Failure handling). Expand only: one new table.
--
--   * One row per planned reminder: 7 days and 1 day before the event, already moved out of quiet
--     hours (23:00-09:00 Africa/Cairo) by the application. UNIQUE (event_id, due_at) is the dedupe
--     key the spec names, so a retried planner or a doubled worker run cannot create a second row.
--   * state machine: pending -> sending (claimed by a worker, lease in claimed_at) -> sent | skipped
--     | failed. A stale 'sending' row (crashed worker) is re-claimed after the lease.
--   * The row holds no message text and no event note; the notification carries a template key
--     and a deep link only.
--   * RLS as 0062: owner reads, the system role (workers) writes.

CREATE TABLE calendar_reminders (
  id           uuid PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  offset_days  smallint NOT NULL CHECK (offset_days BETWEEN 0 AND 60),
  due_at       timestamptz NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at   timestamptz,
  sent_at      timestamptz,
  skip_reason  text CHECK (skip_reason IS NULL OR skip_reason IN ('event_past', 'event_changed', 'reminders_off', 'kill_switch', 'duplicate', 'no_recipient', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_reminders_event_due_uq UNIQUE (event_id, due_at)
);
CREATE INDEX calendar_reminders_due_idx ON calendar_reminders (due_at) WHERE state IN ('pending', 'sending');
CREATE INDEX calendar_reminders_user_sent_idx ON calendar_reminders (user_id, sent_at) WHERE state = 'sent';

ALTER TABLE calendar_reminders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_reminders TO app_user;
CREATE POLICY calendar_reminders_owner_select ON calendar_reminders FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_reminders_owner_insert ON calendar_reminders FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_reminders_owner_update ON calendar_reminders FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_reminders_owner_delete ON calendar_reminders FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');
