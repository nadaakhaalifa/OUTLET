-- migration: 0069_product_embeddings_pgvector
-- phase: expand
--
-- Optional ANN column for visual search and similar items (ADR-0023, default pgvector).
-- product_embeddings.vec stays the jsonb source of truth (0039) so nothing depends on the optional
-- extension. When the `vector` extension is installed this migration adds vec_pg vector(768), a
-- trigger that mirrors vec into it for 768-d arrays, a backfill and an HNSW cosine index. Without
-- the extension (PGlite in tests, hosts that lack pgvector) it is a no-op and the retrieval adapter
-- feature-detects the column, falling back to a bounded exact scan only where explicitly allowed.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE product_embeddings ADD COLUMN IF NOT EXISTS vec_pg vector(768)';
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION product_embeddings_sync_vec_pg() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      BEGIN
        IF jsonb_array_length(NEW.vec) = 768 THEN
          NEW.vec_pg := (NEW.vec::text)::vector(768);
        ELSE
          NEW.vec_pg := NULL;
        END IF;
        RETURN NEW;
      END
      $body$
    $f$;
    EXECUTE 'DROP TRIGGER IF EXISTS product_embeddings_sync_vec_pg ON product_embeddings';
    EXECUTE 'CREATE TRIGGER product_embeddings_sync_vec_pg BEFORE INSERT OR UPDATE OF vec ON product_embeddings
             FOR EACH ROW EXECUTE FUNCTION product_embeddings_sync_vec_pg()';
    EXECUTE 'UPDATE product_embeddings SET vec = vec WHERE vec_pg IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS product_embeddings_vec_pg_hnsw ON product_embeddings
             USING hnsw (vec_pg vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'pgvector not installed: product_embeddings.vec_pg skipped (visual search uses the bounded exact scan fallback where allowed)';
  END IF;
END
$$;

-- Model version filter used by every ANN query (queries only match the same model_version).
CREATE INDEX IF NOT EXISTS product_embeddings_model_version ON product_embeddings (model_version);
