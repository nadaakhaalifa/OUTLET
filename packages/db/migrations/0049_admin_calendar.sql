-- migration: 0049_admin_calendar
-- phase: expand
--
-- Admin promotions and mega-event calendar (spec 23, docs/specs/admin-calendar.md). Events are
-- planning records only: they never change a price or start a promotion. Every write appends an
-- audit row in the same transaction. Expand only: two new tables.

CREATE TABLE admin_calendar_events (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('mega_event', 'promotion_window', 'drop_window', 'release_freeze')),
  title_ar    text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 300),
  title_en    text CHECK (title_en IS NULL OR char_length(title_en) <= 300),
  note        text CHECK (note IS NULL OR char_length(note) <= 2000),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'cancelled')),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  uuid NOT NULL,
  updated_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_calendar_events_range_ck CHECK (ends_at > starts_at)
);
CREATE INDEX admin_calendar_events_start_idx ON admin_calendar_events (starts_at DESC, id DESC);

CREATE TABLE admin_calendar_audit (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL,
  actor_id    uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('created', 'updated', 'cancelled')),
  before      jsonb,
  after       jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_calendar_audit_event_idx ON admin_calendar_audit (event_id, at);

ALTER TABLE admin_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_calendar_audit ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON admin_calendar_events TO app_user;
GRANT SELECT, INSERT ON admin_calendar_audit TO app_user;
CREATE POLICY admin_calendar_events_select ON admin_calendar_events FOR SELECT
  USING (app_role() IN ('system', 'marketing', 'ops', 'finance', 'super_admin'));
CREATE POLICY admin_calendar_events_insert ON admin_calendar_events FOR INSERT
  WITH CHECK (app_role() IN ('system', 'marketing', 'ops', 'super_admin'));
CREATE POLICY admin_calendar_events_update ON admin_calendar_events FOR UPDATE
  USING (app_role() IN ('system', 'marketing', 'ops', 'super_admin'))
  WITH CHECK (app_role() IN ('system', 'marketing', 'ops', 'super_admin'));
CREATE POLICY admin_calendar_audit_select ON admin_calendar_audit FOR SELECT
  USING (app_role() IN ('system', 'ops', 'super_admin'));
CREATE POLICY admin_calendar_audit_insert ON admin_calendar_audit FOR INSERT
  WITH CHECK (app_role() IN ('system', 'marketing', 'ops', 'super_admin'));
