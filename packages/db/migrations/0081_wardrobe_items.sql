-- migration: 0081_wardrobe_items
-- phase: expand
--
-- Wardrobe digitization (spec 28 feature 4, docs/specs/phase-3/wardrobe.md, ADR-0043). Expand only.
--
--   * wardrobe_items: a shopper-owned garment. P2 personal data: the photo reference and the
--     attributes. The photo itself is in a private bucket (key scheme wardrobe/yyyy/mm/uuid, no
--     user or file name in the key), EXIF/GPS stripped and virus scanned before it is ever served.
--     image_ref is NULL for an item added by hand ("manual first"; the vision port is optional).
--   * attributes: category, palette, pattern, formality 0..4, seasons, material, modest flag.
--     attributes_source says whether the user typed them or a vision suggestion is still unedited.
--   * wardrobe_uploads: one row per issued signed upload (ownership proof, quota, abandoned-upload
--     purge). Consumed when an item adopts the upload.
-- Consent purpose: the existing `personalization` purpose (ADR-0043 note, ADR-0018 vocabulary is
-- unchanged: nine purposes). Owner scoped by RLS.
-- Retention: user_content (until the user removes the item or deletes the account), abandoned and
-- infected uploads purged by the retention module.

CREATE TABLE wardrobe_items (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id),
  image_ref             text UNIQUE CHECK (image_ref IS NULL OR char_length(image_ref) BETWEEN 10 AND 200),
  image_state           text NOT NULL DEFAULT 'none' CHECK (image_state IN ('none', 'pending_scan', 'clean', 'infected')),
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 2048),
  attributes_source     text NOT NULL DEFAULT 'user' CHECK (attributes_source IN ('user', 'vision')),
  vision_model_version  text CHECK (vision_model_version IS NULL OR char_length(vision_model_version) BETWEEN 1 AND 60),
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wardrobe_items_image_state_ref CHECK ((image_ref IS NULL) = (image_state = 'none'))
);
CREATE INDEX wardrobe_items_user_idx ON wardrobe_items (user_id, created_at DESC, id DESC);
CREATE INDEX wardrobe_items_infected_idx ON wardrobe_items (updated_at) WHERE image_state = 'infected';

CREATE TRIGGER wardrobe_items_touch_updated_at_trg
  BEFORE UPDATE ON wardrobe_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE wardrobe_uploads (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  upload_id     text NOT NULL UNIQUE CHECK (char_length(upload_id) BETWEEN 10 AND 200),
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz
);
CREATE INDEX wardrobe_uploads_user_idx ON wardrobe_uploads (user_id, issued_at DESC);
CREATE INDEX wardrobe_uploads_abandoned_idx ON wardrobe_uploads (issued_at) WHERE consumed_at IS NULL;

ALTER TABLE wardrobe_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON wardrobe_items TO app_user;
CREATE POLICY wardrobe_items_owner_select ON wardrobe_items FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_items_owner_insert ON wardrobe_items FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_items_owner_update ON wardrobe_items FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_items_owner_delete ON wardrobe_items FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE wardrobe_uploads ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON wardrobe_uploads TO app_user;
CREATE POLICY wardrobe_uploads_owner_select ON wardrobe_uploads FOR SELECT USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_uploads_owner_insert ON wardrobe_uploads FOR INSERT WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_uploads_owner_update ON wardrobe_uploads FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY wardrobe_uploads_owner_delete ON wardrobe_uploads FOR DELETE USING (user_id = app_user_id() OR app_role() = 'system');
