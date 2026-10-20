-- migration: 0027_tax_eta
-- phase: expand
--
-- Tax engine and ETA e-invoice / e-receipt submission queue (spec B4, docs/specs/tax-eta.md).
-- Expand only: new tables. NO ledger postings and NO live ETA calls originate here; documents
-- and submissions are bookkeeping that an adapter later sends to ETA.
--
--   * tax_categories        VAT rate per category (14% default) plus an admin-editable exemption.
--   * tax_exemption_audit   append-only audit of every exemption change (before/after, reason).
--   * tax_documents         immutable issued documents (seller e-invoice, shopper e-receipt,
--                           delegated seller goods receipt). Arabic text is mandatory (CHECK).
--   * eta_submissions       one queue row per document: QUEUED/SUBMITTED/ACCEPTED/REJECTED/RETRY/DEAD_LETTER.
--   * eta_signed_documents  the signed document returned by ETA, kept for the retention period.
--   * signing_delegations   seller-granted delegated signing (reference only, never the secret).
--
-- Money is BIGINT piastres. user_id is a real FK; store_id is a logical reference (stores belong
-- to another module). Depends on 0001-0011. RLS: finance/ops/super_admin read everything, a store
-- reads its own documents, a shopper reads own receipts, writes are `system` (the module adapter).

CREATE TABLE tax_categories (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_ar     text NOT NULL CHECK (name_ar ~ '[؀-ۿ]'),
  name_en     text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 200),
  rate_bps    integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  exemption   jsonb CHECK (exemption IS NULL OR jsonb_typeof(exemption) = 'object'),
  version     integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tax_categories_touch_updated_at_trg
  BEFORE UPDATE ON tax_categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

INSERT INTO tax_categories (code, name_ar, name_en, rate_bps) VALUES
  ('standard',        'سلع وخدمات خاضعة للضريبة العادية', 'Standard rated goods and services', 1400),
  ('marketplace_fee', 'عمولات ورسوم المنصة',              'Marketplace commission and fees',    1400),
  ('shipping',        'رسوم الشحن والتوصيل',              'Delivery fees',                      1400),
  ('subscription',    'اشتراك Z-OUTLET Plus',             'Plus subscription',                  1400),
  ('gift_card',       'بطاقات الهدايا',                   'Gift cards',                         1400);

CREATE TABLE tax_exemption_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_code   text NOT NULL REFERENCES tax_categories (code),
  actor_id        uuid NOT NULL,
  action          text NOT NULL CHECK (action IN ('exemption_set', 'exemption_cleared')),
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  before_value    jsonb,
  after_value     jsonb,
  version_before  integer NOT NULL,
  version_after   integer NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_exemption_audit_version_uq UNIQUE (category_code, version_after)
);

CREATE TRIGGER tax_exemption_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON tax_exemption_audit FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE tax_documents (
  id                 uuid PRIMARY KEY,
  internal_id        text NOT NULL CHECK (internal_id ~ '^[A-Za-z0-9_.:-]{1,90}$'),
  kind               text NOT NULL CHECK (kind IN ('seller_einvoice', 'shopper_ereceipt', 'seller_goods_ereceipt')),
  source_ref         text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  store_id           uuid,
  user_id            uuid REFERENCES users (id),
  issuer_name_ar     text NOT NULL CHECK (issuer_name_ar ~ '[؀-ۿ]'),
  recipient_name_ar  text NOT NULL CHECK (recipient_name_ar ~ '[؀-ۿ]'),
  net_amount         bigint NOT NULL CHECK (net_amount >= 0),
  vat_amount         bigint NOT NULL CHECK (vat_amount >= 0),
  gross_amount       bigint NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  document           jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  issued_at          timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_documents_balance_chk CHECK (net_amount + vat_amount = gross_amount),
  CONSTRAINT tax_documents_internal_id_uq UNIQUE (internal_id),
  CONSTRAINT tax_documents_source_uq UNIQUE (kind, source_ref, version),
  CONSTRAINT tax_documents_party_chk CHECK (
    (kind = 'shopper_ereceipt' AND user_id IS NOT NULL)
    OR (kind IN ('seller_einvoice', 'seller_goods_ereceipt') AND store_id IS NOT NULL))
);

CREATE INDEX tax_documents_store_idx ON tax_documents (store_id, issued_at DESC, id) WHERE store_id IS NOT NULL;
CREATE INDEX tax_documents_user_idx ON tax_documents (user_id, issued_at DESC, id) WHERE user_id IS NOT NULL;
CREATE INDEX tax_documents_issued_idx ON tax_documents (issued_at, id);

CREATE TRIGGER tax_documents_append_only_trg
  BEFORE UPDATE OR DELETE ON tax_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE eta_submissions (
  document_id          uuid PRIMARY KEY REFERENCES tax_documents (id),
  internal_id          text NOT NULL UNIQUE,
  state                text NOT NULL DEFAULT 'QUEUED'
                         CHECK (state IN ('QUEUED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'RETRY', 'DEAD_LETTER')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts         integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_submitted_at    timestamptz,
  last_error           text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  eta_uuid             text,
  signed_document_ref  text,
  rejection_reasons    jsonb,
  version              integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  CONSTRAINT eta_submissions_accepted_chk CHECK (state <> 'ACCEPTED' OR eta_uuid IS NOT NULL)
);

CREATE INDEX eta_submissions_due_idx ON eta_submissions (next_attempt_at) WHERE state IN ('QUEUED', 'RETRY');
CREATE INDEX eta_submissions_poll_idx ON eta_submissions (last_submitted_at) WHERE state = 'SUBMITTED';
CREATE INDEX eta_submissions_state_idx ON eta_submissions (state, created_at);

CREATE TRIGGER eta_submissions_touch_updated_at_trg
  BEFORE UPDATE ON eta_submissions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE eta_signed_documents (
  ref           text PRIMARY KEY CHECK (char_length(ref) BETWEEN 1 AND 200),
  internal_id   text NOT NULL REFERENCES eta_submissions (internal_id),
  content_type  text NOT NULL CHECK (char_length(content_type) <= 100),
  body          text NOT NULL,
  sha256        char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  stored_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER eta_signed_documents_append_only_trg
  BEFORE UPDATE OR DELETE ON eta_signed_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE signing_delegations (
  store_id     uuid PRIMARY KEY,
  active       boolean NOT NULL,
  signing_ref  text NOT NULL CHECK (char_length(signing_ref) BETWEEN 1 AND 200),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER signing_delegations_touch_updated_at_trg
  BEFORE UPDATE ON signing_delegations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS ------------------------------------------------------------------------------------
ALTER TABLE tax_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON tax_categories TO app_user;
CREATE POLICY tax_categories_select ON tax_categories FOR SELECT
  USING (app_role() IS NOT NULL);
CREATE POLICY tax_categories_update ON tax_categories FOR UPDATE
  USING (app_role() IN ('finance', 'super_admin', 'system'))
  WITH CHECK (app_role() IN ('finance', 'super_admin', 'system'));

ALTER TABLE tax_exemption_audit ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON tax_exemption_audit TO app_user;
CREATE POLICY tax_exemption_audit_select ON tax_exemption_audit FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'dpo', 'security', 'super_admin', 'system'));
CREATE POLICY tax_exemption_audit_insert ON tax_exemption_audit FOR INSERT
  WITH CHECK (app_role() IN ('finance', 'super_admin', 'system'));

ALTER TABLE tax_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON tax_documents TO app_user;
CREATE POLICY tax_documents_select ON tax_documents FOR SELECT
  USING (user_id = app_user_id()
         OR store_id::text = ANY (app_store_ids())
         OR app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY tax_documents_insert ON tax_documents FOR INSERT
  WITH CHECK (app_role() = 'system');

ALTER TABLE eta_submissions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON eta_submissions TO app_user;
CREATE POLICY eta_submissions_select ON eta_submissions FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system')
         OR EXISTS (SELECT 1 FROM tax_documents d WHERE d.id = eta_submissions.document_id
                      AND (d.user_id = app_user_id() OR d.store_id::text = ANY (app_store_ids()))));
CREATE POLICY eta_submissions_insert ON eta_submissions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY eta_submissions_update ON eta_submissions FOR UPDATE
  USING (app_role() IN ('system', 'finance')) WITH CHECK (app_role() IN ('system', 'finance'));

ALTER TABLE eta_signed_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON eta_signed_documents TO app_user;
CREATE POLICY eta_signed_documents_select ON eta_signed_documents FOR SELECT
  USING (app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY eta_signed_documents_insert ON eta_signed_documents FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE signing_delegations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON signing_delegations TO app_user;
CREATE POLICY signing_delegations_select ON signing_delegations FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('finance', 'super_admin', 'system'));
CREATE POLICY signing_delegations_insert ON signing_delegations FOR INSERT
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY signing_delegations_update ON signing_delegations FOR UPDATE
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system')
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
