-- migration: 0087_product_media_versions
-- phase: expand
--
-- Cutout editing (docs/specs/phase-3/product-media-background-removal.md, "Editing a cutout"). Expand only.
--
--   * product_media_versions: one immutable row per produced cutout of a job (initial run, model re-run or
--     manual refine). Keys only: the mask, transparent PNG, white JPG, optional shadow and optional
--     rendered-background object of that version in the private bucket. `params` holds the edit request in
--     compact form (strokes quantised to 1/1000 integers, no free text, no PII), capped at 256 KB.
--     Rows are never updated; a job keeps at most 5 (the application prunes the oldest non-current one).
--     UNIQUE (job_id, version) makes concurrent version allocation safe. ON DELETE CASCADE from the job,
--     and a trigger buries every key into product_media_blob_graveyard (same crash-safe pattern as 0083).
--   * product_media_jobs: current_version (0 = legacy job without version rows, lazily versioned on first
--     edit), edit_count (refines, cap enforced by the application), promoted_version (version whose
--     catalog copies are stored in promoted_*_ref, so a later edit is re-promoted), background_render_ref.
--   * product_media_usage.refine_units: quarter runs. A refine with a stored mask costs 1 unit, a full run 4.
-- Seller-owned content, scoped by RLS on app_store_ids(); never public, never used for training.

ALTER TABLE product_media_jobs
  ADD COLUMN current_version       integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  ADD COLUMN edit_count            smallint NOT NULL DEFAULT 0 CHECK (edit_count >= 0),
  ADD COLUMN promoted_version      integer NOT NULL DEFAULT 0 CHECK (promoted_version >= 0),
  ADD COLUMN background_render_ref text CHECK (background_render_ref IS NULL OR char_length(background_render_ref) BETWEEN 10 AND 200);

ALTER TABLE product_media_usage
  ADD COLUMN refine_units integer NOT NULL DEFAULT 0 CHECK (refine_units >= 0);

CREATE TABLE product_media_versions (
  id                    uuid PRIMARY KEY,
  job_id                uuid NOT NULL REFERENCES product_media_jobs(id) ON DELETE CASCADE,
  store_id              uuid NOT NULL,
  version               integer NOT NULL CHECK (version >= 1),
  op                    text NOT NULL CHECK (op IN ('initial', 'rerun', 'refine')),
  params                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(params::text) <= 262144),
  mask_ref              text CHECK (mask_ref IS NULL OR char_length(mask_ref) BETWEEN 10 AND 200),
  png_ref               text NOT NULL CHECK (char_length(png_ref) BETWEEN 10 AND 200),
  white_jpg_ref         text NOT NULL CHECK (char_length(white_jpg_ref) BETWEEN 10 AND 200),
  shadow_ref            text CHECK (shadow_ref IS NULL OR char_length(shadow_ref) BETWEEN 10 AND 200),
  background_render_ref text CHECK (background_render_ref IS NULL OR char_length(background_render_ref) BETWEEN 10 AND 200),
  model_id              text CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 60),
  model_version         text CHECK (model_version IS NULL OR char_length(model_version) BETWEEN 1 AND 100),
  latency_ms            integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  quality_score         smallint NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  quality_reasons       text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);
CREATE INDEX product_media_versions_store_idx ON product_media_versions (store_id);

CREATE FUNCTION product_media_versions_bury_blobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO product_media_blob_graveyard (upload_id)
  SELECT k FROM unnest(ARRAY[OLD.mask_ref, OLD.png_ref, OLD.white_jpg_ref, OLD.shadow_ref, OLD.background_render_ref]) AS k
  WHERE k IS NOT NULL
  ON CONFLICT (upload_id) DO NOTHING;
  RETURN OLD;
END $$;

CREATE TRIGGER product_media_versions_bury_blobs_trg
  AFTER DELETE ON product_media_versions
  FOR EACH ROW EXECUTE FUNCTION product_media_versions_bury_blobs();

-- The job trigger also covers the new background-render key.
CREATE OR REPLACE FUNCTION product_media_jobs_bury_blobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO product_media_blob_graveyard (upload_id)
  SELECT k FROM unnest(ARRAY[OLD.original_ref, OLD.png_ref, OLD.white_jpg_ref, OLD.shadow_ref, OLD.promoted_image_ref, OLD.promoted_cutout_ref, OLD.background_render_ref]) AS k
  WHERE k IS NOT NULL
  ON CONFLICT (upload_id) DO NOTHING;
  RETURN OLD;
END $$;

ALTER TABLE product_media_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media_versions TO app_user;
CREATE POLICY product_media_versions_select ON product_media_versions FOR SELECT
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_versions_insert ON product_media_versions FOR INSERT
  WITH CHECK (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
CREATE POLICY product_media_versions_update ON product_media_versions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY product_media_versions_delete ON product_media_versions FOR DELETE
  USING (app_role() = 'system' OR (app_role() = 'seller' AND store_id::text = ANY (app_store_ids())));
