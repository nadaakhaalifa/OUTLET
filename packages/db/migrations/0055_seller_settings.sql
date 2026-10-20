-- migration: 0055_seller_settings
-- phase: expand
--
-- Seller Center settings an approved brand needs to operate (docs/specs/seller-settings.md, spec 19, B5, T4):
-- store profile and legal return windows, media upload slots, payout bank account (field-encrypted IBAN
-- and holder name, 48 h cooling on replacement), shipping origin and courier preferences, seller
-- notification preferences, team invitations (hashed single-use token, 72 h TTL), ETA enrolment
-- STATUS (never credentials), and a settings audit trail. Expand only: new tables.
--
-- Notes
--   * store_id is a logical reference to stores (stores belong to the stores module).
--   * Return windows can never be below the statutory minimum (CHECK, defence in depth beside the domain rule).
--   * IBAN and account-holder name are P3 field-encrypted bytea (AAD seller-bank:<id>:<field>); only
--     iban_last4 is plain. The full IBAN is never returned by any API.
--   * RLS follows 0035: a store reads its own rows, staff roles read all, writes are the module under app.role = 'system'.

CREATE TABLE seller_store_profiles (
  store_id                       uuid PRIMARY KEY,
  display_name_ar                text NOT NULL CHECK (char_length(btrim(display_name_ar)) BETWEEN 2 AND 200),
  display_name_en                text CHECK (display_name_en IS NULL OR char_length(display_name_en) <= 200),
  description_ar                 text CHECK (description_ar IS NULL OR char_length(description_ar) <= 2000),
  description_en                 text CHECK (description_en IS NULL OR char_length(description_en) <= 2000),
  logo_key                       text CHECK (logo_key IS NULL OR logo_key LIKE 'stores/%'),
  cover_key                      text CHECK (cover_key IS NULL OR cover_key LIKE 'stores/%'),
  social_links                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  return_change_of_mind_days     smallint NOT NULL DEFAULT 14 CHECK (return_change_of_mind_days BETWEEN 14 AND 90),
  return_defect_days             smallint NOT NULL DEFAULT 30 CHECK (return_defect_days BETWEEN 30 AND 90),
  return_policy_ar               text CHECK (return_policy_ar IS NULL OR char_length(return_policy_ar) <= 2000),
  return_policy_en               text CHECK (return_policy_en IS NULL OR char_length(return_policy_en) <= 2000),
  free_delivery_threshold_amount bigint NOT NULL DEFAULT 200000 CHECK (free_delivery_threshold_amount >= 0),
  vacation_enabled               boolean NOT NULL DEFAULT false,
  vacation_until                 timestamptz,
  vacation_eta_extra_days        smallint NOT NULL DEFAULT 0 CHECK (vacation_eta_extra_days BETWEEN 0 AND 60),
  version                        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by                     uuid,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_profile_vacation_chk CHECK (NOT vacation_enabled OR vacation_until IS NOT NULL),
  CONSTRAINT seller_profile_policy_ar_chk CHECK (return_policy_en IS NULL OR return_policy_ar IS NOT NULL)
);
CREATE TRIGGER seller_store_profiles_touch_updated_at_trg
  BEFORE UPDATE ON seller_store_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE seller_media_uploads (
  id             uuid PRIMARY KEY,
  store_id       uuid NOT NULL,
  slot           text NOT NULL CHECK (slot IN ('logo', 'cover', 'product')),
  object_key     text NOT NULL UNIQUE CHECK (object_key LIKE 'stores/%'),
  content_type   text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  declared_bytes integer NOT NULL CHECK (declared_bytes > 0 AND declared_bytes <= 8000000),
  status         text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'confirmed', 'rejected', 'expired')),
  reject_code    text,
  width          integer,
  height         integer,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  confirmed_at   timestamptz
);
CREATE INDEX seller_media_uploads_store_idx ON seller_media_uploads (store_id, status, created_at);

CREATE TABLE seller_payout_accounts (
  id               uuid PRIMARY KEY,
  store_id         uuid NOT NULL,
  account_token    text NOT NULL UNIQUE CHECK (account_token ~ '^acct_[0-9a-f]{32}$'),
  iban_enc         bytea NOT NULL,
  iban_last4       text NOT NULL CHECK (iban_last4 ~ '^[0-9A-Z]{4}$'),
  holder_name_enc  bytea NOT NULL,
  legal_name_score smallint NOT NULL CHECK (legal_name_score BETWEEN 0 AND 100),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  activates_at     timestamptz NOT NULL,
  superseded_at    timestamptz,
  CONSTRAINT seller_payout_accounts_superseded_chk CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX seller_payout_accounts_one_active_uq ON seller_payout_accounts (store_id) WHERE status = 'ACTIVE';
CREATE INDEX seller_payout_accounts_store_idx ON seller_payout_accounts (store_id, created_at);

CREATE TABLE seller_shipping_profiles (
  store_id                  uuid PRIMARY KEY,
  origin_governorate_code   text NOT NULL CHECK (origin_governorate_code ~ '^EG-[A-Z]{1,3}$'),
  origin_city_code          text NOT NULL CHECK (origin_city_code ~ '^[a-z0-9-]{2,60}$'),
  origin_street             text NOT NULL CHECK (char_length(origin_street) BETWEEN 3 AND 200),
  origin_building           text CHECK (origin_building IS NULL OR char_length(origin_building) <= 40),
  origin_landmark           text NOT NULL CHECK (char_length(origin_landmark) BETWEEN 2 AND 120),
  origin_contact_name       text NOT NULL CHECK (char_length(origin_contact_name) BETWEEN 2 AND 80),
  origin_contact_phone_enc  bytea NOT NULL,
  origin_lat                double precision CHECK (origin_lat IS NULL OR origin_lat BETWEEN 22 AND 31.7),
  origin_lng                double precision CHECK (origin_lng IS NULL OR origin_lng BETWEEN 24.7 AND 36.9),
  handling_time_hours       smallint NOT NULL DEFAULT 48 CHECK (handling_time_hours BETWEEN 12 AND 168),
  courier_preferences       jsonb NOT NULL DEFAULT '{"default":["bosta"]}'::jsonb,
  packaging_options         jsonb NOT NULL DEFAULT '["standard_box"]'::jsonb,
  version                   integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by                uuid,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seller_notification_prefs (
  store_id    uuid NOT NULL,
  event_type  text NOT NULL CHECK (event_type ~ '^[a-z_]{3,40}$'),
  channel     text NOT NULL CHECK (channel IN ('in_app', 'push', 'email', 'whatsapp', 'sms')),
  enabled     boolean NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, event_type, channel)
);

CREATE TABLE seller_team_invites (
  id            uuid PRIMARY KEY,
  store_id      uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'manager', 'catalog', 'warehouse', 'finance', 'support')),
  phone_blind   bytea NOT NULL,
  phone_enc     bytea NOT NULL,
  phone_masked  text NOT NULL,
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED')),
  invited_by    uuid NOT NULL,
  responded_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  responded_at  timestamptz,
  CONSTRAINT seller_team_invites_responded_chk CHECK ((status = 'PENDING') = (responded_at IS NULL))
);
CREATE UNIQUE INDEX seller_team_invites_pending_uq ON seller_team_invites (store_id, phone_blind) WHERE status = 'PENDING';
CREATE INDEX seller_team_invites_store_idx ON seller_team_invites (store_id, status, created_at);

CREATE TABLE seller_eta_enrolments (
  store_id         uuid PRIMARY KEY,
  status           text NOT NULL DEFAULT 'not_enrolled'
                     CHECK (status IN ('not_enrolled', 'pending_verification', 'verified', 'failed', 'revoked')),
  failure_code     text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{3,60}$'),
  requested_at     timestamptz,
  last_checked_at  timestamptz,
  last_verified_at timestamptz,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seller_settings_events (
  id           uuid PRIMARY KEY,
  store_id     uuid NOT NULL,
  area         text NOT NULL CHECK (area IN ('profile', 'media', 'payout_account', 'shipping', 'notifications', 'team', 'eta')),
  kind         text NOT NULL CHECK (kind ~ '^[a-z_.]{3,60}$'),
  actor_id     uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX seller_settings_events_store_idx ON seller_settings_events (store_id, area, occurred_at);

-- Settings events are append-only evidence.
CREATE FUNCTION seller_settings_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'seller_settings_events is append-only';
END;
$$;
CREATE TRIGGER seller_settings_events_no_update_trg
  BEFORE UPDATE OR DELETE ON seller_settings_events FOR EACH ROW EXECUTE FUNCTION seller_settings_events_immutable();

-- RLS ------------------------------------------------------------------------------------------

ALTER TABLE seller_store_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_payout_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_shipping_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_team_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_eta_enrolments ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_settings_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON seller_store_profiles, seller_media_uploads, seller_payout_accounts,
  seller_shipping_profiles, seller_notification_prefs, seller_team_invites, seller_eta_enrolments TO app_user;
GRANT SELECT, INSERT ON seller_settings_events TO app_user;

CREATE POLICY seller_store_profiles_select ON seller_store_profiles FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY seller_store_profiles_insert ON seller_store_profiles FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_store_profiles_update ON seller_store_profiles FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_media_uploads_select ON seller_media_uploads FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY seller_media_uploads_insert ON seller_media_uploads FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_media_uploads_update ON seller_media_uploads FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_payout_accounts_select ON seller_payout_accounts FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY seller_payout_accounts_insert ON seller_payout_accounts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_payout_accounts_update ON seller_payout_accounts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_shipping_profiles_select ON seller_shipping_profiles FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY seller_shipping_profiles_insert ON seller_shipping_profiles FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_shipping_profiles_update ON seller_shipping_profiles FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_notification_prefs_select ON seller_notification_prefs FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY seller_notification_prefs_insert ON seller_notification_prefs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_notification_prefs_update ON seller_notification_prefs FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- Invites are read by store staff for the list; the acceptance lookup by token hash runs as 'system'.
CREATE POLICY seller_team_invites_select ON seller_team_invites FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY seller_team_invites_insert ON seller_team_invites FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_team_invites_update ON seller_team_invites FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_eta_enrolments_select ON seller_eta_enrolments FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY seller_eta_enrolments_insert ON seller_eta_enrolments FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_eta_enrolments_update ON seller_eta_enrolments FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY seller_settings_events_select ON seller_settings_events FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY seller_settings_events_insert ON seller_settings_events FOR INSERT WITH CHECK (app_role() = 'system');
