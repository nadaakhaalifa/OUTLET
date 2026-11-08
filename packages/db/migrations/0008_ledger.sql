-- migration: 0008_ledger
-- phase: expand (additive only)
-- Source: docs/specs/ledger-chart-of-accounts.md (principles P1-P10, invariants I1-I5, I19, I20),
--         docs/data-model.md ledger section, master prompt T4. TWO-KEY area: owner + chief-reviewer sign-off.
--
-- TENANCY / RLS: the ledger is PLATFORM-LEVEL (finance/admin only; sellers and shoppers read it only through
-- application read models). There is deliberately NO store_id or user_id column, so the RLS audit does not
-- classify these tables as tenant tables. ledger_accounts.owner_type/owner_id hold a store id, user id or
-- provider code as a plain business reference; it is NOT a tenant key and carries no policy.
--
-- Sign convention: amount_minor > 0 = debit, < 0 = credit. Money is BIGINT minor units, never zero.
--
-- Deviations from docs/data-model.md (all additive or hardening):
--   * postings has a surrogate uuid id (+ line_no) as the task requires; data model keyed it (entry_id, line_no).
--   * postings carries market_id; composite FK (account_id, currency, market_id) -> ledger_accounts makes
--     "posting currency = account currency" and "posting market = account market" declarative (stronger than a trigger).
--   * journal_entries gains chain_seq (unambiguous per-market chain order), content_hash (idempotency comparison),
--     prev_hash and hash (per-market hash chain, like audit_log). Partitioning (DM-05) is NOT implemented yet.
--   * journal_entry_keys is not built: idempotency_key is UNIQUE on journal_entries itself.
--   * journal_entries.txid (xid8) closes an entry after its transaction commits (A1); closed_at is omitted. Account type list is a CHECK, not a ledger_account_types table;
--     reserved names (spec 3.5) are absent from the CHECK, so postings to them are impossible (I19).
--   * Seeded platform accounts use gen_random_uuid() (v4), not UUIDv7.
--   * market_id has no FK to markets yet: the markets table is not built.
--   * DEVIATION FROM DM-15 (per-entry/row locking): ledger writers serialise per MARKET with
--     pg_advisory_xact_lock(hashtextextended('ledger:'||market)) so the hash chain has one head. Throughput ceiling:
--     one ledger-writing transaction per market at a time (held until commit/rollback), i.e. the checkout webhook path
--     posts serially per market. Acceptable at Phase 1 volume; revisit (per-shard chains) before mega-events.
--   * Grants (A3): outlet_app gets explicit SELECT, INSERT on ledger_accounts, journal_entries, postings (guarded by role
--     existence). RLS: none on these tables, but the app's outbox INSERT (journal_entry.posted) is market-pinned by RLS,
--     so a ledger post under another market's context fails there.
--   * REVOKE targets role outlet_app only if it exists (it is created by migration 0007 / ADR-0011); this migration
--     does not depend on 0007. Immutability does not rely on grants: triggers block UPDATE/DELETE/TRUNCATE for every role.

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY,                                  -- UUIDv7 from the app (DM-18)
  code        text NOT NULL,                                     -- {type}:{market}:{currency}[:{owner}][:{sub}]
  type        text NOT NULL CHECK (type IN (
    'psp_clearing','bnpl_clearing','cod_clearing','bank_operating','bank_collections','payouts_in_transit',
    'disputes_in_progress','vat_input',
    'seller_pending','seller_available','store_credit','shopper_refunds_payable','courier_payable',
    'platform_vat_output','deferred_revenue',
    'commission_revenue','shipping_revenue','seller_plan_revenue','recharge_revenue',
    'promo_expense_platform','psp_fee_expense','bnpl_fee_expense','courier_cost_expense',
    'chargeback_loss_expense','goodwill_expense','referral_expense','payout_fee_expense')),
  market_id   text NOT NULL CHECK (market_id ~ '^[A-Z]{2}$'),
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  owner_type  text NOT NULL DEFAULT '',
  owner_id    text NOT NULL DEFAULT '',                          -- '' for platform accounts; tombstoned on erasure
  sub         text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_code_key UNIQUE (code),
  CONSTRAINT ledger_accounts_identity_key UNIQUE (market_id, type, owner_type, owner_id, sub, currency),
  CONSTRAINT ledger_accounts_posting_fk_key UNIQUE (id, currency, market_id),
  CONSTRAINT ledger_accounts_code_matches CHECK (
    code = type || ':' || market_id || ':' || currency
      || CASE WHEN owner_id <> '' THEN ':' || owner_id ELSE '' END
      || CASE WHEN sub <> '' THEN ':' || sub ELSE '' END),
  CONSTRAINT ledger_accounts_owner_pair CHECK ((owner_type = '') = (owner_id = '')),
  CONSTRAINT ledger_accounts_store_credit_sub CHECK (
    (type = 'store_credit' AND sub IN ('refund_credit','gift_card','cashback_coins','referral_credit','goodwill'))
    OR (type <> 'store_credit' AND sub = ''))
);
CREATE INDEX ledger_accounts_owner_idx ON ledger_accounts (owner_type, owner_id);

CREATE TABLE journal_entries (
  id               uuid PRIMARY KEY,                             -- UUIDv7 from the app
  kind             text NOT NULL CHECK (kind IN (
    'order_recognised','order_delivered_cod','refund_issued','line_closed','clearing_settled','courier_cost_accrued',
    'courier_remitted','recharge_issued','plan_charged','revenue_recognised','payout_sent','payout_settled',
    'dispute_opened','dispute_resolved','store_credit_granted','store_credit_spent','store_credit_expired','reversal')),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  market_id        text NOT NULL CHECK (market_id ~ '^[A-Z]{2}$'),
  occurred_at      timestamptz(3) NOT NULL,                      -- business time, millisecond precision (hash input)
  txid             xid8 NOT NULL DEFAULT pg_current_xact_id(),   -- writing transaction; postings may only join it (A1)
  note             text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),   -- reversal reason; outside the hash
  ref_type         text NOT NULL CHECK (length(ref_type) > 0),
  ref_id           text NOT NULL CHECK (length(ref_id) > 0),
  reverses_entry_id uuid REFERENCES journal_entries (id),
  chain_seq        bigint NOT NULL CHECK (chain_seq >= 1),
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  prev_hash        text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash             text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT journal_entries_chain_key UNIQUE (market_id, chain_seq),
  CONSTRAINT journal_entries_reverses_key UNIQUE (reverses_entry_id),   -- at most one reversal per entry
  CONSTRAINT journal_entries_market_key UNIQUE (id, market_id),
  CONSTRAINT journal_entries_reversal_shape CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX journal_entries_keyset_idx ON journal_entries (market_id, occurred_at, id);   -- keyset listing
CREATE INDEX journal_entries_ref_idx ON journal_entries (ref_type, ref_id);

CREATE TABLE postings (
  id            uuid PRIMARY KEY,
  entry_id      uuid NOT NULL,
  line_no       smallint NOT NULL CHECK (line_no >= 1),
  account_id    uuid NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),      -- signed: debit +, credit -
  currency      char(3) NOT NULL,
  market_id     text NOT NULL CHECK (market_id ~ '^[A-Z]{2}$'),
  CONSTRAINT postings_entry_line_key UNIQUE (entry_id, line_no),
  CONSTRAINT postings_entry_fk FOREIGN KEY (entry_id, market_id) REFERENCES journal_entries (id, market_id),
  CONSTRAINT postings_account_fk FOREIGN KEY (account_id, currency, market_id) REFERENCES ledger_accounts (id, currency, market_id)
);
CREATE INDEX postings_account_entry_idx ON postings (account_id, entry_id);   -- account statements, balances
CREATE INDEX postings_entry_idx ON postings (entry_id);

-- I1/P2: every entry balances to zero per currency at COMMIT, and has at least two postings.
CREATE FUNCTION ledger_assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  bad_currency text;
  n integer;
BEGIN
  SELECT currency INTO bad_currency FROM postings WHERE entry_id = NEW.entry_id
    GROUP BY currency HAVING SUM(amount_minor) <> 0 LIMIT 1;
  IF bad_currency IS NOT NULL THEN
    RAISE EXCEPTION 'ledger: journal entry % is unbalanced in %', NEW.entry_id, bad_currency
      USING ERRCODE = '23514', CONSTRAINT = 'postings_entry_balanced';
  END IF;
  SELECT count(*) INTO n FROM postings WHERE entry_id = NEW.entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger: journal entry % has fewer than two postings', NEW.entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'postings_entry_min_two';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER postings_entry_balanced
  AFTER INSERT ON postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();

-- An entry committed with no postings at all is also invalid.
CREATE FUNCTION ledger_assert_entry_has_postings() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT count(*) FROM postings WHERE entry_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'ledger: journal entry % has fewer than two postings', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_min_two';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER journal_entries_min_two
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_has_postings();

-- P4/I4: append-only for every role (including the table owner and superusers). Corrections are reversing entries.
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger: % on % is not allowed; post a reversing entry', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$fn$;
-- A1: an entry is closed once its transaction commits. Postings may only be added by the transaction that wrote the entry.
CREATE FUNCTION ledger_assert_entry_open() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT e.txid FROM journal_entries e WHERE e.id = NEW.entry_id) IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger: journal entry % is closed; postings can only be added in the transaction that created it', NEW.entry_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER postings_entry_open BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_open();

CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();

-- ENABLE ALWAYS: the guards also fire under session_replication_role = replica (which skips ordinary triggers).
ALTER TABLE postings ENABLE ALWAYS TRIGGER postings_entry_open;
ALTER TABLE postings ENABLE ALWAYS TRIGGER postings_immutable;
ALTER TABLE postings ENABLE ALWAYS TRIGGER postings_no_truncate;
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER journal_entries_immutable;
ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER journal_entries_no_truncate;

-- Defence in depth for the app role once 0007 creates it; skipped (not created) when absent.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outlet_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON postings, journal_entries FROM outlet_app;
    GRANT SELECT, INSERT ON ledger_accounts, journal_entries, postings TO outlet_app;   -- A3: explicit, not default-privilege luck
  END IF;
END
$do$;

-- Platform accounts (market EG, currency EGP). Owner-scoped accounts (seller_pending, seller_available,
-- store_credit) are created lazily by the ledger service; everything else must be seeded by a migration.
INSERT INTO ledger_accounts (id, code, type, market_id, currency, owner_type, owner_id, sub)
SELECT gen_random_uuid(),
       s.type || ':EG:EGP' || CASE WHEN s.owner_id <> '' THEN ':' || s.owner_id ELSE '' END,
       s.type, 'EG', 'EGP', s.owner_type, s.owner_id, ''
FROM (VALUES
  ('psp_clearing', 'psp', 'paymob'),
  ('bnpl_clearing', 'bnpl', 'valu'),
  ('cod_clearing', 'courier', 'bosta'),
  ('bank_operating', 'bank', 'main'),
  ('bank_collections', 'bank', 'main'),
  ('disputes_in_progress', 'psp', 'paymob'),
  ('courier_payable', 'courier', 'bosta'),
  ('deferred_revenue', 'stream', 'seller_plans'),
  ('payouts_in_transit', '', ''),
  ('vat_input', '', ''),
  ('shopper_refunds_payable', '', ''),
  ('platform_vat_output', '', ''),
  ('commission_revenue', '', ''),
  ('shipping_revenue', '', ''),
  ('seller_plan_revenue', '', ''),
  ('recharge_revenue', '', ''),
  ('promo_expense_platform', '', ''),
  ('psp_fee_expense', '', ''),
  ('bnpl_fee_expense', '', ''),
  ('courier_cost_expense', '', ''),
  ('chargeback_loss_expense', '', ''),
  ('goodwill_expense', '', ''),
  ('referral_expense', '', ''),
  ('payout_fee_expense', '', '')
) AS s(type, owner_type, owner_id);
