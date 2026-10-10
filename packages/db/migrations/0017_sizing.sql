-- migration: 0017_sizing
-- phase: expand
--
-- Size profiles, structured size charts, fit feedback, item flags and seller demand aggregates
-- (spec 10; docs/specs/sizing.md; docs/data-model/sizing.md; docs/privacy/fragments/sizing.yaml).
-- Synthetic data only until ADR-0002 is accepted.
--
-- Notes
--   * size_profiles holds P3 data. label, measurements and quick_start (usual size) are CIPHERTEXT (bytea, envelope encrypted):
--     the application encrypts them with the envelope cipher before the row reaches the database.
--     There is deliberately no date of birth, photo or media column (children: nickname and
--     measurements only, spec B1).
--   * Phase 1 only. brand_size_bias, user_latent_sizes and body_scan_captures arrive with the
--     Phase 2/3 models. Brand history for fit v1 is computed from fit_feedback (brand_id snapshot).
--   * product_id and brand_id are LOGICAL references until the catalog migration lands.
--   * seller_size_demand_agg can only hold cells with demand_count >= 50 (k-anonymity at source).
--     demand_count is the number of DISTINCT shoppers, never requests (ADV-1); the writer must dedupe per user.
--   * RLS follows 0007 and packages/policy/RLS.md: class A (owner) for profiles and feedback,
--     class B (store tenant) for charts and demand, platform write for derived tables.

CREATE TABLE size_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  kind              text NOT NULL CHECK (kind IN ('ME', 'PARTNER', 'CHILD')),
  label             bytea NOT NULL,
  measurements      bytea,
  quick_start       bytea,
  fit_pref          text NOT NULL DEFAULT 'REGULAR' CHECK (fit_pref IN ('SNUG', 'REGULAR', 'LOOSE')),
  modest_fit        boolean NOT NULL DEFAULT false,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX size_profiles_user_live_idx ON size_profiles (user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER size_profiles_touch_updated_at_trg
  BEFORE UPDATE ON size_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- At most 6 live profiles per user, serialised per user (spec 10, proposed in the data model).
CREATE FUNCTION size_profiles_enforce_cap() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('size_profiles:' || NEW.user_id::text, 0));
  SELECT count(*) INTO n FROM size_profiles
    WHERE user_id = NEW.user_id AND deleted_at IS NULL AND id <> NEW.id;
  IF n >= 6 THEN
    RAISE EXCEPTION 'user % already holds 6 size profiles', NEW.user_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER size_profiles_cap_trg
  BEFORE INSERT ON size_profiles FOR EACH ROW EXECUTE FUNCTION size_profiles_enforce_cap();

-- Required measures per product type (mirrors CHART_TEMPLATES in packages/domain/src/sizing).
CREATE TABLE size_chart_templates (
  product_type      text NOT NULL,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  required_measures text[] NOT NULL CHECK (cardinality(required_measures) >= 1),
  unit_default      text NOT NULL DEFAULT 'cm' CHECK (unit_default IN ('cm', 'in')),
  PRIMARY KEY (product_type, version)
);

INSERT INTO size_chart_templates (product_type, version, required_measures) VALUES
  ('tops', 1, ARRAY['bust_cm', 'waist_cm']),
  ('dresses', 1, ARRAY['bust_cm', 'waist_cm', 'hip_cm']),
  ('bottoms', 1, ARRAY['waist_cm', 'hip_cm', 'inseam_cm']),
  ('outerwear', 1, ARRAY['bust_cm', 'shoulders_cm', 'sleeve_cm']),
  ('shoes', 1, ARRAY['foot_length_cm']),
  ('kids_tops', 1, ARRAY['height_cm', 'bust_cm']);

-- Charts are immutable versions: an edit inserts the next chart_version, so feedback stays bound to
-- the version it used. rows are normalised to cm; the entered unit is kept for display.
CREATE TABLE size_charts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES stores (id),
  product_type      text NOT NULL CHECK (length(product_type) BETWEEN 1 AND 60),
  chart_version     integer NOT NULL CHECK (chart_version >= 1),
  unit_entered      text NOT NULL CHECK (unit_entered IN ('cm', 'in')),
  rows              jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) BETWEEN 1 AND 30),
  validated         boolean NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_errors) = 'array'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT size_charts_version_uq UNIQUE (store_id, product_type, chart_version),
  CONSTRAINT size_charts_validated_chk CHECK (NOT validated OR jsonb_array_length(validation_errors) = 0)
);

CREATE INDEX size_charts_store_validated_idx ON size_charts (store_id, validated);

CREATE TRIGGER size_charts_immutable_trg
  BEFORE UPDATE OR DELETE ON size_charts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- One feedback per delivered order line. brand_id, product_type and size_label are snapshots so the
-- brand history rule needs no cross-module join. profile_id is nulled when the profile is deleted.
CREATE TABLE fit_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id  uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users (id),
  profile_id     uuid REFERENCES size_profiles (id) ON DELETE SET NULL,
  product_id     uuid NOT NULL,
  brand_id       uuid NOT NULL,
  product_type   text NOT NULL,
  size_chart_id  uuid REFERENCES size_charts (id),
  size_label     text NOT NULL CHECK (length(size_label) BETWEEN 1 AND 12),
  rating         text NOT NULL CHECK (rating IN ('TOO_SMALL', 'OK', 'TOO_LARGE')),
  area           text CHECK (area IS NULL OR area IN
                   ('CHEST', 'WAIST', 'HIPS', 'LENGTH', 'SHOULDERS', 'SLEEVES', 'OVERALL')),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fit_feedback_order_line_uq UNIQUE (order_line_id)
);

CREATE INDEX fit_feedback_product_chart_idx ON fit_feedback (product_id, size_chart_id);
CREATE INDEX fit_feedback_user_brand_idx ON fit_feedback (user_id, brand_id);

-- Derived aggregate (no user data). flag is INSUFFICIENT below 20 events (Beta-Binomial rule).
CREATE TABLE item_fit_flags (
  product_id     uuid NOT NULL,
  size_chart_id  uuid NOT NULL REFERENCES size_charts (id),
  n_small        integer NOT NULL DEFAULT 0 CHECK (n_small >= 0),
  n_ok           integer NOT NULL DEFAULT 0 CHECK (n_ok >= 0),
  n_large        integer NOT NULL DEFAULT 0 CHECK (n_large >= 0),
  flag           text NOT NULL DEFAULT 'INSUFFICIENT'
                   CHECK (flag IN ('RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE', 'INSUFFICIENT')),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, size_chart_id),
  CONSTRAINT item_fit_flags_min_sample_chk
    CHECK (flag = 'INSUFFICIENT' OR n_small + n_ok + n_large >= 20)
);

-- Seller facing aggregate. Rows below k = 50 can not exist (k-anonymity at source, spec 19.1).
CREATE TABLE seller_size_demand_agg (
  store_id      uuid NOT NULL REFERENCES stores (id),
  product_type  text NOT NULL,
  size_label    text NOT NULL,
  week_start    date NOT NULL,
  demand_count  integer NOT NULL CHECK (demand_count >= 50),
  PRIMARY KEY (store_id, product_type, size_label, week_start)
);

-- Calibration log (ECE). Pseudonymous rotating id only, never user_id, so it can outlive a deletion.
-- Monthly partitions are created by the partition job; the default partition catches the rest.
CREATE TABLE size_recommendation_log (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  pseudonymous_id    text NOT NULL CHECK (pseudonymous_id ~ '^[0-9a-f]{16,64}$'),
  product_id         uuid NOT NULL,
  recommended_size   text NOT NULL,
  confidence         numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  model_version      text NOT NULL,
  accepted           boolean,
  outcome            text CHECK (outcome IS NULL OR outcome IN ('KEPT', 'RETURNED_SIZE', 'NONE')),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE size_recommendation_log_default PARTITION OF size_recommendation_log DEFAULT;

CREATE INDEX size_recommendation_log_product_idx ON size_recommendation_log (product_id, occurred_at);

-- RLS -------------------------------------------------------------------------
REVOKE ALL ON size_profiles, size_chart_templates, size_charts, fit_feedback, item_fit_flags,
  seller_size_demand_agg, size_recommendation_log, size_recommendation_log_default FROM PUBLIC;

-- Class A. A soft-deleted profile is hidden from the app roles (RLS.md invariant 7).
ALTER TABLE size_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON size_profiles TO app_user;
CREATE POLICY size_profiles_owner_select ON size_profiles FOR SELECT
  USING ((user_id = app_user_id() AND deleted_at IS NULL) OR app_role() = 'system');
CREATE POLICY size_profiles_owner_insert ON size_profiles FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY size_profiles_owner_update ON size_profiles FOR UPDATE
  USING ((user_id = app_user_id() AND deleted_at IS NULL) OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

-- Platform configuration, read only for the application.
ALTER TABLE size_chart_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON size_chart_templates TO app_user;
CREATE POLICY size_chart_templates_select ON size_chart_templates FOR SELECT USING (true);

-- Class B with the public-read predicate: validated charts are P0 and shown to shoppers; drafts
-- are visible to the store's own staff and platform roles only.
ALTER TABLE size_charts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON size_charts TO app_user;
CREATE POLICY size_charts_select ON size_charts FOR SELECT
  USING (
    validated
    OR store_id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'system'));
CREATE POLICY size_charts_insert ON size_charts FOR INSERT
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');

-- Class A. No seller policy exists on purpose: a store never reads who gave which feedback.
ALTER TABLE fit_feedback ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON fit_feedback TO app_user;
CREATE POLICY fit_feedback_owner_select ON fit_feedback FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY fit_feedback_owner_insert ON fit_feedback FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY fit_feedback_owner_delete ON fit_feedback FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

-- Derived aggregate: public read (no personal data), written by the aggregation job only.
ALTER TABLE item_fit_flags ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON item_fit_flags TO app_user;
CREATE POLICY item_fit_flags_select ON item_fit_flags FOR SELECT USING (true);
CREATE POLICY item_fit_flags_insert ON item_fit_flags FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY item_fit_flags_update ON item_fit_flags FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- Class B for reads, platform job for writes.
ALTER TABLE seller_size_demand_agg ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON seller_size_demand_agg TO app_user;
CREATE POLICY seller_size_demand_agg_select ON seller_size_demand_agg FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));
CREATE POLICY seller_size_demand_agg_insert ON seller_size_demand_agg FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY seller_size_demand_agg_update ON seller_size_demand_agg FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- Class C (platform only).
ALTER TABLE size_recommendation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE size_recommendation_log_default ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON size_recommendation_log TO app_user;
GRANT SELECT, INSERT ON size_recommendation_log_default TO app_user;
CREATE POLICY size_recommendation_log_select ON size_recommendation_log FOR SELECT
  USING (app_role() IN ('ops', 'system'));
CREATE POLICY size_recommendation_log_insert ON size_recommendation_log FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY size_recommendation_log_default_select ON size_recommendation_log_default FOR SELECT
  USING (app_role() IN ('ops', 'system'));
CREATE POLICY size_recommendation_log_default_insert ON size_recommendation_log_default FOR INSERT
  WITH CHECK (app_role() = 'system');
