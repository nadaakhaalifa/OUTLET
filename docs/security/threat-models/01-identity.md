# Threat model 01: identity (auth, sessions, age gate, consent capture)

Status: Draft for review · Date: 2026-10-11 · Method: STRIDE per boundary · Spec refs: §1, §B6, §T5, ASVS V6/V7/V9 · Code: `apps/api/src/modules/auth`, `packages/auth-core`, `packages/policy` · Detail and older IDs (AUTH-T##): `auth.md` in this folder.

Evidence rule: "tested" means a test in this repository exercises it. All identity adapters currently in use are in-memory (`modules/auth/adapters/in-memory-identity.ts`); the Postgres tables exist (`packages/db/migrations/0006_identity_consent.sql`) but no Kysely identity store is wired. That is residual risk R-ID-1 for every row below.

## Trust boundaries
1. Mobile app to API (`/auth/*`, `/me/sessions`). 2. API to SMS/WhatsApp providers (OTP delivery; port with failover in `packages/auth-core/src/otp-failover.ts`). 3. API to Apple/Google (ID-token verification). 4. Device attestation signal (App Attest / Play Integrity). 5. Admin/seller audiences (passkey sessions).

## Threats
| ID | STRIDE | Threat | Existing control (code) | Proving test | Status |
|---|---|---|---|---|---|
| ID-S1 | S | Brute force of a 6-digit OTP | 5 attempts then lock, 5 min TTL (`auth-core/src/otp-policy.ts`, `modules/auth/application/verify-otp.ts`) | `auth.privacy.http.test.ts`: "five wrong codes lock the challenge even for the right one"; "expired codes are refused" | implemented+tested (in-memory) |
| ID-S2 | S | OTP reuse / race: two verifies of one code | Single-use consume | same file: "a code works once"; "concurrent verifications of one correct code yield exactly one session" | implemented+tested (in-memory; Postgres row-lock behaviour not tested) |
| ID-S3 | S | Forged or replayed Apple/Google identity token | Signature, `iss`, `aud`, `exp`, nonce consumption; alg allow-list | `auth.identity.http.test.ts`: "rejects forged signatures, unknown key ids, alg none and HS256 confusion"; "rejects a nonce that was already consumed"; "an unreachable key source fails closed with 503" | implemented+tested against local keys; live JWKS adapter not present (VERIFY) |
| ID-S4 | S | Stolen refresh token reused | Rotation, reuse detection revokes the family, emits `session.revoked` | `auth.identity.http.test.ts`: "reuse detection: presenting a rotated token revokes the whole family and emits session.revoked" | implemented+tested (in-memory) |
| ID-S5 | S | OTP request from an emulator/bot (SMS pumping) | Attestation required; EG-only numbers; resend timer, per-phone window, per-device daily cap | `auth.privacy.http.test.ts`: "403 without a valid device attestation and sends nothing"; "rejects non-Egyptian and malformed numbers"; "enforces the resend timer, then the per-phone window limit, with Retry-After"; `auth.identity.http.test.ts`: "allows 10 attempts per device per day, then 429" | implemented+tested. Attestation verifier is a stub/fixture: real App Attest/Play Integrity not integrated (ADR-0026 Proposed) |
| ID-T1 | T | Under-18 user retries with another DOB/device/reinstall | 30-day block keyed on device id hash, DOB hash, attested key | `auth.identity.http.test.ts`: "the block survives a reinstall...", "the block follows the date of birth...", "turns 18 exactly on the birthday in Cairo time", "the block expires after 30 days" | implemented+tested (in-memory) |
| ID-R1 | R | User denies a login or consent | Session/audit events; consent history append-only | `modules/privacy/privacy.http.test.ts`: "grants and then withdraws in one tap, appending history" | implemented+tested for consent; login audit-log write not tested (VERIFY) |
| ID-I1 | I | Enumeration: unknown challenge vs wrong code; foreign session id | Indistinguishable responses; 404 for foreign session | `auth.privacy.http.test.ts`: "unknown challenge and a different attested device are indistinguishable from a wrong code"; "a shopper reads their own session"; sessions revoke scoped to caller | implemented+tested |
| ID-I2 | I | DOB or phone stored in clear / plain hash | Keyed identifiers only | `auth.identity.http.test.ts`: "stores only keyed identifiers: no DOB, no plain hash of it, no device id" | implemented+tested. Field-level KMS envelope encryption not implemented (`crypto-inventory.md`) |
| ID-D1 | D | SMS provider outage locks out login | Failover SMS to WhatsApp (`otp-failover.ts`); Apple/Google paths independent | `packages/auth-core/src/auth.test.ts` (failover cases; VERIFY exact titles) | implemented, partly tested; no real provider adapters |
| ID-D2 | D | Identity key source unreachable | Fail closed with 503 + Retry-After | "an unreachable key source fails closed with 503" | implemented+tested |
| ID-E1 | E | Shopper token used on admin/seller audience | Audience-scoped principals; policy guard | `payments/test/http.test.ts`: "rejects a token minted for another audience"; `admin/admin.http.test.ts` "shopper audience 401" | implemented+tested |
| ID-E2 | E | Admin without passkey session | Gate order: audience, active actor, passkey, role | `admin/admin.http.test.ts`: "no passkey 403" per route | implemented+tested |
| ID-E3 | E | Passkey clone / counter rollback | Counter check (`passkey-counter.ts`), single-use challenge | `packages/auth-core/src/auth.test.ts` with fake verifier | implemented, tested with fake only; no real WebAuthn adapter |

## Residual risk
- R-ID-1: in-memory stores only; durability, RLS and concurrency under Postgres unproven for identity.
- R-ID-2: no live attestation or JWKS adapters; abuse controls trust a fixture signal. Do not enable real SMS until ADR-0026 and a provider contract exist.
- R-ID-3: access-token format and DPoP/mTLS binding undecided (matrix V7/V9). VERIFY in code before launch.
- R-ID-4: SIM-swap / recycled-number second factor (spec §1 edge case) has no test found. Not implemented (VERIFY).

## Test that proves absence of regression
`pnpm --filter @outlet/api test -- auth` runs both auth HTTP suites in CI job `verify` (`.github/workflows/ci.yml`).
