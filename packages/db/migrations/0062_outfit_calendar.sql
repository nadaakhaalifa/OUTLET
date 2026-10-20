-- migration: 0062_outfit_calendar
-- phase: expand
--
-- Outfit calendar (spec P3-02, docs/specs/phase-3/outfit-calendar.md, master prompt 28 row 3).
-- Expand only: two new tables, nothing existing changes.
--
--   * calendar_events: a shopper's event (kind, start instant plus Cairo-local date, short note,
--     modesty, season band, optional typed budget, slots already owned). P2, owner scoped by RLS,
--     deleted on account deletion (user_id on every table so the erasure executor can attribute rows).
--     Imported (device) events carry date and kind only; the API never accepts more for them.
--   * calendar_outfits: link from an event to a stylist outfit (outfits, 0039) with a small status
--     machine planned -> in_bag -> purchased -> worn. ON DELETE CASCADE from both sides: clearing
--     the stylist history drops the suggestions, never the event.
--   * Money is integer piastres (BIGINT). The budget is only what the shopper typed for the event;
--     a budget derived from the budget suite is never stored here (spec 12 privacy).
--   * RLS follows 0039: owner reads and writes, the system role (workers) reads and writes all.

CREATE TABLE calendar_events (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id),
  kind              text NOT NULL CHECK (kind IN ('work', 'wedding_guest', 'date', 'eid', 'university', 'travel', 'custom')),
  starts_at         timestamptz NOT NULL,
  -- Cairo-local calendar date of starts_at, resolved through the tz database by the application.
  local_date        date NOT NULL,
  note              text CHECK (note IS NULL OR char_length(note) <= 200),
  modesty           text NOT NULL DEFAULT 'standard' CHECK (modesty IN ('standard', 'modest')),
  season_band       text NOT NULL DEFAULT 'all' CHECK (season_band IN ('summer', 'winter', 'spring', 'autumn', 'all')),
  budget_piastres   bigint CHECK (budget_piastres IS NULL OR budget_piastres >= 0),
  owned_slots       text[] NOT NULL DEFAULT '{}'
                      CHECK (owned_slots <@ ARRAY['top', 'bottom', 'dress', 'shoes', 'bag', 'accessory']::text[]),
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'wishlist', 'device')),
  reminders_enabled boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_events_user_start_idx ON calendar_events (user_id, starts_at, id);
CREATE INDEX calendar_events_active_start_idx ON calendar_events (starts_at) WHERE status = 'active';

CREATE TABLE calendar_outfits (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  outfit_id   uuid NOT NULL REFERENCES outfits (id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_bag', 'purchased', 'worn')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_outfits_event_outfit_uq UNIQUE (event_id, outfit_id)
);
CREATE INDEX calendar_outfits_event_idx ON calendar_outfits (event_id, created_at, id);
CREATE INDEX calendar_outfits_user_idx ON calendar_outfits (user_id);

-- Row level security ---------------------------------------------------------------------
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO app_user;
CREATE POLICY calendar_events_owner_select ON calendar_events FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_events_owner_insert ON calendar_events FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_events_owner_update ON calendar_events FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_events_owner_delete ON calendar_events FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE calendar_outfits ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_outfits TO app_user;
CREATE POLICY calendar_outfits_owner_select ON calendar_outfits FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_outfits_owner_insert ON calendar_outfits FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_outfits_owner_update ON calendar_outfits FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY calendar_outfits_owner_delete ON calendar_outfits FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');
