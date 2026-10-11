# ASVS 5.0 control matrix (Level 2; Level 3 for ledger, payments, admin)

Status: Draft for review · Date: 2026-10-11 (re-baselined against the code of that date; supersedes the 2026-10-10 version, which pre-dated waves 1 to 4) · Spec refs: §T5, §B8, §A2.10 · Owner: Tech Lead · Threat models: `threat-models/01` to `09`.

## How to read
- **Granularity.** Area level (V1 to V17), not official requirement IDs. ASVS 5.0 renumbered everything and no copy of the official list is in this repository. Before the pen test every row must be expanded to official IDs. **VERIFY BEFORE LAUNCH.**
- **Status vocabulary (honest, evidence only).**
  - `IMPL+TESTED`: code exists and a test in the repository exercises it (path given).
  - `IMPL-UNTESTED`: code or config exists, no test exercises it.
  - `NOT-IMPL`: no code. Commitment only.
  - `N/A`: not applicable, reason given.
- **Evidence limits.** Database tests run on PGlite (`*.pglite.test.ts`); `tooling/db/run-on-postgres16.sh` checks migration guarantees on real PG16 but is not a CI job (VERIFY). All identity, PSP, courier, ETA, SMS and LLM adapters are in-memory or fixtures. A test of a fixture proves our handling, not the provider.
- Test IDs from older threat models (`AUTH-T##` etc.) remain in `01`-`09` files' sibling documents; new rows cite file paths.

## V1 Encoding and sanitization
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Output encoding, CSV formula neutralization | L2 | React/Next default escaping; no CSV neutralizer found | `apps/seller-web`, `apps/admin-web`; seller analytics `POST .../exports` has no formula test | NOT-IMPL (CSV), IMPL-UNTESTED (HTML) |
| Injection prevention (SQL etc.) | L2 | Kysely parameterized queries; Semgrep job | `.github/workflows/ci.yml` job `semgrep`; PGlite adapters | IMPL-UNTESTED (no dedicated injection test) |
| Safe parsing of URLs, redirects, deserialization | L2 | Zod `.strict()` pipe; malformed id is validation error | `apps/api/src/platform/zod.pipe.ts`; `apps/api/src/app.http.test.ts` "validates bodies with JSON pointers and never echoes values"; `payments/test/http.test.ts` "404 for a malformed provider path segment" | IMPL+TESTED |

## V2 Validation and business logic
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Schema validation at every boundary | L2 | Zod strict objects | `app.http.test.ts`; many "rejects unknown fields" tests (`checkout.http.test.ts`, `privacy.http.test.ts`) | IMPL+TESTED |
| Money in integer piastres, single rounding point | L3 | `packages/domain/src/money.ts` | `money.test.ts`, `money.mutation.test.ts`; `checkout/test/property.test.ts` | IMPL+TESTED (int64 bound gap noted in older LED-T4) |
| Double-entry invariants (domain and DB) | L3 | `ledger.ts`; deferred trigger; chain | `ledger.test.ts`, `ledger.mutation.test.ts`; `ledger/adapters/kysely-store.pglite.test.ts` | IMPL+TESTED |
| Explicit state machines, invalid transitions rejected | L2/L3 | `packages/domain/src/state-machine`, per-module domain | `orders/test/orders.http.test.ts` "409 invalid_transition"; module domain tests. Property test of unreachable states: not found | IMPL+TESTED (unit); property reachability NOT-IMPL (VERIFY) |
| Idempotency and replay protection on money calls | L3 | `packages/idempotency`, interceptor, outbox/inbox | `idempotency.test.ts`, `mutation-kill.test.ts`; `outbox.test.ts`; `checkout/test/saga.test.ts` | IMPL+TESTED |
| Client totals never trusted | L3 | Server recompute | `checkout.http.test.ts` price-change 409 | IMPL+TESTED |
| Anti-automation (OTP, referral) | L2 | Limits, attestation signal | `auth.privacy.http.test.ts`, `referrals.test.ts` | IMPL+TESTED (attestation verifier is a fixture) |
| Anti-automation (checkout, drops, gift cards) | L2 | App Attest on checkout, drop limits | none found | NOT-IMPL |
| Reservation concurrency, no oversell | L2/L3 | SKIP LOCKED pool | `inventory/test/application.test.ts`, `kysely-store.pglite.test.ts`; `tooling/db/inventory-concurrency.sh` | IMPL+TESTED (10k acceptance not a CI gate) |

## V3 Web frontend
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| CSP with nonces, frame-ancestors none | L2 | `apps/admin-web/src/security/csp.ts`, `apps/seller-web/src/csp.ts` via `proxy.ts` | `admin-web/src/security/csp.test.ts`, `seller-web/src/test/csp.test.ts` | IMPL+TESTED (header unit tests; no browser/DAST run) |
| Cookie attributes, CSRF | L2 | session handling in admin-web | `admin-web/src/session/refresh.ts`; no CSRF test found | IMPL-UNTESTED (VERIFY) |
| Referrer/Permissions policy, no third-party script | L2 | in CSP/proxy | csp tests (partial) | IMPL+TESTED (partial) |

## V4 API and web service
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Method/content-type allow-list, size limits, timeouts | L2 | Nest controllers explicit; problem+json | `app.http.test.ts`; request body-size cap and 10 s timeout not found | IMPL-UNTESTED for caps/timeouts |
| Schema-validated requests, explicit serializers | L2 | Zod, view mappers | `price-integrity/test/http.authz.test.ts` "no seller-private fields" | IMPL+TESTED (per module) |
| Webhook authenticity | L3 | HMAC raw body, window, IP list, dedup | `payments/test/http.test.ts`, `application.test.ts`; courier webhooks `fulfillment` tests | IMPL+TESTED (fixtures) |
| Rate limits | L2 | `platform/rate-limit.guard.ts`, `@RateLimit` fail-open/closed | `app.http.test.ts`; auth limit tests | IMPL+TESTED in-process; Redis-backed shared limiter NOT-IMPL (VERIFY) |

## V5 File handling
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Upload validation, AV scan, EXIF strip, re-encode | L2 | none found | `catalog/imports` handles rows only | NOT-IMPL |
| Private storage, signed URLs <= 15 min | L2 | export ZIP signed URL 24 h (spec says 24 h for exports) | `privacy.http.test.ts` | IMPL+TESTED for exports; image buckets NOT-IMPL |

## V6 Authentication
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Passkeys for admin/seller | L2/L3 | `auth-core/src/passkey-counter.ts`, passkey routes, admin gate | `auth-core/src/auth.test.ts`; `admin.http.test.ts` "no passkey 403" | IMPL+TESTED with fake verifier; real WebAuthn adapter NOT-IMPL |
| OTP lifecycle | L2 | 6 digits, TTL, attempts, single use | `auth.privacy.http.test.ts` | IMPL+TESTED (in-memory); keyed-hash at rest: tested in identity test "stores only keyed identifiers" |
| Federated token verification | L2 | Apple/Google verifier | `auth.identity.http.test.ts` | IMPL+TESTED (local keys; live JWKS NOT-IMPL) |
| Recovery and account merge | L2 | none | n/a | NOT-IMPL |
| Anti-enumeration, brute force | L2 | indistinguishable failures, caps | `auth.privacy.http.test.ts` | IMPL+TESTED |
| Step-up for sensitive actions | L3 | store-credit forfeiture ack, break-glass | `privacy.http.test.ts` "requires acknowledging the forfeiture"; admin elevations | IMPL+TESTED for admin/privacy; IBAN-change step-up NOT-IMPL |

## V7 Session management
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Refresh rotation, reuse detection | L2 | `auth-core/src/refresh-token.ts` | `auth.identity.http.test.ts` "reuse detection..." | IMPL+TESTED (in-memory) |
| List/revoke own sessions | L2 | `/me/sessions` | same file; `auth.privacy.http.test.ts` | IMPL+TESTED |
| Short admin sessions, IP restriction for Finance | L3 | passkey session; IP allow-list not found | `admin.http.test.ts` | IMPL+TESTED (passkey), IP list NOT-IMPL |
| Device binding / attestation | L2 | signal required on OTP, age gate | auth tests | IMPL+TESTED (fixture); real attestation NOT-IMPL (ADR-0026 Proposed) |

## V8 Authorization
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Deny by default, central policy | L2/L3 | `platform/policy.guard.ts`, `packages/policy` | `app.http.test.ts` "denies a route with no authorization declaration"; `packages/policy/src/matrix.test.ts`, `property.test.ts`, `mutation-kill.test.ts`; `apps/api/test/authz-matrix.test.ts` | IMPL+TESTED |
| BOLA, 404 for not-owned | L2/L3 | guard + RLS | negative-authorization tests in orders, payouts, payments, checkout, returns, price-integrity, privacy | IMPL+TESTED |
| Postgres RLS | L2/L3 | `0007_rls_and_grants.sql` and per-module migrations | `*/kysely-store.pglite.test.ts` (payouts, ledger, price-integrity); `platform/db/persistence.test.ts` "RLS through the unit of work" | IMPL+TESTED (PGlite; real PG16 via script only) |
| BFLA admin/seller/finance | L3 | role + audience + passkey | `admin.http.test.ts` matrix; `ledger.http.test.ts` | IMPL+TESTED |
| Mass assignment/BOPLA | L2 | strict DTOs | strict-schema tests | IMPL+TESTED |
| Dual approval, separation of duties | L3 | approvals, thresholds | `admin.http.test.ts` | IMPL+TESTED |

## V9 Self-contained tokens
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Algorithm allow-list, signature, kid, no none | L2 | ID-token verifier | `auth.identity.http.test.ts` "alg none and HS256 confusion" | IMPL+TESTED (inbound IDPs) |
| Own access token claims, 10 min, `amr` | L2 | format not verified in this pass | `apps/api/src/config/env.ts` | IMPL-UNTESTED / VERIFY |

## V10 OAuth and OIDC
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| OAuth client to Apple, Google, seller channels | L2 | Apple/Google ID token only; seller channels not built | auth tests | IMPL+TESTED (sign-in); channels NOT-IMPL |
| Authorization server requirements | L2 | not issuing tokens to third parties | n/a | N/A |

## V11 Cryptography
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Key management policy and rotation | L2/L3 | `crypto-inventory.md`; no KMS adapter | `docs/security/crypto-inventory.md` | NOT-IMPL (document only) |
| Crypto inventory discovery | L3 | CI scan | none | NOT-IMPL |
| Post-quantum plan | L3 | document | crypto-inventory | NOT-IMPL |
| Approved algorithms, single wrapper | L2 | `packages/idempotency/src/sha256.ts`, HMAC in webhooks | `payments/adapters/hmac-webhook.ts` tests | IMPL+TESTED (HMAC); no wrapper lint |
| CSPRNG | L2 | `apps/mobile/src/platform/random.ts`; server OTP | auth tests | IMPL-UNTESTED (randomness source not asserted) |
| Envelope encryption of P3 + blind index | L3 | keyed identifiers present; KMS envelope absent | `auth.identity.http.test.ts` "stores only keyed identifiers" | IMPL+TESTED (keyed hashes); field encryption NOT-IMPL |

## V12 Secure communication
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| TLS 1.2+/HSTS | L2 | `infra/terraform` edge | none run | NOT-IMPL (IaC unverified, VERIFY) |
| Internal/DB encryption | L2 | `infra/terraform/policy` | Conftest policies exist; not verified | IMPL-UNTESTED |
| Outbound TLS validation, timeouts, breakers | L2 | PSP router breaker | `payments/test/application.test.ts` breaker tests | IMPL+TESTED (breaker); TLS config NOT-IMPL |

## V13 Configuration
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Secrets scanning | L2 | gitleaks | `.github/workflows/ci.yml` job `secret-scan`, `.github/gitleaks.toml` | IMPL-UNTESTED (CI tool) |
| Hardened defaults, no debug in prod | L2 | production boot refuses fakes | `payouts/test/module-boot.test.ts`, `reconciliation/test/module-boot.test.ts`, `checkout/test/module-boot.test.ts` | IMPL+TESTED |
| Environment separation | L2 | `infra/terraform/environments` | none | IMPL-UNTESTED |
| SBOM, signing, provenance | L2 | `sbom.yml`, `release.yml`, ADR-0015 | workflows exist; no run evidence in repo | IMPL-UNTESTED |
| Architecture boundaries | L2 | dependency-cruiser | CI job `boundaries`; `apps/admin-web/src/boundaries.test.ts` | IMPL+TESTED |
| Kill switches fail closed | L2 | `packages/feature-flags` | `payments/test/flags.test.ts` | IMPL+TESTED (in-memory provider only) |

## V14 Data protection
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Data classification and inventory | L2 | `docs/privacy/data_inventory.yaml`, `tooling/privacy` | `privacy/exporter-coverage.test.ts` | IMPL+TESTED (exporter vs inventory); "new column must be tagged" CI check VERIFY |
| Minimization in analytics | L2 | `packages/analytics` guards | `packages/analytics/src/catalog.test.ts`, `events-doc.test.ts` | IMPL+TESTED |
| Retention and deletion | L2 | deletion worker, 14-day cooling | `privacy.http.test.ts`; adversarial erasure tests | IMPL+TESTED (deletion); scheduled retention purges NOT-IMPL |
| Client storage protection | L2 | `apps/mobile/src/platform/secure-storage.ts` | `secure-storage.test.ts` | IMPL+TESTED |
| Backups and exports protected | L2 | export signed URL; DPO audit | `privacy.http.test.ts`; backup config not verified | IMPL+TESTED (exports); backups NOT-IMPL (IaC unverified) |
| Immutable financial records | L3 | append-only, chain | `ledger/adapters/kysely-store.pglite.test.ts`; `payouts/test/migration.test.ts`; `price-integrity` append-only test | IMPL+TESTED |

## V15 Secure coding and architecture
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Threat models per module | L2 | `threat-models/01`-`09` + older 13 | review sign-off absent | IMPL-UNTESTED (draft, unreviewed) |
| Unsafe consumption of third-party APIs | L2 | schema-validated provider responses, fixtures | `payments/test/paymob.test.ts`, `checkout/test/recorded-fixture.test.ts` | IMPL+TESTED (fixtures) |
| Strict types and banned patterns | L2 | tsconfig, ESLint | CI jobs `verify` (typecheck, lint) | IMPL-UNTESTED (enforced by CI, not a test) |
| Concurrency safety | L2/L3 | unique keys, SKIP LOCKED, inbox | `outbox.test.ts`, `chaos.test.ts` | IMPL+TESTED |
| Pure domain, injected clock | L2 | dependency-cruiser; coverage gate | CI `boundaries`, `coverage` | IMPL+TESTED |
| Mutation score >= 80% on critical modules | L3 | Stryker | `package.json` script `mutation` covers `packages/domain` only; `*.mutation.test.ts` | IMPL+TESTED for money/ledger; refunds, reservation, promotions, billing NOT-IMPL |

## V16 Logging and error handling
| Area | Lvl | Control | Evidence | Status |
|---|---|---|---|---|
| Security event logging with actor, action, target | L2/L3 | audit sink; `0005_audit_log.sql`; decisions audited | `admin.http.test.ts` "denied decisions are written to the platform audit sink"; `ledger.http.test.ts` | IMPL+TESTED (sink); DB hash-chain on audit_log wiring VERIFY |
| Log redaction | L2 | card-data guard on module source; logger redaction not found | `payments/test/saq-a.test.ts` "module source never logs" | IMPL+TESTED (payments), general logger NOT-IMPL |
| Log integrity, WORM | L3 | none | n/a | NOT-IMPL |
| Generic errors, problem+json, request id | L2 | `platform/problem.filter.ts` | `app.http.test.ts` "readiness reports 503 ... never leaks details", unknown route problem | IMPL+TESTED |
| Alerting and incident response | L2 | `tooling/observability` generates burn-rate rules; runbooks | `tooling/observability/test/burn-rate.test.mjs`, `generate.test.mjs` | IMPL+TESTED (generator); no live alert delivery |

## V17 WebRTC
N/A: no WebRTC in scope. Reopen if live commerce video is added.

## Counts and gaps
Row counts by leading status on 2026-10-11 (73 rows): IMPL+TESTED 52, IMPL-UNTESTED 11, NOT-IMPL 9, N/A 1. A row with a mixed status (for example tested for the sign-in path, not implemented for the channel path) is counted under its first status, so the NOT-IMPL count is a lower bound. Top gaps: real PSP/WebAuthn/attestation/JWKS adapters; scheduler for integrity job, sweeper, reconciliation and payouts; upload pipeline; KMS envelope encryption; audit log WORM/chain verification; real-PG16 in CI; pen test not commissioned; official requirement-ID expansion.
