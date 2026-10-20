-- migration: 0096_search_documents_brand
-- phase: expand
--
-- Catalog brand on the search read model, so the Postgres FTS fallback can serve the `brand_ids` filter.
--
--   * search_documents.brand_id: NULLABLE uuid, no default, no FK. Adding a nullable column without a default is
--     a metadata-only change on PG 11+ (no table rewrite, no long lock). It is a logical reference to
--     brands(id) only: the read model must not block a brand deletion and is rebuilt by the indexer.
--     Existing documents read NULL (no brand) and therefore never match a brand filter until re-indexed.
--   * search_documents_brand_idx: partial index (brand_id IS NOT NULL) used by the `brand_id = any(...)` filter;
--     products without a brand are not indexed.
-- Privacy: P0 public catalog data, no personal data. Retention follows the table (browsing_state).
-- Expand only: additive nullable column, no drops, no type changes. Rollback: DROP INDEX, DROP COLUMN.

-- search_documents ships in 0023; guarded so a partial-chain test database (catalog only) still applies.
DO $$
BEGIN
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    ALTER TABLE search_documents ADD COLUMN brand_id uuid;
    CREATE INDEX search_documents_brand_idx ON search_documents (brand_id) WHERE brand_id IS NOT NULL;
  END IF;
END
$$;
