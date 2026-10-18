# Spec: seller authentication (audience seller_api)

Status: Implemented · Date: 2026-10-11 · ADR: 0031 (decisions 1, 2), 0030 · Contract: `docs/specs/brand-onboarding-contract.md` ("Seller auth") · Threat model: `docs/security/threat-models/01-identity.md` (seller section) · Code: `apps/api/src/modules/auth/seller`, `packages/auth-core` (totp, step-up, enrol claims), `packages/db/migrations/0053_seller_auth.sql`

## Flow
1. `POST /v1/seller/auth/otp/request` (phone, email, locale): phone OTP, same 6 digit / 5 min / 5 attempt code as shoppers. Same 202 answer for known and unknown phones.
2. `POST /v1/seller/auth/otp/verify`: returns an ENROL token (JWT, aud `seller_api`, scope `seller:enrol`, amr `otp_*`, 30 min, no refresh) and `next_step`. An identity that already has a strong factor also gets a single-use `otp_proof` (5 min) and a RESTRICTED enrol token (reaches nothing but logout).
3. First strong factor, with the enrol token: passkey (`passkey/register/options` then `passkey/register`) or TOTP (`totp/enrol` then `totp/confirm`). Success marks the identity `strong_factor`, ends the enrol session and returns a FULL session.
4. Returning sign-in: OTP verify (proof) then `passkey/assert/options` + `passkey/assert`, or `totp/assert` (proof + 6 digit code, or a recovery code in the same field).
5. FULL session: access JWT 10 min (amr contains `webauthn` or `totp`), opaque rotating refresh 30 days with family reuse detection, refreshed through the existing `POST /v1/auth/refresh` (the token decides the audience; the response has the SellerSession shape). `POST /v1/seller/auth/logout`, `GET /v1/seller/auth/sessions`, `DELETE /v1/seller/auth/sessions/{id}` (additive routes).

## Rules
| Rule | Value |
|---|---|
| Identity | `seller_users`, separate from shopper `users`; the same phone may exist in both; no automatic merge (ADR-0031 d1). `shopper_user_id` is reserved for the later explicit link (needs OTP proof in both audiences) and is not written by this module yet |
| Enrol token | scope `seller:enrol`, 30 min, no refresh; refused (403 `strong_factor_required`) on every route that does not carry `@AllowSellerEnrol()`; cannot add a factor to an identity that already has one (SIM-swap defence) |
| Full session | needs a strong factor in the claims AND on the identity; session row decides (revocation is immediate) |
| TOTP | RFC 6238 SHA-1, 6 digits, 30 s, +-1 step; secret field-encrypted; used steps are never accepted again (compare-and-set on `last_used_step`); 5 consecutive failures lock 15 min, doubling per lock up to 24 h; 8 recovery codes shown once, stored as keyed hashes, single use |
| Phone proof | random 256 bit, stored as SHA-256, single use for passkey, kept through typos for TOTP (lockout bounds guessing) |
| OTP abuse | all calling codes allowed; per phone 3 / 15 min, per client 10 / day, per calling-prefix 50 / hour plus the conversion anomaly alert; web clients are keyed by IP, mobile by attested device |
| Step-up | `SellerSessions.assertRecentStrongFactor(sessionId, maxAgeSec)`: true only for a FULL session whose strong factor was asserted within the window; re-run the passkey / TOTP sign-in to refresh |
| Team | roles owner/manager/catalog/warehouse/finance/support per store in `seller_memberships`; `SellerMembershipService.grantStoreRole` (provisioning, idempotent), `revokeStoreRole` (last owner protected), `listMemberships`, `inviteStaff` (owner any role, manager non-managerial roles), `acceptInvites` runs when the invitee obtains a full session. Read port `SellerMembershipsPort` (`list`, `grantsFor`) is exported from the auth index |
| Actor | full session: brand grants from memberships, `assurance` passkey for webauthn, token scopes `seller:session` (+ `seller:read`, `seller:write` when a membership exists) |

## Edge cases
Concurrent first OTP verify for one phone converges on one identity (unique blind index). Suspended seller answers like a wrong code. Two concurrent refreshes: one 409. Providers unconfigured: OTP 503 `provider_not_configured`, KMS missing 503, no signing keys: every seller bearer 401. Web clients without `X-Install-Id` bind refresh to the nil UUID (reuse detection still applies); clients that send it must send the same value to `/v1/auth/refresh`.

## Data (PII)
Tables in `0053`, tagged in `docs/privacy/data_inventory.yaml`: phone P3 envelope + blind index, e-mail P2 envelope, TOTP secret P3 envelope, recovery codes and proofs hashed. RLS: system role only.

## Events (outbox)
`seller.session_revoked`, `seller.strong_factor_enrolled`, `seller.totp_locked`, `seller.recovery_code_used`, `seller.otp_prefix_anomaly`, `seller.membership_granted`, `seller.membership_revoked`.

## Acceptance (tests)
`apps/api/src/production/seller-auth.production.test.ts` (passkey journey with the virtual authenticator, TOTP journey, enrol token 403, clone rollback, refresh reuse, lockout, replay, recovery single use, token forgery, memberships, invites, step-up, encryption at rest), `apps/api/src/modules/auth/seller/test/stores.contract.test.ts` (in-memory, PGlite owner, PGlite app_user with RLS, prefix cap), `packages/auth-core/src/totp.test.ts` (RFC 6238 vectors), authz matrix delegated rows.

## Open items
Seller Center origin must be added to the WebAuthn origins (needs an env surface); automatic shopper link (`shopper_user_id`); email verification (captured, not verified); outbox consumers for the seller events; `@AllowSellerEnrol()` must be added by the applications module to its draft routes (requirements, list, create, patch, documents); a dedicated step-up route; recovery-code regeneration and passkey management endpoints; the OpenAPI pattern of `SellerTotpAssertRequest.code` should allow the recovery format (`XXXXX-XXXXX`).
