-- migration: 0024_auth_hardening
-- phase: expand (columns nullable or backfilled, one new table)
-- Source: security review findings 3, 6, 7 (refresh race grace window, passkey user handle, shared passkey challenge store).
--
-- 1. refresh_tokens: `successor_hash` and `grace_used_at` on the OLD row. A rotated token may be presented once more within
--    10 s (cross-instance refresh race) and gets the same successor pair back: the successor refresh token is re-derived
--    (HMAC of the predecessor hash under a server key), never stored raw; `successor_hash` is the integrity reference.
-- 2. passkey_credentials.user_handle: random WebAuthn user.id (base64url, 32 bytes), shared by all credentials of a user.
-- 3. passkey_challenges: single-use ceremony challenges shared by every API instance (TTL 5 min enforced by the store; purged by auth.purge).
--    Auth-role lookup keyed on sha256('passkey-challenge:' || id) carried in app.auth_token_hash() (a domain-separated hash that cannot
--    collide with a refresh-token or credential hash).

ALTER TABLE refresh_tokens ADD COLUMN successor_hash bytea CHECK (successor_hash IS NULL OR length(successor_hash) = 32);
ALTER TABLE refresh_tokens ADD COLUMN grace_used_at timestamptz;

ALTER TABLE passkey_credentials ADD COLUMN user_handle text;
UPDATE passkey_credentials p SET user_handle = h.handle
  FROM (SELECT user_id, md5(random()::text || user_id::text) || md5(clock_timestamp()::text || user_id::text) AS handle
          FROM (SELECT DISTINCT user_id FROM passkey_credentials) d) h
 WHERE h.user_id = p.user_id;
ALTER TABLE passkey_credentials ALTER COLUMN user_handle SET NOT NULL;
ALTER TABLE passkey_credentials ADD CONSTRAINT passkey_credentials_handle_len CHECK (length(user_handle) BETWEEN 32 AND 128);

-- Revocation (owner, user context) now also runs through the auth pool that the passkey store uses.
GRANT UPDATE (revoked_at) ON passkey_credentials TO outlet_auth;

CREATE TABLE passkey_challenges (
  id          uuid PRIMARY KEY,
  id_hash     bytea NOT NULL UNIQUE CHECK (length(id_hash) = 32),   -- sha256('passkey-challenge:' || id), written by the store
  market_id   text NOT NULL CHECK (length(market_id) > 0),
  purpose     text NOT NULL CHECK (purpose IN ('register', 'assert')),
  user_id     uuid REFERENCES users (id),                          -- registration: the enrolling user; assertion: NULL
  device_id   text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 64),
  challenge   text NOT NULL CHECK (length(challenge) BETWEEN 16 AND 512),
  user_handle text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX passkey_challenges_expires_idx ON passkey_challenges (expires_at);

SELECT app.enable_user_rls('passkey_challenges');   -- also ENABLE + FORCE RLS; the auth-role policies below are the exceptions
GRANT SELECT, INSERT, DELETE ON passkey_challenges TO outlet_auth;
GRANT SELECT, DELETE ON passkey_challenges TO outlet_worker;

CREATE POLICY passkey_challenges__auth_issue ON passkey_challenges FOR INSERT TO outlet_auth
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id());
CREATE POLICY passkey_challenges__auth_take ON passkey_challenges FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND id_hash = app.auth_token_hash());
CREATE POLICY passkey_challenges__auth_take_delete ON passkey_challenges FOR DELETE TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND id_hash = app.auth_token_hash());

CREATE POLICY passkey_challenges__worker_auth_purge ON passkey_challenges FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND expires_at < now() - interval '1 hour');
CREATE POLICY passkey_challenges__worker_auth_purge_delete ON passkey_challenges FOR DELETE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'auth.purge' AND market_id = app.current_market_id() AND expires_at < now() - interval '1 hour');
