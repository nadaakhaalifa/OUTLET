-- migration: 0020_passkeys
-- phase: expand (new table only)
-- Source: master prompt section 1 (passkeys), T5 (passkeys mandatory for sellers and admins); apps/api WebAuthnPasskeys.
--
-- Tenancy: user-isolated (FORCE RLS on user_id via app.enable_user_rls) for enrolment, listing and revocation.
-- Pre-auth assertion: a discoverable-credential sign-in knows only the credential id, not the user. The auth-role exception policies
-- find the row by app.auth_token_hash() (the existing outlet_auth lookup key; db/src stays unchanged) carrying
-- sha256('passkey:' || credential_id) computed by the store, i.e. a domain-separated hash that cannot collide with a refresh-token hash. The raw credential id
-- is never a context value. Both policies are pinned to ctx 'auth' and app.current_market_id().
-- Counter rule (enforced by the store, not here): strictly increasing, except an authenticator that never counts (0 -> 0).

CREATE TABLE passkey_credentials (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id),
  market_id          text NOT NULL CHECK (length(market_id) > 0),
  credential_id      text NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 1 AND 1024),
  credential_id_hash bytea NOT NULL CHECK (length(credential_id_hash) = 32),   -- sha256('passkey:' || credential_id), written by the store (convert_to is not immutable, so no generated column)
  public_key         bytea NOT NULL,
  counter            bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports         text[] NOT NULL DEFAULT '{}',
  aaguid             text,
  backed_up          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL,
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id) WHERE revoked_at IS NULL;
CREATE INDEX passkey_credentials_hash_idx ON passkey_credentials (credential_id_hash);

SELECT app.enable_user_rls('passkey_credentials');

GRANT SELECT, INSERT ON passkey_credentials TO outlet_auth;
GRANT UPDATE (counter, last_used_at) ON passkey_credentials TO outlet_auth;
GRANT SELECT ON passkey_credentials TO outlet_app;
GRANT UPDATE (revoked_at) ON passkey_credentials TO outlet_app;

CREATE POLICY passkey_credentials__auth_lookup ON passkey_credentials FOR SELECT TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND revoked_at IS NULL AND credential_id_hash = app.auth_token_hash());
CREATE POLICY passkey_credentials__auth_use ON passkey_credentials FOR UPDATE TO outlet_auth
  USING (app.ctx() = 'auth' AND market_id = app.current_market_id() AND revoked_at IS NULL AND credential_id_hash = app.auth_token_hash())
  WITH CHECK (app.ctx() = 'auth' AND market_id = app.current_market_id());
