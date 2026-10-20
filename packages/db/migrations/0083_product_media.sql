-- migration: 0083_product_media
-- phase: expand
--
-- Automatic background removal for seller product photos (docs/specs/phase-3/product-media-background-removal.md,
-- ADR-0028 kill switch kill.background_removal). Expand only.
--
--   * product_media_jobs: one row per uploaded original. The original and every derivative (transparent
--     PNG, white-background JPG, optional soft-shadow PNG) are objects in the private bucket; the row only
--     holds keys (scheme product-media/yyyy/mm/uuid and product-media-derived/yyyy/mm/uuid, no store, user
--     or file name in a key). UNIQUE (store_id, original_ref) makes processing idempotent per upload id.
--   * status machine PENDING -> PROCESSING -> READY | NEEDS_REVIEW | FAILED; decision (none | accepted |
--     use_original) is the seller's choice and is separate from the machine.
--   * product_media_usage: per-store daily run counter (quota).
--   * product_media_blob_graveyard: keys of deleted jobs awaiting object-store erasure (same crash-safe
--     pattern as wardrobe_blob_graveyard, 0082). A trigger fills it, the retention worker drains it.
-- Seller-owned content (P1 business data, may show a model or a person: treated as P2 by the inventory
-- note). Scoped by RLS on app_store_ids(); never public, never used for training.

CREATE TABLE product_media_jobs (
  id                 uuid PRIMARY KEY,
  store_id           uuid NOT NULL,
  created_by         uuid NOT NULL,
  original_ref       text NOT NULL CHECK (char_length(original_ref) BETWEEN 10 AND 200),
  content_type       text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes         integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 12582912),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED')),
  decision           text NOT NULL DEFAULT 'none' CHECK (decision IN ('none', 'accepted', 'use_original')),
  requested_model    text CHECK (requested_model IS NULL OR char_length(requested_model) BETWEEN 1 AND 60),
  model_id           text CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 60),
  model_version      text CHECK (model_version IS NULL OR char_length(model_version) BETWEEN 1 AND 100),
  quality_score      smallint CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  quality_reasons    text[] NOT NULL DEFAULT '{}',
  png_ref            text CHECK (png_ref IS NULL OR char_length(png_ref) BETWEEN 10 AND 200),
  white_jpg_ref      text CHECK (white_jpg_ref IS NULL OR char_length(white_jpg_ref) BETWEEN 10 AND 200),
  shadow_ref         text CHECK (shadow_ref IS NULL OR char_length(shadow_ref) BETWEEN 10 AND 200),
  latency_ms         integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code         text CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  attempts           smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, original_ref),
  CONSTRAINT product_media_ready_has_outputs CHECK (status NOT IN ('READY', 'NEEDS_REVIEW') OR (png_ref IS NOT NULL AND white_jpg_ref IS NOT NULL AND quality_score IS NOT NULL))
);
CREATE INDEX product_media_jobs_store_idx ON product_media_jobs (store_id, created_at DESC, id DESC);
CREATE INDEX product_media_jobs_age_idx ON product_media_jobs (updated_at);

CREATE TRIGGER product_media_jobs_touch_updated_at_trg
  BEFORE UPDATE ON product_media_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE product_media_usage (
  store_id  uuid NOT NULL,
  day       date NOT NULL,
  runs      integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  PRIMARY KEY (store_id, day)
);

CREATE TABLE product_media_blob_graveyard (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id   text NOT NULL UNIQUE CHECK (char_length(upload_id) BETWEEN 10 AND 200),
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_media_blob_graveyard_age_idx ON product_media_blob_graveyard (deleted_at);

CREATE FUNCTION product_media_jobs_bury_blobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO product_media_blob_graveyard (upload_id)
  SELECT k FROM unnest(ARRAY[OLD.original_ref, OLD.png_ref, OLD.white_jpg_ref, OLD.shadow_ref]) AS k
  WHERE k IS NOT NULL
  ON CONFLICT (upload_id) DO NOTHING;
  RETURN OLD;
END $$;

CREATE TRIGGER product_media_jobs_bury_blobs_trg
  AFTER DELETE ON product_media_jobs
  FOR EACH ROW EXECUTE FUNCTION product_media_jobs_bury_blobs();

ALTER TABLE product_media_jobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media_jobs TO app_user;
CREATE POLICY product_media_jobs_select ON product_media_jobs FOR SELECT
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_jobs_insert ON product_media_jobs FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_jobs_update ON product_media_jobs FOR UPDATE
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())))
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_jobs_delete ON product_media_jobs FOR DELETE USING (app_role() = 'system');

ALTER TABLE product_media_usage ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media_usage TO app_user;
CREATE POLICY product_media_usage_select ON product_media_usage FOR SELECT
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_usage_insert ON product_media_usage FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_usage_update ON product_media_usage FOR UPDATE
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())))
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_usage_delete ON product_media_usage FOR DELETE USING (app_role() = 'system');

-- Written only by the trigger (SECURITY DEFINER), read and drained by the retention worker (system role).
ALTER TABLE product_media_blob_graveyard ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_media_blob_graveyard_system ON product_media_blob_graveyard FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
