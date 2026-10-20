# Spec: auth in production (Postgres stores, token service, providers)

Status: Implemented, with the open items listed at the end · Date: 2026-10-11 · Spec refs: master prompt section 1 (identity), B1, B6, T5; ASVS 5.0 L2 · ADR: 0030 · Threat model: `docs/security/threat-models/01-identity.md` · Code: `apps/api/src/modules/auth`, `packages/auth-core`, `packages/db/migrations/0047_auth_hardening.sql`

## Flow
1. `POST /v1/auth/age-gate` (attested device): DOB evaluated in Cairo time. Under 18 returns 403 `age_blocked` and blocks three HMAC identifiers for 30 days. Otherwise a 24 h pass is stored with the age band and the DOB encrypted.
2. Phone: `POST /v1/auth/otp/request` then `POST /v1/auth/otp/verify`. Apple, Google: `POST /v1/auth/apple|google`. Passkey: `POST /v1/auth/passkey/assert/options` then `POST /v1/auth/passkey/assert` (registration needs a session: `.../register/options`, `.../register`).
3. Each success opens a session: `auth_sessions` row (sid), a refresh family and the first refresh token (`sessions` row), and returns `{access_token (EdDSA JWT, 10 min), refresh_token (opaque, 30 d)}`.
4. `POST /v1/auth/refresh` rotates; `DELETE /v1/me/sessions/{id}` revokes; `GET /v1/me` returns the profile summary.

## Rules
| Rule | Value |
|---|---|
| Access token | JWT EdDSA, `typ at+jwt`, `kid`, `aud` buyer_api / seller_api / admin_api, `amr`, `sid`, lifetime <= 10 min |
| Refresh token | 256-bit random, stored as SHA-256, device bound, 30 days, rotated on every use, reuse or device mismatch revokes the family and notifies the user |
| OTP | 6 digits, 5 min, 5 attempts, HMAC(pepper, phone, salt, code) stored, 3 sends / 15 min / phone, 10 / day / device, resend backoff 30 s doubling to 15 min, calling code allow-list `20`, SMS then WhatsApp failover |
| Age | >= 18 to register; 18 to 20 `limited_capacity = true`, `age_band = 18_20`; 21+ `21_plus`; under 18 no account, 30 day soft block on device key, device id hash and DOB (all keyed HMAC) |
| Passkey | UP and UV required, challenge single use 5 min, counter regression = `suspected_clone` + revoke all sessions, BE immutable |
| Social | RS256 only, issuer / audience / expiry / nonce checked, nonce consumed once, JWKS from fixed hosts only |
| `GET /v1/me` | `{id, locale, age_band, limited_capacity, phone_verified, status, created_at}`; no phone, e-mail or any P3 value |

## Edge cases
- Concurrent first sign-in for one phone or subject converges on one account (unique `(provider, subject_hash)`; loser rolls its user insert back and re-reads).
- Two concurrent refreshes: one wins, one gets 409 `refresh_conflict`; the winner's token is the only live one.
- Providers not configured: bearer routes 401; age gate, OTP, social, passkey sign-in 503 `provider_not_configured` (never a fake success).
- Access token for a revoked session or a deleted/inactive user: 401 immediately.
- Key rotation: tokens signed by the previous key verify until that key is removed from the source.

## Data (PII class)
`users` (id P2, locale P2, age_band P2, limited_capacity P2, dob_ciphertext P3 enc, email_ciphertext P2 enc), `identities` (subject_ciphertext enc, subject_hash blind index), `devices`, `session_families`, `sessions` (refresh_hash), `auth_sessions`, `otp_challenges` (phone_ciphertext P3 enc, phone_hash, code_hash), `otp_send_log` (hashes only), `age_gate_blocks`, `age_gate_passes`, `auth_nonces`, `passkey_challenges`, `passkey_credentials`. Tagged in `docs/privacy/data_inventory.yaml`. RLS on all; pre-account tables `system` only.

## API
Unchanged paths (see `docs/api/openapi.yaml`). `GET /v1/me`: shopper bearer, not idempotent-relevant, 120 / min / user.

## Events
`session.revoked {session_id, user_id, family_id, reason, notify_user}` and `user.age_blocked {occurred_at}` to `outbox_events` (own transaction, see ADR-0030 consequences).

## Failure handling
JWKS fetch failure: `provider_unavailable` (503) and a stale-free cache (an expired entry is never served). KMS or key source down after a successful load: last good keys keep serving. Unconfigured KMS: 503 on every phone / DOB / e-mail operation.

## Security and abuse
BOLA: sessions and passkey challenges are owner-scoped (404 for foreign ids). Brute force: OTP attempts and per-challenge, per-phone, per-device limits. Replay: OTP single use, passkey challenge single use, social nonce single use, refresh rotation. Algorithm confusion, `alg none`, kid confusion and embedded key headers are rejected. SSRF: fixed JWKS hosts, https, DNS-level private-address refusal, no redirects. API2 / API4 / API6 / API7 mapping in the threat model.

## Metrics
OTP delivery p95, sign-in success rate, refresh reuse detections per day (alert > 0 spikes), `provider_not_configured` count (must be 0 once live), JWKS fetch failures.

## Acceptance (all are tests)
`apps/api/src/production/auth.production.test.ts` (OTP sign-in, `GET /v1/me`, encrypted-at-rest check, 18-20 flag, under-18 block, refresh reuse, device binding, forged / wrong-audience / expired / alg-none / kid tokens, Apple through the real fetcher, passkey replay and counter rollback, unconfigured 503/401), `adapters/stores.contract.test.ts` (in-memory, PGlite owner, PGlite `app_user` with RLS, opt-in real Postgres via `AUTH_PG_URL`), `adapters/token-service.test.ts`, `adapters/provider-jwks-fetcher.test.ts`, `adapters/webauthn-verifier.test.ts` (virtual authenticator, see header of `test/virtual-authenticator.ts`), `adapters/field-cipher.test.ts`, `apps/api/test/authz-matrix.test.ts` (`GET /v1/me`).

## Open items
Real App Attest / Play Integrity verifier (port only), KMS and secret-manager adapters, SMS / WhatsApp providers, env surface for key material, outbox atomicity of auth events, `/.well-known/jwks.json` endpoint, second factor for recycled numbers (spec 1 edge case), retention job for expired auth rows (opportunistic deletes only).

## Guest browsing note (ADR-0055, behind `flag.guest_browsing`)
Browsing, a device-only bag and saved items need no account; the age gate (`/v1/auth/age-gate`) still precedes every OTP, Apple, Google and passkey sign-in, so a token (and therefore every server cart/wishlist write) exists only after the 18+ attestation. There is no anonymous token audience and no anonymous session. The only server write a guest-originated bag ever causes is `POST /v1/me/guest-merge`, called with the new account's own bearer after sign-up/sign-in (buyer audience, Idempotency-Key, 5/min per user and 20/day per session, 404 while the flag is blocked). Guest analytics ingest stays blocked on VR-DASH-07. Open legal points: VR-GUEST-01, VR-GUEST-02, VR-GUEST-03.
