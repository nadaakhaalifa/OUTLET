-- migration: 0060_family_plans
-- phase: expand
--
-- Family plan seats (docs/specs/phase-3/family-student-plans.md, section 14, B6, ADR-0012). Expand only:
-- three new tables.
--
--   * family_groups: one per family subscription; the owner is the billing and contracting party.
--     seat_limit is a snapshot of the plan version's limit at creation (owner included).
--   * family_members: one row per seat. Pending invites are rows with status INVITED and no user,
--     so a seat is held from the invite on. seat_no (1..8) is unique per group among rows that
--     hold a seat, which makes oversubscription impossible even if two accepts race; the
--     application also locks the group row. Seat 1 is the owner.
--   * a user holds at most one seat across all families (partial unique index on user_id).
--   * REMOVED rows keep the seat and the benefit until seat_end_at (the next cycle), then ENDED.
--   * family_invites: token_hash is the HMAC of a 128 bit token; the phone is never stored, only
--     its blind-index hash. Invites expire after 7 days (enforced by the application, data here).
--   * Row level security: the owner reads the group, its seats and its invites, a member reads
--     only its own seat row; every write runs as app.role = 'system' (the policy guard authorizes).
--     family_groups policies never reference family_members (no policy recursion).

CREATE TABLE family_groups (
  id                    uuid PRIMARY KEY,
  owner_user_id         uuid NOT NULL REFERENCES users (id),
  subscription_id       uuid NOT NULL REFERENCES subscriptions (id),
  seat_limit            smallint NOT NULL CHECK (seat_limit BETWEEN 1 AND 8),
  status                text NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  ending_notice_sent_at timestamptz,
  ended_at              timestamptz,
  version               integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT family_groups_subscription_uq UNIQUE (subscription_id),
  CONSTRAINT family_groups_ended_has_time CHECK (status <> 'ENDED' OR ended_at IS NOT NULL)
);

CREATE UNIQUE INDEX family_groups_one_active_owner_uq ON family_groups (owner_user_id) WHERE status = 'ACTIVE';
CREATE INDEX family_groups_active_idx ON family_groups (id) WHERE status = 'ACTIVE';

CREATE TABLE family_members (
  id                  uuid PRIMARY KEY,
  group_id            uuid NOT NULL REFERENCES family_groups (id),
  user_id             uuid REFERENCES users (id),
  role                text NOT NULL CHECK (role IN ('owner', 'member')),
  status              text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'REMOVED', 'ENDED')),
  seat_no             smallint NOT NULL CHECK (seat_no BETWEEN 1 AND 8),
  nickname            text CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 40),
  invited_at          timestamptz NOT NULL,
  seat_effective_from timestamptz,
  seat_end_at         timestamptz,
  removed_at          timestamptz,
  removed_by          text CHECK (removed_by IS NULL OR removed_by IN ('owner', 'self', 'system')),
  CONSTRAINT family_members_user_by_status CHECK (
    (status IN ('ACTIVE', 'REMOVED') AND user_id IS NOT NULL) OR (status = 'INVITED' AND user_id IS NULL) OR status = 'ENDED'
  ),
  CONSTRAINT family_members_removed_has_end CHECK (status <> 'REMOVED' OR (seat_end_at IS NOT NULL AND removed_at IS NOT NULL)),
  CONSTRAINT family_members_owner_seat CHECK (role <> 'owner' OR seat_no = 1)
);

CREATE UNIQUE INDEX family_members_seat_uq ON family_members (group_id, seat_no)
  WHERE status IN ('INVITED', 'ACTIVE', 'REMOVED');
CREATE UNIQUE INDEX family_members_user_one_family_uq ON family_members (user_id)
  WHERE user_id IS NOT NULL AND status IN ('ACTIVE', 'REMOVED');
CREATE INDEX family_members_group_idx ON family_members (group_id, status);

CREATE TABLE family_invites (
  id                 uuid PRIMARY KEY,
  group_id           uuid NOT NULL REFERENCES family_groups (id),
  member_id          uuid NOT NULL REFERENCES family_members (id),
  invitee_phone_hash text NOT NULL CHECK (char_length(invitee_phone_hash) = 64),
  token_hash         text NOT NULL CHECK (char_length(token_hash) = 64),
  expires_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  revoked_at         timestamptz,
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT family_invites_token_uq UNIQUE (token_hash),
  CONSTRAINT family_invites_member_uq UNIQUE (member_id),
  CONSTRAINT family_invites_one_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX family_invites_group_idx ON family_invites (group_id, created_at DESC);

ALTER TABLE family_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON family_groups TO app_user;
CREATE POLICY family_groups_select ON family_groups FOR SELECT
  USING (owner_user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY family_groups_system_insert ON family_groups FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY family_groups_system_update ON family_groups FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON family_members TO app_user;
CREATE POLICY family_members_select ON family_members FOR SELECT
  USING (
    user_id = app_user_id()
    OR app_role() = 'system'
    OR EXISTS (SELECT 1 FROM family_groups g WHERE g.id = family_members.group_id AND g.owner_user_id = app_user_id())
  );
CREATE POLICY family_members_system_insert ON family_members FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY family_members_system_update ON family_members FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON family_invites TO app_user;
CREATE POLICY family_invites_select ON family_invites FOR SELECT
  USING (created_by = app_user_id() OR app_role() = 'system');
CREATE POLICY family_invites_system_insert ON family_invites FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY family_invites_system_update ON family_invites FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
