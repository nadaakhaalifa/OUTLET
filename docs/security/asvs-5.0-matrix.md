# ASVS 5.0 control matrix (Level 2, Level 3 for ledger, payments and admin)

Status: Draft for review · Date: 2026-10-10 · Spec refs: §T5, §B8, §A2.9 · Owner: Tech Lead (security review before each phase gate)

## How to read this document

- **Target.** OWASP ASVS 5.0.0 Level 2 for the API and web surfaces. Level 3 applies to the ledger, payments and admin areas (rows marked L3). The master prompt names these targets in §T5.
- **Granularity.** This matrix is mapped at chapter and requirement-area level (V1 to V17). ASVS 5.0 renumbered every requirement, and this repository holds no copy of the official requirement list, so individual requirement IDs are deliberately not quoted. Before the launch gate, each row must be expanded to the official requirement IDs from the published ASVS 5.0.0 list and any area that does not apply recorded as "not applicable" with a reason. **VERIFY BEFORE LAUNCH.**
- **Status vocabulary.**
  - `planned`: designed here and in a threat model, no code.
  - `partial`: some code or SQL exists in the repository (cited), but the control is incomplete or no test executes it.
  - `implemented`: code exists and a test that passes in this repository proves it (cited).
- **Test column.** Test IDs of the form `XXX-T##` (two digits) refer to the proving tests listed in the per-module threat models in `docs/security/threat-models/`. A test ID that has no test file yet is a commitment, not evidence.
- **State at date of writing.** The only `implemented` rows rest on `packages/domain/src/money.ts` and `packages/domain/src/ledger.ts`, covered by `money.test.ts` and `ledger.test.ts` (32 tests, run and passing on 2026-10-10). Everything else is `partial` or `planned`. No row claims a control that the repository does not contain.

## Summary by chapter

| Chapter | Level | Implemented | Partial | Planned |
|---|---|---|---|---|
| V1 Encoding and Sanitization | L2 | 0 | 0 | 3 |
| V2 Validation and Business Logic | L2, L3 for ledger and payments | 2 | 1 | 4 |
| V3 Web Frontend Security | L2 | 0 | 0 | 3 |
| V4 API and Web Service | L2 | 0 | 0 | 4 |
| V5 File Handling | L2 | 0 | 0 | 2 |
| V6 Authentication | L2, L3 for admin | 0 | 0 | 6 |
| V7 Session Management | L2, L3 for admin | 0 | 1 | 3 |
| V8 Authorization | L2, L3 for ledger, payments, admin | 0 | 2 | 3 |
| V9 Self-contained Tokens | L2 | 0 | 0 | 2 |
| V10 OAuth and OIDC | L2 (conditional) | 0 | 0 | 2 |
| V11 Cryptography | L2, L3 for P3 and ledger | 0 | 1 | 5 |
| V12 Secure Communication | L2 | 0 | 0 | 3 |
| V13 Configuration | L2 | 0 | 1 | 4 |
| V14 Data Protection | L2, L3 for P3 | 0 | 2 | 4 |
| V15 Secure Coding and Architecture | L2 | 0 | 2 | 3 |
| V16 Security Logging and Error Handling | L2, L3 for audit | 0 | 1 | 4 |
| V17 WebRTC | n/a | n/a | n/a | n/a |

## V1 Encoding and Sanitization

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Output encoding for HTML, JSON, CSV and email contexts | L2 | api, seller-web, admin-web, notifications | Context-specific encoders at every output; template engine auto-escape; CSV export neutralizes formula prefixes | SELL-T04, LLM-T13, NOTIF-T01 | planned |
| Injection prevention for SQL, NoSQL, OS command, LDAP and template | L2 | all modules, db | Parameterized queries only through the query builder; no string-built SQL; lint rule against raw template queries | SUP-T03; Semgrep rule (planned); LLM-T13 | planned |
| Safe handling of untrusted deserialization, URLs and redirects | L2 | api, crawler, mobile | Zod at every boundary; redirect and webhook-target URLs validated against allow-lists | PRICE-T07, MOB-T02 | planned |

## V2 Validation and Business Logic

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Input validation against an explicit schema at trust boundaries | L2 | validation, api | Zod schemas, `.strict()` objects, explicit min and max, allow-list DTOs | LED-T06; API3 generated test (`api-top10.md`) | planned |
| Money arithmetic: integer minor units, one rounding point, allocation conserves total | L3 | domain | `bigint` piastres only; largest-remainder allocation; typed errors | `packages/domain/src/money.test.ts` (23 tests including fast-check properties), PAY-T06 | implemented (`packages/domain/src/money.ts`). Gap: range is not bounded to int64 (see LED-T4) |
| Double-entry invariants: balanced per currency, at least two postings, no zero postings, reversal negates | L3 | domain, ledger | `createJournalEntry`, `reverseEntry`, `trialBalance` | `packages/domain/src/ledger.test.ts` (9 tests including property test); database half LED-T03, LED-T04 | implemented in domain (`packages/domain/src/ledger.ts`); database half is `partial` under V8 and V14 |
| Business-logic limits and sequential flow integrity (state machines, no step skipping) | L2, L3 payments | orders, payouts, returns | Typed state machines with invalid-transition errors; eligibility computed server-side | LED-T14, PAY-T07, INV-T02 | planned (`packages/domain/src/state-machine/index.ts` is an empty export) |
| Anti-automation of sensitive business flows (API6 overlap) | L2 | auth, checkout, drops, referrals, gift cards | Per-user, device and IP limits; attestation; velocity rules | AUTH-T01, INV-T07, GIFT-T06, GIFT-T08 | planned |
| Idempotency and replay protection for state-changing money calls | L3 | idempotency, outbox, ledger | `Idempotency-Key` required; `journal_entries.idempotency_key UNIQUE`; `inbox_processed` dedup | LED-T07, PAY-T04, PAY-T05 | partial (SQL in `packages/db/migrations/0003_ledger.sql` and `0004_idempotency_outbox_inbox.sql`, untested; `packages/idempotency/src/index.ts` is an empty export) |
| Client-supplied totals, prices and discounts never trusted | L2, L3 payments | checkout | Server recomputes basket; client sends IDs and quantities | PAY-T03 | planned |

## V3 Web Frontend Security

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Content Security Policy with nonces, no inline script, frame-ancestors none | L2 | seller-web, admin-web | CSP header set at the edge and in the app; report-only first | PAY-T10; header scan in DAST | planned |
| Cookie and storage attributes for web sessions (Secure, HttpOnly, SameSite) | L2 | seller-web, admin-web | Session cookie scoped to host; CSRF token on state-changing routes | ADM-T11 and a CSRF negative test (to be written) | planned |
| Clickjacking, Referrer-Policy, Permissions-Policy, third-party script control | L2 | seller-web, admin-web | Strict headers; no third-party script on payment-adjacent pages (SAQ A) | PAY-T10 | planned |

## V4 API and Web Service

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Generic web service security: HTTP method allow-list, content-type enforcement, request size limits, timeouts | L2 | api | Default 10 s timeout; body size caps; explicit methods per route | AUTH-T19, API4 tests in `api-top10.md` | planned |
| Schema-validated requests and responses; explicit serializers | L2 | api | OpenAPI generated from code; response serializers are allow-lists | API3 generated test | planned |
| Webhook authenticity: signature, timestamp, dedup | L3 payments | payments | HMAC over raw body, timestamp window, event ID `UNIQUE`, IP allow-list | PAY-T01 | planned |
| Rate limits per route and per principal | L2 | api, edge | Redis token bucket, WAF | AUTH-T19, LLM-T09 | planned |

## V5 File Handling

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Upload validation: type sniffing, size cap, AV scan, re-encode, EXIF/GPS strip | L2 | catalog, sellers, returns | Upload pipeline into private buckets; signed URLs of 15 minutes or less | SELL-T04 | planned |
| Safe storage and delivery: no executable content served, content-disposition, bucket isolation | L2 | storage, cdn | Private buckets; images only through resizer | SELL-T04 | planned |

## V6 Authentication

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Passkeys (WebAuthn) mandatory for sellers and admins, offered to shoppers | L2, L3 admin | auth | Fixed RP ID, single-use challenge, counter and clone detection | AUTH-T09, AUTH-T21 | partial (challenge, origin and counter checks tested with a fake verifier; no real WebAuthn adapter) |
| OTP lifecycle: length, TTL, attempt cap, keyed hash storage, constant-time compare | L2 | auth | 6 digits, 5 min, 5 attempts, HMAC at rest | AUTH-T03, AUTH-T04 | planned |
| Federated sign-in token verification (Apple, Google) | L2 | auth | JWKS verification, `iss`, `aud`, `exp`, nonce | AUTH-T06 | partial (Apple and Google ID-token verifier tested against local keys; no JWKS fetch adapter) |
| Credential recovery and account merge without bypass | L2 | auth | Step-up on merge; no knowledge-based recovery | AUTH-T14 | planned |
| Anti-enumeration and brute-force defences | L2 | auth | Identical responses, per phone and device limits | AUTH-T16, AUTH-T18 | planned |
| Multi-factor and step-up for sensitive actions | L3 admin, payments | auth, payouts | Step-up for IBAN change, store credit use, export | AUTH-T05, LED-T13 | planned |

## V7 Session Management

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Refresh token rotation, reuse detection, family revocation | L2 | auth | Opaque, hashed at rest, rotated on every use | AUTH-T07 | partial (rotation, reuse detection, device binding implemented and tested in `apps/api/src/auth.identity.http.test.ts` over in-memory fixtures; hash-only column and family tables in `packages/db/migrations/0006_identity_consent.sql`; no Postgres adapter) |
| Session termination and listing by the user | L2 | auth, users | `DELETE /v1/me/sessions/{id}` scoped by user | AUTH-T22 | partial (listing and revocation scoped to the caller, 404 for foreign ids, tested over HTTP; in-memory only) |
| Re-authentication for sensitive actions; admin session lifetime | L3 admin | auth, admin | Short admin sessions; IP restriction for Finance and Super-admin | ADM-T01, ADM-T02 | planned |
| Device binding and attestation | L2 | auth, mobile | App Attest and Play Integrity as risk signal | AUTH-T10, AUTH-T11 | planned |

## V8 Authorization

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Deny by default, central policy decision point | L2, L3 | policy | Central guard plus RLS; not-owned equals 404 | AUTH-T20, ADM-T10 | partial (RLS skeleton and session-variable contract in `packages/db/migrations/0002_roles_and_helpers.sql` and `0007_rls_and_grants.sql`; `packages/policy/src/index.ts` is an empty export; untested) |
| Object-level authorization (BOLA) on every route | L2, L3 ledger | all | Ownership check in guard and RLS | LED-T11, PAY-T02, SELL-T07, INV-T10 | partial (RLS policies on ledger and identity tables in `0007_rls_and_grants.sql`; no API exists to test) |
| Function-level authorization (BFLA) for admin, seller and finance routes | L3 admin | admin, sellers | Separate namespace and audience; role from policy package | ADM-T11 | planned |
| Field-level authorization (BOPLA) and mass assignment | L2 | api | Explicit DTOs and serializers | API3 tests | planned |
| Dual approval and separation of duties for money and role changes | L3 | payouts, admin | Approver differs from requester; thresholds | LED-T08, ADM-T09 | planned |

## V9 Self-contained Tokens

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Algorithm allow-list, signature verification, `kid` handling, no `none` | L2 | auth-core | Pinned algorithm in verifier config, asymmetric keys | AUTH-T08 | partial (ID-token verifier pins RS256; access tokens are still opaque dev strings) |
| Claim validation: `iss`, `aud`, `exp`, `nbf`, `amr`; short lifetime | L2 | auth-core | 10 minute access tokens, audience-scoped | AUTH-T08 | planned |

## V10 OAuth and OIDC

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| OAuth client behaviour toward Apple, Google and seller channel providers (state, PKCE, redirect URI exact match, token storage in KMS) | L2 | auth, sellers | PKCE, exact redirect match, tokens by reference | SELL-T09 | planned |
| Authorization server requirements (V10.4 area) | L2 conditional | none | Applies only if Z-OUTLET issues tokens to third parties; not in scope now. Reopen the auth threat model if that changes | n/a | planned (conditional, not applicable today) |

## V11 Cryptography

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Key management policy, ownership, rotation | L2, L3 | platform | `crypto-inventory.md`; KMS-managed keys; yearly rotation | Rotation drill record (planned) | planned |
| Cryptographic inventory and discovery of crypto usage | L3 | platform | `docs/security/crypto-inventory.md` exists as a document; discovery scan in CI planned | CI scan test (planned) | partial (inventory document only: `docs/security/crypto-inventory.md`) |
| Post-quantum migration plan (spec cites 11.1.4, L3) | L3 | platform | Plan and agility requirements in `crypto-inventory.md` | Algorithm agility test (planned) | planned |
| Approved algorithms and modes (AES-256-GCM, SHA-256 or better, HMAC-SHA-256, Ed25519 or ECDSA P-256) | L2 | all | Single crypto wrapper module; no ad hoc primitives | Semgrep rule and unit tests (planned) | planned |
| Randomness from a CSPRNG for tokens, OTPs, IDs | L2 | auth | Platform CSPRNG; UUIDv7 only for non-secret IDs; domain stays pure by injecting randomness | AUTH-T03 | planned |
| Envelope encryption of P3 with blind indexes | L3 | users, payouts | KMS DEK per field class; HMAC blind index | LED-T10, AUTH-T04 | planned (schema carries `subject_ciphertext` and `subject_hash` in `0006_identity_consent.sql`) |

## V12 Secure Communication

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| TLS 1.2 or higher, prefer 1.3, strong cipher suites, HSTS preload | L2 | edge | Terminate at managed edge; scanner in CI | TLS scan (testssl or equivalent) in staging | planned |
| Service-to-service and database connections encrypted and authenticated | L2 | infra | mTLS or private network plus TLS to Postgres | Infra policy test (Conftest) | planned |
| Certificate validation on outbound calls to PSPs, couriers, ETA | L2 | adapters | No TLS verification disabling; timeouts and breakers | API10 tests | planned |

## V13 Configuration

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Secrets management: no secrets in code or images, rotation, OIDC from CI | L2 | platform | Secret manager; pre-commit and CI scanning | SUP-T05 | planned |
| Hardened defaults, no debug endpoints, security headers | L2 | api | Production profile; OpenAPI is the endpoint catalog | API8 and API9 tests | planned |
| Environment separation: staging has no production data | L2 | infra | Separate accounts and networks; synthetic data only | SUP-T06 | planned |
| Dependency and build integrity (SBOM, signing, provenance) | L2 | CI | Lockfile, CycloneDX, cosign, SLSA | SUP-T02, SUP-T04 | planned |
| Architecture boundary enforcement | L2 | repo | dependency-cruiser rules for module boundaries and domain purity | SUP-T09 | partial (`.dependency-cruiser.cjs`, `eslint.config.mjs`; no CI workflow exists in the repository, so nothing enforces them on merge yet) |

## V14 Data Protection

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Data classification and inventory (P0 to P3) | L2 | privacy | `docs/privacy/data_inventory.yaml` with schema check | PRIV-T03 | partial (`docs/privacy/data_inventory.yaml`, `tooling/privacy/inventory-schema.mjs`; CI check not wired) |
| Minimization and no P2/P3 to analytics or logs | L2 | analytics, logger | Property-name and value guards; consent gating | PRIV-T05, PRIV-T06, AUTH-T17 | partial (`packages/analytics/src/pii.ts`, `naming.ts`; no test file for them yet) |
| Retention and deletion | L2 | privacy | Retention jobs, deletion fan-out | PRIV-T09 | planned |
| Protection of sensitive data in client storage and caches | L2 | mobile | SecureStore, encrypted MMKV | MOB-T06 | planned |
| Backups and exports protected and access-logged | L2 | infra, privacy | Encrypted backups; dual-approved exports | PRIV-T07, ADM-T06 | planned |
| Immutable financial and audit records | L3 | ledger, audit | Append-only triggers, grants, hash chain | LED-T04, ADM-T03 | planned (SQL only; see V16 and `packages/db/migrations/0003_ledger.sql`) |

## V15 Secure Coding and Architecture

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Documented trust boundaries and threat models per module | L2 | docs | STRIDE models under `docs/security/threat-models/` | Review sign-off record | partial (drafts in `docs/security/threat-models/`, not yet reviewed) |
| Safe use of third-party components; unsafe consumption of APIs | L2 | adapters | Schema-validated provider responses, breakers | API10 tests | planned |
| Type-safe, strict code and banned patterns (`any`, ts-ignore, non-null assertion) | L2 | repo | TS strict, ESLint rules | Lint in CI | partial (`eslint.config.mjs` rules present; not run by CI) |
| Concurrency and race-condition safety for stock and money | L2, L3 | inventory, ledger | `FOR UPDATE SKIP LOCKED`, unique keys, transactions | INV-T02, LED-T07 | planned |
| Pure domain, injected clock and randomness | L2 | domain | Dependency rules forbid I/O imports in domain | SUP-T09 | planned |

## V16 Security Logging and Error Handling

| Area | Level | Module | Control | Proving test | Status |
|---|---|---|---|---|---|
| Security event logging with actor, action, target, request ID | L2, L3 | audit | Append-only hash-chained `audit_log` | ADM-T05, AUTH-T15 | partial (`packages/db/migrations/0005_audit_log.sql`; untested) |
| Log redaction of secrets and personal data | L2 | logger | Deny-list and masking | AUTH-T17, PAY-T09 | planned |
| Log integrity and tamper evidence, WORM shipping | L3 | audit, infra | Chain verification, checkpoints, object-lock bucket | ADM-T03 | planned |
| Generic error responses without stack traces; Problem+JSON | L2 | api | Central error filter | API8 test | planned |
| Alerting and incident response | L2 | observability | SLO alerts, severity matrix | Runbook drill | planned |

## V17 WebRTC

Not applicable: no WebRTC feature in the product scope. Reopen if live commerce video is added.

## Open items and decisions

1. Expand every row to official ASVS 5.0.0 requirement IDs and levels before the Phase 1 security gate. **VERIFY BEFORE LAUNCH.**
2. Decide whether DPoP or mTLS binds refresh tokens (see auth threat model); the V7 and V9 rows depend on it.
3. Pen test before launch, yearly, and before each major money feature (spec §T5). No test has been commissioned.
4. A CI workflow does not exist in the repository, so every "CI" control is planned.
