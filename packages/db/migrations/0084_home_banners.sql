-- migration: 0084_home_banners
-- phase: expand
--
-- In-app offer banners: the swipeable carousel on the shopper Home (docs/specs/phase-3/home-banners.md,
-- ADR-0028 kill switch kill.home_banners). Expand only (new table, nothing existing is altered).
--
--   * One row per banner. The visibility window is checked against SERVER time only (the API never reads
--     a client clock). status is the editor's intent (draft | scheduled | paused); "live" is derived:
--     status = 'scheduled' AND starts_at <= now() < ends_at.
--   * CTA is typed, never a free-form URL: kind drop | store | category | search | voucher with an id,
--     a short query or integer-piastre price bounds. Column shape is enforced by CHECK constraints.
--   * Images are object-store keys only (no scheme, no host, no dot); AR text is required, EN optional.
--   * Sponsored banners must carry an ads or finance reference (sponsor_ref); the app always renders the
--     'Sponsored' label for them and the composer allows at most 1 sponsored slide per 3.
--   * No personal data and NO targeting columns: no budget, affordability or per-user financial signal may
--     ever be a targeting input (spec 12, 17). Coarse segments (governorate, locale, new-vs-returning,
--     Plus) are deliberately not modelled yet; adding one is a separate reviewed migration.
-- Business content, class P0/P1. Readable by everyone only while scheduled; written by marketing/ops.

CREATE TABLE home_banners (
  id             uuid PRIMARY KEY,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'paused')),
  title_ar       text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 60),
  title_en       text CHECK (title_en IS NULL OR char_length(title_en) BETWEEN 1 AND 60),
  subtitle_ar    text CHECK (subtitle_ar IS NULL OR char_length(subtitle_ar) BETWEEN 1 AND 120),
  subtitle_en    text CHECK (subtitle_en IS NULL OR char_length(subtitle_en) BETWEEN 1 AND 120),
  image_key      text CHECK (image_key IS NULL OR (char_length(image_key) BETWEEN 10 AND 200 AND image_key ~ '^[a-z0-9][a-z0-9_-]*(/[A-Za-z0-9_-]+)+$')),
  art_variant    text CHECK (art_variant IS NULL OR art_variant IN ('warm', 'cool', 'neutral', 'festive')),
  priority       smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  sponsored      boolean NOT NULL DEFAULT false,
  sponsor_ref    text CHECK (sponsor_ref IS NULL OR (char_length(sponsor_ref) BETWEEN 3 AND 80 AND sponsor_ref ~ '^[A-Za-z0-9._:-]+$')),
  cta_kind       text NOT NULL CHECK (cta_kind IN ('drop', 'store', 'category', 'search', 'voucher')),
  cta_target_id  text CHECK (cta_target_id IS NULL OR cta_target_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  cta_query      text CHECK (cta_query IS NULL OR (char_length(cta_query) BETWEEN 1 AND 80 AND cta_query !~* '(://|^www\.|^[a-z][a-z0-9+.-]*:)')),
  cta_price_min  bigint CHECK (cta_price_min IS NULL OR cta_price_min >= 0),
  cta_price_max  bigint CHECK (cta_price_max IS NULL OR cta_price_max >= 0),
  created_by     uuid NOT NULL,
  updated_by     uuid NOT NULL,
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_banners_window CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '90 days'),
  CONSTRAINT home_banners_sponsor CHECK (sponsored = (sponsor_ref IS NOT NULL)),
  CONSTRAINT home_banners_price_order CHECK (cta_price_min IS NULL OR cta_price_max IS NULL OR cta_price_min <= cta_price_max),
  CONSTRAINT home_banners_cta_shape CHECK (
    (cta_kind IN ('drop', 'store', 'voucher') AND cta_target_id IS NOT NULL AND cta_query IS NULL AND cta_price_min IS NULL AND cta_price_max IS NULL)
    OR (cta_kind = 'category' AND cta_target_id IS NOT NULL AND cta_query IS NULL)
    OR (cta_kind = 'search' AND cta_target_id IS NULL AND cta_query IS NOT NULL)
  )
);
CREATE INDEX home_banners_live_idx ON home_banners (status, starts_at, ends_at);

CREATE TRIGGER home_banners_touch_updated_at_trg
  BEFORE UPDATE ON home_banners
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE home_banners ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON home_banners TO app_user;
CREATE POLICY home_banners_select ON home_banners FOR SELECT
  USING (status = 'scheduled' OR app_role() IN ('marketing', 'ops', 'super_admin', 'system'));
CREATE POLICY home_banners_insert ON home_banners FOR INSERT
  WITH CHECK (app_role() IN ('marketing', 'ops', 'system'));
CREATE POLICY home_banners_update ON home_banners FOR UPDATE
  USING (app_role() IN ('marketing', 'ops', 'system'))
  WITH CHECK (app_role() IN ('marketing', 'ops', 'system'));
CREATE POLICY home_banners_delete ON home_banners FOR DELETE
  USING (app_role() IN ('marketing', 'ops', 'system'));
