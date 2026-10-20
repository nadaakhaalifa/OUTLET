-- migration: 0041_rewards
-- phase: expand
--
-- Rewards: coin events, goodwill debt, 12 month spend, tiers, challenges, light games with
-- published odds (docs/specs/phase2/06-rewards-coins-games.md). Expand only: new tables.
--
--   * coin_events is append only (no UPDATE grant except journal_entry_id settlement, expressed as
--     a dedicated column rule below). Earn rows carry the ledger entry that recognised the credit;
--     clawback and expire rows point at the earn row they reduce (parent_id).
--   * Debt (coins already spent when a purchase was returned) is netted from future earnings and
--     is never charged: coin_debts.amount is kept equal to the sum of debt_delta by the adapter.
--   * game_odds_versions is immutable (SELECT/INSERT only). Plays store the odds version, the
--     roll, the server seed and its hash so any play can be re-derived by an auditor.
--   * No column can hold cash: outcome_kind is nothing | coins | voucher.
--   * Row level security: shoppers read their own rows, the public reads odds, writes run as
--     app.role = 'system' (the policy guard authorizes who may ask).

CREATE TABLE reward_config_versions (
  version      integer PRIMARY KEY CHECK (version >= 1),
  config       jsonb NOT NULL,
  approval_id  text NOT NULL CHECK (char_length(approval_id) BETWEEN 1 AND 80),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coin_events (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id),
  kind               text NOT NULL CHECK (kind IN
                       ('purchase', 'photo_review', 'profile_completion', 'fit_feedback', 'referral',
                        'streak', 'challenge', 'game', 'clawback', 'expire')),
  sub                text NOT NULL DEFAULT 'cashback_coins' CHECK (sub IN ('cashback_coins', 'referral_credit')),
  amount             bigint NOT NULL,
  debt_delta         bigint NOT NULL DEFAULT 0,
  parent_id          uuid REFERENCES coin_events (id),
  source_ref         text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  journal_entry_id   uuid,
  expires_at         timestamptz,
  piastres_per_coin  bigint NOT NULL CHECK (piastres_per_coin >= 1),
  config_version     integer NOT NULL CHECK (config_version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coin_events_idem_uq UNIQUE (kind, source_ref),
  CONSTRAINT coin_events_earn_shape CHECK (
    kind IN ('clawback', 'expire')
    OR (amount > 0 AND debt_delta <= 0 AND -debt_delta <= amount AND expires_at IS NOT NULL AND parent_id IS NULL)),
  CONSTRAINT coin_events_clawback_shape CHECK (
    kind <> 'clawback'
    OR (amount < 0 AND debt_delta >= 0 AND debt_delta <= -amount AND parent_id IS NOT NULL)),
  CONSTRAINT coin_events_expire_shape CHECK (
    kind <> 'expire' OR (amount <= 0 AND debt_delta = 0 AND parent_id IS NOT NULL))
);

CREATE INDEX coin_events_user_idx ON coin_events (user_id, created_at DESC, id DESC);
CREATE INDEX coin_events_parent_idx ON coin_events (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX coin_events_due_idx ON coin_events (expires_at, id) WHERE parent_id IS NULL AND kind NOT IN ('clawback', 'expire');
CREATE INDEX coin_events_pending_idx ON coin_events (created_at, id)
  WHERE parent_id IS NULL AND kind NOT IN ('clawback', 'expire') AND journal_entry_id IS NULL AND amount + debt_delta > 0;

CREATE TABLE coin_debts (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  amount      bigint NOT NULL CHECK (amount >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spend_events (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  source_ref   text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  amount       bigint NOT NULL CHECK (amount <> 0),
  occurred_at  timestamptz NOT NULL,
  CONSTRAINT spend_events_source_uq UNIQUE (source_ref)
);

CREATE INDEX spend_events_user_idx ON spend_events (user_id, occurred_at);

CREATE TABLE tier_status (
  user_id               uuid PRIMARY KEY REFERENCES users (id),
  tier                  text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold', 'black')),
  net_spend_12m         bigint NOT NULL CHECK (net_spend_12m >= 0),
  evaluated_at          timestamptz NOT NULL,
  pending_tier          text CHECK (pending_tier IS NULL OR pending_tier IN ('bronze', 'silver', 'gold', 'black')),
  pending_effective_at  timestamptz,
  CONSTRAINT tier_status_pending_pair CHECK ((pending_tier IS NULL) = (pending_effective_at IS NULL))
);

CREATE INDEX tier_status_eval_idx ON tier_status (evaluated_at);

CREATE TABLE challenges (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CHECK (code ~ '^[a-z0-9_-]{1,40}$'),
  rule          jsonb NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  reward_coins  bigint NOT NULL CHECK (reward_coins > 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenges_code_uq UNIQUE (code),
  CONSTRAINT challenges_window_ck CHECK (window_end > window_start)
);

CREATE TABLE game_odds_versions (
  id              uuid PRIMARY KEY,
  game            text NOT NULL CHECK (game IN ('daily_spin', 'scratch_card')),
  version         integer NOT NULL CHECK (version >= 1),
  odds            jsonb NOT NULL,
  published_at    timestamptz NOT NULL,
  effective_from  timestamptz NOT NULL,
  approval_id     text NOT NULL CHECK (char_length(approval_id) BETWEEN 1 AND 80),
  CONSTRAINT game_odds_version_uq UNIQUE (game, version),
  CONSTRAINT game_odds_effective_ck CHECK (effective_from >= published_at)
);

CREATE TABLE game_plays (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id),
  game              text NOT NULL CHECK (game IN ('daily_spin', 'scratch_card')),
  intent_id         text NOT NULL CHECK (char_length(intent_id) BETWEEN 8 AND 80),
  day_key           date NOT NULL,
  seq               smallint NOT NULL CHECK (seq BETWEEN 1 AND 3),
  odds_version_id   uuid NOT NULL REFERENCES game_odds_versions (id),
  roll_ppm          integer NOT NULL CHECK (roll_ppm BETWEEN 0 AND 999999),
  outcome_id        text NOT NULL,
  outcome_kind      text NOT NULL CHECK (outcome_kind IN ('nothing', 'coins', 'voucher')),
  coins             bigint CHECK (coins IS NULL OR coins > 0),
  voucher_template_id text,
  server_seed       text NOT NULL CHECK (server_seed ~ '^[0-9a-f]{64}$'),
  server_seed_hash  text NOT NULL CHECK (server_seed_hash ~ '^[0-9a-f]{64}$'),
  source_ref        text,
  reward_ref        text,
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_plays_intent_uq UNIQUE (user_id, game, intent_id),
  CONSTRAINT game_plays_day_seq_uq UNIQUE (user_id, game, day_key, seq),
  CONSTRAINT game_plays_source_uq UNIQUE (game, source_ref),
  CONSTRAINT game_plays_reward_shape CHECK (
    (outcome_kind = 'coins' AND coins IS NOT NULL AND voucher_template_id IS NULL)
    OR (outcome_kind = 'voucher' AND coins IS NULL AND voucher_template_id IS NOT NULL)
    OR (outcome_kind = 'nothing' AND coins IS NULL AND voucher_template_id IS NULL))
);

CREATE INDEX game_plays_user_idx ON game_plays (user_id, game, created_at DESC);

CREATE TABLE game_entitlements (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  source_ref  text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_entitlements_source_uq UNIQUE (source_ref)
);

CREATE INDEX game_entitlements_user_idx ON game_entitlements (user_id, created_at);

-- Row level security --------------------------------------------------------------------
ALTER TABLE reward_config_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON reward_config_versions TO app_user;
CREATE POLICY reward_config_system ON reward_config_versions FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE coin_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON coin_events TO app_user;
GRANT UPDATE (journal_entry_id) ON coin_events TO app_user;
CREATE POLICY coin_events_select ON coin_events FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY coin_events_system_insert ON coin_events FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY coin_events_system_settle ON coin_events FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE coin_debts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON coin_debts TO app_user;
CREATE POLICY coin_debts_select ON coin_debts FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY coin_debts_system_write ON coin_debts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY coin_debts_system_update ON coin_debts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE spend_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON spend_events TO app_user;
CREATE POLICY spend_events_select ON spend_events FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY spend_events_system_insert ON spend_events FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE tier_status ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON tier_status TO app_user;
CREATE POLICY tier_status_select ON tier_status FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY tier_status_system_insert ON tier_status FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY tier_status_system_update ON tier_status FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON challenges TO app_user;
CREATE POLICY challenges_public_select ON challenges FOR SELECT USING (active OR app_role() = 'system');
CREATE POLICY challenges_system_insert ON challenges FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY challenges_system_update ON challenges FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE game_odds_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON game_odds_versions TO app_user;
CREATE POLICY game_odds_public_select ON game_odds_versions FOR SELECT USING (true);
CREATE POLICY game_odds_system_insert ON game_odds_versions FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE game_plays ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON game_plays TO app_user;
CREATE POLICY game_plays_select ON game_plays FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY game_plays_system_insert ON game_plays FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY game_plays_system_settle ON game_plays FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE game_entitlements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON game_entitlements TO app_user;
CREATE POLICY game_entitlements_select ON game_entitlements FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY game_entitlements_system_insert ON game_entitlements FOR INSERT WITH CHECK (app_role() = 'system');
