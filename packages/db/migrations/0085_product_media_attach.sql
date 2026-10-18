-- migration: 0085_product_media_attach
-- phase: expand
--
-- Links an accepted background-removal cutout to the product record (docs/specs/phase-3/product-media-background-removal.md).
--
--   * product_media_jobs.attached_product_id: the product the job is attached to (NULL = free). Set by a
--     compare-and-set UPDATE in the catalog write path, so a job can back exactly one product and two
--     concurrent writes cannot both win. Cleared when the product no longer references the job.
--   * product_media_jobs.promoted_image_ref / promoted_cutout_ref: keys of the copies promoted to the
--     catalog image purpose (catalog/yyyy/mm/uuid), so a re-attach reuses them and the delete trigger
--     buries them with the job's other objects.
--   * product_media gains media_job_id + image_ref (default image, white-background JPG or the original for
--     use_original) + cutout_ref (transparent PNG, only for accepted cutouts). Keys only, no new PII.
--     A partial unique index keeps one job on one product image row.
-- Expand only: every new column is nullable and unused by existing readers.

ALTER TABLE product_media_jobs
  ADD COLUMN attached_product_id   uuid,
  ADD COLUMN promoted_image_ref    text CHECK (promoted_image_ref IS NULL OR char_length(promoted_image_ref) BETWEEN 10 AND 200),
  ADD COLUMN promoted_cutout_ref   text CHECK (promoted_cutout_ref IS NULL OR char_length(promoted_cutout_ref) BETWEEN 10 AND 200);
CREATE INDEX product_media_jobs_attached_idx ON product_media_jobs (attached_product_id) WHERE attached_product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION product_media_jobs_bury_blobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO product_media_blob_graveyard (upload_id)
  SELECT k FROM unnest(ARRAY[OLD.original_ref, OLD.png_ref, OLD.white_jpg_ref, OLD.shadow_ref, OLD.promoted_image_ref, OLD.promoted_cutout_ref]) AS k
  WHERE k IS NOT NULL
  ON CONFLICT (upload_id) DO NOTHING;
  RETURN OLD;
END $$;

ALTER TABLE product_media
  ADD COLUMN media_job_id uuid,
  ADD COLUMN image_ref    text CHECK (image_ref IS NULL OR char_length(image_ref) BETWEEN 10 AND 200),
  ADD COLUMN cutout_ref   text CHECK (cutout_ref IS NULL OR char_length(cutout_ref) BETWEEN 10 AND 200),
  ADD CONSTRAINT product_media_job_refs_ck CHECK ((media_job_id IS NULL AND image_ref IS NULL AND cutout_ref IS NULL) OR (media_job_id IS NOT NULL AND image_ref IS NOT NULL));
CREATE UNIQUE INDEX product_media_job_uq ON product_media (media_job_id) WHERE media_job_id IS NOT NULL;
