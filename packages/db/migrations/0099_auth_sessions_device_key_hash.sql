-- migration: 0099_auth_sessions_device_key_hash
-- phase: expand
--
-- Recycled-number step-up (VR-GUEST-06, docs/specs/guest-browsing.md): "known device" must not rest on the
-- client-supplied install_id alone. auth_sessions records the keyed hash (HMAC blind index, same function as
-- otp_challenges.device_key_hash) of the ATTESTED device key the session was opened from.
--
--   * Nullable, no default, no rewrite. Sessions created before this migration keep NULL and are treated as
--     NOT a known device (fail closed), so an old session cannot suppress the step-up.
-- Privacy: P2 hashed identifier, see data_inventory.yaml (auth_sessions.device_key_hash). Retention follows
--   auth_sessions (auth_credentials); purging a row removes the step-up evidence too.
-- Rollback: ALTER TABLE auth_sessions DROP COLUMN device_key_hash (every step-up then fires for stale accounts).

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS device_key_hash bytea;
