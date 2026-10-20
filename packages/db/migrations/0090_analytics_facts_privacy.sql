-- no-transaction
-- migration: 0090_analytics_facts_privacy
-- phase: expand
--
-- Dashboard foundations, tracks 6 and 4 (docs/specs/dashboard-foundations.md section 6, "Facts retention and
-- erasure (H3)" and the suppression memo DDL; ADR-0045).
--
-- Runs outside a transaction so the indexes can be built CONCURRENTLY. Every statement is idempotent
-- (IF NOT EXISTS, guarded DO blocks, CREATE OR REPLACE), so a run that stopped half way is simply re-run.
-- An index left INVALID by an interrupted concurrent build must be dropped by hand before the re-run.
--
--   H3  facts are P2: a DELETE grant and a column-limited UPDATE grant (system only) for the 25-month purge and
--       for forgetShopper(); an erase-only trigger refuses any other UPDATE even from an owner session.
--   M9  term_hash (P2) and the relaxed search CHECK, NOT VALID then VALIDATE.
--   B2  seller_analytics_suppression_memo (monotone k-anonymity memo; the logic is track 4).
--   H3  analytics_erased_keys: erased shopper keys kept 31 days so a late outbox payload cannot re-introduce them.

-- Indexes ------------------------------------------------------------------------------------
-- Covering index for union distinct counts by track 4.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sa_facts_store_kind_shopper_idx
  ON seller_analytics_facts (store_id, kind, occurred_at) INCLUDE (shopper_key, source, governorate)
  WHERE shopper_key IS NOT NULL;
-- Purge by age (H3).
CREATE INDEX CONCURRENTLY IF NOT EXISTS sa_facts_occurred_idx ON seller_analytics_facts (occurred_at);
-- Erasure by pseudonym (H3): the covering index leads with store_id and cannot serve this lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sa_facts_shopper_idx ON seller_analytics_facts (shopper_key) WHERE shopper_key IS NOT NULL;
-- Order-level counting for the `orders` rollup (first purchase fact of a seller order) and its reconciliation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sa_facts_order_idx
  ON seller_analytics_facts (store_id, seller_order_id, occurred_at) WHERE kind = 'purchase';

-- term_hash and the relaxed search CHECK (M9) --------------------------------------------------
ALTER TABLE seller_analytics_facts ADD COLUMN IF NOT EXISTS term_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sa_facts_term_hash_chk' AND conrelid = 'seller_analytics_facts'::regclass) THEN
    ALTER TABLE seller_analytics_facts ADD CONSTRAINT sa_facts_term_hash_chk
      CHECK (term_hash IS NULL OR term_hash ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sa_facts_search_term_chk' AND conrelid = 'seller_analytics_facts'::regclass) THEN
    ALTER TABLE seller_analytics_facts ADD CONSTRAINT sa_facts_search_term_chk
      CHECK (kind <> 'search_click' OR term IS NOT NULL OR term_hash IS NOT NULL) NOT VALID;
  END IF;
END
$$;
ALTER TABLE seller_analytics_facts VALIDATE CONSTRAINT sa_facts_term_hash_chk;
ALTER TABLE seller_analytics_facts VALIDATE CONSTRAINT sa_facts_search_term_chk;
-- lint-allow: drop-constraint-or-index replaced by sa_facts_search_term_chk (validated above): term OR term_hash
ALTER TABLE seller_analytics_facts DROP CONSTRAINT IF EXISTS sa_facts_search_chk;

-- Erase-only trigger (H3) ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sa_facts_erase_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shopper_key IS NOT NULL THEN
    RAISE EXCEPTION 'seller_analytics_facts: shopper_key may only be set to NULL';
  END IF;
  IF (to_jsonb(NEW) - 'shopper_key') IS DISTINCT FROM (to_jsonb(OLD) - 'shopper_key') THEN
    RAISE EXCEPTION 'seller_analytics_facts: only shopper_key may change';
  END IF;
  RETURN NEW;
END
$$;

-- lint-allow: drop-constraint-or-index guard for an idempotent re-run of this migration
DROP TRIGGER IF EXISTS sa_facts_erase_only_trg ON seller_analytics_facts;
CREATE TRIGGER sa_facts_erase_only_trg
  BEFORE UPDATE ON seller_analytics_facts
  FOR EACH ROW EXECUTE FUNCTION sa_facts_erase_only();

-- Grants and policies (system only) ------------------------------------------------------------
GRANT DELETE ON seller_analytics_facts TO app_user;
GRANT UPDATE (shopper_key) ON seller_analytics_facts TO app_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'seller_analytics_facts' AND policyname = 'sa_facts_delete') THEN
    CREATE POLICY sa_facts_delete ON seller_analytics_facts FOR DELETE USING (app_role() = 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'seller_analytics_facts' AND policyname = 'sa_facts_erase') THEN
    CREATE POLICY sa_facts_erase ON seller_analytics_facts FOR UPDATE
      USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
  END IF;
END
$$;

-- Suppression memo (B2) ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_analytics_suppression_memo (
  store_id        uuid NOT NULL,
  metric          text NOT NULL CHECK (char_length(metric) <= 64),
  dimension       text NOT NULL CHECK (dimension IN ('none', 'source', 'governorate', 'term')),
  dim_key         text NOT NULL CHECK (char_length(dim_key) <= 64),
  bucket          text NOT NULL CHECK (bucket ~ '^([0-9]{4}-[0-9]{2}(-[0-9]{2})?|[0-9]{4}-[0-9]{2}\.\.[0-9]{4}-[0-9]{2})$'),
  reason          text NOT NULL CHECK (reason IN ('primary', 'complementary', 'margin')),
  first_hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, metric, dimension, dim_key, bucket)
);
CREATE INDEX IF NOT EXISTS sasm_first_hidden_idx ON seller_analytics_suppression_memo (first_hidden_at);
ALTER TABLE seller_analytics_suppression_memo ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON seller_analytics_suppression_memo TO app_user;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'seller_analytics_suppression_memo' AND policyname = 'sasm_select') THEN
    CREATE POLICY sasm_select ON seller_analytics_suppression_memo FOR SELECT USING (app_role() = 'system');
    CREATE POLICY sasm_insert ON seller_analytics_suppression_memo FOR INSERT WITH CHECK (app_role() = 'system');
    CREATE POLICY sasm_delete ON seller_analytics_suppression_memo FOR DELETE USING (app_role() = 'system');
  END IF;
END
$$;

-- Erased shopper keys (H3 step 3) ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_erased_keys (
  shopper_key text PRIMARY KEY CHECK (char_length(shopper_key) BETWEEN 8 AND 128),
  erased_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aek_erased_at_idx ON analytics_erased_keys (erased_at);
ALTER TABLE analytics_erased_keys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON analytics_erased_keys TO app_user;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'analytics_erased_keys' AND policyname = 'aek_select') THEN
    CREATE POLICY aek_select ON analytics_erased_keys FOR SELECT USING (app_role() = 'system');
    CREATE POLICY aek_insert ON analytics_erased_keys FOR INSERT WITH CHECK (app_role() = 'system');
    CREATE POLICY aek_delete ON analytics_erased_keys FOR DELETE USING (app_role() = 'system');
  END IF;
END
$$;
