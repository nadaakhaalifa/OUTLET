-- migration: 0037_gift_cards
-- phase: expand
--
-- Closed-loop gift cards and group gifts (spec 15.1, docs/specs/phase2/02-gift-cards.md,
-- ADR-0003, ADR-0014, ADR-0021). Expand only: five new tables, nothing existing changes.
--
--   * The code is never stored. code_hash is HMAC-SHA256 (hex) of the canonical code under a
--     versioned key (code_key_version) so rotation is possible; last4 is the only display aid.
--     The columns are NULL until payment succeeds, and the CHECK ties them to the status.
--   * Money is BIGINT piastres, currency EGP. remaining <= amount always; the sum of
--     non-reversed redemptions plus remaining equals amount (conservation) and the module
--     maintains it inside one row-locked transaction.
--   * recipient_contact and message are application-level envelope ciphertext (P2/P3).
--   * gift_card_attempts keeps no code and no code hash: account, device and IP hashes only.
--     Retention 90 days (docs/privacy/retention-schedule.md); a purge job removes older rows.
--   * Pot share tokens are 128-bit, stored only as SHA-256 (share_token_hash).
--   * Row level security: owners read their own rows; every write runs as app.role = 'system'.

CREATE TABLE gift_pots (
  id                  uuid PRIMARY KEY,
  organiser_id        uuid NOT NULL REFERENCES users (id),
  organiser_nickname  text NOT NULL CHECK (char_length(organiser_nickname) BETWEEN 1 AND 40),
  target              bigint NOT NULL CHECK (target BETWEEN 10000 AND 1000000 AND target % 100 = 0),
  currency            text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  closes_at           timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'CLOSED_FUNDED', 'CLOSED_UNFUNDED', 'REFUNDING', 'REFUNDED')),
  -- the POT_OPEN card this pot issues on close; no FK because gift_cards is created after gift_pots
  card_id             uuid,
  share_token_hash    text NOT NULL UNIQUE CHECK (char_length(share_token_hash) = 64),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  CONSTRAINT gift_pots_closed_ck CHECK ((status = 'OPEN') = (closed_at IS NULL))
);

CREATE INDEX gift_pots_organiser_idx ON gift_pots (organiser_id, created_at DESC);
CREATE INDEX gift_pots_due_idx ON gift_pots (closes_at) WHERE status = 'OPEN';

CREATE TABLE gift_cards (
  id                  uuid PRIMARY KEY,
  purchaser_id        uuid NOT NULL REFERENCES users (id),
  code_hash           text UNIQUE CHECK (code_hash IS NULL OR char_length(code_hash) = 64),
  code_key_version    integer CHECK (code_key_version IS NULL OR code_key_version >= 1),
  last4               text CHECK (last4 IS NULL OR last4 ~ '^[0-9A-Z]{4}$'),
  amount              bigint NOT NULL CHECK (amount BETWEEN 10000 AND 1000000),
  remaining           bigint NOT NULL CHECK (remaining >= 0),
  currency            text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  scope_store_id      uuid,
  status              text NOT NULL
                        CHECK (status IN ('PENDING_PAYMENT', 'POT_OPEN', 'ISSUED', 'DELIVERED', 'REDEEMED', 'EXPIRED', 'VOIDED', 'CANCELLED')),
  design              text NOT NULL CHECK (design IN ('birthday', 'eid', 'ramadan', 'wedding', 'new_baby', 'graduation', 'thank_you')),
  recipient_channel   text NOT NULL CHECK (recipient_channel IN ('whatsapp', 'sms', 'email', 'in_app')),
  recipient_contact   bytea,
  message             bytea,
  scheduled_at        timestamptz,
  pot_id              uuid REFERENCES gift_pots (id),
  payment_intent_id   text,
  idempotency_key     text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  expires_at          timestamptz,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  issued_at           timestamptz,
  delivered_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gift_cards_remaining_le_amount CHECK (remaining <= amount),
  CONSTRAINT gift_cards_code_status_ck CHECK (
    (code_hash IS NOT NULL) = (status IN ('ISSUED', 'DELIVERED', 'REDEEMED', 'EXPIRED', 'VOIDED'))
  ),
  CONSTRAINT gift_cards_code_fields_ck CHECK (
    (code_hash IS NULL) = (code_key_version IS NULL) AND (code_hash IS NULL) = (last4 IS NULL)
  ),
  CONSTRAINT gift_cards_redeemed_ck CHECK (status <> 'REDEEMED' OR remaining = 0),
  CONSTRAINT gift_cards_open_balance_ck CHECK (status NOT IN ('ISSUED', 'DELIVERED') OR remaining > 0),
  CONSTRAINT gift_cards_expiry_ck CHECK (code_hash IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT gift_cards_idem_uq UNIQUE (purchaser_id, idempotency_key)
);

CREATE INDEX gift_cards_purchaser_idx ON gift_cards (purchaser_id, created_at DESC, id DESC);
CREATE INDEX gift_cards_expiry_idx ON gift_cards (expires_at) WHERE status IN ('ISSUED', 'DELIVERED');

CREATE TABLE gift_card_redemptions (
  id               uuid PRIMARY KEY,
  card_id          uuid NOT NULL REFERENCES gift_cards (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  amount           bigint NOT NULL CHECK (amount > 0),
  status           text NOT NULL CHECK (status IN ('pending', 'completed', 'reversed')),
  status_before    text NOT NULL CHECK (status_before IN ('ISSUED', 'DELIVERED')),
  journal_entry_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT gift_card_redemptions_completed_ck CHECK ((status = 'completed') = (journal_entry_id IS NOT NULL))
);

CREATE INDEX gift_card_redemptions_pending_idx ON gift_card_redemptions (created_at) WHERE status = 'pending';
CREATE INDEX gift_card_redemptions_card_idx ON gift_card_redemptions (card_id, created_at);
CREATE INDEX gift_card_redemptions_user_idx ON gift_card_redemptions (user_id, created_at DESC);

CREATE TABLE gift_card_attempts (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_hash text NOT NULL CHECK (char_length(device_hash) = 64),
  ip_hash     text NOT NULL CHECK (char_length(ip_hash) = 64),
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'wrong', 'throttled', 'pending')),
  at          timestamptz NOT NULL
);

-- 'pending' = admitted but not yet finalized; it counts as a failure so the check-and-record is one step
CREATE INDEX gift_card_attempts_account_idx ON gift_card_attempts (account_id, at DESC) WHERE outcome IN ('wrong', 'pending');
CREATE INDEX gift_card_attempts_device_idx ON gift_card_attempts (device_hash, at DESC) WHERE outcome IN ('wrong', 'pending');
CREATE INDEX gift_card_attempts_ip_idx ON gift_card_attempts (ip_hash, at DESC) WHERE outcome IN ('wrong', 'pending');
CREATE INDEX gift_card_attempts_retention_idx ON gift_card_attempts (at);

CREATE TABLE gift_pot_contributions (
  id                uuid PRIMARY KEY,
  pot_id            uuid NOT NULL REFERENCES gift_pots (id),
  user_id           uuid NOT NULL REFERENCES users (id),
  amount            bigint NOT NULL CHECK (amount >= 100 AND amount % 100 = 0),
  payment_intent_id text,
  status            text NOT NULL CHECK (status IN ('pending', 'pending_void', 'paid', 'cancelled', 'refunded', 'refund_failed')),
  idempotency_key   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 120),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gift_pot_contributions_idem_uq UNIQUE (user_id, idempotency_key)
);

CREATE INDEX gift_pot_contributions_pot_idx ON gift_pot_contributions (pot_id, created_at);
CREATE INDEX gift_pot_contributions_intent_idx ON gift_pot_contributions (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- Row level security --------------------------------------------------------------------
ALTER TABLE gift_pots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON gift_pots TO app_user;
CREATE POLICY gift_pots_select ON gift_pots FOR SELECT
  USING (organiser_id = app_user_id() OR app_role() = 'system');
CREATE POLICY gift_pots_insert ON gift_pots FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY gift_pots_update ON gift_pots FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON gift_cards TO app_user;
CREATE POLICY gift_cards_select ON gift_cards FOR SELECT
  USING (purchaser_id = app_user_id() OR app_role() = 'system');
CREATE POLICY gift_cards_insert ON gift_cards FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY gift_cards_update ON gift_cards FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE gift_card_redemptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON gift_card_redemptions TO app_user;
CREATE POLICY gift_card_redemptions_select ON gift_card_redemptions FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY gift_card_redemptions_insert ON gift_card_redemptions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY gift_card_redemptions_update ON gift_card_redemptions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE gift_card_attempts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON gift_card_attempts TO app_user;
CREATE POLICY gift_card_attempts_select ON gift_card_attempts FOR SELECT USING (app_role() = 'system');
CREATE POLICY gift_card_attempts_insert ON gift_card_attempts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY gift_card_attempts_delete ON gift_card_attempts FOR DELETE USING (app_role() = 'system');

ALTER TABLE gift_pot_contributions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON gift_pot_contributions TO app_user;
CREATE POLICY gift_pot_contributions_select ON gift_pot_contributions FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY gift_pot_contributions_insert ON gift_pot_contributions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY gift_pot_contributions_update ON gift_pot_contributions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
