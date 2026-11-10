# OWASP API Security Top 10 (2023) → controls → tests

- **Status:** Draft v1 (2026-11-07). All rows **not started** (no application code yet).
- **Surface:** NestJS API (`/v1`), webhook receivers, Next.js server routes, admin namespace.
- **Links:** test IDs from `docs/security/threat-models.md`; `API-T##` tests are defined at the end of this file. Adapted from `/Users/nadakhalifa/OUTLET/docs/security/api-top10.md`.
- Item names follow the 2023 edition; confirm the list against the published OWASP page at pen-test scoping (⚠ VERIFY, part of V65).

| Item | Risk for Outlex | Where it bites | Controls | Proving tests |
|---|---|---|---|---|
| **API1:2023 Broken Object Level Authorization** | Reading or changing another shopper's order, address or return, or another seller's listing, payout or statement by id | Orders, addresses, returns, seller listings, statements, payouts, DSAR exports, Price Watch channels | Central `policy` guard on every route (lint rule: route without guard fails); Postgres RLS on every tenant table (`FORCE`, non-owner role, `SET LOCAL` per transaction); not-owned → 404; UUIDv7 ids (not a security control) | API-T01, POL-T01, POL-T03, POL-T05, LED-T07 |
| **API2:2023 Broken Authentication** | OTP brute force, SMS pumping, refresh replay, forged federated tokens, weak seller/admin auth | `/v1/auth/*`, every authenticated route | OTP limits and keyed hash; passkeys mandatory for sellers/admins; 10 min JWT with alg allow-list; rotating refresh with family revoke; Turnstile before OTP send | AUTH-T01 to AUTH-T11 |
| **API3:2023 Broken Object Property Level Authorization** | Mass assignment (seller sets `verified_discount`, `grade`, `status`, `commission_bps`); over-exposure (buyer PII to sellers, IBAN, cost data) | Listing wizard, profile, seller order views, admin views | Zod `.strict()` allow-list DTOs; explicit response serializers; field-level policy for P2/P3; server-computed fields never accepted | CAT-T01, API-T02 |
| **API4:2023 Unrestricted Resource Consumption** | Search abuse, huge pages and bodies, LLM cost, SMS bills, export floods, bulk imports, image uploads | Search, NL parse, listing copilot, OTP, CSV import, exports, uploads | Rate-limit table (threat-models §0); page size ≤ 50 keyset; facets ≤ 30; body and upload caps; 10 s timeout; LLM token budgets + cost breaker; SMS spend breaker | API-T03, SRCH-T01, LLM-T06, AUTH-T09, CAT-T07 |
| **API5:2023 Broken Function Level Authorization** | Shopper or seller reaching admin, finance, refund approval, kill switches; seller staff role escalation | `/v1/admin/*`, seller owner-only actions, payouts | Separate namespaces and token audiences; deny by default; dual approval for money and role grants; seller team roles enforced in policy | POL-T02, ADM-T02, LED-T04 |
| **API6:2023 Unrestricted Access to Sensitive Business Flows** | Drop scalping, card testing, COD fake orders, referral and voucher farms, review fraud, price-check abuse | Drops, checkout, OTP, referrals, vouchers, reviews, `POST /v1/seller/listings/{id}/price-check` | Waiting Room signed tokens; per user/device/payment-fingerprint caps; Turnstile/attestation; card-testing rules; COD risk score and caps; multi-account graph; per-store price-check budget | INV-T02 to INV-T04, PAY-T06, PAY-T10 |
| **API7:2023 Server Side Request Forgery** | Seller-supplied website/feed URLs, image import URLs, webhook callback targets | Price Watch connectors and crawler, image import | Verified domains only; resolve-then-check IP against private/loopback/link-local/metadata ranges; IP pinning (anti-rebinding); ≤ 3 redirects re-checked; HTTPS only; egress allow-list proxy; no internal credentials on crawler | PW-T01, PW-T02, API-T04 |
| **API8:2023 Security Misconfiguration** | Verbose errors, permissive CORS, debug routes, missing headers, middleware-only auth (CVE-2025-29927), cache of private responses | Edge, web, API, buckets | Production profile, Problem+JSON without stack traces; CORS allow-list; security headers; strip `x-middleware-*` at edge; `no-store` on private routes; IaC scanning | API-T05, API-T08, POL-T07, SEO-T04 |
| **API9:2023 Improper Inventory Management** | Shadow or old endpoints, undocumented webhooks, staging reaching prod data, unknown market routes | Whole API, `/v1`, staging | OpenAPI generated from code is the only route catalog; route-inventory test; `Sunset` header and ≥ 6 months deprecation; staging synthetic data and separate credentials | API-T06, API-T09 |
| **API10:2023 Unsafe Consumption of APIs** | Trusting PSP, BNPL, courier, ETA, SMS, LLM and Shopify/Woo responses; slow upstreams; amount mismatches | All adapters | Zod validation of every upstream response; timeouts, retries with jitter, circuit breakers; webhook amounts compared with local intent; upstream text never executed; LLM output schema-checked | API-T07, PAY-T02, PAY-T08, LLM-T03 |

## API tests defined here

| ID | Test |
|---|---|
| API-T01 | Generated from OpenAPI: for every route with an object id, user/store A requesting B's object → 404 and no side effect (two shoppers, two stores, every role) |
| API-T02 | CI diff of generated response schemas against an allow-list of P2/P3 fields; a new sensitive field fails the build |
| API-T03 | Oversized body, page size 51, 31 facets → Problem+JSON 400/413 with bounded resource use |
| API-T04 | Outbound URL validator rejects private ranges, non-HTTPS, redirects to private ranges, rebinding fixtures |
| API-T05 | Staging scan: CORS allow-list only, no stack traces in 4xx/5xx bodies, no debug routes |
| API-T06 | Deprecated version returns `Sunset` header and keeps behaviour until the date |
| API-T07 | Each adapter has hostile fixtures (malformed, oversized, slow, wrong amount/currency); the module returns a typed error and trips its breaker, never an unhandled exception |
| API-T08 | Header scan: CSP with nonce, HSTS, nosniff, Referrer-Policy, COOP, frame-ancestors on every web route |
| API-T09 | Route inventory: every route in the running app exists in the OpenAPI document and has a policy guard, an idempotency guard (if mutating) and pagination (if a list) |

## Residual risk
- BOLA (API1) is the most likely real defect. API-T01 must run before the first route that takes an id is merged.
- API6 edge controls depend on the Cloudflare plan (⚠ V48).
- Courier webhooks may not support HMAC (⚠ V43); compensate with polling and transition validation (SHIP-T01).
