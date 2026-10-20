-- migration: 0034_refunds_store_credit
-- phase: expand
--
-- Refunds (spec 15.6, ADR-0021 decision 3 and 5) and the store-credit wallet projection (spec 15.2,
-- ADR-0003). Expand only: new tables. The LEDGER stays the system of record (0003); these tables
-- hold the refund state machine, its legs and attempts, and the credit lots, holds and history
-- whose sums are reconciled nightly against the store_credit:{user}:{sub} accounts.
--
--   * refunds         one per RefundIntent (unique idempotency_key = "refund-intent:{returnId}"),
--                     with the journal entry that is posted BEFORE any provider call.
--   * refund_legs     one per tender route; state is the shared Refund machine.
--                     A BNPL tender can only have channel bnpl_cancel, and bnpl_cancel can only
--                     belong to a BNPL tender (CHECK): BNPL cash conversion is structurally
--                     impossible (spec B3, docs/data-model/payments.md).
--   * refund_attempts one row per provider attempt (provider idempotency key = leg id).
--   * credit_lots / credit_holds / credit_hold_lines / credit_transactions: closed-loop credit.
--     There is no top-up, withdrawal or transfer table or column by design.
--
-- user_id is a real FK. store_id, seller_order_id, return_id are LOGICAL references (other
-- modules own those tables). Money is BIGINT piastres. Depends on 0001-0011.
-- RLS: owner read, writes by the module adapter under app.role = 'system', staff read.

CREATE TABLE refunds (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id),
  store_id              uuid NOT NULL,
  seller_order_id       uuid NOT NULL,
  return_id             uuid,
  source                text NOT NULL CHECK (source IN ('return', 'cancellation', 'admin')),
  idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  status                text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
                          ('REQUESTED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED')),
  currency              char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  amount                bigint NOT NULL CHECK (amount > 0),
  item_total            bigint NOT NULL CHECK (item_total >= 0),
  voucher_total         bigint NOT NULL CHECK (voucher_total >= 0),
  delivery_fee_total    bigint NOT NULL CHECK (delivery_fee_total >= 0),
  allocation_lines      jsonb NOT NULL CHECK (jsonb_typeof(allocation_lines) = 'array'),
  ledger_entry          jsonb NOT NULL,
  ledger_posted_at      timestamptz,
  return_received_at    timestamptz,
  requested_at          timestamptz NOT NULL,
  initiated_at          timestamptz,
  completed_at          timestamptz,
  version               integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT refunds_net_chk CHECK (amount = item_total - voucher_total + delivery_fee_total),
  CONSTRAINT refunds_completed_chk CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE INDEX refunds_user_idx ON refunds (user_id, created_at DESC, id);
CREATE INDEX refunds_status_idx ON refunds (status, requested_at);
CREATE INDEX refunds_return_idx ON refunds (return_id) WHERE return_id IS NOT NULL;

CREATE TRIGGER refunds_touch_updated_at_trg
  BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE refund_legs (
  id                     uuid PRIMARY KEY,
  refund_id              uuid NOT NULL REFERENCES refunds (id) ON DELETE CASCADE,
  position               integer NOT NULL CHECK (position >= 0),
  tender_id              text NOT NULL CHECK (char_length(tender_id) BETWEEN 1 AND 64),
  method                 text NOT NULL CHECK (method IN
                           ('card', 'apple_pay', 'meeza', 'mobile_wallet', 'instapay', 'fawry', 'bnpl', 'cod',
                            'store_credit', 'gift_card')),
  channel                text NOT NULL CHECK (channel IN
                           ('psp_original', 'psp_reverse', 'bank_transfer_iban', 'wallet_transfer', 'store_credit',
                            'store_credit_original_sub', 'fawry_voucher', 'bnpl_cancel')),
  amount                 bigint NOT NULL CHECK (amount > 0),
  credit_sub             text,
  tender_ref             jsonb NOT NULL DEFAULT '{}'::jsonb,
  state                  text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN
                           ('REQUESTED', 'LEDGER_POSTED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED')),
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at        timestamptz,
  provider_ref           text,
  failure_code           text CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
  needs_payout_details   boolean NOT NULL DEFAULT false,
  verify_row             text CHECK (verify_row IS NULL OR verify_row ~ '^VR-[A-Z0-9-]+$'),
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_legs_position_uq UNIQUE (refund_id, position),
  -- B3: BNPL goes back through the provider only, and only BNPL uses that channel.
  CONSTRAINT refund_legs_bnpl_provider_only_chk CHECK ((method = 'bnpl') = (channel = 'bnpl_cancel')),
  CONSTRAINT refund_legs_credit_sub_chk CHECK (
    (channel IN ('store_credit', 'store_credit_original_sub')) = (credit_sub IS NOT NULL))
);

CREATE INDEX refund_legs_due_idx ON refund_legs (next_attempt_at) WHERE state = 'FAILED';
CREATE INDEX refund_legs_open_idx ON refund_legs (state) WHERE state IN ('REQUESTED', 'LEDGER_POSTED', 'SUBMITTED', 'FAILED');
CREATE INDEX refund_legs_provider_ref_idx ON refund_legs (provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TRIGGER refund_legs_touch_updated_at_trg
  BEFORE UPDATE ON refund_legs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE refund_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leg_id      uuid NOT NULL REFERENCES refund_legs (id) ON DELETE CASCADE,
  attempt_no  integer NOT NULL CHECK (attempt_no >= 1),
  outcome     text NOT NULL CHECK (outcome IN ('confirmed', 'pending', 'rejected', 'unavailable')),
  code        text CHECK (code IS NULL OR char_length(code) <= 64),
  at          timestamptz NOT NULL,
  CONSTRAINT refund_attempts_leg_no_uq UNIQUE (leg_id, attempt_no)
);

-- Store credit ------------------------------------------------------------------------------

CREATE TABLE credit_lots (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  sub_key     text NOT NULL CHECK (sub_key ~ '^(refund_credit|cashback_coins|referral_credit|goodwill|gift_card:[A-Za-z0-9_-]+)$'),
  granted     bigint NOT NULL CHECK (granted > 0),
  remaining   bigint NOT NULL CHECK (remaining >= 0),
  held        bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  expires_at  timestamptz,
  source_key  text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 160),
  created_at  timestamptz NOT NULL,
  CONSTRAINT credit_lots_source_uq UNIQUE (source_key),
  CONSTRAINT credit_lots_remaining_chk CHECK (remaining <= granted),
  CONSTRAINT credit_lots_held_chk CHECK (held <= remaining),
  -- refund credit never expires; gift cards expire with the card; the rest always expire
  CONSTRAINT credit_lots_expiry_chk CHECK (
    (sub_key = 'refund_credit' AND expires_at IS NULL)
    OR (sub_key <> 'refund_credit' AND expires_at IS NOT NULL))
);

CREATE INDEX credit_lots_user_idx ON credit_lots (user_id, created_at, id);
CREATE INDEX credit_lots_expiry_idx ON credit_lots (expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;

CREATE TABLE credit_holds (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id),
  ref              text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 128),
  status           text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'captured', 'released')),
  amount           bigint NOT NULL CHECK (amount > 0),
  expires_at       timestamptz NOT NULL,
  order_entry_key  text,
  created_at       timestamptz NOT NULL,
  resolved_at      timestamptz,
  CONSTRAINT credit_holds_ref_uq UNIQUE (user_id, ref),
  CONSTRAINT credit_holds_resolved_chk CHECK ((status = 'held') = (resolved_at IS NULL))
);

CREATE INDEX credit_holds_expiry_idx ON credit_holds (expires_at) WHERE status = 'held';

CREATE TABLE credit_hold_lines (
  hold_id  uuid NOT NULL REFERENCES credit_holds (id) ON DELETE CASCADE,
  lot_id   uuid NOT NULL REFERENCES credit_lots (id),
  sub_key  text NOT NULL,
  amount   bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY (hold_id, lot_id)
);

CREATE TABLE credit_transactions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  kind        text NOT NULL CHECK (kind IN ('credit_added', 'credit_used', 'credit_expired')),
  reason      text NOT NULL CHECK (reason IN
                ('refund', 'gift_card', 'cashback', 'referral', 'goodwill', 'order', 'expiry')),
  sub_key     text NOT NULL,
  amount      bigint NOT NULL CHECK (amount > 0),
  ref         text,
  dedupe_key  text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 192),
  created_at  timestamptz NOT NULL,
  CONSTRAINT credit_transactions_dedupe_uq UNIQUE (dedupe_key)
);

CREATE INDEX credit_transactions_user_idx ON credit_transactions (user_id, created_at DESC, id);

-- Row level security -----------------------------------------------------------------------

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON refunds TO app_user;
CREATE POLICY refunds_select ON refunds FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('support', 'finance', 'trust_safety', 'system'));
CREATE POLICY refunds_insert ON refunds FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY refunds_update ON refunds FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE refund_legs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON refund_legs TO app_user;
CREATE POLICY refund_legs_select ON refund_legs FOR SELECT
  USING (app_role() IN ('support', 'finance', 'trust_safety', 'system')
    OR EXISTS (SELECT 1 FROM refunds r WHERE r.id = refund_legs.refund_id AND r.user_id = app_user_id()));
CREATE POLICY refund_legs_insert ON refund_legs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY refund_legs_update ON refund_legs FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE refund_attempts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON refund_attempts TO app_user;
CREATE POLICY refund_attempts_select ON refund_attempts FOR SELECT
  USING (app_role() IN ('finance', 'system'));
CREATE POLICY refund_attempts_insert ON refund_attempts FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE credit_lots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON credit_lots TO app_user;
CREATE POLICY credit_lots_select ON credit_lots FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('support', 'finance', 'system'));
CREATE POLICY credit_lots_insert ON credit_lots FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY credit_lots_update ON credit_lots FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE credit_holds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON credit_holds TO app_user;
CREATE POLICY credit_holds_select ON credit_holds FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('support', 'finance', 'system'));
CREATE POLICY credit_holds_insert ON credit_holds FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY credit_holds_update ON credit_holds FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE credit_hold_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON credit_hold_lines TO app_user;
CREATE POLICY credit_hold_lines_select ON credit_hold_lines FOR SELECT
  USING (app_role() IN ('finance', 'system')
    OR EXISTS (SELECT 1 FROM credit_holds h WHERE h.id = credit_hold_lines.hold_id AND h.user_id = app_user_id()));
CREATE POLICY credit_hold_lines_insert ON credit_hold_lines FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON credit_transactions TO app_user;
CREATE POLICY credit_transactions_select ON credit_transactions FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('support', 'finance', 'system'));
CREATE POLICY credit_transactions_insert ON credit_transactions FOR INSERT WITH CHECK (app_role() = 'system');
