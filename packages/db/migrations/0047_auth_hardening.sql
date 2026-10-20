-- migration: 0047_auth_hardening
-- phase: expand
--
-- Postgres storage for the auth module (spec 1, B1, B6, ASVS 5.0 L2; ADR-0030). Additive only.
--   * users gain the age fields (P2 age_band, limited_capacity) and field-encrypted P3 columns
--     (dob_ciphertext, email_ciphertext). Phone lives on identities (provider = 'phone').
--   * auth_sessions is the login session the access token's `sid` names; its refresh tokens are
--     the existing `sessions` rows (one per rotation, hash only) inside the existing family.
--   * OTP challenges and the send log keep a keyed HMAC of the phone (blind index) and an
--     envelope-encrypted phone; never a plaintext phone, never a plaintext code (HMAC hash only).
--   * Pre-account tables (OTP, age gate, nonces, passkey challenges) are system-role only.

ALTER TABLE users
  ADD COLUMN dob_ciphertext     bytea,
  ADD COLUMN email_ciphertext   bytea,
  ADD COLUMN age_band           text CHECK (age_band IS NULL OR age_band IN ('18_20', '21_plus')),
  ADD COLUMN limited_capacity   boolean NOT NULL DEFAULT false;

-- lint-allow: drop-constraint-or-index the CHECK is replaced in the same migration by a superset (adds device_mismatch)
ALTER TABLE session_families DROP CONSTRAINT session_families_revoke_reason_check;
ALTER TABLE session_families ADD CONSTRAINT session_families_revoke_reason_check
  CHECK (revoke_reason IN ('logout', 'reuse_detected', 'admin', 'deletion', 'device_mismatch'));

CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY,
  family_id    uuid NOT NULL UNIQUE REFERENCES session_families (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  device_id    uuid NOT NULL REFERENCES devices (id),
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  amr          text[] NOT NULL CHECK (cardinality(amr) >= 1),
  created_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenges (
  id               uuid PRIMARY KEY,
  phone_hash       bytea NOT NULL CHECK (length(phone_hash) = 32),
  phone_ciphertext bytea NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  device_key_hash  bytea NOT NULL CHECK (length(device_key_hash) = 32),
  salt             text NOT NULL,
  code_hash        text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  issued_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status           text NOT NULL CHECK (status IN ('pending', 'consumed', 'locked'))
);
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges (expires_at);

CREATE TABLE otp_send_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_hash  bytea NOT NULL CHECK (length(phone_hash) = 32),
  device_hash bytea NOT NULL CHECK (length(device_hash) = 32),
  sent_at     timestamptz NOT NULL
);
CREATE INDEX otp_send_log_phone_idx ON otp_send_log (phone_hash, sent_at DESC);
CREATE INDEX otp_send_log_device_idx ON otp_send_log (device_hash, sent_at DESC);

CREATE TABLE age_gate_blocks (
  key_hash      text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),  -- HMAC identifier, never a DOB
  blocked_until timestamptz NOT NULL
);

CREATE TABLE age_gate_passes (
  key_hash       text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz NOT NULL,
  age_band       text NOT NULL CHECK (age_band IN ('18_20', '21_plus')),
  dob_ciphertext bytea            -- P3, envelope-encrypted; copied to the user at sign-up, purged with the pass
);

CREATE TABLE auth_nonces (
  key_hash   text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$' OR key_hash ~ '^(apple|google):[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL
);

CREATE TABLE passkey_challenges (
  id         uuid PRIMARY KEY,
  challenge  text NOT NULL CHECK (length(challenge) BETWEEN 16 AND 256),
  purpose    text NOT NULL CHECK (purpose IN ('register', 'assert')),
  user_id    uuid REFERENCES users (id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE passkey_credentials (
  credential_id    text PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 1024),
  user_id          uuid NOT NULL REFERENCES users (id),
  public_key       text NOT NULL,
  sign_count       bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  status           text NOT NULL CHECK (status IN ('active', 'suspected_clone')),
  backup_eligible  boolean NOT NULL DEFAULT false,
  backed_up        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL
);
CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id);

-- RLS: deny by default; the application runs as app_user and elevates to `system` per transaction.
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO app_user;
CREATE POLICY auth_sessions_owner ON auth_sessions FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE passkey_credentials ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON passkey_credentials TO app_user;
CREATE POLICY passkey_credentials_owner ON passkey_credentials FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE otp_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON otp_challenges TO app_user;
CREATE POLICY otp_challenges_system ON otp_challenges FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE otp_send_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON otp_send_log TO app_user;
CREATE POLICY otp_send_log_system ON otp_send_log FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE age_gate_blocks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON age_gate_blocks TO app_user;
CREATE POLICY age_gate_blocks_system ON age_gate_blocks FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE age_gate_passes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON age_gate_passes TO app_user;
CREATE POLICY age_gate_passes_system ON age_gate_passes FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE auth_nonces ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON auth_nonces TO app_user;
CREATE POLICY auth_nonces_system ON auth_nonces FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE passkey_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON passkey_challenges TO app_user;
CREATE POLICY passkey_challenges_system ON passkey_challenges FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
