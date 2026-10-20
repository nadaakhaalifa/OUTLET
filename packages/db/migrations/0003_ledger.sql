-- migration: 0003_ledger
-- phase: expand
--
-- Double-entry ledger (spec T4, docs/specs/money-and-ledger.md).
-- Sign convention: positive amount = debit, negative = credit.
-- Guarantees enforced by the database, independent of application code:
--   1. postings per entry per currency sum to 0 (DEFERRED constraint trigger,
--      checked at COMMIT, so an entry may be built row by row);
--   2. an entry has at least 2 postings;
--   3. postings can only be added in the transaction that created the entry;
--   4. postings and journal entries are immutable (UPDATE / DELETE / TRUNCATE
--      rejected; privileges never granted either);
--   5. a posting's currency equals its account's currency;
--   6. journal_entries.idempotency_key is UNIQUE (permanent money idempotency).
-- Corrections are reversing entries (reverses_entry_id), never edits.

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- chart-of-accounts type, e.g. seller_payable, psp_clearing, platform_commission
  type        text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*$'),
  owner_type  text NOT NULL CHECK (owner_type IN ('platform', 'store', 'user', 'psp', 'courier', 'bnpl_provider')),
  -- '' for platform-owned accounts; store/user id or provider code otherwise
  owner_id    text NOT NULL DEFAULT '',
  -- distinguishes sub-accounts, e.g. store_credit:{user}:{sub}
  sub_key     text NOT NULL DEFAULT '',
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  CONSTRAINT ledger_accounts_owner_chk CHECK ((owner_type = 'platform') = (owner_id = '')),
  CONSTRAINT ledger_accounts_identity_uq UNIQUE (type, owner_type, owner_id, sub_key, currency),
  -- target of the composite FK that pins posting currency to account currency
  CONSTRAINT ledger_accounts_id_currency_uq UNIQUE (id, currency)
);

CREATE INDEX ledger_accounts_owner_idx ON ledger_accounts (owner_type, owner_id);

-- Accounts are identity-stable: only closed_at may change.
CREATE FUNCTION ledger_accounts_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on ledger_accounts is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.type, NEW.owner_type, NEW.owner_id, NEW.sub_key, NEW.currency, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.type, OLD.owner_type, OLD.owner_id, OLD.sub_key, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'ledger_accounts identity columns are immutable (only closed_at may change)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'ledger account % is already closed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ledger_accounts_guard_trg
  BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard();

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (length(kind) > 0),
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) > 0),
  occurred_at        timestamptz NOT NULL,
  ref_type           text NOT NULL CHECK (length(ref_type) > 0),
  ref_id             text NOT NULL CHECK (length(ref_id) > 0),
  -- set on reversing entries; at most one reversal per entry
  reverses_entry_id  uuid REFERENCES journal_entries (id),
  -- transaction that created the entry; postings may only join in that transaction
  txid               xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_idempotency_key_uq UNIQUE (idempotency_key),
  CONSTRAINT journal_entries_reverses_uq UNIQUE (reverses_entry_id),
  CONSTRAINT journal_entries_not_self_reversal CHECK (reverses_entry_id IS DISTINCT FROM id)
);

CREATE INDEX journal_entries_ref_idx ON journal_entries (ref_type, ref_id);
CREATE INDEX journal_entries_occurred_idx ON journal_entries (occurred_at);

CREATE TABLE postings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries (id),
  account_id uuid NOT NULL,
  -- signed minor units (piastres for EGP); never zero
  amount     bigint NOT NULL CHECK (amount <> 0),
  currency   char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT postings_account_currency_fk
    FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency)
);

CREATE INDEX postings_entry_idx ON postings (entry_id);
CREATE INDEX postings_account_idx ON postings (account_id, currency);

-- Immutability -------------------------------------------------------------
CREATE TRIGGER postings_immutable_trg
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER postings_no_truncate_trg
  BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER journal_entries_immutable_trg
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate_trg
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A posting may only be added in the transaction that created its entry. -----
-- SECURITY DEFINER so RLS on journal_entries cannot hide the entry from it.
CREATE FUNCTION postings_same_txn_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  entry_txid xid8;
BEGIN
  SELECT txid INTO entry_txid FROM journal_entries WHERE id = NEW.entry_id;
  -- missing entry: the foreign key reports it
  IF FOUND AND entry_txid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'postings can only be added in the transaction that created entry %', NEW.entry_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER postings_same_txn_trg
  BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION postings_same_txn_guard();

-- Balance check, DEFERRED to commit ----------------------------------------
CREATE FUNCTION ledger_assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  target_entry uuid;
  posting_count integer;
  bad record;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_entry := NEW.id;
  ELSE
    target_entry := NEW.entry_id;
  END IF;

  SELECT count(*) INTO posting_count FROM postings WHERE entry_id = target_entry;
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'journal entry % has % posting(s); at least 2 are required', target_entry, posting_count
      USING ERRCODE = 'check_violation';
  END IF;

  FOR bad IN
    SELECT currency, sum(amount) AS total
    FROM postings
    WHERE entry_id = target_entry
    GROUP BY currency
    HAVING sum(amount) <> 0
  LOOP
    RAISE EXCEPTION 'journal entry % is unbalanced in %: postings sum to %', target_entry, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END LOOP;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER postings_balanced_trg
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();

-- An entry with no postings at all must also fail at commit.
CREATE CONSTRAINT TRIGGER journal_entries_balanced_trg
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();

-- Derived views: balances are never stored as the truth (spec 15.2). --------
CREATE VIEW ledger_balances AS
  SELECT account_id, currency, sum(amount)::bigint AS balance, count(*)::bigint AS posting_count
  FROM postings
  GROUP BY account_id, currency;

-- Integrity job input: every row must be 0 (spec T4).
CREATE VIEW ledger_trial_balance AS
  SELECT currency, sum(amount)::bigint AS total
  FROM postings
  GROUP BY currency;
