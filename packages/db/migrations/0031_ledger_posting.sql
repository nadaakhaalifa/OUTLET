-- migration: 0031_ledger_posting
-- phase: expand
--
-- Hash chain over journal entries (spec T4 integrity job, docs/specs/ledger-posting.md).
-- One append-only link per entry: entry_hash = sha256(prev_hash || canonical entry), computed by the
-- posting service while it holds pg_advisory_xact_lock, so seq order is the commit order of chain
-- appends. Gaps in seq are expected (identity values burn on rollback); the verifier requires only
-- strictly increasing seq and an unbroken prev_hash chain.
--
-- Expand-safe: one new table, no change to existing tables. journal_entries and postings keep their
-- immutability triggers (0003); this table gets the same guard.

CREATE TABLE ledger_entry_chain (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries (id),
  prev_hash  text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entry_chain_entry_uq UNIQUE (entry_id),
  CONSTRAINT ledger_entry_chain_hash_uq UNIQUE (entry_hash),
  -- two entries can never claim the same predecessor: a fork is rejected by the database
  CONSTRAINT ledger_entry_chain_prev_uq UNIQUE (prev_hash)
);

CREATE TRIGGER ledger_entry_chain_immutable_trg
  BEFORE UPDATE OR DELETE ON ledger_entry_chain
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_chain_no_truncate_trg
  BEFORE TRUNCATE ON ledger_entry_chain
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE ledger_entry_chain ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ledger_entry_chain TO app_user;
CREATE POLICY ledger_entry_chain_select ON ledger_entry_chain FOR SELECT
  USING (app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY ledger_entry_chain_insert ON ledger_entry_chain FOR INSERT
  WITH CHECK (app_role() IN ('finance', 'system'));
