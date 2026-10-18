-- migration: 0082_wardrobe_blob_graveyard
-- phase: expand
--
-- Crash-safe photo erasure for wardrobe items (spec 28 feature 4, spec B1, ADR-0043).
--
-- A wardrobe photo is an object in a private bucket; the row only holds its key. Rows can disappear
-- through paths that do not know about the bucket (account erasure deletes by user_id, retention,
-- history clear). A trigger therefore copies the key of every deleted wardrobe_items row, and of
-- every unconsumed wardrobe_uploads row, into this graveyard in the same transaction. The retention
-- module deletes the object and then the graveyard row; the application also deletes the object
-- immediately on a user delete (the graveyard is the safety net, not the primary path).
-- The key scheme `wardrobe/yyyy/mm/uuid` carries no user id and no file name, so the graveyard holds
-- no personal data and no user key (it cannot be attributed to an account).

CREATE TABLE wardrobe_blob_graveyard (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id   text NOT NULL UNIQUE CHECK (char_length(upload_id) BETWEEN 10 AND 200),
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wardrobe_blob_graveyard_age_idx ON wardrobe_blob_graveyard (deleted_at);

CREATE FUNCTION wardrobe_items_bury_blob() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.image_ref IS NOT NULL THEN
    INSERT INTO wardrobe_blob_graveyard (upload_id) VALUES (OLD.image_ref) ON CONFLICT (upload_id) DO NOTHING;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER wardrobe_items_bury_blob_trg
  AFTER DELETE ON wardrobe_items
  FOR EACH ROW EXECUTE FUNCTION wardrobe_items_bury_blob();

CREATE FUNCTION wardrobe_uploads_bury_blob() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.consumed_at IS NULL THEN
    INSERT INTO wardrobe_blob_graveyard (upload_id) VALUES (OLD.upload_id) ON CONFLICT (upload_id) DO NOTHING;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER wardrobe_uploads_bury_blob_trg
  AFTER DELETE ON wardrobe_uploads
  FOR EACH ROW EXECUTE FUNCTION wardrobe_uploads_bury_blob();

-- Written only by the triggers above (SECURITY DEFINER) and read/purged by the retention worker
-- (system role). The application role has no grant.
ALTER TABLE wardrobe_blob_graveyard ENABLE ROW LEVEL SECURITY;
CREATE POLICY wardrobe_blob_graveyard_system ON wardrobe_blob_graveyard FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
