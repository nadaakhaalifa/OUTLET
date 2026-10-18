-- migration: 0086_product_department
-- phase: expand
--
-- Shopper department for the Home boxes (Women / Men / Kids). Accessories stays a category, not a
-- department (docs/plan/department-attribute.md).
--
--   * products.department: women | men | kids | unisex, NOT NULL DEFAULT 'unisex'. Existing rows take the
--     default (a constant DEFAULT on PG 11+ is a metadata-only change, no table rewrite), so old readers
--     and writers that never send the column keep working.
--   * search_documents.department: same enum and default; written by the indexer, read by the Postgres FTS
--     fallback filter. A document re-index fills the real value; until then it reads 'unisex'.
--   * products_department_idx: partial-free btree on (department, status) for the department browse.
--   * search_documents_department_idx: filter support for the fallback engine.
-- Privacy: P0 public product attribute, no personal data.
-- Expand only: additive columns with defaults, no drops, no type changes.

ALTER TABLE products
  ADD COLUMN department text NOT NULL DEFAULT 'unisex'
    CONSTRAINT products_department_chk CHECK (department IN ('women', 'men', 'kids', 'unisex'));
CREATE INDEX products_department_status_idx ON products (department, status);

-- search_documents ships in 0023; guarded so a partial-chain test database (catalog only) still applies.
DO $$
BEGIN
  IF to_regclass('public.search_documents') IS NOT NULL THEN
    ALTER TABLE search_documents
      ADD COLUMN department text NOT NULL DEFAULT 'unisex'
        CONSTRAINT search_documents_department_chk CHECK (department IN ('women', 'men', 'kids', 'unisex'));
    CREATE INDEX search_documents_department_idx ON search_documents (department);
  END IF;
END
$$;
