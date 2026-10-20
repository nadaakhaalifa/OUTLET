-- migration: 0006_identity_consent
-- phase: expand
--
-- Minimal identity and consent core (spec 2, B1, docs/data-model/auth.md and
-- privacy.md). No real personal data may be stored yet (ADR-0002 not accepted).
-- Phone, e-mail and provider subjects are P2: only blind-index hashes and
-- encrypted ciphertext columns exist. Date of birth is deliberately absent:
-- only the 18+ attestation timestamp is stored (spec B6). A P3 column is added
-- by a later expand migration once the envelope-encryption design is accepted.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  locale            text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  country           char(2) NOT NULL DEFAULT 'EG' CHECK (country ~ '^[A-Z]{2}$'),
  age_attested_18_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TRIGGER users_touch_updated_at_trg
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE identities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users (id),
  provider               text NOT NULL CHECK (provider IN ('phone', 'apple', 'google', 'passkey')),
  subject_ciphertext     bytea,            -- P2, envelope-encrypted by the application
  subject_hash           bytea NOT NULL CHECK (length(subject_hash) = 32),  -- HMAC blind index
  verified               boolean NOT NULL DEFAULT false,
  last_authenticated_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_subject_uq UNIQUE (provider, subject_hash)
);

CREATE INDEX identities_user_idx ON identities (user_id);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users (id),   -- NULL until bound
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  install_id   text NOT NULL CHECK (length(install_id) > 0),  -- random per install, P2
  attest_status text NOT NULL DEFAULT 'unknown' CHECK (attest_status IN ('unknown', 'verified', 'failed')),
  attested_at  timestamptz,
  app_version  text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_install_id_uq UNIQUE (install_id)
);

CREATE INDEX devices_user_idx ON devices (user_id, last_seen DESC);

CREATE TABLE session_families (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  device_id     uuid NOT NULL REFERENCES devices (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout', 'reuse_detected', 'admin', 'deletion')),
  CONSTRAINT session_families_revoke_chk CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

CREATE INDEX session_families_user_active_idx ON session_families (user_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES session_families (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  device_id   uuid NOT NULL REFERENCES devices (id),
  refresh_hash bytea NOT NULL CHECK (length(refresh_hash) = 32),  -- hash only, never the token
  rotation_no integer NOT NULL DEFAULT 0 CHECK (rotation_no >= 0),
  amr         text NOT NULL CHECK (amr IN ('otp', 'passkey', 'apple', 'google')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_refresh_hash_uq UNIQUE (refresh_hash),
  CONSTRAINT sessions_family_rotation_uq UNIQUE (family_id, rotation_no)
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Consent (spec B1). Purposes are the closed list from the spec. -----------
CREATE TABLE consent_text_versions (
  purpose    text NOT NULL CHECK (purpose IN (
               'marketing_push', 'marketing_whatsapp', 'marketing_email', 'analytics',
               'personalization', 'budget_insights', 'measurements', 'location_precise',
               'cross_border_ml')),
  version    integer NOT NULL CHECK (version >= 1),
  locale     text NOT NULL CHECK (locale IN ('ar', 'en')),
  body_hash  bytea NOT NULL CHECK (length(body_hash) = 32),  -- SHA-256 of the text shown
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purpose, version, locale)
);

CREATE TRIGGER consent_text_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON consent_text_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE consent_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- strict insertion order; now() ties inside one clock tick cannot decide current state
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'device')),
  subject_id    uuid NOT NULL,   -- logical FK: user or device (consent may precede registration)
  purpose       text NOT NULL CHECK (purpose IN (
                  'marketing_push', 'marketing_whatsapp', 'marketing_email', 'analytics',
                  'personalization', 'budget_insights', 'measurements', 'location_precise',
                  'cross_border_ml')),
  version       integer NOT NULL CHECK (version >= 1),
  granted       boolean NOT NULL,
  method        text NOT NULL CHECK (method IN ('onboarding', 'settings', 'prompt', 'api')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  ip_hash       text,            -- HMAC, P2
  app_version   text
);

CREATE INDEX consent_records_subject_idx
  ON consent_records (subject_type, subject_id, purpose, occurred_at DESC);

-- Append-only history: withdrawal is a new row with granted = false.
CREATE TRIGGER consent_records_immutable_trg
  BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER consent_records_no_truncate_trg
  BEFORE TRUNCATE ON consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Current state is a projection of the history. "No row" means not consented
-- (never pre-ticked). security_invoker so RLS of the caller applies.
CREATE VIEW consents_current WITH (security_invoker = true) AS
  SELECT DISTINCT ON (subject_type, subject_id, purpose)
         subject_type, subject_id, purpose, granted, version, occurred_at AS since
  FROM consent_records
  ORDER BY subject_type, subject_id, purpose, seq DESC;
