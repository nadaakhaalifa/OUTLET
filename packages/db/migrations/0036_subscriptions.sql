-- migration: 0036_subscriptions
-- phase: expand
--
-- Z-OUTLET Plus subscriptions (spec 14, docs/specs/phase2/01-plus-subscriptions.md, ADR-0004
-- Plan A, ADR-0012 age gate, ADR-0021 ledger first). Expand only: seven new tables.
--
--   * plans are versioned rows (code, version) with an effective_from; a price change is a new
--     version at least 30 days ahead (enforced in the application, effective_from is data).
--   * one live (non EXPIRED) subscription per user, enforced by a partial unique index, so a
--     duplicate subscribe tap cannot create a second row.
--   * subscription_invoices are unique per (subscription, cycle, attempt): the dunning schedule
--     and the PSP idempotency key are the same triple.
--   * entitlements are a projection of the subscription (group commerce_benefits | app_features).
--     app_features is reserved for Plan B and is empty by default.
--   * trial_claims holds HMAC hashes only (phone, device, card fingerprint); never raw values.
--   * plus_savings_ledger is written by the system only and is unique per (order group, benefit).
--   * Money is BIGINT piastres. Column names avoid reserved words (billing_interval,
--     entitlement_group, entitlement_key).
--   * Row level security: owners read their own rows, writes run as app.role = 'system'
--     (the policy guard authorizes the actor); plans are world readable.

CREATE TABLE plans (
  id               uuid PRIMARY KEY,
  code             text NOT NULL CHECK (code ~ '^plus_[a-z0-9_]{1,40}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  price            bigint NOT NULL CHECK (price > 0),
  currency         text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  version          integer NOT NULL CHECK (version >= 1),
  active           boolean NOT NULL DEFAULT true,
  trial_days       integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 60),
  effective_from   timestamptz NOT NULL,
  notified_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_version_uq UNIQUE (code, version)
);

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users (id),
  plan_id                  uuid NOT NULL REFERENCES plans (id),
  plan_code                text NOT NULL,
  plan_version             integer NOT NULL CHECK (plan_version >= 1),
  billing_interval         text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  status                   text NOT NULL
                             CHECK (status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED_AT_PERIOD_END', 'EXPIRED')),
  period_start             timestamptz NOT NULL,
  period_end               timestamptz NOT NULL,
  trial_end                timestamptz,
  cancel_at                timestamptz,
  paused_at                timestamptz,
  paused_until             timestamptz,
  grace_ends_at            timestamptz,
  failed_at                timestamptz,
  dunning_attempts         smallint NOT NULL DEFAULT 0 CHECK (dunning_attempts BETWEEN 0 AND 3),
  cycle                    integer NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  next_action_at           timestamptz,
  pending_plan_code        text,
  trial_reminder_sent_at   timestamptz,
  psp_token_ref            text NOT NULL,
  version                  integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_period_order CHECK (period_end >= period_start),
  CONSTRAINT subscriptions_paused_has_until CHECK (status <> 'PAUSED' OR paused_until IS NOT NULL),
  CONSTRAINT subscriptions_past_due_has_grace CHECK (status <> 'PAST_DUE' OR grace_ends_at IS NOT NULL)
);

CREATE UNIQUE INDEX subscriptions_one_live_uq ON subscriptions (user_id) WHERE status <> 'EXPIRED';
CREATE INDEX subscriptions_user_status_idx ON subscriptions (user_id, status);
CREATE INDEX subscriptions_status_period_end_idx ON subscriptions (status, period_end);
CREATE INDEX subscriptions_sweeper_idx ON subscriptions (next_action_at, id) WHERE status <> 'EXPIRED';

CREATE TABLE subscription_invoices (
  id                 uuid PRIMARY KEY,
  subscription_id    uuid NOT NULL REFERENCES subscriptions (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  cycle              integer NOT NULL CHECK (cycle >= 1),
  attempt            smallint NOT NULL CHECK (attempt BETWEEN 0 AND 3),
  kind               text NOT NULL CHECK (kind IN ('first', 'renewal', 'dunning', 'upgrade')),
  amount             bigint NOT NULL CHECK (amount >= 0),
  vat                bigint NOT NULL CHECK (vat >= 0),
  credit_applied     bigint NOT NULL DEFAULT 0 CHECK (credit_applied >= 0),
  net_recognition    bigint NOT NULL DEFAULT 0 CHECK (net_recognition >= 0),
  periods_total      smallint NOT NULL DEFAULT 1 CHECK (periods_total BETWEEN 1 AND 12),
  periods_recognised smallint NOT NULL DEFAULT 0,
  period_start       timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('PAID', 'FAILED', 'REFUNDED')),
  psp_provider       text,
  psp_ref            text,
  eta_receipt_id     text,
  issued_at          timestamptz NOT NULL,
  charged_at         timestamptz,
  refunded_at        timestamptz,
  CONSTRAINT subscription_invoices_attempt_uq UNIQUE (subscription_id, cycle, attempt),
  CONSTRAINT subscription_invoices_recognised_le_total CHECK (periods_recognised <= periods_total),
  CONSTRAINT subscription_invoices_vat_le_amount CHECK (vat <= amount),
  -- B-5: a positive PAID or REFUNDED charge must name its PSP; no clearing-account fallback.
  CONSTRAINT subscription_invoices_provider_chk CHECK (amount = 0 OR status = 'FAILED' OR psp_provider IS NOT NULL)
);

CREATE INDEX subscription_invoices_user_idx ON subscription_invoices (user_id, issued_at DESC);
CREATE INDEX subscription_invoices_recognition_idx ON subscription_invoices (period_start)
  WHERE status = 'PAID' AND periods_recognised < periods_total;

CREATE TABLE entitlements (
  source_subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  user_id                uuid NOT NULL REFERENCES users (id),
  entitlement_group      text NOT NULL CHECK (entitlement_group IN ('commerce_benefits', 'app_features')),
  entitlement_key        text NOT NULL CHECK (char_length(entitlement_key) BETWEEN 1 AND 60),
  valid_from             timestamptz NOT NULL,
  valid_to               timestamptz NOT NULL,
  PRIMARY KEY (source_subscription_id, entitlement_group, entitlement_key),
  CONSTRAINT entitlements_window CHECK (valid_to > valid_from)
);

CREATE INDEX entitlements_user_idx ON entitlements (user_id, entitlement_group, valid_to);

CREATE TABLE plus_savings_ledger (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id),
  order_group_id  uuid NOT NULL,
  benefit         text NOT NULL CHECK (char_length(benefit) BETWEEN 1 AND 60),
  amount_saved    bigint NOT NULL CHECK (amount_saved >= 0),
  created_at      timestamptz NOT NULL,
  reversed_at     timestamptz,
  CONSTRAINT plus_savings_once_uq UNIQUE (order_group_id, benefit)
);

CREATE INDEX plus_savings_user_idx ON plus_savings_ledger (user_id, created_at DESC);

CREATE TABLE trial_claims (
  person_key_hash text PRIMARY KEY CHECK (char_length(person_key_hash) = 64),
  subscription_id uuid NOT NULL,
  claimed_at      timestamptz NOT NULL
);

CREATE TABLE plus_signups (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id),
  plan_id          uuid NOT NULL REFERENCES plans (id),
  charge_key       text NOT NULL,
  token_ref        text NOT NULL,
  device_id        text,
  amount           bigint NOT NULL CHECK (amount > 0),
  status           text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  psp_ref          text,
  client_action    jsonb,
  subscription_id  uuid,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT plus_signups_charge_key_uq UNIQUE (charge_key)
);

CREATE INDEX plus_signups_user_idx ON plus_signups (user_id, created_at DESC);

CREATE TABLE subscription_webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON plans TO app_user;
CREATE POLICY plans_select ON plans FOR SELECT USING (true);
CREATE POLICY plans_system_insert ON plans FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY plans_system_update ON plans FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO app_user;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY subscriptions_system_insert ON subscriptions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY subscriptions_system_update ON subscriptions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON subscription_invoices TO app_user;
CREATE POLICY subscription_invoices_select ON subscription_invoices FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY subscription_invoices_system_insert ON subscription_invoices FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY subscription_invoices_system_update ON subscription_invoices FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON entitlements TO app_user;
CREATE POLICY entitlements_select ON entitlements FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY entitlements_system_insert ON entitlements FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY entitlements_system_update ON entitlements FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY entitlements_system_delete ON entitlements FOR DELETE USING (app_role() = 'system');

ALTER TABLE plus_savings_ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON plus_savings_ledger TO app_user;
CREATE POLICY plus_savings_select ON plus_savings_ledger FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY plus_savings_system_insert ON plus_savings_ledger FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY plus_savings_system_update ON plus_savings_ledger FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE trial_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON trial_claims TO app_user;
CREATE POLICY trial_claims_system_select ON trial_claims FOR SELECT USING (app_role() = 'system');
CREATE POLICY trial_claims_system_insert ON trial_claims FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE plus_signups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON plus_signups TO app_user;
CREATE POLICY plus_signups_select ON plus_signups FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY plus_signups_system_insert ON plus_signups FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY plus_signups_system_update ON plus_signups FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE subscription_webhook_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON subscription_webhook_events TO app_user;
CREATE POLICY subscription_webhook_events_system_select ON subscription_webhook_events FOR SELECT USING (app_role() = 'system');
CREATE POLICY subscription_webhook_events_system_insert ON subscription_webhook_events FOR INSERT WITH CHECK (app_role() = 'system');
