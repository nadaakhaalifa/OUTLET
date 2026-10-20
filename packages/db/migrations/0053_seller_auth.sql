-- migration: 0053_seller_auth
-- phase: expand
--
-- Seller authentication (audience seller_api; ADR-0031 decision 1 and 2). Additive only.
--   * seller_users is a separate identity from users (own id, own sessions, own strong factor). A
--     person who is also a shopper shares the phone (equal blind index) but is NOT merged:
--     shopper_user_id is a nullable link written only after the same phone passed OTP in both
--     audiences (ADR-0031, decision 1).
--   * P3 values (phone, e-mail, TOTP secret) are envelope-encrypted; lookups use keyed blind indexes.
--   * OTP, proofs and passkey challenges are pre-account tables: `system` role only (as 0047).
--   * seller_memberships are the per-store grants the policy layer reads (role per store).
--   * Everything is RLS deny by default; the application elevates to `system` per transaction.

CREATE TABLE seller_users (
  id                uuid PRIMARY KEY,
  phone_hash        bytea NOT NULL CHECK (length(phone_hash) = 32),
  phone_ciphertext  bytea NOT NULL,                       -- P3, field encrypted
  email_ciphertext  bytea,                                -- P2, field encrypted
  email_hash        bytea CHECK (email_hash IS NULL OR length(email_hash) = 32),
  locale            text NOT NULL CHECK (locale IN ('ar', 'en')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  strong_factor     boolean NOT NULL DEFAULT false,
  shopper_user_id   uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL,
  CONSTRAINT seller_users_phone_uq UNIQUE (phone_hash)
);
CREATE INDEX seller_users_shopper_idx ON seller_users (shopper_user_id) WHERE shopper_user_id IS NOT NULL;

CREATE TABLE seller_otp_challenges (
  id                uuid PRIMARY KEY,
  phone_hash        bytea NOT NULL CHECK (length(phone_hash) = 32),
  phone_ciphertext  bytea NOT NULL,
  email_ciphertext  bytea,
  locale            text NOT NULL CHECK (locale IN ('ar', 'en')),
  channel           text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  client_key_hash   bytea NOT NULL CHECK (length(client_key_hash) = 32),
  salt              text NOT NULL,
  code_hash         text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status            text NOT NULL CHECK (status IN ('pending', 'consumed', 'locked'))
);
CREATE INDEX seller_otp_challenges_expiry_idx ON seller_otp_challenges (expires_at);

CREATE TABLE seller_otp_send_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_hash  bytea NOT NULL CHECK (length(phone_hash) = 32),
  client_hash bytea NOT NULL CHECK (length(client_hash) = 32),
  prefix      text NOT NULL CHECK (prefix ~ '^[0-9]{1,8}$'),
  sent_at     timestamptz NOT NULL,
  verified    boolean NOT NULL DEFAULT false
);
CREATE INDEX seller_otp_send_log_phone_idx ON seller_otp_send_log (phone_hash, sent_at DESC);
CREATE INDEX seller_otp_send_log_client_idx ON seller_otp_send_log (client_hash, sent_at DESC);
CREATE INDEX seller_otp_send_log_prefix_idx ON seller_otp_send_log (prefix, sent_at DESC);

-- Single-use proof that the phone was just verified (5 min), required by the assert endpoints.
CREATE TABLE seller_otp_proofs (
  proof_hash     text PRIMARY KEY CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  seller_user_id uuid NOT NULL REFERENCES seller_users (id),
  otp_channel    text NOT NULL CHECK (otp_channel IN ('sms', 'whatsapp')),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

CREATE TABLE seller_passkey_challenges (
  id             uuid PRIMARY KEY,
  challenge      text NOT NULL CHECK (length(challenge) BETWEEN 16 AND 256),
  purpose        text NOT NULL CHECK (purpose IN ('register', 'assert')),
  seller_user_id uuid REFERENCES seller_users (id),
  otp_channel    text CHECK (otp_channel IS NULL OR otp_channel IN ('sms', 'whatsapp')),
  expires_at     timestamptz NOT NULL
);

CREATE TABLE seller_passkey_credentials (
  credential_id   text PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 1024),
  seller_user_id  uuid NOT NULL REFERENCES seller_users (id),
  public_key      text NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  status          text NOT NULL CHECK (status IN ('active', 'suspected_clone')),
  backup_eligible boolean NOT NULL DEFAULT false,
  backed_up       boolean NOT NULL DEFAULT false,
  label           text CHECK (label IS NULL OR length(label) <= 60),
  created_at      timestamptz NOT NULL
);
CREATE INDEX seller_passkey_credentials_user_idx ON seller_passkey_credentials (seller_user_id);

CREATE TABLE seller_totp (
  seller_user_id    uuid PRIMARY KEY REFERENCES seller_users (id),
  secret_ciphertext bytea NOT NULL,                       -- P3, field encrypted (AAD seller_totp.secret)
  status            text NOT NULL CHECK (status IN ('pending', 'active')),
  last_used_step    bigint CHECK (last_used_step IS NULL OR last_used_step >= 0),
  failed_count      integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  lock_count        integer NOT NULL DEFAULT 0 CHECK (lock_count >= 0),
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL,
  confirmed_at      timestamptz
);

CREATE TABLE seller_recovery_codes (
  seller_user_id uuid NOT NULL REFERENCES seller_users (id),
  code_hash      text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at        timestamptz,
  PRIMARY KEY (seller_user_id, code_hash)
);

CREATE TABLE seller_sessions (
  id             uuid PRIMARY KEY,
  seller_user_id uuid NOT NULL REFERENCES seller_users (id),
  kind           text NOT NULL CHECK (kind IN ('enrol', 'full')),
  restricted     boolean NOT NULL DEFAULT false,          -- enrol token of an identity that already has a strong factor
  install_id     text NOT NULL CHECK (length(install_id) BETWEEN 1 AND 64),
  amr            text[] NOT NULL CHECK (cardinality(amr) >= 1),
  strong_at      timestamptz,                             -- when the strong factor was asserted (step-up clock)
  created_at     timestamptz NOT NULL,
  last_used_at   timestamptz NOT NULL,
  expires_at     timestamptz,                             -- enrol sessions only
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('logout', 'user_revoked', 'reuse_detected', 'device_mismatch', 'upgraded', 'clone_suspected', 'admin')),
  CONSTRAINT seller_sessions_revoke_chk CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT seller_sessions_full_strong_chk CHECK (kind <> 'full' OR strong_at IS NOT NULL)
);
CREATE INDEX seller_sessions_user_idx ON seller_sessions (seller_user_id) WHERE revoked_at IS NULL;

CREATE TABLE seller_refresh_tokens (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES seller_sessions (id),
  refresh_hash  bytea NOT NULL CHECK (length(refresh_hash) = 32),
  rotation_no   integer NOT NULL CHECK (rotation_no >= 0),
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT seller_refresh_hash_uq UNIQUE (refresh_hash),
  CONSTRAINT seller_refresh_rotation_uq UNIQUE (session_id, rotation_no)
);

-- store_id is validated by the provisioning use case (no FK: the store row is created in the same
-- transaction by a different module and the module boundary forbids reaching into its table).
CREATE TABLE seller_memberships (
  id             uuid PRIMARY KEY,
  seller_user_id uuid NOT NULL REFERENCES seller_users (id),
  store_id       uuid NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'manager', 'catalog', 'warehouse', 'finance', 'support')),
  granted_by     uuid,                                    -- seller_users.id, or null for the system (provisioning)
  created_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX seller_memberships_active_uq ON seller_memberships (seller_user_id, store_id) WHERE revoked_at IS NULL;
CREATE INDEX seller_memberships_store_idx ON seller_memberships (store_id) WHERE revoked_at IS NULL;

CREATE TABLE seller_staff_invites (
  id               uuid PRIMARY KEY,
  store_id         uuid NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner', 'manager', 'catalog', 'warehouse', 'finance', 'support')),
  phone_hash       bytea NOT NULL CHECK (length(phone_hash) = 32),
  phone_ciphertext bytea NOT NULL,                        -- P3
  invited_by       uuid NOT NULL REFERENCES seller_users (id),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  revoked_at       timestamptz
);
CREATE UNIQUE INDEX seller_staff_invites_open_uq ON seller_staff_invites (store_id, phone_hash)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX seller_staff_invites_phone_idx ON seller_staff_invites (phone_hash) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- RLS: deny by default; every statement runs as the `system` role (auth flows precede any actor).
ALTER TABLE seller_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_users TO app_user;
CREATE POLICY seller_users_system ON seller_users FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_otp_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_otp_challenges TO app_user;
CREATE POLICY seller_otp_challenges_system ON seller_otp_challenges FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_otp_send_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_otp_send_log TO app_user;
CREATE POLICY seller_otp_send_log_system ON seller_otp_send_log FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_otp_proofs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_otp_proofs TO app_user;
CREATE POLICY seller_otp_proofs_system ON seller_otp_proofs FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_passkey_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_passkey_challenges TO app_user;
CREATE POLICY seller_passkey_challenges_system ON seller_passkey_challenges FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_passkey_credentials ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_passkey_credentials TO app_user;
CREATE POLICY seller_passkey_credentials_system ON seller_passkey_credentials FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_totp ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_totp TO app_user;
CREATE POLICY seller_totp_system ON seller_totp FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_recovery_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_recovery_codes TO app_user;
CREATE POLICY seller_recovery_codes_system ON seller_recovery_codes FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_sessions TO app_user;
CREATE POLICY seller_sessions_system ON seller_sessions FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_refresh_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_refresh_tokens TO app_user;
CREATE POLICY seller_refresh_tokens_system ON seller_refresh_tokens FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_memberships ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_memberships TO app_user;
CREATE POLICY seller_memberships_system ON seller_memberships FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
ALTER TABLE seller_staff_invites ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON seller_staff_invites TO app_user;
CREATE POLICY seller_staff_invites_system ON seller_staff_invites FOR ALL
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
