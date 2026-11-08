-- migration: 0015_seller_accounts
-- phase: expand (new tables only)
-- Source: docs/data-model.md (store_members, seller_kyc_cases, kyc_documents, seller_signatories), master prompt 19 / B6,
--         docs/adr/0008 (plans, D1: prices undecided -> plan_code nullable), docs/adr/0011 (roles and contexts).
--
-- Deviations from the ERD (reviewed in the report):
--   * store_members: role_code kept; status invited|active|suspended|removed. user_id is NULL while invited; the invite is
--     bound to an HMAC blind index of the invitee's phone/email (invitee_bidx), never the contact itself. Accepting links
--     the user whose own users.phone_bidx/email_bidx equals it. strong_auth_enrolled_at/method record passkey/TOTP (DM-09).
--   * kyc_cases (ERD seller_kyc_cases) uses `state`, adds applicant_user_id (the login that owns the onboarding, which is
--     the missing seller -> user link noted in catalog StoreService) and check_results. reason_code + reason_note replace decision_reason.
--   * kyc_documents references media_assets(id) (document pointer only; contents never stored here). Per-document automatic
--     check summaries are in `checks` jsonb (no extracted text).
--   * seller_signatories keeps only the age result (age_21_plus, age_checked_at), never DOB, name or national id.
--   * seller_bank_accounts (not in the ERD) holds the payout IBAN: iban_ct (FieldCipher) + iban_bidx (HMAC) + account_name_ct.
--   * kyc_decisions (not in the ERD) is the append-only decision log; UPDATE/DELETE are revoked and refused by trigger.
--   * seller_plan_assignments: plan_code nullable until D1 (prices) is decided; no price columns.
--   * RLS: store_members = store isolation (+ one outlet_auth exception for "my memberships", see below). The seller-level
--     tables have neither store_id nor user_id (a seller exists before any store), so they are keyed through
--     kyc_cases.applicant_user_id and named <tbl>_user_isolation. State transitions and anything that
--     decides KYC are written by outlet_worker under the named job 'seller.kyc' (ADR-0011: no privileged client), through
--     <tbl>__worker_seller_kyc exception policies at the end of this file; outlet_app never writes them.

-- ---------------------------------------------------------------- store_members
CREATE TABLE store_members (
  id                        uuid PRIMARY KEY,
  store_id                  uuid NOT NULL REFERENCES stores (id),
  market_id                 text NOT NULL,
  user_id                   uuid REFERENCES users (id),
  role_code                 text NOT NULL CHECK (role_code IN ('owner', 'manager', 'catalog', 'warehouse', 'finance', 'support')),
  status                    text NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invitee_kind              text CHECK (invitee_kind IN ('phone', 'email')),
  invitee_bidx              bytea CHECK (invitee_bidx IS NULL OR length(invitee_bidx) = 32),
  invite_expires_at         timestamptz,
  invited_by                uuid REFERENCES users (id),
  accepted_at               timestamptz,
  removed_at                timestamptz,
  strong_auth_enrolled_at   timestamptz,
  strong_auth_method        text CHECK (strong_auth_method IN ('passkey', 'totp')),
  version                   int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'invited' OR (invitee_bidx IS NOT NULL AND invitee_kind IS NOT NULL AND invite_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('active', 'suspended') OR (user_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((strong_auth_enrolled_at IS NULL) = (strong_auth_method IS NULL))
);
CREATE UNIQUE INDEX store_members_store_user_uidx ON store_members (store_id, user_id) WHERE user_id IS NOT NULL AND status <> 'removed';
CREATE UNIQUE INDEX store_members_store_invitee_uidx ON store_members (store_id, invitee_bidx) WHERE status = 'invited';
CREATE INDEX store_members_user_active_idx ON store_members (user_id, store_id) WHERE status = 'active';
CREATE INDEX store_members_store_role_idx ON store_members (store_id, role_code) WHERE status = 'active';

ALTER TABLE store_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_members FORCE ROW LEVEL SECURITY;
CREATE POLICY store_members_store_isolation ON store_members
  USING (store_id = app.current_store_id() AND market_id = app.current_market_id())
  WITH CHECK (store_id = app.current_store_id() AND market_id = app.current_market_id());

-- "My memberships" (store switcher, token minting) has no store yet, so store isolation cannot serve it. Least privilege:
-- ONE read-only exception, outlet_auth only, narrowed to the caller's own ACTIVE rows (needs the narrowed user id),
-- market pinned, column-limited (no invitee_bidx, no inviter). outlet_app cannot see other stores' rows.
CREATE POLICY store_members__auth_my_memberships ON store_members FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND user_id = app.current_user_id() AND status = 'active');
-- Exactly the columns the store switcher query reads (store_id, role_code, strong_auth_enrolled_at) and filters on (user_id, status).
GRANT SELECT (store_id, user_id, role_code, status, strong_auth_enrolled_at) ON store_members TO outlet_auth;
REVOKE DELETE ON store_members FROM outlet_app;

-- ---------------------------------------------------------------- kyc_cases
CREATE TABLE kyc_cases (
  id                 uuid PRIMARY KEY,
  seller_id          uuid NOT NULL REFERENCES sellers (id),
  market_id          text NOT NULL,
  applicant_user_id  uuid NOT NULL REFERENCES users (id),
  kind               text NOT NULL DEFAULT 'onboarding' CHECK (kind IN ('onboarding', 'periodic_review')),
  state              text NOT NULL DEFAULT 'DRAFT'
                     CHECK (state IN ('DRAFT', 'SUBMITTED', 'AUTO_CHECKS', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  submitted_at       timestamptz,
  decided_at         timestamptz,
  decided_by         uuid,
  reason_code        text,
  reason_note        text,
  provider           text,
  provider_ref       text,
  check_results      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(check_results) = 'array'),
  version            int NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('SUBMITTED', 'AUTO_CHECKS', 'APPROVED', 'REJECTED', 'SUSPENDED', 'NEEDS_INFO') OR submitted_at IS NOT NULL),
  CHECK (state NOT IN ('APPROVED', 'REJECTED', 'SUSPENDED') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL))
);
CREATE UNIQUE INDEX kyc_cases_seller_onboarding_uidx ON kyc_cases (seller_id) WHERE kind = 'onboarding';
CREATE INDEX kyc_cases_queue_idx ON kyc_cases (state, submitted_at) WHERE state IN ('SUBMITTED', 'AUTO_CHECKS', 'NEEDS_INFO');
CREATE INDEX kyc_cases_applicant_idx ON kyc_cases (applicant_user_id, created_at DESC);

ALTER TABLE kyc_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY kyc_cases_user_isolation ON kyc_cases
  USING (applicant_user_id = app.current_user_id() AND market_id = app.current_market_id());
REVOKE INSERT, UPDATE, DELETE ON kyc_cases FROM outlet_app;

-- Append-only decision log: every state change of a case, with who and why.
CREATE TABLE kyc_decisions (
  id           uuid PRIMARY KEY,
  case_id      uuid NOT NULL REFERENCES kyc_cases (id),
  seller_id    uuid NOT NULL REFERENCES sellers (id),
  market_id    text NOT NULL,
  from_state   text NOT NULL,
  to_state     text NOT NULL,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('applicant', 'system', 'admin')),
  actor_id     uuid,
  reason_code  text,
  reason_note  text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_decisions_case_idx ON kyc_decisions (case_id, occurred_at);

CREATE FUNCTION kyc_decisions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'kyc_decisions is append-only'; END $$;
CREATE TRIGGER kyc_decisions_no_update BEFORE UPDATE OR DELETE ON kyc_decisions
  FOR EACH ROW EXECUTE FUNCTION kyc_decisions_immutable();
CREATE TRIGGER kyc_decisions_no_truncate BEFORE TRUNCATE ON kyc_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION kyc_decisions_immutable();
ALTER TABLE kyc_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY kyc_decisions_user_isolation ON kyc_decisions
  USING (market_id = app.current_market_id()
         AND EXISTS (SELECT 1 FROM kyc_cases c WHERE c.id = kyc_decisions.case_id AND c.applicant_user_id = app.current_user_id()));
REVOKE INSERT, UPDATE, DELETE ON kyc_decisions FROM outlet_app;

-- ---------------------------------------------------------------- kyc_documents (pointers only)
CREATE TABLE kyc_documents (
  id              uuid PRIMARY KEY,
  case_id         uuid NOT NULL REFERENCES kyc_cases (id),
  seller_id       uuid NOT NULL REFERENCES sellers (id),
  market_id       text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('commercial_register', 'tax_card', 'signatory_national_id', 'brand_authorization', 'proof_of_purchase', 'iban_letter')),
  media_asset_id  uuid NOT NULL REFERENCES media_assets (id),
  status          text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'verified', 'rejected', 'superseded')),
  checks          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  expires_on      date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, kind, media_asset_id)
);
CREATE INDEX kyc_documents_case_idx ON kyc_documents (case_id, kind);
CREATE INDEX kyc_documents_expiry_idx ON kyc_documents (expires_on) WHERE expires_on IS NOT NULL;

-- ---------------------------------------------------------------- seller_signatories (age result only)
CREATE TABLE seller_signatories (
  id              uuid PRIMARY KEY,
  seller_id       uuid NOT NULL REFERENCES sellers (id),
  market_id       text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  age_21_plus     boolean NOT NULL,
  age_checked_at  timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, user_id)
);
CREATE INDEX seller_signatories_user_idx ON seller_signatories (user_id);

-- ---------------------------------------------------------------- seller_bank_accounts (P3)
CREATE TABLE seller_bank_accounts (
  id               uuid PRIMARY KEY,
  seller_id        uuid NOT NULL REFERENCES sellers (id),
  market_id        text NOT NULL,
  iban_ct          bytea NOT NULL,
  iban_bidx        bytea NOT NULL CHECK (length(iban_bidx) = 32),
  iban_last4       text NOT NULL CHECK (iban_last4 ~ '^[A-Z0-9]{4}$'),
  account_name_ct  bytea NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX seller_bank_accounts_seller_uidx ON seller_bank_accounts (seller_id) WHERE status <> 'rejected';
CREATE INDEX seller_bank_accounts_bidx_idx ON seller_bank_accounts (market_id, iban_bidx);

-- ---------------------------------------------------------------- seller_plan_assignments (no prices, D1 undecided)
CREATE TABLE seller_plan_assignments (
  id              uuid PRIMARY KEY,
  seller_id       uuid NOT NULL REFERENCES sellers (id),
  market_id       text NOT NULL,
  plan_code       text,
  effective_from  timestamptz NOT NULL,
  assigned_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, effective_from)
);

-- ---------------------------------------------------------------- RLS for the seller-level tables
-- Visible to the applicant only (the login that owns the onboarding case). Writes (outlet_app) are allowed only while
-- the case is DRAFT or NEEDS_INFO (WITH CHECK); SELECT sees every state.
CREATE FUNCTION app.owns_kyc_seller(p_seller uuid, p_market text, p_editable boolean) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM kyc_cases c
     WHERE c.seller_id = p_seller AND c.market_id = p_market AND p_market = app.current_market_id()
       AND c.applicant_user_id = app.current_user_id()
       AND (NOT p_editable OR c.state IN ('DRAFT', 'NEEDS_INFO')))
$$;

ALTER TABLE kyc_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY kyc_documents_user_isolation ON kyc_documents
  USING (app.owns_kyc_seller(seller_id, market_id, false))
  WITH CHECK (app.owns_kyc_seller(seller_id, market_id, true));

ALTER TABLE seller_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_bank_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_bank_accounts_user_isolation ON seller_bank_accounts
  USING (app.owns_kyc_seller(seller_id, market_id, false))
  WITH CHECK (app.owns_kyc_seller(seller_id, market_id, true));

ALTER TABLE seller_plan_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_plan_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_plan_assignments_user_isolation ON seller_plan_assignments
  USING (app.owns_kyc_seller(seller_id, market_id, false));

-- seller_signatories has a user_id column: the audited shape (current_user_id) applies. The signatory is the acting user.
ALTER TABLE seller_signatories ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_signatories FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_signatories_user_isolation ON seller_signatories
  USING (user_id = app.current_user_id() AND market_id = app.current_market_id())
  WITH CHECK (user_id = app.current_user_id() AND market_id = app.current_market_id());

-- ---------------------------------------------------------------- privileges for outlet_app
REVOKE DELETE ON kyc_documents, seller_bank_accounts FROM outlet_app;
REVOKE UPDATE ON kyc_documents FROM outlet_app;
-- The 21+ result is written by the platform at submission from the user's own record; a user can never assert it.
REVOKE INSERT, UPDATE, DELETE ON seller_signatories FROM outlet_app;
REVOKE INSERT, UPDATE, DELETE ON seller_plan_assignments FROM outlet_app;
-- Replacing the IBAN during NEEDS_INFO: only the encrypted payload columns, never status/verified_at.
REVOKE UPDATE ON seller_bank_accounts FROM outlet_app;
GRANT UPDATE (iban_ct, iban_bidx, iban_last4, account_name_ct, updated_at) ON seller_bank_accounts TO outlet_app;

-- ---------------------------------------------------------------- worker job 'seller.kyc' (ADR-0011, no RLS-bypassing client)
-- Seller creation, applicant edits of legal identity, KYC state transitions, admin decisions and the first-owner bootstrap
-- run as outlet_worker with app.job() = 'seller.kyc' (market pinned). Applicant-driven calls also bind the narrowed
-- app.current_user_id(), admin and system calls do not. outlet_app keeps its read and document/IBAN-payload write paths.
CREATE POLICY kyc_cases__worker_seller_kyc ON kyc_cases FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, INSERT, UPDATE ON kyc_cases TO outlet_worker;

CREATE POLICY kyc_decisions__worker_seller_kyc ON kyc_decisions FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, INSERT ON kyc_decisions TO outlet_worker;

-- Automatic checks mark documents verified/rejected and the IBAN verified/rejected; nothing is created or deleted here.
CREATE POLICY kyc_documents__worker_seller_kyc ON kyc_documents FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, UPDATE ON kyc_documents TO outlet_worker;

CREATE POLICY seller_bank_accounts__worker_seller_kyc ON seller_bank_accounts FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, UPDATE ON seller_bank_accounts TO outlet_worker;

-- The 21+ result is written at submission by the platform from the applicant's own record, in the applicant's narrowed context.
CREATE POLICY seller_signatories__worker_seller_kyc ON seller_signatories FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, INSERT, UPDATE ON seller_signatories TO outlet_worker;

CREATE POLICY seller_plan_assignments__worker_seller_kyc ON seller_plan_assignments FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id());
GRANT SELECT, INSERT ON seller_plan_assignments TO outlet_worker;

-- First owner only: an ACTIVE owner row for the narrowed user, who must own an APPROVED onboarding case. (A "store has no
-- members" subquery on store_members itself would make the policy recurse; the service checks it and the partial unique
-- index store_members_store_user_uidx stops a duplicate for the same user.) SELECT is the same predicate; no UPDATE/DELETE grant.
CREATE POLICY store_members__worker_seller_kyc ON store_members FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'seller.kyc' AND market_id = app.current_market_id()
              AND role_code = 'owner' AND status = 'active' AND user_id = app.current_user_id()
              AND EXISTS (SELECT 1 FROM kyc_cases c WHERE c.applicant_user_id = store_members.user_id AND c.market_id = store_members.market_id
                                                       AND c.kind = 'onboarding' AND c.state = 'APPROVED'));
GRANT SELECT, INSERT ON store_members TO outlet_worker;

-- sellers has no store_id/user_id (no RLS, ADR-0010); outlet_app is read-only on it, so the job holds the writes.
GRANT SELECT, INSERT, UPDATE ON sellers TO outlet_worker;
