-- migration: 0038_budget
-- phase: expand
--
-- Budget suite (spec 12, docs/specs/phase2/03-budget-affordability.md). Expand only: six new
-- tables, nothing existing changes.
--
--   * Opt-in under the budget_insights consent. These tables are P3 (financial behaviour):
--     every amount, the category split and the free text are application-level envelope
--     ciphertext (bytea), bound to the row with AAD. The database never sees a plaintext amount.
--   * Isolation: no sellers, ads, ranking or promotion code reads these tables. There is no
--     foreign table, view or function here that exposes them; the dependency-cruiser rule
--     (.dependency-cruiser.cjs) forbids the importing modules, and RLS below limits rows to
--     their owner (or the system role used by the budget module itself).
--   * Erasure: every table cascades from users, and the module purges all rows on consent
--     withdrawal, on DELETE /v1/me/budget and on account deletion (rows are NOT retained).
--   * budget_cycles is the row the checkout cap re-check locks (SELECT ... FOR UPDATE) so two
--     concurrent orders cannot both pass the cap.
--   * budget_spend_events is the idempotent ledger of spend and refunds the cycle totals are
--     derived from (PK user_id + event_key); it holds no order contents beyond ciphertext.

CREATE TABLE budgets (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  amount        bytea NOT NULL,
  per_category  bytea,
  payday        smallint NOT NULL CHECK (payday BETWEEN 1 AND 31),
  cap_mode      text NOT NULL DEFAULT 'off' CHECK (cap_mode IN ('off', 'soft', 'hard')),
  -- Hard cap: maturity of the latest unlock request (24 h after the request). Null if none.
  hold_until    timestamptz,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budget_cycles (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cycle_start     timestamptz NOT NULL,
  cycle_end       timestamptz NOT NULL,
  spent           bytea NOT NULL,
  refunded        bytea NOT NULL,
  refund_received bytea NOT NULL,
  rolled_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cycle_start),
  CONSTRAINT budget_cycles_window CHECK (cycle_end > cycle_start)
);

CREATE TABLE budget_spend_events (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_key       text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 120),
  kind            text NOT NULL CHECK (kind IN ('placed', 'refund', 'cod_refusal')),
  order_placed_at timestamptz NOT NULL,
  occurred_at     timestamptz NOT NULL,
  detail          bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);

CREATE INDEX budget_spend_events_user_time_idx ON budget_spend_events (user_id, order_placed_at);
CREATE INDEX budget_spend_events_user_occurred_idx ON budget_spend_events (user_id, occurred_at);

CREATE TABLE installment_commitments (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  source     text NOT NULL CHECK (source IN ('provider', 'user')),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  monthly    bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, provider, starts_at),
  CONSTRAINT installment_commitments_window CHECK (ends_at >= starts_at)
);

CREATE TABLE savings_goals (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title         bytea NOT NULL,
  target_amount bytea NOT NULL,
  target_date   date,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX savings_goals_user_idx ON savings_goals (user_id);

CREATE TABLE budget_unlock_requests (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL,
  unlock_at    timestamptz NOT NULL,
  CONSTRAINT budget_unlock_requests_delay CHECK (unlock_at >= requested_at + interval '24 hours')
);

CREATE INDEX budget_unlock_requests_user_idx ON budget_unlock_requests (user_id, requested_at DESC);

-- Row level security: owner or the budget module's system role. No public or cross-user read. ---
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO app_user;
CREATE POLICY budgets_owner ON budgets FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE budget_cycles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_cycles TO app_user;
CREATE POLICY budget_cycles_owner ON budget_cycles FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE budget_spend_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON budget_spend_events TO app_user;
CREATE POLICY budget_spend_events_select ON budget_spend_events FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY budget_spend_events_insert ON budget_spend_events FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY budget_spend_events_delete ON budget_spend_events FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE installment_commitments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON installment_commitments TO app_user;
CREATE POLICY installment_commitments_owner ON installment_commitments FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON savings_goals TO app_user;
CREATE POLICY savings_goals_owner ON savings_goals FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE budget_unlock_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON budget_unlock_requests TO app_user;
CREATE POLICY budget_unlock_requests_select ON budget_unlock_requests FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY budget_unlock_requests_insert ON budget_unlock_requests FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY budget_unlock_requests_delete ON budget_unlock_requests FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');
