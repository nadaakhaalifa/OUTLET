-- migration: 0051_sellers_applications
-- phase: expand
--
-- Brand applications (applicant side of ADR-0031; docs/specs/sellers-module.md, master prompt 19 and B5).
-- brand_applications, brand_application_documents, brand_application_history.
--
-- Deliberate scope:
--   * applicant_id is a LOGICAL reference to seller_users (migration 0053 is another change); no FK.
--   * Personal fields (legal name, contact, signatory name and dob) live in ONE field-encrypted blob
--     (pii_enc). The national id is encrypted separately with an HMAC blind index for duplicate-claim
--     detection. Business registration numbers are plain columns (B5 public legal identity) and are
--     masked to the last four characters on the applicant view.
--   * Documents never carry a user, store or file name in object_key; the original file name is encrypted.
--   * Tenant key: app.user_id equals applicant_id with app.role = 'seller'; review staff and the system
--     role read and write through their own roles.

CREATE TABLE brand_applications (
  id                      uuid PRIMARY KEY,
  applicant_id            uuid NOT NULL,
  status                  text NOT NULL CHECK (status IN
                            ('DRAFT','SUBMITTED','AUTO_CHECKS','IN_REVIEW','NEEDS_INFO','APPROVED','REJECTED','SUSPENDED','WITHDRAWN')),
  version                 integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  brand_kind              text NOT NULL CHECK (brand_kind IN ('local','global')),
  country                 char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  brand_name              text NOT NULL CHECK (char_length(brand_name) BETWEEN 2 AND 80),
  brand_name_norm         text NOT NULL CHECK (char_length(brand_name_norm) BETWEEN 1 AND 160),
  ownership_basis         text CHECK (ownership_basis IS NULL OR ownership_basis IN
                            ('brand_owner','authorized_distributor','third_party_reseller')),
  trademark_register      text CHECK (trademark_register IS NULL OR trademark_register IN
                            ('WIPO','EUIPO','USPTO','EGYPT_TMO','OTHER_NATIONAL')),
  trademark_number        text CHECK (trademark_number IS NULL OR char_length(trademark_number) <= 40),
  trademark_owner_name    text CHECK (trademark_owner_name IS NULL OR char_length(trademark_owner_name) <= 200),
  commercial_register_no  text CHECK (commercial_register_no IS NULL OR char_length(commercial_register_no) <= 40),
  tax_card_no             text CHECK (tax_card_no IS NULL OR char_length(tax_card_no) <= 40),
  company_reg_no          text CHECK (company_reg_no IS NULL OR char_length(company_reg_no) <= 40),
  company_reg_country     char(2) CHECK (company_reg_country IS NULL OR company_reg_country ~ '^[A-Z]{2}$'),
  vat_or_tax_id           text CHECK (vat_or_tax_id IS NULL OR char_length(vat_or_tax_id) <= 40),
  website_domain          text CHECK (website_domain IS NULL OR char_length(website_domain) <= 253),
  social_handles          jsonb NOT NULL DEFAULT '{}'::jsonb,
  eta_registration        text CHECK (eta_registration IS NULL OR eta_registration IN ('unknown','registered','not_registered')),
  description_ar          text CHECK (description_ar IS NULL OR char_length(description_ar) <= 1000),
  description_en          text CHECK (description_en IS NULL OR char_length(description_en) <= 1000),
  acknowledgements        jsonb NOT NULL DEFAULT '{}'::jsonb,
  pii_enc                 bytea,
  national_id_enc         bytea,
  national_id_blind       bytea,
  domain_verification     jsonb,
  appeal_used             boolean NOT NULL DEFAULT false,
  appeal_statement        text CHECK (appeal_statement IS NULL OR char_length(appeal_statement) <= 2000),
  submitted_at            timestamptz,
  decision                text CHECK (decision IS NULL OR decision IN ('approved','rejected','needs_info')),
  decision_reason_code    text CHECK (decision_reason_code IS NULL OR char_length(decision_reason_code) <= 64),
  decision_message_ar     text CHECK (decision_message_ar IS NULL OR char_length(decision_message_ar) <= 1000),
  decision_message_en     text CHECK (decision_message_en IS NULL OR char_length(decision_message_en) <= 1000),
  decided_at              timestamptz,
  reapply_after           timestamptz,
  appeal_allowed          boolean NOT NULL DEFAULT false,
  decision_due_at         timestamptz,
  rejected_at             timestamptz,
  store_id                uuid,
  assignee_id             uuid,
  claimed_at              timestamptz,
  requested_items         jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_applications_applicant_idx ON brand_applications (applicant_id, created_at DESC, id DESC);
CREATE INDEX brand_applications_queue_idx ON brand_applications (status, submitted_at, id);
CREATE INDEX brand_applications_national_id_idx ON brand_applications (national_id_blind) WHERE national_id_blind IS NOT NULL;
-- One active application per (applicant, normalised brand name).
CREATE UNIQUE INDEX brand_applications_one_active_uq ON brand_applications (applicant_id, brand_name_norm)
  WHERE status IN ('DRAFT','SUBMITTED','AUTO_CHECKS','IN_REVIEW','NEEDS_INFO','APPROVED','SUSPENDED');

CREATE TRIGGER brand_applications_touch_updated_at_trg
  BEFORE UPDATE ON brand_applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION brand_applications_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'WITHDRAWN' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'brand application % is withdrawn', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'brand application version must not decrease' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.applicant_id <> OLD.applicant_id THEN
    RAISE EXCEPTION 'brand application ownership is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER brand_applications_guard_trg
  BEFORE UPDATE ON brand_applications FOR EACH ROW EXECUTE FUNCTION brand_applications_guard();

CREATE TABLE brand_application_documents (
  id                    uuid PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES brand_applications (id),
  applicant_id          uuid NOT NULL,
  requirement_code      text NOT NULL CHECK (char_length(requirement_code) BETWEEN 1 AND 64),
  original_filename_enc bytea,
  content_type          text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes            integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256                text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key            text NOT NULL UNIQUE CHECK (object_key ~ '^kyc/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}$'),
  upload_status         text NOT NULL DEFAULT 'awaiting_upload' CHECK (upload_status IN ('awaiting_upload','uploaded','expired')),
  scan_status           text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','error')),
  review_status         text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','accepted','rejected','unreadable')),
  review_note_public    text CHECK (review_note_public IS NULL OR char_length(review_note_public) <= 500),
  review_note_internal  text CHECK (review_note_internal IS NULL OR char_length(review_note_internal) <= 2000),
  created_at            timestamptz NOT NULL DEFAULT now(),
  uploaded_at           timestamptz
);
CREATE INDEX brand_application_documents_app_idx ON brand_application_documents (application_id, created_at, id);

CREATE TABLE brand_application_history (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES brand_applications (id),
  applicant_id    uuid NOT NULL,
  from_status     text NOT NULL,
  to_status       text NOT NULL,
  event           text NOT NULL CHECK (char_length(event) BETWEEN 1 AND 64),
  actor_type      text NOT NULL CHECK (actor_type IN ('APPLICANT','SYSTEM','ADMIN')),
  actor_id        uuid,
  reason_code     text CHECK (reason_code IS NULL OR char_length(reason_code) <= 64),
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_application_history_app_idx ON brand_application_history (application_id, occurred_at);
CREATE TRIGGER brand_application_history_immutable_trg
  BEFORE UPDATE OR DELETE ON brand_application_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- RLS: the applicant (role 'seller', app.user_id = applicant_id) sees and edits only their own rows;
-- review staff and system read and write all.
ALTER TABLE brand_applications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON brand_applications TO app_user;
CREATE POLICY brand_applications_select ON brand_applications FOR SELECT
  USING ((app_role() = 'seller' AND applicant_id = app_user_id())
    OR app_role() IN ('system', 'ops', 'trust_safety', 'super_admin'));
CREATE POLICY brand_applications_insert ON brand_applications FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() = 'system');
CREATE POLICY brand_applications_update ON brand_applications FOR UPDATE
  USING ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() IN ('system', 'ops', 'trust_safety'))
  WITH CHECK ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() IN ('system', 'ops', 'trust_safety'));

ALTER TABLE brand_application_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON brand_application_documents TO app_user;
CREATE POLICY brand_application_documents_select ON brand_application_documents FOR SELECT
  USING ((app_role() = 'seller' AND applicant_id = app_user_id())
    OR app_role() IN ('system', 'ops', 'trust_safety', 'super_admin'));
CREATE POLICY brand_application_documents_insert ON brand_application_documents FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() = 'system');
CREATE POLICY brand_application_documents_update ON brand_application_documents FOR UPDATE
  USING ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() IN ('system', 'ops', 'trust_safety'))
  WITH CHECK ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() IN ('system', 'ops', 'trust_safety'));
CREATE POLICY brand_application_documents_delete ON brand_application_documents FOR DELETE
  USING ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() = 'system');

ALTER TABLE brand_application_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON brand_application_history TO app_user;
CREATE POLICY brand_application_history_select ON brand_application_history FOR SELECT
  USING ((app_role() = 'seller' AND applicant_id = app_user_id())
    OR app_role() IN ('system', 'ops', 'trust_safety', 'super_admin'));
CREATE POLICY brand_application_history_insert ON brand_application_history FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND applicant_id = app_user_id()) OR app_role() IN ('system', 'ops', 'trust_safety'));
