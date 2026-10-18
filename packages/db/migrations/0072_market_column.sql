-- migration: 0072_market_column
-- phase: expand
--
-- Market abstraction seam (ADR-0040 option 1, docs/specs/phase-3/gcc-market-abstraction.md). Expand only.
--
--   * Adds `market` (ISO 3166-1 alpha-2, default 'EG') to the five tables whose rows are market
--     scoped: carts, order_groups, price_events, promotions, budgets.
--   * Constant NOT NULL default: a metadata-only change, no rewrite and no backfill. Existing rows
--     read as 'EG', which is what they always were. The check only enforces the code shape; it does
--     NOT list valid markets (that is the domain registry and a release flag, not the schema).
--   * Deliberately NOT touched: journal_entries and postings. Ledger semantics are unchanged; the
--     currency already travels on every posting and entries must balance per currency.
--   * No new market is enabled and no per-country behaviour exists. Nothing reads this column yet
--     beyond tests; later phases add `market` to indexes and RLS only when a second market is real.

ALTER TABLE carts        ADD COLUMN market text NOT NULL DEFAULT 'EG' CHECK (market ~ '^[A-Z]{2}$');
ALTER TABLE order_groups ADD COLUMN market text NOT NULL DEFAULT 'EG' CHECK (market ~ '^[A-Z]{2}$');
ALTER TABLE price_events ADD COLUMN market text NOT NULL DEFAULT 'EG' CHECK (market ~ '^[A-Z]{2}$');
ALTER TABLE promotions   ADD COLUMN market text NOT NULL DEFAULT 'EG' CHECK (market ~ '^[A-Z]{2}$');
ALTER TABLE budgets      ADD COLUMN market text NOT NULL DEFAULT 'EG' CHECK (market ~ '^[A-Z]{2}$');
