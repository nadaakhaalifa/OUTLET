-- 0052 brand verification (ADR-0031, docs/specs/brand-verification.md): domain ownership proof, trademark
-- evidence, sanctions screening results, auto-check reports, duplicate-claim registry and conflicts.
-- Additive only. application_id is a plain uuid with NO foreign key (the sellers module owns applications).
-- All access is through the API as role 'system'. PII: trademark owner names (P2, legal entities).

CREATE TABLE bv_domain_verifications (
  application_id  uuid PRIMARY KEY,
  applicant_id    uuid NOT NULL,
  domain          text NOT NULL CHECK (domain ~ '^[a-z0-9.-]{3,253}$'),
  method          text NOT NULL CHECK (method IN ('dns_txt', 'email')),
  status          text NOT NULL CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  nonce           text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  email_local     text CHECK (email_local IN ('admin', 'info', 'webmaster', 'hostmaster')),
  email_code_hash text CHECK (email_code_hash IS NULL OR email_code_hash ~ '^[0-9a-f]{64}$'),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at      timestamptz NOT NULL,
  verified_at     timestamptz,
  version         integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  CHECK (method = 'email' OR (email_local IS NULL AND email_code_hash IS NULL))
);
CREATE INDEX bv_domain_verifications_domain_idx ON bv_domain_verifications (domain) WHERE status = 'verified';

CREATE TABLE bv_claims (
  application_id       uuid PRIMARY KEY,
  applicant_id         uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('local', 'global')),
  country              text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  brand_name_norm      text NOT NULL CHECK (length(brand_name_norm) BETWEEN 1 AND 200),
  claim_domain         text,
  trademark_key        text,
  domain_verified_at   timestamptz,
  trademark_matched_at timestamptz,
  submitted_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bv_claims_country_idx ON bv_claims (country);
CREATE INDEX bv_claims_domain_idx ON bv_claims (claim_domain) WHERE claim_domain IS NOT NULL;
CREATE INDEX bv_claims_trademark_idx ON bv_claims (trademark_key) WHERE trademark_key IS NOT NULL;

CREATE TABLE bv_claim_conflicts (
  id                    uuid PRIMARY KEY,
  conflict_key          text NOT NULL UNIQUE CHECK (length(conflict_key) BETWEEN 36 AND 2000),
  application_ids       uuid[] NOT NULL CHECK (cardinality(application_ids) >= 2),
  reasons               text[] NOT NULL,
  status                text NOT NULL CHECK (status IN ('open', 'resolved')),
  outcome               text CHECK (outcome IN ('keep_first', 'replace_with_this', 'both_valid', 'reject_all')),
  winner_application_id uuid,
  resolved_by           uuid,
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (outcome IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX bv_claim_conflicts_apps_idx ON bv_claim_conflicts USING gin (application_ids);

CREATE TABLE bv_trademark_lookups (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('registry', 'manual')),
  office          text NOT NULL CHECK (office IN ('WIPO', 'EUIPO', 'USPTO', 'EGYPT-IP', 'OTHER')),
  register_number text NOT NULL CHECK (length(register_number) BETWEEN 1 AND 64),
  found           boolean NOT NULL,
  owner_name      text CHECK (owner_name IS NULL OR length(owner_name) <= 300),
  mark_text       text CHECK (mark_text IS NULL OR length(mark_text) <= 300),
  mark_classes    integer[] NOT NULL DEFAULT '{}',
  mark_status     text CHECK (mark_status IN ('registered', 'pending', 'expired', 'cancelled', 'unknown')),
  registered_on   date,
  expires_on      date,
  owner_score     integer CHECK (owner_score BETWEEN 0 AND 100),
  owner_band      text CHECK (owner_band IN ('match', 'weak', 'mismatch')),
  recorded_by     uuid,
  retrieved_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bv_trademark_lookups_app_idx ON bv_trademark_lookups (application_id, created_at DESC);

CREATE TABLE bv_screenings (
  id               uuid PRIMARY KEY,
  application_id   uuid NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('clear', 'warn', 'fail', 'error')),
  matched_list_ids text[] NOT NULL DEFAULT '{}',
  list_version     text NOT NULL CHECK (length(list_version) BETWEEN 1 AND 64),
  screened_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bv_screenings_app_idx ON bv_screenings (application_id, created_at DESC);

CREATE TABLE bv_auto_check_reports (
  id                     uuid PRIMARY KEY,
  application_id         uuid NOT NULL,
  risk                   text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  dual_approval_required boolean NOT NULL,
  report                 jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bv_auto_check_reports_app_idx ON bv_auto_check_reports (application_id, created_at DESC);

CREATE TABLE bv_history (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL,
  actor_id        uuid,
  action          text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  ref_id          uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bv_history_app_idx ON bv_history (application_id, created_at);

ALTER TABLE bv_domain_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_claim_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_trademark_lookups ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_auto_check_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bv_history ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON bv_domain_verifications TO app_user;
GRANT SELECT, INSERT, UPDATE ON bv_claims TO app_user;
GRANT SELECT, INSERT, UPDATE ON bv_claim_conflicts TO app_user;
GRANT SELECT, INSERT ON bv_trademark_lookups TO app_user;
GRANT SELECT, INSERT ON bv_screenings TO app_user;
GRANT SELECT, INSERT ON bv_auto_check_reports TO app_user;
GRANT SELECT, INSERT ON bv_history TO app_user;

CREATE POLICY bv_domain_verifications_select ON bv_domain_verifications FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_domain_verifications_insert ON bv_domain_verifications FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_domain_verifications_update ON bv_domain_verifications FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY bv_claims_select ON bv_claims FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_claims_insert ON bv_claims FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_claims_update ON bv_claims FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY bv_claim_conflicts_select ON bv_claim_conflicts FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_claim_conflicts_insert ON bv_claim_conflicts FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_claim_conflicts_update ON bv_claim_conflicts FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY bv_trademark_lookups_select ON bv_trademark_lookups FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_trademark_lookups_insert ON bv_trademark_lookups FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_screenings_select ON bv_screenings FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_screenings_insert ON bv_screenings FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_auto_check_reports_select ON bv_auto_check_reports FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_auto_check_reports_insert ON bv_auto_check_reports FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY bv_history_select ON bv_history FOR SELECT USING (app_role() = 'system');
CREATE POLICY bv_history_insert ON bv_history FOR INSERT WITH CHECK (app_role() = 'system');

-- Evidence and history are append-only.
CREATE TRIGGER bv_trademark_lookups_no_mutation_trg BEFORE UPDATE OR DELETE ON bv_trademark_lookups FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bv_screenings_no_mutation_trg BEFORE UPDATE OR DELETE ON bv_screenings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bv_auto_check_reports_no_mutation_trg BEFORE UPDATE OR DELETE ON bv_auto_check_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bv_history_no_mutation_trg BEFORE UPDATE OR DELETE ON bv_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
