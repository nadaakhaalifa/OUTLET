-- migration: 0032_payments
-- phase: expand
--
-- PSP payment records (spec 7, B8, 15.6; docs/specs/payments.md; ADR-0021).
-- payment_intents: one PSP intent per OrderGroup, an explicit state machine mirrored in a trigger.
-- payment_events_raw: every webhook body that reached us, deduplicated, immutable.
-- payment_refunds: one row per refund request, idempotent per (intent, key).
-- payment_methods: saved cards as PSP tokens plus display data only.
--
-- Deliberate scope:
--   * SAQ A: there is no PAN, CVV, holder name or full expiry-with-number column anywhere. A
--     migration test scans the column names; a body scan redacts Luhn-valid numbers before storage.
--   * No ledger rows here. The checkout saga posts to psp_clearing on payment.succeeded.
--   * order_group_id has no FK: checkout mints it before orders intake creates the order_groups row.
--   * Dedup of webhooks is UNIQUE (provider, event_id). Rows that failed signature verification get
--     the synthetic id 'unverified:<sha256(body)>' (enforced by CHECK), so a forged event id can
--     never occupy the id of a genuine event, and identical garbage deduplicates too.
--   * RLS: owners read their own intents, refunds and saved cards. Every write and every raw event
--     is the 'system' role.

CREATE TABLE payment_intents (
  id               uuid PRIMARY KEY,
  order_group_id   uuid NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users (id),
  provider         text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_ref     text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 128),
  method           text NOT NULL CHECK (method IN ('card','meeza','apple_pay','mobile_wallet','instapay','fawry')),
  amount           bigint NOT NULL CHECK (amount > 0),
  currency         char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  status           text NOT NULL DEFAULT 'CREATED' CHECK (status IN
                     ('CREATED','REQUIRES_ACTION','AUTHORIZED','SUCCEEDED','FAILED','VOIDED',
                      'PARTIALLY_REFUNDED','REFUNDED')),
  refunded_amount  bigint NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  client_action    jsonb CHECK (client_action IS NULL OR octet_length(client_action::text) <= 4096),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  failure_code     text CHECK (failure_code IS NULL OR length(failure_code) <= 64),
  expires_at       timestamptz NOT NULL,
  version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_refund_chk CHECK (refunded_amount <= amount),
  CONSTRAINT payment_intents_refund_status_chk CHECK (
    (status = 'REFUNDED' AND refunded_amount = amount)
    OR (status = 'PARTIALLY_REFUNDED' AND refunded_amount > 0 AND refunded_amount < amount)
    OR (status NOT IN ('REFUNDED','PARTIALLY_REFUNDED') AND refunded_amount = 0)
  )
);
CREATE UNIQUE INDEX payment_intents_provider_ref_uq ON payment_intents (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE INDEX payment_intents_user_idx ON payment_intents (user_id, created_at DESC);
CREATE INDEX payment_intents_expirable_idx ON payment_intents (expires_at)
  WHERE status IN ('CREATED','REQUIRES_ACTION');

CREATE TRIGGER payment_intents_touch_updated_at_trg
  BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The state machine in the database: identity columns never change, terminal states never move,
-- only the declared transitions are possible, and the version only goes up by one.
CREATE FUNCTION payment_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.order_group_id, NEW.user_id, NEW.method, NEW.amount, NEW.currency, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.order_group_id, OLD.user_id, OLD.method, OLD.amount, OLD.currency, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'payment intent identity and amount are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'payment intent provider reference is immutable once set' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status IN ('FAILED','VOIDED','REFUNDED') THEN
      RAISE EXCEPTION 'payment intent is in a terminal state' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (
      (OLD.status = 'CREATED' AND NEW.status IN ('REQUIRES_ACTION','AUTHORIZED','SUCCEEDED','FAILED','VOIDED'))
      OR (OLD.status = 'REQUIRES_ACTION' AND NEW.status IN ('AUTHORIZED','SUCCEEDED','FAILED','VOIDED'))
      OR (OLD.status = 'AUTHORIZED' AND NEW.status IN ('SUCCEEDED','FAILED','VOIDED'))
      OR (OLD.status = 'SUCCEEDED' AND NEW.status IN ('PARTIALLY_REFUNDED','REFUNDED'))
      OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED')
    ) THEN
      RAISE EXCEPTION 'illegal payment intent transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.refunded_amount < OLD.refunded_amount THEN
    RAISE EXCEPTION 'refunded amount never decreases' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_intents_guard_trg
  BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION payment_intents_guard();

CREATE TABLE payment_events_raw (
  id               uuid PRIMARY KEY,
  provider         text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  event_id         text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 160),
  signature_ok     boolean NOT NULL,
  reject_reason    text CHECK (reject_reason IS NULL OR length(reject_reason) <= 64),
  body             jsonb NOT NULL CHECK (octet_length(body::text) <= 262144),
  body_sha256      char(64) NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  process_outcome  text CHECK (process_outcome IS NULL OR length(process_outcome) <= 120),
  UNIQUE (provider, event_id),
  CONSTRAINT payment_events_raw_unverified_id_chk CHECK (
    (signature_ok AND event_id NOT LIKE 'unverified:%')
    OR (NOT signature_ok AND event_id = 'unverified:' || body_sha256)
  ),
  CONSTRAINT payment_events_raw_reject_chk CHECK ((signature_ok AND reject_reason IS NULL) OR (NOT signature_ok AND reject_reason IS NOT NULL))
);
CREATE INDEX payment_events_raw_unprocessed_idx ON payment_events_raw (received_at)
  WHERE processed_at IS NULL AND signature_ok;

-- Webhook bodies are financial records (retention 7y, spec B1): immutable except processing marks.
CREATE FUNCTION payment_events_raw_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment events are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.provider, NEW.event_id, NEW.signature_ok, NEW.reject_reason, NEW.body, NEW.body_sha256, NEW.received_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider, OLD.event_id, OLD.signature_ok, OLD.reject_reason, OLD.body, OLD.body_sha256, OLD.received_at) THEN
    RAISE EXCEPTION 'payment event content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
    RAISE EXCEPTION 'payment event is already processed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_events_raw_guard_trg
  BEFORE UPDATE OR DELETE ON payment_events_raw
  FOR EACH ROW EXECUTE FUNCTION payment_events_raw_guard();

CREATE TABLE payment_refunds (
  id                   uuid PRIMARY KEY,
  intent_id            uuid NOT NULL REFERENCES payment_intents (id),
  idempotency_key      text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  amount               bigint NOT NULL CHECK (amount > 0),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider_refund_ref  text CHECK (provider_refund_ref IS NULL OR length(provider_refund_ref) BETWEEN 1 AND 128),
  failure_code         text CHECK (failure_code IS NULL OR length(failure_code) <= 64),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, idempotency_key)
);
CREATE UNIQUE INDEX payment_refunds_provider_ref_uq ON payment_refunds (provider_refund_ref)
  WHERE provider_refund_ref IS NOT NULL;
CREATE INDEX payment_refunds_intent_idx ON payment_refunds (intent_id);

CREATE TRIGGER payment_refunds_touch_updated_at_trg
  BEFORE UPDATE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION payment_refunds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.intent_id, NEW.idempotency_key, NEW.amount, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.intent_id, OLD.idempotency_key, OLD.amount, OLD.created_at) THEN
    RAISE EXCEPTION 'payment refund identity and amount are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'payment refund is already settled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_refunds_guard_trg
  BEFORE UPDATE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION payment_refunds_guard();

CREATE TABLE payment_methods (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  provider     text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  psp_token    text NOT NULL CHECK (length(psp_token) BETWEEN 8 AND 256),
  brand        text NOT NULL CHECK (brand IN ('visa','mastercard','meeza','amex','other')),
  last4        char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month    smallint NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year     smallint NOT NULL CHECK (exp_year BETWEEN 2000 AND 2200),
  fingerprint  text NOT NULL CHECK (length(fingerprint) BETWEEN 8 AND 128),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (provider, psp_token)
);
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id) WHERE deleted_at IS NULL;

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payment_intents TO app_user;
CREATE POLICY payment_intents_select ON payment_intents FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('system', 'ops', 'support', 'finance', 'super_admin'));
CREATE POLICY payment_intents_insert ON payment_intents FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY payment_intents_update ON payment_intents FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE payment_events_raw ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payment_events_raw TO app_user;
CREATE POLICY payment_events_raw_system ON payment_events_raw FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payment_refunds TO app_user;
CREATE POLICY payment_refunds_select ON payment_refunds FOR SELECT
  USING (
    app_role() IN ('system', 'ops', 'support', 'finance', 'super_admin')
    OR EXISTS (SELECT 1 FROM payment_intents i WHERE i.id = payment_refunds.intent_id AND i.user_id = app_user_id())
  );
CREATE POLICY payment_refunds_insert ON payment_refunds FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY payment_refunds_update ON payment_refunds FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON payment_methods TO app_user;
CREATE POLICY payment_methods_select ON payment_methods FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('system', 'support', 'super_admin'));
CREATE POLICY payment_methods_insert ON payment_methods FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY payment_methods_update ON payment_methods FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
