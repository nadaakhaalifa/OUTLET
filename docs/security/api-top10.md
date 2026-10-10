# OWASP API Security Top 10 (2023) mapping

Status: Draft for review · Date: 2026-10-10 · Spec refs: §T3, §T5, §A2.9 · Surface: the NestJS modular monolith under `apps/api` and the OpenAPI document generated from it

## State of the code

`apps/api/src/index.ts` exists as a skeleton and no routes are defined. Every control below is `planned` unless a row cites repository code. The repository does hold database-level building blocks for API1, API3 and API5 (RLS and grants), cited in the rows. They have not been executed by any test, so they count as `partial`.

Test IDs of the form `XXX-T##` are defined in `docs/security/threat-models/`. New IDs introduced here are prefixed `API-T` and are listed at the end.

## Mapping

| Item | Risk in Z-OUTLET | Where it bites | Controls | Proving tests | Status |
|---|---|---|---|---|---|
| **API1:2023 Broken Object Level Authorization** | Reading or changing another user's order group, address, session, reservation, ledger statement or seller listing by guessing an ID | Orders, addresses, sessions, reservations, seller stock, statements, DSAR exports, gift-card ownership | Central `policy` guard (ownership, role, tenant) plus Postgres RLS; unknown or foreign ID returns 404; UUIDs not sequential; per-route negative tests generated from OpenAPI | PAY-T02, AUTH-T22, SELL-T07, INV-T10, LED-T11, PRIV-T01, API-T01 (all routes, two users) | partial (RLS in `packages/db/migrations/0007_rls_and_grants.sql`; guard in `packages/policy/src/index.ts` is an empty export) |
| **API2:2023 Broken Authentication** | OTP brute force and pumping, token theft, JWT confusion, weak refresh handling | `/v1/auth/*`, every authenticated route | OTP caps and keyed hash, passkeys mandatory for sellers and admins, JWT algorithm allow-list, 10 minute tokens, rotating hashed refresh with reuse detection, attestation, step-up | AUTH-T01 to AUTH-T11, AUTH-T16 to AUTH-T21 | partial (OTP, age gate, Apple/Google, passkey, refresh, logout implemented over in-memory fixtures with HTTP tests in `apps/api/src/auth.identity.http.test.ts`; JWT signer, JWKS fetch, WebAuthn crypto, App Attest verification and Postgres adapters not built) |
| **API3:2023 Broken Object Property Level Authorization** | Mass assignment (a seller sets a "was price", a shopper sets `status` or `price`), excessive data exposure (on-hand stock, buyer PII, IBAN) | Seller product and import endpoints, profile update, order and seller-order responses | Explicit allow-list DTOs and response serializers; `.strict()` Zod objects; field-level policy for PII fields; no ORM entity returned directly | SELL-T03, SELL-T05, INV-T06, LED-T10, SELL-T08, API-T02 (OpenAPI response schema diff) | planned |
| **API4:2023 Unrestricted Resource Consumption** | Search and filter abuse, huge pages and bodies, LLM cost, SMS pumping bills, export floods, bulk import | `/v1/search`, `/v1/search/parse`, `/v1/stylist/*`, OTP, imports, DSAR | Per-route rate limits, body and upload caps, page size max 50, facets max 30, 10 s default timeout, per-user LLM token budgets and cost breaker, per-prefix SMS budget, queue caps | AUTH-T01, AUTH-T19, LLM-T09, SELL-T10, PRIV-T10, SUP-T07, API-T03 (oversize body and page size) | planned |
| **API5:2023 Broken Function Level Authorization** | Shopper or seller token reaching admin, finance or refund-approval functions; staff granting roles | `/v1/admin/*`, `/v1/seller/*` owner-only actions, payouts, refunds, kill switches | Separate namespaces and token audiences; role resolved server-side by policy; deny by default; dual approval for money functions | ADM-T10, ADM-T11, PAY-T13, SELL-T11, AUTH-T20, LED-T08 | partial (role-based RLS policies in `0007_rls_and_grants.sql`; no routes) |
| **API6:2023 Unrestricted Access to Sensitive Business Flows** | Scalping and hoarding on drops, card testing, referral and promo farms, COD abuse, review fraud, gift-card enumeration | Drops, checkout (`POST /v1/checkout` requires attestation), OTP, referrals, gift-card redeem, reviews, coupons | Per-account, device and IP limits; App Attest and Play Integrity; bot scoring at edge; purchase caps per SKU; COD risk rules; velocity rules; waiting room | INV-T07, INV-T08, PAY-T12, PAY-T14, GIFT-T01, GIFT-T06, GIFT-T08, AUTH-T10 | planned |
| **API7:2023 Server Side Request Forgery** | Seller-supplied channel and image URLs, crawler targets, webhook test endpoints, LLM fetch tools (none) | Crawler, channel connections, seller image import, outbound webhooks | Only seller-verified domains, resolved-IP checks against private and link-local ranges, DNS-rebinding guard, redirect cap, egress allow-listed proxy, no internal credentials on crawler, network policy | PRICE-T01, PRICE-T06, PRICE-T07, API-T04 (webhook target validation) | planned |
| **API8:2023 Security Misconfiguration** | Verbose errors, permissive CORS, debug routes, default credentials, missing headers, TLS downgrade, over-broad IAM | Gateway, API, edge, containers, buckets | Production profile with generic Problem+JSON errors; strict CORS allow-list; security headers; TLS 1.2+ with HSTS; IaC scanning; least-privilege IAM; config as code | API-T05 (header and CORS scan in staging), SUP-T03, SUP-T06, TLS scan | planned |
| **API9:2023 Improper Inventory Management** | Shadow endpoints, old API versions, staging reaching production data, undocumented webhooks | Whole API surface, `/v1` versions, staging | OpenAPI generated from code is the only route catalog; route inventory test; `Sunset` header and 6 month deprecation policy; staging uses synthetic data and separate credentials | SUP-T08, SUP-T06, API-T06 (deprecated version sunset header) | planned |
| **API10:2023 Unsafe Consumption of APIs** | Trusting PSP, courier, ETA, BNPL, SMS and LLM responses; malformed or hostile payloads; slow upstreams | All adapters in `apps/api` | Zod validation of every upstream response; timeouts; retries with jitter; circuit breakers; amounts compared with local state; webhook signatures; never pass upstream text to interpreters | PAY-T01, PAY-T11, NOTIF-T09, LLM-T10, API-T07 (contract tests with hostile fixtures per adapter) | planned |

## New tests defined here

| ID | Test |
|---|---|
| API-T01 | Generated suite: for every route that takes an object ID, user A requesting user B's object receives 404 and no side effect |
| API-T02 | CI diff of generated OpenAPI response schemas against an allow-list of fields flagged P2/P3; new sensitive field fails the build |
| API-T03 | Oversized body, oversized page size and 31 facets are rejected with Problem+JSON and consume bounded resources |
| API-T04 | Webhook and callback target validation rejects private ranges, non-HTTPS and redirects |
| API-T05 | Staging scan: only allow-listed origins in CORS, required headers present, no stack traces in 4xx and 5xx bodies |
| API-T06 | Deprecated version responds with `Sunset` header and retains behaviour until the date |
| API-T07 | Each adapter has a fixture set of malformed, oversized and slow upstream responses; the module returns a typed error and trips its breaker, never an unhandled exception |

## Residual risk and open items

- BOLA is the most likely real-world defect; the generated per-route test (API-T01) is the primary guard and must be wired before the first route that takes an ID ships.
- Bot management vendor and edge product are not chosen; API6 controls at the edge depend on that decision.
- Item names and numbering follow the 2023 edition referenced in the master prompt; confirm against the published list at the pen-test scoping stage. **VERIFY BEFORE LAUNCH.**
