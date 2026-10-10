# Threat model: auth (identity, sessions, devices)

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §1, §B6, §T2, §T5, §A2.9 · Modules: `auth`, `users`, device attestation

No auth code exists (`packages/auth-core/src/index.ts` is an empty export). The only repository artefacts are the identity tables and RLS policies in `packages/db/migrations/0006_identity_consent.sql` and `0007_rls_and_grants.sql` (hashed refresh tokens, `UNIQUE (family_id, rotation_no)`, blind-index identities, no date of birth column), which have not been executed by any test. Every control below is `planned` unless a row cites a file.

## Scope and assets
| Asset | Class | Why it matters |
|---|---|---|
| Phone number, DOB, email | P3 / P3 / P2 (field-encrypted) | Identity and age gate; PDPL sensitive |
| Refresh token family, session rows | P1 | Account takeover = access to orders, store credit, addresses |
| OTP codes (in flight) | P1 | Single factor for most shoppers |
| Passkey credentials (public key, counter) | P1 | Mandatory for sellers and admins |
| Device attestation state | P1 | Gate for OTP, checkout, drops, gift-card redemption |

## Trust boundaries and actors
Mobile app to API edge (WAF, rate limit) · API to SMS and WhatsApp providers · API to Apple and Google identity providers · API to App Attest / Play Integrity verification. Adversaries: SMS-pumping fraudsters, account takeover crews, emulator and bot farms, under-18 users evading the gate, a curious insider.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| AUTH-S1 | S/D | SMS pumping and toll fraud through `POST /v1/auth/otp/request` | EG country-code allow-list at launch, per-prefix budget cap with anomaly alert, 3 sends per 15 min per phone and 10 per day per device, attestation token required, exponential resend timer | AUTH-T01 integration: the 4th send in 15 min is 429; AUTH-T02 non-EG prefix is refused without calling the provider (fake provider asserts zero sends) | planned |
| AUTH-S2 | S | OTP brute force | 6 digits, 5 min TTL, max 5 verify attempts, then the code is burned; code stored only as a keyed hash (HMAC), constant-time compare | AUTH-T03 the 6th attempt fails even with the right code; AUTH-T04 OTP table never contains plaintext | planned |
| AUTH-S3 | S | Takeover through SIM swap or a recycled phone number | Number unused for more than 180 days on a new device requires a second factor (email link or passkey) before any stored value is shown; sensitive actions (store credit use, payout bank change, address book export) require step-up | AUTH-T05 dormant-number login on a new device returns `step_up_required` and no balance | planned |
| AUTH-S4 | S | Forged or replayed Apple / Google ID token | Verify signature against cached JWKS, `iss`, `aud`, `exp`, nonce bound to the login attempt; reject unknown `kid` after one JWKS refresh | AUTH-T06 table-driven: wrong aud, expired, replayed nonce, unknown kid all rejected | planned |
| AUTH-S5 | S/E | Stolen refresh token | Opaque, hashed at rest (`sessions.refresh_hash`), device-bound, 30 days, rotated on every use, reuse detection revokes the whole `family_id` and notifies the user. Sender-constrained refresh (DPoP) is an open decision, see below | AUTH-T07 reuse of a rotated token revokes every session in the family (spec §1 acceptance) | partial (schema only: `sessions.refresh_hash` hash-only column and `session_families` in `packages/db/migrations/0006_identity_consent.sql`; rotation and reuse detection logic not written) |
| AUTH-S6 | S | JWT algorithm confusion, `none`, key confusion, audience misuse | Algorithm allow-list pinned in verifier config, asymmetric keys with `kid`, 10 min lifetime, audience-scoped, `amr` claim; no authorization data beyond scopes in the token | AUTH-T08 tokens with `alg=none`, HS256-signed-with-public-key and wrong audience are rejected | planned |
| AUTH-S7 | S | Passkey registration or assertion abuse | Fixed RP ID and origin check, single-use server challenge with 5 min TTL, signature counter and clone detection, registration only inside a recently authenticated session | AUTH-T09 replayed assertion and wrong-origin assertion rejected | planned |
| AUTH-S8 | S | Fake clients, emulator farms, scripted OTP and checkout traffic | App Attest (iOS) and Play Integrity (Android) verified server-side with server challenge; assertion counter checked; failure degrades to stricter limits, not silent allow | AUTH-T10 request without a valid attestation to an attested route is 401; AUTH-T11 replayed assertion counter rejected | planned |
| AUTH-T1 | T | Age tampering: edit DOB after registration, retry with another DOB, or skip the gate via social sign-in | Age band computed server-side only; DOB editable once through support with audit; under-18 device hash blocks retry for 30 days; the gate runs after every identity provider before the account becomes active | AUTH-T12 under-18 DOB stores no PII beyond the device hash (spec §1 acceptance); AUTH-T13 Apple sign-in cannot reach an active state without an age attestation | planned |
| AUTH-T2 | T/E | Account merge used to take over a verified account | Merge only after both identities verified and a step-up on the surviving account; merge recorded in the audit log | AUTH-T14 merge with one unverified identity is refused | planned |
| AUTH-R1 | R | A user or insider denies a login, session revoke or merge | `session.revoked`, login, refresh, merge and step-up events written to the append-only audit log with device ID, IP hash and request ID | AUTH-T15 each listed action creates exactly one audit row | planned |
| AUTH-I1 | I | Account enumeration through OTP request or login response differences | Identical response body, status and comparable timing for known and unknown numbers | AUTH-T16 response equality test over known vs unknown phone | planned |
| AUTH-I2 | I | OTP, tokens or phone numbers in logs, traces or analytics | Logger-level redaction, token and OTP keys on a deny-list, phone masked to last 2 digits, analytics receives pseudonymous ID only | AUTH-T17 log capture over the whole auth suite contains no phone, OTP or token | planned |
| AUTH-D1 | D | An attacker locks a victim out by burning the victim's OTP quota | Limits keyed on (phone, device) as well as phone; no account lock, only resend back-off; passkey and social paths stay available | AUTH-T18 attacker device exhausting the victim's phone quota does not block the victim's own device | planned |
| AUTH-D2 | D | Request flood on auth endpoints | Edge rate limiting and WAF, small body limit, 10 s default timeout | AUTH-T19 k6 smoke on auth routes holds p95 and returns 429 above limit | planned |
| AUTH-E1 | E | Privilege confusion between shopper, seller staff and admin | Roles resolved server-side by the `policy` package per request; seller and admin sessions require passkey (TOTP fallback); admin tokens are shorter lived and IP-restricted for Finance and Super-admin | AUTH-T20 shopper token on a seller or admin route is 403; AUTH-T21 seller login without passkey or TOTP refused | planned |
| AUTH-E2 | E | BOLA on session management (`DELETE /v1/me/sessions/{id}`) | Session lookup scoped by `user_id`; foreign IDs return 404 | AUTH-T22 user A deleting user B's session is 404 and B's session survives | partial (RLS policy `sessions_owner` in `packages/db/migrations/0007_rls_and_grants.sql`; untested) |

## Decisions and open items
- **DPoP or mTLS for refresh tokens.** Spec §T5 asks for the consideration. Default: device-bound opaque refresh token plus attestation; revisit DPoP when the mobile attestation key can sign requests. Record as an ADR before Phase 1 auth is built.
- **WhatsApp OTP fallback.** Template approval and sender identity are provider specific. VERIFY BEFORE LAUNCH with the chosen provider; no API behavior is assumed here.
- **OTP delivery vendor and SMS-pumping tooling** are not chosen; thresholds above are starting defaults.
- **Third-party token issuance** (ASVS V10 OAuth AS items) is out of scope until Outlet NK issues tokens to third parties; if sellers' channel integrations ever need Outlet NK as an OAuth provider, this model must be reopened.

## Residual risk
Phone-number-based identity is inherently exposed to SIM swap; the 180-day rule and step-up reduce but do not remove it. Attestation can be bypassed on rooted or jailbroken devices; treat it as a risk signal, not proof.
