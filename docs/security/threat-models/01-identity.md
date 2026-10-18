# Threat model 01: identity (auth, sessions, age gate, consent capture)

Status: Draft for review · Date: 2026-10-11 · Method: STRIDE per boundary · Spec refs: §1, §B6, §T5, ASVS V6/V7/V9 · Code: `apps/api/src/modules/auth`, `packages/auth-core`, `packages/policy` · Detail and older IDs (AUTH-T##): `auth.md` in this folder.

Evidence rule: "tested" means a test in this repository exercises it. Development still runs in-memory adapters; production now composes Kysely stores (migrations 0006 and 0047), the EdDSA token service, the real JWKS fetcher and the real WebAuthn verifier (ADR-0030, `docs/specs/auth-production.md`). Rows marked (prod) are proven against the production composition over PGlite (`apps/api/src/production/auth.production.test.ts`) and the store contract against PGlite with the `app_user` role and a real Postgres 18 (`AUTH_PG_URL`).

## Trust boundaries
1. Mobile app to API (`/auth/*`, `/me/sessions`). 2. API to SMS/WhatsApp providers (OTP delivery; port with failover in `packages/auth-core/src/otp-failover.ts`). 3. API to Apple/Google (ID-token verification). 4. Device attestation signal (App Attest / Play Integrity). 5. Admin/seller audiences (passkey sessions).

## Threats
| ID | STRIDE | Threat | Existing control (code) | Proving test | Status |
|---|---|---|---|---|---|
| ID-S1 | S | Brute force of a 6-digit OTP | 5 attempts then lock, 5 min TTL (`auth-core/src/otp-policy.ts`, `modules/auth/application/verify-otp.ts`) | `auth.privacy.http.test.ts`: "five wrong codes lock the challenge even for the right one"; "expired codes are refused" | implemented+tested (in-memory); (prod) wrong codes never sign in, per-challenge limit answers 429 before the 5th attempt locks the row |
| ID-S2 | S | OTP reuse / race: two verifies of one code | Single-use consume | same file: "a code works once"; "concurrent verifications of one correct code yield exactly one session" | implemented+tested (in-memory); Postgres `compareAndSet` run concurrently in the store contract on real Postgres |
| ID-S3 | S | Forged or replayed Apple/Google identity token | Signature, `iss`, `aud`, `exp`, nonce consumption; alg allow-list | `auth.identity.http.test.ts`: "rejects forged signatures, unknown key ids, alg none and HS256 confusion"; "rejects a nonce that was already consumed"; "an unreachable key source fails closed with 503" | implemented+tested; (prod) `CachingJwksKeyFetcher` with fixed hosts, kid-miss refresh, redirect/size/timeout/SSRF tests in `adapters/provider-jwks-fetcher.test.ts`. Not exercised against the live Apple/Google endpoints (VERIFY) |
| ID-S4 | S | Stolen refresh token reused | Rotation, reuse detection revokes the family, emits `session.revoked` | `auth.identity.http.test.ts`: "reuse detection: presenting a rotated token revokes the whole family and emits session.revoked" | implemented+tested (in-memory) |
| ID-S5 | S | OTP request from an emulator/bot (SMS pumping) | Attestation required; EG-only numbers; resend timer, per-phone window, per-device daily cap | `auth.privacy.http.test.ts`: "403 without a valid device attestation and sends nothing"; "rejects non-Egyptian and malformed numbers"; "enforces the resend timer, then the per-phone window limit, with Retry-After"; `auth.identity.http.test.ts`: "allows 10 attempts per device per day, then 429" | implemented+tested. Attestation verifier is a stub/fixture in dev; in production it is Unconfigured and every attested route answers 503 until a real App Attest / Play Integrity verifier exists (ADR-0026 Proposed) |
| ID-T1 | T | Under-18 user retries with another DOB/device/reinstall | 30-day block keyed on device id hash, DOB hash, attested key | `auth.identity.http.test.ts`: "the block survives a reinstall...", "the block follows the date of birth...", "turns 18 exactly on the birthday in Cairo time", "the block expires after 30 days" | implemented+tested (in-memory) |
| ID-R1 | R | User denies a login or consent | Session/audit events; consent history append-only | `modules/privacy/privacy.http.test.ts`: "grants and then withdraws in one tap, appending history" | implemented+tested for consent; login audit-log write not tested (VERIFY) |
| ID-I1 | I | Enumeration: unknown challenge vs wrong code; foreign session id | Indistinguishable responses; 404 for foreign session | `auth.privacy.http.test.ts`: "unknown challenge and a different attested device are indistinguishable from a wrong code"; "a shopper reads their own session"; sessions revoke scoped to caller | implemented+tested |
| ID-I2 | I | DOB or phone stored in clear / plain hash | Keyed identifiers only | `auth.identity.http.test.ts`: "stores only keyed identifiers: no DOB, no plain hash of it, no device id" | implemented+tested. (prod) phone, DOB, e-mail are AES-GCM envelope encrypted with blind indexes (`LocalKeyFieldCipher`); production default KMS port is Unconfigured (503). Test "P2/P3 values are never stored in clear". A real KMS adapter is still missing |
| ID-D1 | D | SMS provider outage locks out login | Failover SMS to WhatsApp (`otp-failover.ts`); Apple/Google paths independent | `packages/auth-core/src/auth.test.ts` (failover cases; VERIFY exact titles) | implemented, partly tested; no real provider adapters |
| ID-D2 | D | Identity key source unreachable | Fail closed with 503 + Retry-After | "an unreachable key source fails closed with 503" | implemented+tested |
| ID-E1 | E | Shopper token used on admin/seller audience | Audience-scoped principals; policy guard | `payments/test/http.test.ts`: "rejects a token minted for another audience"; `admin/admin.http.test.ts` "shopper audience 401" | implemented+tested |
| ID-E2 | E | Admin without passkey session | Gate order: audience, active actor, passkey, role | `admin/admin.http.test.ts`: "no passkey 403" per route | implemented+tested |
| ID-E3 | E | Passkey clone / counter rollback | Counter check (`passkey-counter.ts`), single-use challenge, `suspected_clone` + revoke all sessions | `packages/auth-core/src/auth.test.ts`; (prod) `webauthn-verifier.test.ts` (virtual authenticator) and "passkeys end to end ... replay, counter rollback" | implemented+tested with real WebAuthn verification (`@simplewebauthn/server`) |
| ID-S6 | S | Forged access token: alg none, wrong key, HS256 with the public key, RS256, kid confusion, embedded jwk/jku | Pinned EdDSA + `typ`, kid from the loaded set only, forbidden headers, issuer/audience/lifetime re-check (`adapters/token-service.ts`) | `adapters/token-service.test.ts`; (prod) "forged, wrong-audience, expired and malformed bearer tokens are all 401" | implemented+tested |
| ID-S7 | S | Replay of a passkey assertion or a social nonce | Single-use challenge (`DELETE ... RETURNING`), nonce `INSERT ... ON CONFLICT DO NOTHING` | store contract; (prod) passkey replay, Apple nonce replay | implemented+tested |
| ID-T2 | T | JWKS poisoning / SSRF through the key fetcher | Fixed hosts, https, no redirects, DNS private-address refusal, size and time caps, RSA only | `provider-jwks-fetcher.test.ts` | implemented+tested locally; never run against live hosts |
| ID-I3 | I | Stolen DB dump reveals phone, DOB, refresh tokens or OTP codes | Ciphertext + blind index, token and code hashes only | (prod) "P2/P3 values are never stored in clear" | implemented+tested; KEK custody is ADR-0002 |

## Residual risk
- R-ID-1 (reduced): Postgres stores exist and pass the contract on PGlite (owner and `app_user` with RLS) and on a real Postgres 18; they have not run behind PgBouncer or under load. Auth events are outboxed in a separate transaction (a crash between state change and event loses one `session.revoked` notification).
- R-ID-2 (reduced): production fails closed without providers. Missing: real App Attest / Play Integrity verifier, SMS / WhatsApp providers (ADR-0026 and a provider contract), live Apple/Google JWKS verification, KMS adapter (the in-process cipher is for synthetic data only), secret-manager key source and an env surface for it.
- R-ID-3: DPoP / mTLS binding of access tokens undecided (matrix V7/V9). Tokens are bearer, 10 minutes, revocable by session.
- R-ID-4: SIM-swap / recycled-number second factor (spec 1 edge case) not implemented.
- R-ID-5: expired auth rows (challenges, send log, passes, nonces) are deleted opportunistically on insert, not by a scheduled retention rule.
- R-ID-6: the `userHandle` is optional on assertions; clients should set it to the user id at registration, otherwise only the credential-to-user mapping binds the login.

## Test that proves absence of regression
`pnpm --filter @outlet/api test -- auth` runs both auth HTTP suites in CI job `verify` (`.github/workflows/ci.yml`).

## Seller authentication (audience seller_api; ADR-0031)

| STRIDE | Threat | Control |
|---|---|---|
| Spoofing | SIM swap on a returning seller enrols an attacker factor | An identity with a strong factor gets a RESTRICTED enrol token; enrolment endpoints refuse enrol sessions once `strong_factor` is true; sign-in needs passkey or TOTP in addition to the phone proof |
| Spoofing | Phone-only token used on store routes | `scope=seller:enrol` tokens are denied (403) by the policy guard unless a route opts in with `@AllowSellerEnrol()`; the actor carries no grants |
| Spoofing | TOTP guessing / replay | +-1 step window, used steps rejected (compare-and-set), 5 failures lock with doubling backoff, proof needed, recovery codes keyed-hashed and single use |
| Spoofing | Token forgery, alg none, wrong audience, enrol scope added to a full token | EdDSA pinned, kid/typ checks, audience per route, schema rejects enrol scope with a strong amr, session row required |
| Tampering | Refresh theft | Rotation, family revoked on reuse or device mismatch, `seller.session_revoked` with `notifySeller` |
| Repudiation | Who enrolled / used a recovery code | Outbox events `seller.strong_factor_enrolled`, `seller.recovery_code_used`, `seller.totp_locked` |
| Info disclosure | Account enumeration | Identical 202 for known and unknown phones; suspended, unknown and wrong-code verifies answer alike; assert endpoints answer a uniform 401 |
| Info disclosure | P3 at rest | Phone, e-mail, TOTP secret field-encrypted; proofs, recovery codes, refresh tokens hashed; blind indexes for lookups |
| DoS / cost | SMS pumping with international numbers | Per-prefix hourly cap and conversion anomaly alert, per-phone and per-client limits, provider failover only after limits |
| Elevation | Staff escalation, last owner removal | Invite rights by role, grants resolved from the database on every request, last owner protected, step-up helper for sensitive actions |
| Elevation | Cross-seller session access | Session list and revoke are keyed by the token subject; a foreign id is 404 |
Residual risks: e-mail is captured but not verified; WebAuthn origin for the Seller Center is configuration, not code (see `docs/specs/seller-auth.md`, open items).
