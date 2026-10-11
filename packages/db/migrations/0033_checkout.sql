-- migration: 0033_checkout
-- phase: expand
--
-- Checkout saga persistence (spec 7; docs/specs/checkout.md; ADR-0021 decision 6).
-- checkout_sagas: one row per OrderGroup, the saga as an explicit persisted state machine.
-- checkout_payment_events: every verified (or rejected) provider event, deduplicated.
--
-- Deliberate scope:
--   * `facts` is the pure SagaFacts of packages/domain/src/checkout (status, flags, ids); `quote` is
--     the priced quote the saga executes (bigint values are tagged strings, never JSON numbers).
--     `client_action` is the last action handed to the app (redirect, sdk, fawry reference).
--     Money columns are denormalised BIGINT
--     piastres for reconciliation queries, EGP only.
--   * order_group_id is minted by checkout and is the PSP idempotency key. The order_groups row is
--     created later by orders intake (PlaceOrders), so there is no FK to it.
--   * RLS: owner reads their own saga; every write is the system role (the saga runs as system).
--   * No card data, address or phone is stored (PSP tokens and ids only).

CREATE TABLE checkout_sagas (
  order_group_id   uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash     text NOT NULL CHECK (length(request_hash) BETWEEN 1 AND 128),
  cart_hash        text NOT NULL CHECK (length(cart_hash) BETWEEN 1 AND 128),
  status           text NOT NULL CHECK (status IN
                     ('VALIDATE_CART','RESERVE_INVENTORY','HOLD_CREDIT','CREATE_INTENT','AWAIT_PAYMENT',
                      'CLAIM_AND_POST','PLACED','COMPENSATING','FAILED','EXPIRED','CANCELLED','REFUNDED')),
  method           text NOT NULL CHECK (method IN
                     ('card','apple_pay','meeza','mobile_wallet','instapay','fawry','bnpl','cod')),
  provider         text CHECK (provider IS NULL OR length(provider) <= 64),
  currency         char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  total_amount     bigint NOT NULL CHECK (total_amount >= 0),
  credit_amount    bigint NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  external_amount  bigint NOT NULL DEFAULT 0 CHECK (external_amount >= 0),
  facts            jsonb NOT NULL,
  quote            jsonb NOT NULL,
  client_action    jsonb,
  version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_wake_at     timestamptz,
  last_error       text CHECK (last_error IS NULL OR length(last_error) <= 500),
  stuck_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_sagas_amounts_chk CHECK (credit_amount + external_amount = total_amount),
  UNIQUE (user_id, idempotency_key)
);

-- One live OrderGroup per (user, priced bag and method): duplicate taps with different keys collapse.
CREATE UNIQUE INDEX checkout_sagas_live_cart_uq ON checkout_sagas (user_id, cart_hash)
  WHERE status NOT IN ('PLACED','FAILED','EXPIRED','CANCELLED','REFUNDED');
CREATE INDEX checkout_sagas_wake_idx ON checkout_sagas (next_wake_at)
  WHERE status NOT IN ('PLACED','FAILED','EXPIRED','CANCELLED','REFUNDED') AND stuck_at IS NULL;
CREATE INDEX checkout_sagas_user_idx ON checkout_sagas (user_id, created_at DESC);

CREATE TRIGGER checkout_sagas_touch_updated_at_trg
  BEFORE UPDATE ON checkout_sagas FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE checkout_payment_events (
  id              uuid PRIMARY KEY,
  provider        text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  event_id        text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  order_group_id  uuid,
  intent_id       text CHECK (intent_id IS NULL OR length(intent_id) <= 128),
  kind            text NOT NULL CHECK (kind IN ('succeeded','failed','rejected')),
  amount          bigint CHECK (amount IS NULL OR amount >= 0),
  signature_ok    boolean NOT NULL,
  reject_reason   text CHECK (reject_reason IS NULL OR length(reject_reason) <= 64),
  body            text NOT NULL CHECK (length(body) <= 65536),
  received_at     timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX checkout_payment_events_group_idx ON checkout_payment_events (order_group_id);

-- Webhook bodies are financial records (retention 7y, spec B1): immutable except applied_at.
CREATE FUNCTION checkout_payment_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment events are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.provider, NEW.event_id, NEW.order_group_id, NEW.intent_id, NEW.kind, NEW.amount,
      NEW.signature_ok, NEW.body, NEW.received_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider, OLD.event_id, OLD.order_group_id, OLD.intent_id, OLD.kind, OLD.amount,
      OLD.signature_ok, OLD.body, OLD.received_at) THEN
    RAISE EXCEPTION 'payment event content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER checkout_payment_events_guard_trg
  BEFORE UPDATE OR DELETE ON checkout_payment_events
  FOR EACH ROW EXECUTE FUNCTION checkout_payment_events_guard();

ALTER TABLE checkout_sagas ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON checkout_sagas TO app_user;
CREATE POLICY checkout_sagas_select ON checkout_sagas FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('system', 'ops', 'support', 'super_admin'));
CREATE POLICY checkout_sagas_insert ON checkout_sagas FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY checkout_sagas_update ON checkout_sagas FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE checkout_payment_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON checkout_payment_events TO app_user;
CREATE POLICY checkout_payment_events_system ON checkout_payment_events FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
