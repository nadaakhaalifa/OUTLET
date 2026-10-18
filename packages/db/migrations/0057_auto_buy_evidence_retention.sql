-- migration: 0057_auto_buy_evidence_retention
-- phase: expand
--
-- Phase 3 money review, findings B-1 and B-3 (docs/plan/phase-3-money-review.md), ADR-0036 notes.
-- Expand-compatible: nothing is dropped from the data, constraints are only widened or made stricter
-- for deletes. Old code keeps working (it never writes the new state).
--
--   * B-3: the mandate and attempt rows are the evidence for a merchant-initiated charge (accepted
--     terms, pre-charge notice log, order link). They must survive an account deletion for the
--     financial retention period, so the cascades from users and mandates become RESTRICT. Erasure
--     tombstones the users row (it never hard-deletes it) and scrubs the personal columns in place.
--   * The immutability trigger blocked that in-place scrub (it would have parked every erasure of a
--     user with a rule). It now permits exactly two columns to change: accepted_device_id and
--     psp_token_ref (the shopper's device and vault reference). The commercial terms stay immutable.
--   * B-1: a new attempt state MANUAL_REVIEW (an unresolved PSP outcome is never FAILED).

-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_mandates DROP CONSTRAINT auto_buy_mandates_user_id_fkey;
ALTER TABLE auto_buy_mandates
  ADD CONSTRAINT auto_buy_mandates_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_attempts DROP CONSTRAINT auto_buy_attempts_mandate_id_fkey;
ALTER TABLE auto_buy_attempts
  ADD CONSTRAINT auto_buy_attempts_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES auto_buy_mandates (id) ON DELETE RESTRICT;
-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_attempts DROP CONSTRAINT auto_buy_attempts_user_id_fkey;
ALTER TABLE auto_buy_attempts
  ADD CONSTRAINT auto_buy_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- A scrubbed token reference may be NULL on a closed unattended rule.
-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_mandates DROP CONSTRAINT auto_buy_mandates_mode_token;
ALTER TABLE auto_buy_mandates ADD CONSTRAINT auto_buy_mandates_mode_token CHECK (
  (mode = 'notify_confirm' AND psp_token_ref IS NULL)
  OR (mode = 'unattended' AND (psp_token_ref IS NOT NULL OR status <> 'ARMED')));

CREATE OR REPLACE FUNCTION auto_buy_mandates_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- accepted_device_id and psp_token_ref are deliberately NOT compared: the privacy erasure scrubs them.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
     OR NEW.size_label IS DISTINCT FROM OLD.size_label
     OR NEW.target_price IS DISTINCT FROM OLD.target_price
     OR NEW.max_price IS DISTINCT FROM OLD.max_price
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.mandate_version IS DISTINCT FROM OLD.mandate_version
     OR NEW.mandate_locale IS DISTINCT FROM OLD.mandate_locale
     OR NEW.terms_sha256 IS DISTINCT FROM OLD.terms_sha256
     OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'an accepted auto-buy mandate is immutable; create a new mandate' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'ARMED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed auto-buy mandate cannot be reopened' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_attempts DROP CONSTRAINT auto_buy_attempts_state_check;
ALTER TABLE auto_buy_attempts ADD CONSTRAINT auto_buy_attempts_state_check CHECK (state IN (
  'TRIGGERED', 'SKIPPED', 'NOTIFIED', 'CHARGING', 'REQUIRES_USER_ACTION', 'MANUAL_REVIEW',
  'PURCHASED', 'CANCELLED_BY_USER', 'FAILED', 'DISARMED'));
-- lint-allow: drop-constraint-or-index re-created in the same migration; the new form is equal or stricter for deletes (RESTRICT) or a widening for scrub/new state
ALTER TABLE auto_buy_attempts DROP CONSTRAINT auto_buy_attempts_notified;
ALTER TABLE auto_buy_attempts ADD CONSTRAINT auto_buy_attempts_notified CHECK (
  state NOT IN ('NOTIFIED', 'CHARGING', 'REQUIRES_USER_ACTION', 'MANUAL_REVIEW', 'PURCHASED')
  OR (notice_sent_at IS NOT NULL AND cancel_deadline IS NOT NULL));

-- Manual review queue (ops).
CREATE INDEX auto_buy_attempts_review_idx ON auto_buy_attempts (updated_at) WHERE state = 'MANUAL_REVIEW';
