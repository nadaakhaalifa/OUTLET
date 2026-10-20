-- migration: 0077_creator_payouts
-- phase: expand
--
-- Creators and affiliates, part 3: payouts (ADR-0037 option 1: accrue-only, payouts engaged OFF).
-- The module reuses the seller payout state machine (SCHEDULED, ON_HOLD, APPROVED, SENT, SETTLED,
-- FAILED, CANCELLED) and the admin approval records for dual approval. Nothing here sends money:
-- the provider port defaults to Unconfigured and the kill switch kill.creator_payouts is on.
--
--   * creator_payouts: amount is bigint piastres. At most one open payout per creator (partial
--     unique index). attempt numbers the ledger idempotency subject (payout id plus attempt).
--   * commissions.payout_id: the commissions reserved by a payout. A cancelled payout releases them.

CREATE TABLE creator_payouts (
  id             uuid PRIMARY KEY,
  creator_id     uuid NOT NULL REFERENCES creator_accounts (id),
  amount         bigint NOT NULL CHECK (amount > 0),
  state          text NOT NULL DEFAULT 'SCHEDULED' CHECK (state IN
                   ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'SENT', 'SETTLED', 'FAILED', 'CANCELLED')),
  hold_reason    text CHECK (hold_reason IS NULL OR char_length(hold_reason) <= 64),
  attempt        integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider_ref   text CHECK (provider_ref IS NULL OR char_length(provider_ref) <= 128),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 128),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_payouts_hold_shape CHECK (state <> 'ON_HOLD' OR hold_reason IS NOT NULL)
);

CREATE UNIQUE INDEX creator_payouts_one_open_idx ON creator_payouts (creator_id)
  WHERE state IN ('SCHEDULED', 'ON_HOLD', 'APPROVED', 'SENT', 'FAILED');
CREATE INDEX creator_payouts_creator_idx ON creator_payouts (creator_id, created_at DESC);
CREATE INDEX creator_payouts_state_idx ON creator_payouts (state, created_at);

ALTER TABLE commissions ADD COLUMN payout_id uuid REFERENCES creator_payouts (id);
CREATE INDEX commissions_payout_idx ON commissions (payout_id) WHERE payout_id IS NOT NULL;

ALTER TABLE creator_payouts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON creator_payouts TO app_user;

CREATE POLICY creator_payouts_select ON creator_payouts FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM creator_accounts a WHERE a.id = creator_payouts.creator_id AND a.user_id = app_user_id()));
CREATE POLICY creator_payouts_insert ON creator_payouts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY creator_payouts_update ON creator_payouts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
