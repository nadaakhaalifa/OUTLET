-- migration: 0056_price_drop_auto_buy
-- phase: expand
--
-- Price-drop auto-buy (docs/specs/phase-3/price-drop-auto-buy.md, master prompt 28 row 1, ADR-0036).
-- Expand only: three new tables, nothing existing changes.
--
--   * auto_buy_mandate_texts: the exact mandate wording per (version, locale). Immutable: a trigger
--     refuses UPDATE and DELETE, so a mandate can always be shown the text the shopper accepted.
--   * auto_buy_mandates: one explicit, per-item opt-in. The commercial terms (sku, size, target,
--     max, expiry, mode, token reference, accepted text) are immutable once accepted; only the
--     lifecycle columns (status, closed_reason) may change. A change of terms is a NEW mandate.
--     psp_token_ref is a reference into the PSP vault, never a card number (spec B8, SAQ A).
--   * auto_buy_attempts: one row per (mandate, price event). The UNIQUE key is the idempotency
--     guarantee: the same price event delivered twice yields exactly one attempt and so at most
--     one order (idempotency key auto_buy:{mandate}:{price_event}).
--   * sku_id, order_group_id are LOGICAL references (catalog and orders own those tables).
--   * updated_at is written by the module (application clock), not by a trigger: the sweeps compare
--     it with the same clock they run on.
--   * RLS: the owner reads; every write is the module under app.role = 'system'.
--   * Erasure: every table cascades from users (account deletion cancels and removes all rules).

CREATE TABLE auto_buy_mandate_texts (
  version     integer NOT NULL CHECK (version >= 1),
  locale      text NOT NULL CHECK (locale IN ('ar', 'en')),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 4000),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, locale)
);

CREATE FUNCTION auto_buy_mandate_texts_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auto_buy_mandate_texts rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER auto_buy_mandate_texts_guard_trg
  BEFORE UPDATE OR DELETE ON auto_buy_mandate_texts
  FOR EACH ROW EXECUTE FUNCTION auto_buy_mandate_texts_guard();

CREATE TABLE auto_buy_mandates (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sku_id             uuid NOT NULL,
  size_label         text NOT NULL CHECK (char_length(size_label) BETWEEN 1 AND 32),
  target_price       bigint NOT NULL CHECK (target_price > 0),
  max_price          bigint NOT NULL,
  currency           text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  mode               text NOT NULL CHECK (mode IN ('notify_confirm', 'unattended')),
  psp_token_ref      text CHECK (psp_token_ref IS NULL OR char_length(psp_token_ref) BETWEEN 8 AND 200),
  status             text NOT NULL DEFAULT 'ARMED' CHECK (status IN ('ARMED', 'PURCHASED', 'DISARMED', 'EXPIRED')),
  closed_reason      text CHECK (closed_reason IS NULL OR char_length(closed_reason) <= 64),
  expires_at         timestamptz NOT NULL,
  mandate_version    integer NOT NULL,
  mandate_locale     text NOT NULL,
  terms_sha256       text NOT NULL CHECK (terms_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at        timestamptz NOT NULL,
  accepted_device_id text NOT NULL CHECK (char_length(accepted_device_id) BETWEEN 1 AND 128),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_buy_mandates_max_ge_target CHECK (max_price >= target_price),
  CONSTRAINT auto_buy_mandates_expiry_after_accept CHECK (expires_at > accepted_at),
  -- Unattended mode needs a vault reference; notify-and-confirm never carries one.
  CONSTRAINT auto_buy_mandates_mode_token CHECK ((mode = 'unattended') = (psp_token_ref IS NOT NULL)),
  CONSTRAINT auto_buy_mandates_closed_reason CHECK (status = 'ARMED' OR closed_reason IS NOT NULL),
  CONSTRAINT auto_buy_mandates_text_fk FOREIGN KEY (mandate_version, mandate_locale)
    REFERENCES auto_buy_mandate_texts (version, locale)
);

-- One active rule per (user, sku): a second rule for the same item is rejected, not stacked.
CREATE UNIQUE INDEX auto_buy_mandates_one_active_idx ON auto_buy_mandates (user_id, sku_id) WHERE status = 'ARMED';
-- The evaluator's lookup: armed rules for a sku whose target the new price has reached.
CREATE INDEX auto_buy_mandates_sku_target_idx ON auto_buy_mandates (sku_id, target_price) WHERE status = 'ARMED';
CREATE INDEX auto_buy_mandates_expiry_idx ON auto_buy_mandates (expires_at) WHERE status = 'ARMED';
CREATE INDEX auto_buy_mandates_user_idx ON auto_buy_mandates (user_id, created_at DESC);

CREATE FUNCTION auto_buy_mandates_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
     OR NEW.size_label IS DISTINCT FROM OLD.size_label
     OR NEW.target_price IS DISTINCT FROM OLD.target_price
     OR NEW.max_price IS DISTINCT FROM OLD.max_price
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.psp_token_ref IS DISTINCT FROM OLD.psp_token_ref
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.mandate_version IS DISTINCT FROM OLD.mandate_version
     OR NEW.mandate_locale IS DISTINCT FROM OLD.mandate_locale
     OR NEW.terms_sha256 IS DISTINCT FROM OLD.terms_sha256
     OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR NEW.accepted_device_id IS DISTINCT FROM OLD.accepted_device_id THEN
    RAISE EXCEPTION 'an accepted auto-buy mandate is immutable; create a new mandate' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'ARMED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed auto-buy mandate cannot be reopened' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_buy_mandates_guard_trg
  BEFORE UPDATE ON auto_buy_mandates
  FOR EACH ROW EXECUTE FUNCTION auto_buy_mandates_guard();

CREATE TABLE auto_buy_attempts (
  id              uuid PRIMARY KEY,
  mandate_id      uuid NOT NULL REFERENCES auto_buy_mandates (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  price_event_id  text NOT NULL CHECK (char_length(price_event_id) BETWEEN 1 AND 128),
  mode            text NOT NULL CHECK (mode IN ('notify_confirm', 'unattended')),
  state           text NOT NULL CHECK (state IN (
                    'TRIGGERED', 'SKIPPED', 'NOTIFIED', 'CHARGING', 'REQUIRES_USER_ACTION',
                    'PURCHASED', 'CANCELLED_BY_USER', 'FAILED', 'DISARMED')),
  trigger_price   bigint NOT NULL CHECK (trigger_price > 0),
  charge_price    bigint CHECK (charge_price IS NULL OR charge_price > 0),
  notice_sent_at  timestamptz,
  cancel_deadline timestamptz,
  charge_started_at timestamptz,
  reservation_ref text CHECK (reservation_ref IS NULL OR char_length(reservation_ref) <= 128),
  order_group_id  uuid,
  failure_reason  text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_buy_attempts_event_unique UNIQUE (mandate_id, price_event_id),
  CONSTRAINT auto_buy_attempts_notified CHECK (
    state NOT IN ('NOTIFIED', 'CHARGING', 'REQUIRES_USER_ACTION', 'PURCHASED')
    OR (notice_sent_at IS NOT NULL AND cancel_deadline IS NOT NULL)),
  CONSTRAINT auto_buy_attempts_window CHECK (cancel_deadline IS NULL OR cancel_deadline >= notice_sent_at + interval '15 minutes'),
  CONSTRAINT auto_buy_attempts_purchased CHECK (state <> 'PURCHASED' OR mode = 'notify_confirm' OR order_group_id IS NOT NULL),
  CONSTRAINT auto_buy_attempts_failed CHECK (state NOT IN ('FAILED', 'SKIPPED') OR failure_reason IS NOT NULL)
);

CREATE INDEX auto_buy_attempts_mandate_idx ON auto_buy_attempts (mandate_id, created_at DESC);
CREATE INDEX auto_buy_attempts_user_idx ON auto_buy_attempts (user_id, created_at DESC);
-- The worker's due scan: notices whose cancel window has elapsed.
CREATE INDEX auto_buy_attempts_due_idx ON auto_buy_attempts (cancel_deadline) WHERE state = 'NOTIFIED' AND mode = 'unattended';
CREATE INDEX auto_buy_attempts_open_idx ON auto_buy_attempts (updated_at) WHERE state IN ('CHARGING', 'REQUIRES_USER_ACTION');

-- Row level security: the owner reads; only the module (system role) writes. ----------------------
ALTER TABLE auto_buy_mandate_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_buy_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE auto_buy_attempts ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON auto_buy_mandate_texts TO app_user;
GRANT SELECT, INSERT, UPDATE ON auto_buy_mandates, auto_buy_attempts TO app_user;

CREATE POLICY auto_buy_mandate_texts_select ON auto_buy_mandate_texts FOR SELECT USING (true);
CREATE POLICY auto_buy_mandate_texts_insert ON auto_buy_mandate_texts FOR INSERT WITH CHECK (app_role() = 'system');

CREATE POLICY auto_buy_mandates_select ON auto_buy_mandates FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY auto_buy_mandates_insert ON auto_buy_mandates FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY auto_buy_mandates_update ON auto_buy_mandates FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY auto_buy_attempts_select ON auto_buy_attempts FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY auto_buy_attempts_insert ON auto_buy_attempts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY auto_buy_attempts_update ON auto_buy_attempts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
