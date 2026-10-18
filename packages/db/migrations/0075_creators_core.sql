-- migration: 0075_creators_core
-- phase: expand
--
-- Creators and affiliates, part 1 (docs/specs/phase-3/creators-affiliates.md, ADR-0037).
-- New tables only; nothing existing changes.
--
--   * creator_terms: the exact terms text per (version, locale). Immutable, so a creator can always
--     be shown what was accepted (same pattern as auto_buy_mandate_texts).
--   * creator_accounts: one per user. Handle is unique and lower-case. The creator's ledger
--     account is creator_payable:{user_id}. Not cascaded from users: a creator with money history
--     is pseudonymised by the erasure job, never row-deleted (spec 2, financial retention).
--   * creator_kyc: P3. Every identity and tax field is envelope-encrypted by the application
--     (bytea, key id alongside). Written and read only by the module under app.role = 'system',
--     every read carries a reason in the audit log. The tax form fields are tagged
--     VERIFY BEFORE LAUNCH (VR-P3-03): their final shape depends on Egyptian tax counsel.
--   * affiliate_links: target is a product, store or look. Slugs are unguessable. Creator-entered
--     prices do not exist anywhere in this schema (prices are read live from the catalog).
--   * creator_looks and creator_look_items: curated looks reference catalog product ids only.
--   * RLS: the owner reads their own rows; every write is the module under app.role = 'system'.

CREATE TABLE creator_terms (
  version     integer NOT NULL CHECK (version >= 1),
  locale      text NOT NULL CHECK (locale IN ('ar', 'en')),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 20000),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, locale)
);

CREATE FUNCTION creator_terms_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'creator_terms rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER creator_terms_guard_trg
  BEFORE UPDATE OR DELETE ON creator_terms
  FOR EACH ROW EXECUTE FUNCTION creator_terms_guard();

CREATE TABLE creator_accounts (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id),
  handle             text NOT NULL CHECK (handle ~ '^[a-z][a-z0-9_]{2,29}$'),
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  status             text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'ACTIVE', 'SUSPENDED', 'REJECTED')),
  kyc_state          text NOT NULL DEFAULT 'DRAFT' CHECK (kyc_state IN
                       ('DRAFT', 'SUBMITTED', 'AUTO_CHECKS', 'APPROVED', 'NEEDS_INFO', 'REJECTED')),
  terms_version      integer NOT NULL CHECK (terms_version >= 1),
  terms_accepted_at  timestamptz NOT NULL,
  payout_pref        text NOT NULL DEFAULT 'credit' CHECK (payout_pref IN ('cash', 'credit')),
  status_reason      text CHECK (status_reason IS NULL OR char_length(status_reason) <= 200),
  applied_at         timestamptz NOT NULL,
  decided_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_accounts_user_uq UNIQUE (user_id),
  CONSTRAINT creator_accounts_handle_uq UNIQUE (handle),
  CONSTRAINT creator_accounts_active_needs_kyc_started CHECK (status <> 'ACTIVE' OR kyc_state <> 'DRAFT')
);

CREATE INDEX creator_accounts_status_idx ON creator_accounts (status, applied_at);

CREATE TABLE creator_kyc (
  creator_id        uuid PRIMARY KEY REFERENCES creator_accounts (id),
  key_id            text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 128),
  legal_name_enc    bytea NOT NULL,
  national_id_enc   bytea NOT NULL,
  national_id_hash  bytea NOT NULL CHECK (length(national_id_hash) = 32),
  payout_iban_enc   bytea,
  payout_name_enc   bytea,
  -- VERIFY BEFORE LAUNCH (VR-P3-03): tax identity and form fields, shape pending Tax counsel.
  tax_id_enc        bytea,
  tax_form_enc      bytea,
  submitted_at      timestamptz NOT NULL,
  reviewed_at       timestamptz,
  reviewed_by       uuid,
  review_reason     text CHECK (review_reason IS NULL OR char_length(review_reason) <= 200)
);

-- One identity document may back one creator account only (duplicate-account control).
CREATE UNIQUE INDEX creator_kyc_national_id_uq ON creator_kyc (national_id_hash);

CREATE TABLE affiliate_links (
  id           uuid PRIMARY KEY,
  creator_id   uuid NOT NULL REFERENCES creator_accounts (id),
  target_type  text NOT NULL CHECK (target_type IN ('product', 'store', 'look')),
  target_id    uuid NOT NULL,
  slug         text NOT NULL CHECK (slug ~ '^[A-Za-z0-9_-]{10,40}$'),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz,
  CONSTRAINT affiliate_links_slug_uq UNIQUE (slug)
);

CREATE UNIQUE INDEX affiliate_links_one_active_idx
  ON affiliate_links (creator_id, target_type, target_id) WHERE status = 'ACTIVE';
CREATE INDEX affiliate_links_creator_idx ON affiliate_links (creator_id, created_at DESC);

CREATE TABLE creator_looks (
  id             uuid PRIMARY KEY,
  creator_id     uuid NOT NULL REFERENCES creator_accounts (id),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'TAKEN_DOWN', 'ARCHIVED')),
  takedown_reason text CHECK (takedown_reason IS NULL OR char_length(takedown_reason) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_looks_takedown_reason CHECK (status <> 'TAKEN_DOWN' OR takedown_reason IS NOT NULL)
);

CREATE INDEX creator_looks_creator_idx ON creator_looks (creator_id, updated_at DESC);
CREATE INDEX creator_looks_published_idx ON creator_looks (creator_id) WHERE status = 'PUBLISHED';

CREATE TABLE creator_look_items (
  look_id     uuid NOT NULL REFERENCES creator_looks (id) ON DELETE CASCADE,
  position    smallint NOT NULL CHECK (position BETWEEN 0 AND 11),
  product_id  uuid NOT NULL,
  PRIMARY KEY (look_id, position),
  CONSTRAINT creator_look_items_product_uq UNIQUE (look_id, product_id)
);

-- Row level security -------------------------------------------------------------------------
ALTER TABLE creator_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_kyc ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_looks ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_look_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON creator_terms TO app_user;
GRANT SELECT, INSERT, UPDATE ON creator_accounts, creator_kyc, affiliate_links, creator_looks TO app_user;
GRANT SELECT, INSERT, DELETE ON creator_look_items TO app_user;

CREATE POLICY creator_terms_select ON creator_terms FOR SELECT USING (true);
CREATE POLICY creator_terms_insert ON creator_terms FOR INSERT WITH CHECK (app_role() = 'system');

CREATE POLICY creator_accounts_select ON creator_accounts FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY creator_accounts_insert ON creator_accounts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY creator_accounts_update ON creator_accounts FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- KYC is never read by the owner through SQL: the module returns state only, never the fields.
CREATE POLICY creator_kyc_all ON creator_kyc FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY affiliate_links_select ON affiliate_links FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM creator_accounts a WHERE a.id = affiliate_links.creator_id AND a.user_id = app_user_id()));
CREATE POLICY affiliate_links_insert ON affiliate_links FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY affiliate_links_update ON affiliate_links FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY creator_looks_select ON creator_looks FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM creator_accounts a WHERE a.id = creator_looks.creator_id AND a.user_id = app_user_id()));
CREATE POLICY creator_looks_insert ON creator_looks FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY creator_looks_update ON creator_looks FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

CREATE POLICY creator_look_items_select ON creator_look_items FOR SELECT
  USING (app_role() = 'system' OR EXISTS (
    SELECT 1 FROM creator_looks l JOIN creator_accounts a ON a.id = l.creator_id
    WHERE l.id = creator_look_items.look_id AND a.user_id = app_user_id()));
CREATE POLICY creator_look_items_write ON creator_look_items FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY creator_look_items_delete ON creator_look_items FOR DELETE USING (app_role() = 'system');
