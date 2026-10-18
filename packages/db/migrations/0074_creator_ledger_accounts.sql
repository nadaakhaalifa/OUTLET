-- migration: 0074_creator_ledger_accounts
-- phase: expand
--
-- Creators and affiliates (docs/specs/phase-3/creators-affiliates.md, ADR-0037): two new ledger
-- account types, added through a forward INSERT because 0011 is generated and never rewritten
-- (tooling/db/generate-account-types-migration.mjs POST_0011_TYPES).
--
--   * creator_payable:{creator_user_id}   liability, credit-normal, persisted owner type 'user'.
--     May go negative after a clawback of an already paid commission; the module reports that
--     explicitly and nets it from the next payout.
--   * creator_commission_expense          expense, debit-normal, platform singleton.
--
-- Mirrors packages/domain/src/chart-of-accounts/accounts.ts; ledger-account-types.test.ts compares.
-- Expand only: inserting rows into a lookup table cannot break existing data.

INSERT INTO ledger_account_types (code, category, normal_side, owner_type, in_spec_t4, status) VALUES
  ('creator_payable', 'liability', 'credit', 'user', false, 'active'),
  ('creator_commission_expense', 'expense', 'debit', 'platform', false, 'active')
ON CONFLICT (code) DO NOTHING;
