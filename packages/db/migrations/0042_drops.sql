-- migration: 0042_drops
-- phase: expand
--
-- Limited drops and the waiting room (spec 16, 20.2, T9; docs/specs/phase2/07-drops-waiting-room.md).
-- Expand only: six new tables, nothing existing changes.
--
--   * drops / drop_items are P0 catalogue data. Money is BIGINT piastres. The lifecycle is the
--     registered Drop state machine; `paused` is a reversible flag, not a state. `version` is the
--     optimistic lock used by every transition and edit.
--   * Redis is the queue of record while a drop runs. queue_tickets is the durable AUDIT row,
--     written when a ticket is admitted, abandoned or rejected. It never decides who is next.
--   * admission_tokens: one row per issued 15 minute JWT (jti). used_at makes it single use.
--     The signature check itself is stateless, so checkout survives a queue outage.
--   * drop_purchases is the per-user and per-device allowance ledger; reservation_id is unique
--     so a retried claim cannot count twice.
--   * Device identifiers are stored only as a SHA-256 hash (device_hash).
--   * Row level security: published drops are world readable, buyers see only their own rows,
--     every write runs as app.role = 'system' (the policy guard authorizes sellers and admins).

CREATE TABLE drops (
  id                 uuid PRIMARY KEY,
  store_id           uuid NOT NULL,
  type               text NOT NULL
                       CHECK (type IN ('public', 'members_only', 'flash_hour', 'mystery_box', 'price_ladder', 'last_chance')),
  state              text NOT NULL
                       CHECK (state IN ('DRAFT', 'SCHEDULED', 'EARLY_ACCESS', 'LIVE', 'SOLD_OUT', 'ENDED', 'ARCHIVED')),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  starts_at          timestamptz NOT NULL,
  early_access_at    timestamptz,
  ends_at            timestamptz NOT NULL,
  admit_per_sec      integer NOT NULL CHECK (admit_per_sec BETWEEN 1 AND 5000),
  limits             jsonb NOT NULL
                       CHECK (jsonb_typeof(limits) = 'object' AND (limits ->> 'per_user') ~ '^[0-9]+$' AND (limits ->> 'per_device') ~ '^[0-9]+$'),
  ladder             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ladder) = 'array'),
  mystery            jsonb CHECK (mystery IS NULL OR jsonb_typeof(mystery) = 'object'),
  paused             boolean NOT NULL DEFAULT false,
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drops_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT drops_early_ck CHECK (early_access_at IS NULL OR early_access_at < starts_at),
  CONSTRAINT drops_early_members_only_ck CHECK ((type = 'members_only') = (early_access_at IS NOT NULL)),
  CONSTRAINT drops_mystery_ck CHECK ((type = 'mystery_box') = (mystery IS NOT NULL))
);

CREATE INDEX drops_store_idx ON drops (store_id, starts_at DESC, id DESC);
CREATE INDEX drops_open_idx ON drops (starts_at, id) WHERE state IN ('SCHEDULED', 'EARLY_ACCESS', 'LIVE');
CREATE INDEX drops_public_idx ON drops (starts_at DESC, id DESC) WHERE state <> 'DRAFT';

CREATE TABLE drop_items (
  drop_id    uuid NOT NULL REFERENCES drops (id) ON DELETE CASCADE,
  sku_id     uuid NOT NULL,
  stock_cap  integer NOT NULL CHECK (stock_cap >= 1),
  price      bigint NOT NULL CHECK (price > 0),
  PRIMARY KEY (drop_id, sku_id)
);

CREATE TABLE queue_tickets (
  id           uuid PRIMARY KEY,
  drop_id      uuid NOT NULL REFERENCES drops (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  device_hash  text NOT NULL CHECK (char_length(device_hash) = 64),
  state        text NOT NULL CHECK (state IN ('admitted', 'abandoned', 'rejected')),
  joined_at    timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  CONSTRAINT queue_tickets_user_uq UNIQUE (drop_id, user_id, joined_at)
);

CREATE INDEX queue_tickets_drop_idx ON queue_tickets (drop_id, joined_at);
CREATE INDEX queue_tickets_user_idx ON queue_tickets (user_id, joined_at DESC);

CREATE TABLE admission_tokens (
  jti          uuid PRIMARY KEY,
  drop_id      uuid NOT NULL REFERENCES drops (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  device_hash  text NOT NULL CHECK (char_length(device_hash) = 64),
  ticket_id    uuid NOT NULL,
  issued_at    timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  CONSTRAINT admission_tokens_ttl_ck CHECK (expires_at = issued_at + interval '15 minutes')
);

CREATE INDEX admission_tokens_user_idx ON admission_tokens (drop_id, user_id, issued_at DESC);
CREATE INDEX admission_tokens_expiry_idx ON admission_tokens (expires_at) WHERE used_at IS NULL;

CREATE TABLE drop_waitlist (
  drop_id     uuid NOT NULL REFERENCES drops (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY (drop_id, user_id)
);

CREATE TABLE drop_purchases (
  id              uuid PRIMARY KEY,
  drop_id         uuid NOT NULL REFERENCES drops (id) ON DELETE CASCADE,
  sku_id          uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  device_hash     text NOT NULL CHECK (char_length(device_hash) = 64),
  qty             integer NOT NULL CHECK (qty >= 1),
  reservation_id  uuid NOT NULL,
  released_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drop_purchases_reservation_uq UNIQUE (reservation_id)
);

CREATE INDEX drop_purchases_user_idx ON drop_purchases (drop_id, sku_id, user_id) WHERE released_at IS NULL;
CREATE INDEX drop_purchases_device_idx ON drop_purchases (drop_id, sku_id, device_hash) WHERE released_at IS NULL;

-- Row level security --------------------------------------------------------------------
ALTER TABLE drops ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON drops TO app_user;
CREATE POLICY drops_select ON drops FOR SELECT USING (state <> 'DRAFT' OR app_role() = 'system');
CREATE POLICY drops_system_insert ON drops FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY drops_system_update ON drops FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY drops_system_delete ON drops FOR DELETE USING (app_role() = 'system' AND state = 'DRAFT');

ALTER TABLE drop_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON drop_items TO app_user;
CREATE POLICY drop_items_select ON drop_items FOR SELECT
  USING (app_role() = 'system' OR EXISTS (SELECT 1 FROM drops d WHERE d.id = drop_id AND d.state <> 'DRAFT'));
CREATE POLICY drop_items_system_insert ON drop_items FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY drop_items_system_update ON drop_items FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY drop_items_system_delete ON drop_items FOR DELETE USING (app_role() = 'system');

ALTER TABLE queue_tickets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON queue_tickets TO app_user;
CREATE POLICY queue_tickets_select ON queue_tickets FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY queue_tickets_system_insert ON queue_tickets FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE admission_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON admission_tokens TO app_user;
CREATE POLICY admission_tokens_select ON admission_tokens FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY admission_tokens_system_insert ON admission_tokens FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY admission_tokens_system_update ON admission_tokens FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE drop_waitlist ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON drop_waitlist TO app_user;
CREATE POLICY drop_waitlist_select ON drop_waitlist FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY drop_waitlist_insert ON drop_waitlist FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY drop_waitlist_system_update ON drop_waitlist FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE drop_purchases ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON drop_purchases TO app_user;
CREATE POLICY drop_purchases_select ON drop_purchases FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY drop_purchases_system_insert ON drop_purchases FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY drop_purchases_system_update ON drop_purchases FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
