-- migration: 0003_identity
-- phase: expand (additive only)
-- Source: docs/data-model.md section 7.5 (identity, sessions and devices).
--
-- Deviations from the data model (all additive, noted for review):
--   * market_id has no FK to markets (the markets table is not built yet).
--   * Row-level security is NOT applied in this file: it ships in 0006_auth_policy_hardening
--     (FORCE RLS on user_id via app.enable_user_rls). The authorization policy itself lives in
--     packages/policy; RLS is the database backstop for it.
--   * otp_challenges is a plain table (data model: monthly RANGE partitions on id).
--   * rate_limit_hits is new: backs the Postgres RateLimiter (3 OTP / 15 min / phone,
--     10 / day / device). Keys are HMAC hex strings, never raw phone numbers.
--   * Encryption: *_ct columns hold AES-256-GCM envelopes produced behind the
--     FieldCipher port; *_bidx are HMAC-SHA256 blind indexes (BUILD-PROMPT section 4).

CREATE TABLE users (
  id                uuid PRIMARY KEY,                        -- UUIDv7
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  phone_ct          bytea,                                   -- P3 enc
  phone_bidx        bytea CHECK (phone_bidx IS NULL OR length(phone_bidx) = 32),
  email_ct          bytea,
  email_bidx        bytea,
  dob_ct            bytea,                                   -- P3 enc
  age_band          text CHECK (age_band IS NULL OR age_band IN ('under_18_blocked', '18_20', '21_plus')),
  limited_capacity  boolean NOT NULL DEFAULT false,
  display_name      text,
  locale            text NOT NULL DEFAULT 'ar-EG',
  phone_verified_at timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX users_market_phone_uq ON users (market_id, phone_bidx) WHERE phone_bidx IS NOT NULL;
CREATE UNIQUE INDEX users_market_email_uq ON users (market_id, email_bidx) WHERE email_bidx IS NOT NULL;

CREATE TABLE user_identities (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  provider      text NOT NULL CHECK (provider IN ('apple', 'google', 'phone')),
  subject_ct    bytea NOT NULL,
  subject_bidx  bytea NOT NULL,
  verified_at   timestamptz,
  last_auth_at  timestamptz,
  created_at    timestamptz NOT NULL,
  UNIQUE (provider, subject_bidx)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE devices (
  id               uuid PRIMARY KEY,
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  user_id          uuid REFERENCES users (id),               -- NULL before sign-in
  platform         text NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
  install_id_hash  bytea NOT NULL,
  ua_family        text,
  attest_status    text,
  web_push_ct      bytea,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  revoked_at       timestamptz,
  UNIQUE (install_id_hash)
);
CREATE INDEX devices_user_seen_idx ON devices (user_id, last_seen_at DESC);

CREATE TABLE otp_challenges (
  id          uuid PRIMARY KEY,
  market_id   text NOT NULL CHECK (length(market_id) > 0),
  phone_bidx  bytea NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('login', 'verify_phone', 'step_up')),
  code_hash   bytea NOT NULL,                                -- HMAC(challenge id + code); never the code
  channel     text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  provider    text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  device_id   uuid,                                          -- no FK: a challenge may precede device registration
  ip_hmac     bytea,
  created_at  timestamptz NOT NULL
);
CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone_bidx, created_at DESC);
CREATE INDEX otp_challenges_device_idx ON otp_challenges (device_id, created_at DESC);
CREATE INDEX otp_challenges_expires_idx ON otp_challenges (expires_at);

CREATE TABLE session_families (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id),
  device_id      uuid NOT NULL REFERENCES devices (id),
  amr            text[] NOT NULL,
  created_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IS NULL OR revoke_reason IN ('logout', 'reuse_detected', 'admin', 'password_change'))
);
CREATE INDEX session_families_active_idx ON session_families (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  family_id    uuid NOT NULL REFERENCES session_families (id),
  token_hash   bytea NOT NULL CHECK (length(token_hash) = 32),   -- SHA-256 of the opaque token
  rotation_no  int NOT NULL,
  issued_at    timestamptz NOT NULL,
  used_at      timestamptz,                                      -- set once; a second use is reuse
  expires_at   timestamptz NOT NULL,
  UNIQUE (token_hash),
  UNIQUE (family_id, rotation_no)
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id, rotation_no DESC);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

CREATE TABLE age_attestations (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id),
  market_id       text NOT NULL,
  attested_18_at  timestamptz NOT NULL,
  policy_version  int NOT NULL,
  method          text NOT NULL CHECK (method IN ('self_attest', 'provider_kyc')),
  created_at      timestamptz NOT NULL
);
CREATE INDEX age_attestations_user_idx ON age_attestations (user_id);

-- Under-18 soft block: only hashes, no other PII (master prompt section 1 acceptance).
CREATE TABLE age_blocks (
  id             uuid PRIMARY KEY,
  market_id      text NOT NULL CHECK (length(market_id) > 0),
  device_hash    bytea NOT NULL,
  dob_hash       bytea NOT NULL,
  blocked_until  timestamptz NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX age_blocks_device_idx ON age_blocks (device_hash, blocked_until);

CREATE TABLE rate_limit_hits (
  key     text NOT NULL,
  hit_at  timestamptz NOT NULL
);
CREATE INDEX rate_limit_hits_key_idx ON rate_limit_hits (key, hit_at);
CREATE INDEX rate_limit_hits_hit_at_idx ON rate_limit_hits (hit_at);
