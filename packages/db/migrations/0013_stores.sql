-- migration: 0013_stores
-- phase: expand
--
-- Stores, worlds directory, legal identity projection, favourite stores and
-- the new-since-last-visit activity feed (spec 3, 19, B5; docs/data-model/sellers.md,
-- docs/specs/stores-worlds.md). Synthetic data only until ADR-0002 is accepted.
--
-- Notes
--   * stores.seller_id is a logical reference: the sellers table belongs to the
--     sellers module migration. stores.seller_kyc_state is a denormalised cache of
--     the seller KYC state (machine in packages/domain), refreshed by the
--     ApplySellerKycEvent use case. A store is shopper-visible only when
--     status IN (ACTIVE, PAUSED) AND seller_kyc_state = APPROVED.
--   * Money is integer piastres (BIGINT) with a sibling currency column.
--   * RLS follows 0007 and packages/policy/RLS.md (class B, public-read predicate).

CREATE TABLE stores (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id                       uuid NOT NULL,
  kind                            text NOT NULL CHECK (kind IN ('local', 'global')),
  slug                            text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  name_ar                         text NOT NULL CHECK (length(btrim(name_ar)) > 0 AND length(name_ar) <= 200),
  name_en                         text CHECK (name_en IS NULL OR length(name_en) <= 200),
  description_ar                  text CHECK (description_ar IS NULL OR length(description_ar) <= 2000),
  description_en                  text CHECK (description_en IS NULL OR length(description_en) <= 2000),
  status                          text NOT NULL DEFAULT 'DRAFT'
                                    CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'SUSPENDED')),
  seller_kyc_state                text NOT NULL DEFAULT 'DRAFT'
                                    CHECK (seller_kyc_state IN
                                      ('DRAFT', 'SUBMITTED', 'AUTO_CHECKS', 'NEEDS_INFO', 'APPROVED',
                                       'REJECTED', 'SUSPENDED', 'TERMINATED')),
  health_score                    integer CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100),
  verified_badge                  boolean NOT NULL DEFAULT false,
  logo_url                        text,
  cover_url                       text,
  free_delivery_threshold_amount  bigint NOT NULL DEFAULT 200000 CHECK (free_delivery_threshold_amount >= 0),
  currency                        char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_slug_uq UNIQUE (slug)
);

CREATE INDEX stores_kind_status_idx ON stores (kind, status);
CREATE INDEX stores_seller_idx ON stores (seller_id);

CREATE TRIGGER stores_touch_updated_at_trg
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Seller staff may edit presentation fields only. Lifecycle, KYC cache, score and
-- badge belong to the platform (enforcement ladder, KYC), so a compromised or
-- careless seller session cannot un-suspend a store (spec 9.5, API5).
CREATE FUNCTION stores_guard_platform_columns() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF app_role() IS NULL OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system') THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.seller_kyc_state IS DISTINCT FROM OLD.seller_kyc_state
     OR NEW.health_score IS DISTINCT FROM OLD.health_score
     OR NEW.verified_badge IS DISTINCT FROM OLD.verified_badge
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'platform-owned store columns can only be changed by the platform'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER stores_guard_platform_columns_trg
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION stores_guard_platform_columns();

-- Derived read model for directory sorting and cards. Written by jobs and by the
-- pricing-integrity module only. max_verified_discount_pct is NEVER seller supplied.
CREATE TABLE store_directory_stats (
  store_id                   uuid PRIMARY KEY REFERENCES stores (id),
  follower_count             integer NOT NULL DEFAULT 0 CHECK (follower_count >= 0),
  max_verified_discount_pct  integer CHECK (max_verified_discount_pct IS NULL OR max_verified_discount_pct BETWEEN 5 AND 100),
  rating_avg                 numeric(3, 2) CHECK (rating_avg IS NULL OR rating_avg BETWEEN 0 AND 5),
  rating_count               integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  live_drop                  boolean NOT NULL DEFAULT false,
  trending_score             integer NOT NULL DEFAULT 0 CHECK (trending_score >= 0),
  last_drop_at               timestamptz,
  p80_delivery_hours         integer CHECK (p80_delivery_hours IS NULL OR p80_delivery_hours > 0),
  refreshed_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_directory_stats_rating_chk CHECK ((rating_avg IS NULL) = (rating_count = 0))
);

CREATE INDEX store_directory_stats_trending_idx ON store_directory_stats (trending_score DESC, store_id);

-- Published projection of seller legal identity (spec B5: shown on every listing).
-- Source of truth stays in sellers (encrypted). This row is written when the store is
-- approved and is PUBLIC by legal requirement; it holds no signatory or national-id data.
CREATE TABLE store_legal_identity_public (
  store_id               uuid PRIMARY KEY REFERENCES stores (id),
  legal_name_ar          text NOT NULL CHECK (length(btrim(legal_name_ar)) > 0),
  legal_name_en          text,
  commercial_register_no text,
  tax_card_no            text,
  governorate            text NOT NULL CHECK (length(btrim(governorate)) > 0),
  published_at           timestamptz NOT NULL DEFAULT now()
);

-- user_favorite_stores: 1 to 30 ordered favourites (spec 3). Positions 0..29 unique per
-- user make the cap a table constraint, not only an application check.
CREATE TABLE user_favorite_stores (
  user_id      uuid NOT NULL REFERENCES users (id),
  store_id     uuid NOT NULL REFERENCES stores (id),
  position     integer NOT NULL CHECK (position BETWEEN 0 AND 29),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, store_id),
  CONSTRAINT user_favorite_stores_position_uq UNIQUE (user_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX user_favorite_stores_store_idx ON user_favorite_stores (store_id);

-- Interim feed for "new since last visit". The catalog module will publish
-- product.published and drop.scheduled through the outbox; a consumer appends here.
-- Append-only: the counters are COUNT(*) WHERE occurred_at > last_seen_at.
CREATE TABLE store_activity_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores (id),
  kind        text NOT NULL CHECK (kind IN ('product_published', 'drop_scheduled')),
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_activity_events_store_time_idx ON store_activity_events (store_id, occurred_at DESC);

CREATE TRIGGER store_activity_events_immutable_trg
  BEFORE UPDATE OR DELETE ON store_activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS -------------------------------------------------------------------------
REVOKE ALL ON stores, store_directory_stats, store_legal_identity_public,
  user_favorite_stores, store_activity_events FROM PUBLIC;

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON stores TO app_user;
-- Public-read predicate for the shopper audience; staff see their own tenant; platform roles all.
CREATE POLICY stores_select ON stores FOR SELECT
  USING (
    (status IN ('ACTIVE', 'PAUSED') AND seller_kyc_state = 'APPROVED')
    OR id::text = ANY (app_store_ids())
    OR app_role() IN ('ops', 'trust_safety', 'support', 'super_admin', 'system'));
CREATE POLICY stores_insert ON stores FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'system'));
CREATE POLICY stores_update ON stores FOR UPDATE
  USING (id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'))
  WITH CHECK (id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));

ALTER TABLE store_directory_stats ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON store_directory_stats TO app_user;
CREATE POLICY store_directory_stats_select ON store_directory_stats FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = store_directory_stats.store_id)
    OR app_role() IN ('ops', 'system'));
CREATE POLICY store_directory_stats_write ON store_directory_stats FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'system'));
CREATE POLICY store_directory_stats_update ON store_directory_stats FOR UPDATE
  USING (app_role() IN ('ops', 'system'))
  WITH CHECK (app_role() IN ('ops', 'system'));

ALTER TABLE store_legal_identity_public ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON store_legal_identity_public TO app_user;
CREATE POLICY store_legal_identity_select ON store_legal_identity_public FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = store_legal_identity_public.store_id)
    OR app_role() IN ('ops', 'system'));
CREATE POLICY store_legal_identity_insert ON store_legal_identity_public FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'system'));
CREATE POLICY store_legal_identity_update ON store_legal_identity_public FOR UPDATE
  USING (app_role() IN ('ops', 'system'))
  WITH CHECK (app_role() IN ('ops', 'system'));
-- Saving a store whose legal identity is null removes the public row (never leave a stale identity).
CREATE POLICY store_legal_identity_delete ON store_legal_identity_public FOR DELETE
  USING (app_role() IN ('ops', 'system'));

-- Class A (user-owned). A store's own staff never read who favourited it; only counts.
ALTER TABLE user_favorite_stores ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_favorite_stores TO app_user;
CREATE POLICY user_favorite_stores_select ON user_favorite_stores FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_favorite_stores_insert ON user_favorite_stores FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_favorite_stores_update ON user_favorite_stores FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY user_favorite_stores_delete ON user_favorite_stores FOR DELETE
  USING (user_id = app_user_id() OR app_role() = 'system');

-- Follower counts: aggregate only, never who. RLS hides other users' rows, so the count runs as the
-- table owner via SECURITY DEFINER with a pinned search_path; callers get counts, not rows.
CREATE FUNCTION store_follower_counts() RETURNS TABLE (store_id uuid, followers bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT f.store_id, count(*)::bigint FROM user_favorite_stores f GROUP BY f.store_id
$$;
REVOKE ALL ON FUNCTION store_follower_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_follower_counts() TO app_user;

ALTER TABLE store_activity_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON store_activity_events TO app_user;
CREATE POLICY store_activity_events_select ON store_activity_events FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM stores s WHERE s.id = store_activity_events.store_id)
    OR app_role() IN ('ops', 'system'));
CREATE POLICY store_activity_events_insert ON store_activity_events FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'system'));
