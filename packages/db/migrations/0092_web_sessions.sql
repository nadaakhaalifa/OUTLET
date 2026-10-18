-- migration: 0092_web_sessions
-- phase: expand
--
-- Admin web sign-in (docs/specs/dashboard-foundations.md track 1, "Session binding for admin-web", H1;
-- ADR-0048 decision 6; closes the technical part of VR-AC-02). Additive and expand-only:
--
--   * devices.platform and auth_sessions.platform admit 'web'. The CHECK is swapped for a superset:
--     the new constraint is added NOT VALID (catalog only) and then validated; existing rows already
--     satisfy it, so VALIDATE cannot fail on current data.
--   * auth_sessions.uv records that the session was opened by a passkey assertion whose verifier
--     checked user verification. Default false; only the passkey path sets it true.
--   * devices.install_secret_hash is the SHA-256 (32 bytes) of the server-minted browser install
--     token. Only 'web' rows carry it; the token itself is never stored (P2 device identifier hash).
--     install_id of a 'web' row is a server-minted UUID, never client supplied.
-- Rollback: drop the three additions; no data migration is involved.

-- lint-allow: drop-constraint-or-index the CHECK is replaced in the same migration by a superset (adds 'web')
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('ios', 'android', 'web')) NOT VALID;
ALTER TABLE devices VALIDATE CONSTRAINT devices_platform_check;

-- lint-allow: drop-constraint-or-index the CHECK is replaced in the same migration by a superset (adds 'web')
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_platform_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_platform_check
  CHECK (platform IN ('ios', 'android', 'web')) NOT VALID;
ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_platform_check;

ALTER TABLE auth_sessions ADD COLUMN uv boolean NOT NULL DEFAULT false;

ALTER TABLE devices
  ADD COLUMN install_secret_hash bytea
    CONSTRAINT devices_install_secret_hash_len_chk CHECK (install_secret_hash IS NULL OR length(install_secret_hash) = 32);

-- Only web rows may carry an install-token hash.
ALTER TABLE devices ADD CONSTRAINT devices_install_secret_web_only_chk
  CHECK (install_secret_hash IS NULL OR platform = 'web') NOT VALID;
ALTER TABLE devices VALIDATE CONSTRAINT devices_install_secret_web_only_chk;
