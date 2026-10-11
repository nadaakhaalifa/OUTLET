-- migration: 0026_referrals
-- phase: expand
--
-- Referral codes and attributions (spec 15.4, docs/specs/referrals.md).
-- Expand only: two new tables. This module never writes the ledger; rewards leave as
-- outbox events (referral.reward_earned, referral.plus_month_earned) written in the same
-- transaction as the settlement and the inbox row.
--
--   * One code per owner, one referral per friend (first attribution wins).
--   * Device and payment fingerprint values are stored only as SHA-256 hex (64 chars).
--   * A self referral is recorded as status 'rejected' (silent to the caller, logged here).
--   * Row level security: owner/party reads, friend inserts own attribution, settlement is
--     system only (app.role = 'system').

CREATE TABLE referral_codes (
  id             uuid PRIMARY KEY,
  owner_user_id  uuid NOT NULL REFERENCES users (id),
  code           char(8) NOT NULL CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,
  CONSTRAINT referral_codes_owner_uq UNIQUE (owner_user_id),
  CONSTRAINT referral_codes_code_uq UNIQUE (code)
);

CREATE TABLE referrals (
  id                        uuid PRIMARY KEY,
  code_id                   uuid NOT NULL REFERENCES referral_codes (id),
  referrer_id               uuid NOT NULL REFERENCES users (id),
  referee_id                uuid NOT NULL REFERENCES users (id),
  status                    text NOT NULL CHECK (status IN ('attributed', 'rewarded', 'rejected')),
  reject_reason             text CHECK (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 40),
  referee_device_hashes     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(referee_device_hashes) = 'array'),
  order_id                  uuid,
  payment_fingerprint_hash  char(64) CHECK (payment_fingerprint_hash IS NULL OR payment_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  reward_amount             bigint CHECK (reward_amount IS NULL OR reward_amount > 0),
  reward_currency           char(3) CHECK (reward_currency IS NULL OR reward_currency = 'EGP'),
  attributed_at             timestamptz NOT NULL DEFAULT now(),
  settled_at                timestamptz,
  CONSTRAINT referrals_referee_uq UNIQUE (referee_id),
  CONSTRAINT referrals_self_only_rejected CHECK (referrer_id <> referee_id OR status = 'rejected'),
  CONSTRAINT referrals_reason_iff_rejected CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CONSTRAINT referrals_reward_iff_rewarded CHECK ((status = 'rewarded') = (reward_amount IS NOT NULL)),
  CONSTRAINT referrals_reward_pair CHECK ((reward_amount IS NULL) = (reward_currency IS NULL)),
  CONSTRAINT referrals_settled_iff_final CHECK ((status = 'attributed') = (settled_at IS NULL))
);

CREATE INDEX referrals_referrer_idx ON referrals (referrer_id, attributed_at DESC);
CREATE INDEX referrals_rewarded_idx ON referrals (referrer_id, settled_at) WHERE status = 'rewarded';

-- Row level security --------------------------------------------------------------------
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON referral_codes TO app_user;
-- A friend must be able to resolve a code to its owner at attribution time, but never list codes:
-- resolution runs as 'system'. Owners read and create only their own.
CREATE POLICY referral_codes_owner_select ON referral_codes FOR SELECT
  USING (owner_user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY referral_codes_owner_insert ON referral_codes FOR INSERT
  WITH CHECK (owner_user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON referrals TO app_user;
CREATE POLICY referrals_party_select ON referrals FOR SELECT
  USING (referrer_id = app_user_id() OR referee_id = app_user_id() OR app_role() = 'system');
CREATE POLICY referrals_referee_insert ON referrals FOR INSERT
  WITH CHECK (referee_id = app_user_id() OR app_role() = 'system');
CREATE POLICY referrals_system_update ON referrals FOR UPDATE
  USING (app_role() = 'system')
  WITH CHECK (app_role() = 'system');
