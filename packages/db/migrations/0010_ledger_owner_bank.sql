-- migration: 0010_ledger_owner_bank
-- phase: expand
--
-- The domain chart of accounts (packages/domain/src/chart-of-accounts) has a
-- `bank_settlement` account whose owner kind is `bank`; the 0003 CHECK did
-- not allow it, so persisting that account would have failed (ADR-0018).
-- Widening an IN-list only admits more values, so no existing row can break.
-- Persistence names stay `store` and `user`; the adapter maps them to the
-- domain's `seller` and `shopper`.

-- lint-allow: drop-constraint-or-index replaced in the same transaction by a strictly wider CHECK
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_owner_type_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_owner_type_check
  CHECK (owner_type IN ('platform', 'store', 'user', 'psp', 'courier', 'bnpl_provider', 'bank'));
