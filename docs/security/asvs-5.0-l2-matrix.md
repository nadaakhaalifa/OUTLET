# OWASP ASVS 5.0 control matrix (skeleton)

- **Status:** Draft skeleton v1 (2026-11-07). Every row status is **not started** (no application code yet).
- **Target:** Level 2 for the whole web and API. **Level 3** for ledger, payments/checkout, payouts and the admin console (BUILD-PROMPT §4).
- **Granularity:** chapter and area level only. ASVS 5.0.0 (May/June 2025) renumbered every requirement, and the official text is not in this repository. **⚠ VERIFY: before the external pen test, expand every row to the exact ASVS 5.0.0 requirement IDs from the official OWASP release.** Do not reuse ASVS 4.x IDs. Chapter titles below are from memory of the 5.0 structure and must also be checked (⚠ VERIFY).
- **Links:** threat test IDs refer to `docs/security/threat-models.md`. Ledger invariants refer to `docs/specs/ledger-chart-of-accounts.md` §5.
- **Status vocabulary:** not started · in progress · implemented (untested) · implemented + tested (evidence path) · N/A (with reason).

| Ch. | Requirement area | Level | Our control | Owning module | Test / evidence location | Status |
|---|---|---|---|---|---|---|
| **V1 Encoding and Sanitization** | Output encoding for HTML, attributes, JS, URLs | L2 | React escaping; lint bans `dangerouslySetInnerHTML`; CSP nonces | web (all apps) | CAT-T04; `apps/web/test/xss/*` | not started |
| V1 | Injection prevention (SQL, search filters, OS) | L2 | Parameterized queries only (Kysely/Prisma); lint bans raw SQL concatenation; search filters from Zod objects | all API modules, search | SRCH-T03; Semgrep rules in CI | not started |
| V1 | CSV/formula injection in exports | L2 | Neutralize `= + - @` leading cells in every CSV export | seller analytics, admin exports | `exports/test/csv-formula.test.ts` | not started |
| V1 | Safe deserialization and parsing of untrusted HTML (crawler) | L2 | Sandboxed parser with size/time caps | pricing-integrity (Price Watch) | PW-T06 | not started |
| **V2 Validation and Business Logic** | Schema validation at every boundary (HTTP, queue, webhook, env, DB JSON) | L2 | Zod `.strict()` everywhere | platform | `app.http.test.ts` unknown-field tests | not started |
| V2 | Money correctness: bigint minor units, single rounding point, double entry | **L3** | Ledger spec P1–P10 | ledger | Ledger I1–I24 property tests; Stryker ≥ 80% | not started |
| V2 | Business flow order and state machines | L2 / **L3** money | Explicit state machines; invalid transition → typed 409 | orders, payouts, refunds, returns | Per-machine unit + reachability property tests | not started |
| V2 | Anti-automation on sensitive flows (OTP, checkout, drops, price check, reviews, referrals) | L2 | Rate-limit table + Turnstile/attestation + per-identity limits | auth, checkout, inventory, pricing-integrity | AUTH-T09/T10, PAY-T06, INV-T02/T04 | not started |
| V2 | Idempotency and replay protection on writes | **L3** | `Idempotency-Key` UUIDv7, 24 h store, hash mismatch → 422 | platform, checkout, ledger | PAY-T03; ledger I5 | not started |
| V2 | Client-side values never trusted (prices, totals, discounts) | **L3** | Server recompute in checkout saga | checkout | PAY-T02, INV-T07 | not started |
| **V3 Web Frontend Security** | Content Security Policy with nonces, no `unsafe-inline`; Trusted Types where feasible | L2 | Per-request nonce; strict-dynamic | web | `apps/web/test/csp.test.ts`; ZAP baseline | not started |
| V3 | Cookie attributes and CSRF | L2 / **L3** admin | `HttpOnly; Secure; SameSite`; CSRF token on cookie-auth forms; Origin check | web, admin | ADM-T04 | not started |
| V3 | Security headers (HSTS preload, nosniff, Referrer-Policy, COOP, frame-ancestors) | L2 | Edge + Next.js headers config | web, edge | API-T08 (header scan) | not started |
| V3 | Third-party script control on payment pages (SAQ A eligibility) | **L3** | Script inventory, SRI, payment-page DOM hash monitor | checkout web | PAY-T05 | not started |
| **V4 API and Web Service** | HTTP method and content-type allow-list; request size limits; timeouts | L2 | Nest defaults overridden; body cap; 10 s timeout | platform | API-T03 | not started |
| V4 | Webhook authenticity | **L3** | IP allow-list + HMAC raw body + ±5 min + dedup | payments, fulfillment, pricing-integrity | PAY-T01, SHIP-T01, PW-T04 | not started |
| V4 | Rate limiting and 429 semantics | L2 | Redis GCRA (Lua) + edge rules; `Retry-After` | platform | AUTH-T10, SRCH-T01 | not started |
| V4 | API inventory, versioning, deprecation | L2 | OpenAPI generated from code; `Sunset` header | platform | API-T06, API-T09 | not started |
| **V5 File Handling** | Upload validation (type sniff, size, AV scan, re-encode, EXIF/GPS strip) | L2 | Upload pipeline | catalog (photos, defect photos), returns (photos), KYC docs | CAT-T03, RET-T04 | not started |
| V5 | Private storage and short-lived signed URLs (≤ 15 min; DSAR export ≤ 24 h) | L2 | Private buckets | catalog, privacy | PRIV-T02 | not started |
| **V6 Authentication** | OTP lifecycle, attempt limits, keyed hash at rest | L2 | Auth spec | auth | AUTH-T01, AUTH-T10 | not started |
| V6 | Passkeys (WebAuthn) mandatory for sellers and admins | L2 / **L3** admin | Passkey + TOTP recovery | auth, admin | AUTH-T04, ADM-T01 | not started |
| V6 | Account recovery and recycled phone numbers | L2 | Second factor on stale number + new device | auth | AUTH-T02 | not started |
| V6 | Federated identity (Apple/Google) token validation | L2 | JWKS, iss/aud/exp/nonce | auth | AUTH-T03 | not started |
| **V7 Session Management** | Short access tokens, rotating refresh tokens, reuse detection | L2 | 10 min JWT; opaque device-bound refresh, family revoke | auth | AUTH-T08, AUTH-T11 | not started |
| V7 | Session listing and revocation by the user; logout | L2 | `GET/DELETE /v1/me/sessions/{id}` | auth | AUTH-T06 | not started |
| V7 | Re-authentication for sensitive actions (IBAN, export, payout approval) | **L3** money/admin | Step-up with passkey | auth, payouts, privacy | LED-T03, PRIV-T01 | not started |
| **V8 Authorization** | Deny by default; object-level checks (BOLA) → 404 | L2 | Central `policy` guard | policy | POL-T01 | not started |
| V8 | Function-level checks (BFLA) → 403 | L2 / **L3** admin | Role from server-side policy; separate audiences | policy, admin | POL-T02 | not started |
| V8 | Tenant isolation in the database (RLS) | L2 | `FORCE ROW LEVEL SECURITY`, non-owner role, `SET LOCAL` per transaction | policy, db | POL-T03 to POL-T06 | not started |
| V8 | Dual control (maker/checker) for money and role changes | **L3** | Dual approval | admin, payouts | LED-T04, ADM-T02 | not started |
| **V9 Self-contained Tokens** | JWT algorithm allow-list, audience, expiry, key rotation | L2 | Asymmetric keys in KMS; JWKS rotation | auth | AUTH-T05 | not started |
| V9 | Signed drop admission tokens | L2 | Short TTL, bound to user + device | inventory/drops | INV-T03 | not started |
| **V10 OAuth and OIDC** | As OAuth client (Apple, Google, Shopify): state, PKCE, exact redirect URIs | L2 | Library-backed flows | auth, pricing-integrity | AUTH-T03, PW-T08 | not started |
| V10 | As authorization server (issuing tokens to third parties) | — | N/A in Phase 1: we do not issue tokens to third parties. Re-assess if a public API ships | — | — | N/A |
| **V11 Cryptography** | Approved algorithms; KMS envelope encryption for P3 fields; blind indexes (HMAC) | L2 / **L3** money | Crypto inventory; yearly key rotation | platform, privacy | `docs/security/crypto-inventory.md` (to write); `crypto.test.ts` | not started |
| V11 | Secure random (OTP, gift-card codes, share tokens, idempotency keys) | L2 | CSPRNG only; lint bans `Math.random` in server code | auth, wishlists | lint rule test | not started |
| V11 | Post-quantum migration planning | **L3** | Entry in crypto inventory | platform | crypto inventory | not started |
| **V12 Secure Communication** | TLS 1.2+ (prefer 1.3), HSTS preload | L2 | Edge + origin TLS config | edge, infra | TLS scan in CI/staging | not started |
| V12 | Internal service TLS / mTLS; egress through allow-list proxy | L2 / **L3** payments | Proxy for PSP, courier, crawler, LLM | infra | PW-T01, API-T04 | not started |
| **V13 Configuration** | No secrets in code or images; secrets manager; OIDC from CI | L2 | gitleaks, secrets manager | infra | SUP-T02, SUP-T05 | not started |
| V13 | Dependency and build integrity (SBOM, provenance, pinned actions, min release age) | L2 | §2 supply-chain rules | infra | SUP-T01 | not started |
| V13 | Production profile: no debug routes, generic errors, strict CORS | L2 | Config as code | platform | API-T05 | not started |
| V13 | Strip internal framework headers at the edge (CVE-2025-29927 class) | L2 | Cloudflare transform rule | edge | POL-T07 | not started |
| **V14 Data Protection** | Data classification (P0–P3) on every column; RoPA; retention jobs | L2 | `data_inventory.yaml`; CI fails on untagged column | privacy | PRIV-T05 | not started |
| V14 | Sensitive data not in logs, URLs, caches or analytics | L2 | PII-redacting logger; `no-store` on private routes | platform, web | SEO-T04; log scan | not started |
| V14 | Consent-gated client SDKs | L2 | SDKs after consent only | web, privacy | PRIV-T04 | not started |
| V14 | Data residency per market cell | L2 | ADR-0002 / ADR-0006 #6 | infra, privacy | ⚠ V2 | not started |
| **V15 Secure Coding and Architecture** | Hexagonal modules, pure domain, dependency-cruiser fitness functions | L2 | CI gate | all | dependency-cruiser report | not started |
| V15 | Concurrency safety (reservations, payouts, idempotency races) | L2 / **L3** money | SKIP LOCKED, unique keys, state machines | inventory, ledger, payouts | INV-T01, LED-T05 | not started |
| V15 | Mass-assignment protection; explicit serializers | L2 | Allow-list DTOs and response mappers | all API modules | CAT-T01, API-T02 | not started |
| V15 | Third-party components inventory and update policy | L2 | Renovate with delay, OSV, ADR-lite per dependency | infra | SUP-T01 | not started |
| **V16 Security Logging and Error Handling** | Security events logged (auth, authz failures, admin actions, money actions) | L2 / **L3** money/admin | Structured logs + hash-chained audit log to WORM | platform, admin, ledger | ADM-T05, LED-T06 | not started |
| V16 | Log integrity and no sensitive data in logs | L2 | Redaction at logger; append-only audit | platform | log scan test | not started |
| V16 | Errors fail safe (fail closed on money/auth) and leak nothing (Problem+JSON) | L2 | Generic errors in production | platform | API-T05 | not started |
| V16 | Alerting tied to incident response (PDPC 72 h) | L2 | Burn-rate alerts; breach runbook | SRE, privacy | PRIV-T06 | not started |
| **V17 WebRTC** | Media/signalling security for live features | — | N/A in Phase 1. Re-assess for V2 live defect walkthroughs and live auctions (addendum #15, #16) | live (V2) | — | N/A |

## Open items
1. ⚠ VERIFY exact ASVS 5.0.0 chapter titles and requirement IDs against the official release; expand each row to IDs before the pen test (proposed verify row **V65**).
2. Write `docs/security/crypto-inventory.md` (not yet in this repo).
3. MASVS v2 matrix is a Phase 2 deliverable (apps).
