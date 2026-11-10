# STRIDE threat models (Phase 0)

- **Status:** Draft v1 (2026-11-07). Needs security-architect review and a chief-reviewer pass for the two-key modules (auth, policy/RLS, checkout/payments, ledger/payouts, privacy, pricing-integrity).
- **Scope:** Outlex (code name Outlet NK), web-first (Next.js) + NestJS modular monolith + PostgreSQL 16 + Redis + Cloudflare edge. Apps come in Phase 2 (MASVS v2 then).
- **Sources:** BUILD-PROMPT §2, §4, §5; master prompt §T5, Part B; `docs/specs/price-watch.md` §10; `docs/specs/shipping-domestic-international.md`; ADR-0006; `research_notes/Outlet NK engineering standard/security_ratelimit.md` and `anti_vibe_coding.md`. Adapted from `/Users/nadakhalifa/OUTLET/docs/security/threat-models/` (older build).
- **How to read:** S Spoofing · T Tampering · R Repudiation · I Information disclosure · D Denial of service · E Elevation of privilege. Residual risk: **L** low · **M** medium · **H** high (after controls). Every control has a test ID; a control without a passing test is "not done" (BUILD-PROMPT §2.4).
- **Status of all rows:** not started (no application code yet).

---

## 0. System-wide trust boundaries

| ID | Boundary | Crosses it |
|---|---|---|
| TB1 | Internet → Cloudflare edge (WAF, bot score, rate rules, Waiting Room) | All browser and bot traffic |
| TB2 | Edge → Next.js web (SSR/ISR) | Page requests; **internal `x-middleware-*` headers stripped here** |
| TB3 | Web / browser → NestJS API | JSON over HTTPS; JWT or cookie session; Idempotency-Key |
| TB4 | API → PostgreSQL (via PgBouncer, transaction mode) | Non-owner app role, `FORCE ROW LEVEL SECURITY`, `SET LOCAL app.current_store_id` / `app.current_user_id` per transaction |
| TB5 | API → Redis | Rate-limit counters, sold-out flags, waiting-room queue (never truth) |
| TB6 | API / workers → third parties (PSP, BNPL, courier, ETA, SMS/WhatsApp, LLM, maps) | Outbound through an egress allow-list proxy |
| TB7 | Third parties → webhooks | IP allow-list + HMAC over raw body + timestamp ±5 min + event-id dedup |
| TB8 | Crawler workers → seller websites (internet) | Isolated network segment, dedicated egress proxy, no internal credentials |
| TB9 | Admin console → API (admin namespace) | Passkey, SSO + device posture, IP allow-list for Finance/Super-admin |
| TB10 | CI/CD → cloud | OIDC, no long-lived keys, signed artifacts |
| TB11 | Market cell (EG personal/money data) → global layer (public catalog, CDN) | Only P0 public data leaves the cell (ADR-0006 #6, ADR-0002 ⚠ V2) |

### Rate-limit budgets (BUILD-PROMPT §4, starting values, tune by measurement)

| Endpoint | Budget | Algorithm and key |
|---|---|---|
| OTP request | 3 per 15 min per phone, 10 per day per device; EG country codes only at launch; per-prefix spend caps, an SMS spend circuit breaker, and an alert when sends rise but verifications don't (SMS-pumping protection) | Sliding window (phone hash, device); edge rule (IP-with-NAT, ASN) as a coarse first layer |
| OTP verify | 5 attempts per code | Counter on the code record (Postgres), code burned after 5 |
| Search | 30 per 10 s per user | GCRA / token bucket in Redis (atomic Lua), key `route:user` (anon: `route:device`) |
| Checkout | 5 per min per user and per device, plus App Attest / Turnstile | GCRA per user and per device; 1 concurrent checkout per user |
| Gift-card redeem (Phase 2) | 5 failures per hour per account | Sliding window on failures; device + IP/ASN secondary |
| Price check (seller) | 60 per min per store | GCRA, key `route:store` |
| Public shared-wishlist | 20 per min per IP | Edge rule with "IP with NAT support"; app GCRA per IP + token |
| Webhooks | IP allow-list plus HMAC plus a timestamp window of ±5 min | Not a budget: authenticity gate; plus per-provider edge rate rule |

All limited responses are **429 with `Retry-After`**. IETF RateLimit headers are still a draft; do not depend on them.

> **CGNAT note.** Egyptian mobile networks put many users behind one public IP (carrier-grade NAT). **Never block on IP alone.** Prefer user, device (attested) and phone-hash keys; use IP-with-NAT-support or high IP thresholds at the edge plus ASN anomaly alerts. Layering: Cloudflare (IP/ASN/JA4/path, coarse) → NestJS guard with Redis Lua (user, device, route, phone hash) → domain limits in Postgres (per-user drop caps, transactional). Redis down: auth and money routes **fail closed**; catalog read routes fail open with edge limits still active.

---

## 1. Auth (OTP, Apple, Google, passkeys, sessions)

**Assets:** accounts, sessions and refresh families, phone numbers (P3), DOB (P3), passkey credentials, SMS budget.
**Boundaries:** TB1, TB3, TB4, TB6 (SMS/WhatsApp, Apple/Google JWKS).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| S | OTP brute force | 6 digits, 5 min TTL, 5 attempts then burn; keyed hash at rest | L | AUTH-T01 6th attempt fails even with right code |
| S | Recycled phone number takes over an old account | Number unused > 180 days + new device → second factor before stored value shown | M | AUTH-T02 |
| S | Forged Apple/Google ID token | Verify signature against cached JWKS, `iss`, `aud`, `exp`, nonce; algorithm allow-list | L | AUTH-T03 alg=none / wrong aud rejected |
| S | Seller or admin without a passkey | Passkey mandatory for seller and admin roles; TOTP fallback only for recovery | L | AUTH-T04 seller route with OTP-only session → 403 |
| T | JWT tampering / algorithm confusion | Asymmetric signing, fixed alg, audience per app, 10 min TTL | L | AUTH-T05 |
| R | User denies a login or session action | Audit log of login, refresh, revoke (device, IP hash, request id) | L | AUTH-T06 audit row per event |
| I | Account enumeration via OTP or error text | Same response and timing whether the phone exists or not | M | AUTH-T07 response diff test |
| I | Refresh token theft from storage | Opaque, device-bound, hashed at rest; web: `HttpOnly; Secure; SameSite` cookie | M | AUTH-T08 |
| D | **SMS pumping** (toll fraud) | EG prefixes only, per-prefix spend cap, circuit breaker, send-vs-verify ratio alert, Turnstile before send | M | AUTH-T09 non-EG prefix rejected; breaker opens at cap |
| D | OTP flood on one victim | 3/15 min per phone, 10/day per device, exponential resend timer | L | AUTH-T10 |
| E | Refresh-token replay | Rotate on every use; reuse → revoke the family + notify | L | AUTH-T11 |
| E | Under-18 account | DOB gate; device soft-block 30 days; no PII stored on refusal | L | AUTH-T12 |
| E | Stolen access token stays valid until expiry: the 10-min JWT is verified without a database read, so logout or family revocation does not stop it (accepted, finding 13; brief called it AUTH-T11, which is the refresh-replay row above) | Short TTL (10 min); refresh rotation + reuse detection end the family within one TTL; money, payout and admin routes re-check the session family where the policy requires it; logout works with the refresh token when the access token has expired (`logout-by-refresh`) | M (accepted) | AUTH-T13 |
| R | Refresh race across API instances locks out a legitimate client or hides a replay | 10 s grace: a rotated token may be presented once more and returns the same pair (successor re-derived by HMAC, never stored raw); a second use or any use after 10 s is reuse and revokes the family | L | AUTH-T14 |
| S | Device-registration storm to dodge the under-18 block and OTP budgets | Closed budget per IP/ASN (CGNAT multipliers), `DeviceAttestationPort` (Turnstile / App Attest; unconfigured fails closed), per-phone verify budget | M | AUTH-T15 |
| S | Passkey ceremony replay or cross-device use | Challenges in Postgres, single-use, 5-min TTL, bound to device and user; WebAuthn user handle is a random per-user value, userName a masked phone | L | AUTH-T16 |

## 2. Policy / RLS (authorization core)

**Assets:** every tenant row (stores, listings, orders, payouts, statements), buyer PII visible to sellers.
**Boundaries:** TB3, TB4.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| E | **BOLA**: seller A reads seller B's object | Central `policy` guard on every route (ownership + role + tenant), deny by default, not-owned → 404 | M (most likely real defect) | POL-T01 generated per-route test: other tenant → 404, no side effect |
| E | BFLA: shopper or seller reaches admin/finance function | Separate namespaces and token audiences; role from server-side policy | L | POL-T02 wrong role → 403 on every admin and seller route |
| E | Missing RLS on a new tenant table (Lovable CVE-2025-48757 class) | CI fails if a table with `store_id`/`user_id` lacks `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy | L | POL-T03 schema scan + automatic RLS test per tenant table |
| E | App role bypasses RLS | App connects as non-owner, no `BYPASSRLS`; migrations run as a separate owner role | L | POL-T04 `SELECT rolbypassrls` check; owner role unused at runtime |
| I | **Tenant setting leaks across PgBouncer clients** | `SET LOCAL` per transaction only; session-level `SET` banned by lint | L | POL-T05 two interleaved transactions on one pooled connection never see each other's rows |
| T | Missing tenant setting → query sees all rows | RLS policy uses `current_setting('app.current_store_id', true)`; NULL matches nothing | L | POL-T06 query without setting returns 0 rows |
| E | Next.js middleware bypass (CVE-2025-29927 class) | AuthZ only in the API; edge strips `x-middleware-subrequest` and other internal headers; alert on presence | L | POL-T07 request with the header still 401/403 at API; edge rule test |
| R | Admin acts on a tenant without trace | Audit log with reason code on every cross-tenant admin read | L | POL-T08 |

## 3. Catalog and seller listing wizard

**Assets:** listings, defect cards and photos, condition grades, size charts, seller legal identity, uploaded images.
**Boundaries:** TB3, TB4, upload storage, TB6 (LLM copilot, image moderation).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| T | Mass assignment: seller sets `verified_discount`, `status`, `grade_override` | Explicit allow-list DTOs (Zod `.strict()`); server-computed fields never accepted | L | CAT-T01 unknown/protected fields → 400 |
| T | Seller hides defects or upgrades a grade | Required close-up photo per defect; AI only flags, never upgrades; "seen N defects" tick before add-to-bag | M | CAT-T02 publish without defect photo fails |
| T | Malicious upload (polyglot, SVG script, zip bomb) | Type sniffing, size cap, AV scan, re-encode to AVIF/WebP, EXIF/GPS strip, private bucket, signed URLs ≤ 15 min | M | CAT-T03 SVG/polyglot fixtures rejected; EXIF removed |
| I | Stored XSS through titles or descriptions | React escaping, no `dangerouslySetInnerHTML` (lint), CSP nonces, Trusted Types where feasible | L | CAT-T04 payload fixtures render inert |
| S | Counterfeit or impersonating brand store | KYC + brand authorization; pHash duplicate detection across stores; takedown flow | M | CAT-T05 |
| R | Seller denies a price or grade change | Every change is an immutable `price_events` / audit row with actor | L | CAT-T06 |
| D | Bulk CSV import abuse | Row cap, async job with quota per store, dry-run | L | CAT-T07 |
| I | Publishing critical safety defects | Critical defect type blocks publish | L | CAT-T08 |

## 4. Price Watch crawler and channel connectors (SSRF focus)

**Assets:** seller OAuth tokens (KMS), evidence records, internal network, the VRP and "% off" claims.
**Boundaries:** TB8 (crawler → internet), TB6 (Shopify/Woo APIs), TB7 (Shopify/Woo webhooks).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| E/I | **SSRF**: seller domain resolves to `169.254.169.254`, `10/8`, `127/8`, `::1`, link-local | Only verified domains; resolve then check the IP against private, loopback, link-local, metadata ranges; connect to the checked IP; egress proxy denies private ranges too | M | PW-T01 fixture domains for every private range blocked at app and proxy |
| E/I | DNS rebinding between check and fetch | Pin the resolved IP for the request; re-check on every redirect; max 3 redirects; HTTPS only | M | PW-T02 rebinding fixture (first public, then private) blocked |
| S | Seller connects a competitor's cheaper site | Domain ownership proof (DNS TXT, meta tag or file); OAuth counts for Shopify/Woo | L | PW-T03 unverified domain → refused |
| S | Forged Shopify/Woo webhook | HMAC on raw body, timestamp window, dedup by event id | L | PW-T04 |
| T | Cloaking: site shows our crawler different prices | Varied UA within policy, shopper "report price", spot checks (residential egress ⚠ V27) | M | PW-T05 |
| T | Hostile HTML attacks the parser or LLM | Sandboxed parser, size/time caps, LLM gets text only as delimited data (LLM01) | M | PW-T06 prompt-injection fixture does not change the extracted price schema |
| R | Seller disputes a finding | Immutable evidence: screenshot, DOM hash, URL, timestamp, rule | L | PW-T07 |
| I | OAuth token leak | KMS envelope, read-only scopes, revocable, never logged | L | PW-T08 log scan for token patterns |
| D | Crawler overloads a seller site or our budget | ≤ 1 req / 5 s per domain, robots.txt respected, kill switch | L | PW-T09 |
| T | Stale evidence keeps a "% off" alive | Evidence > 72 h → no % (fail closed); disconnect → all % removed | L | PW-T10 property: displayed reference ≤ true 30-day min |

## 5. Search

**Assets:** search cluster, catalog index, query logs (PII-free), NL-parse LLM budget.
**Boundaries:** TB1, TB3, TB6 (LLM for NL parse).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| D | Expensive queries, deep pagination, facet explosion | Max 30 facets, page size ≤ 50, keyset cursor only, timeouts, 30/10 s per user | L | SRCH-T01 |
| D | Bulk scraping | Edge per IP/ASN (high, CGNAT-aware) + app per user; cursor-only | M (price data is public by design) | SRCH-T02 |
| T | Injection into the search engine filter syntax | Filters built from a Zod-validated object, never string-concatenated | L | SRCH-T03 |
| T | LLM NL parse produces arbitrary filters | Output schema-constrained; unknown fields dropped; no tools | L | SRCH-T04 |
| I | Suspended or private listings leak via index | Index sync from outbox removes them; PDP re-checks status from Postgres | M (sync lag ≤ 60 s) | SRCH-T05 |
| D | Search engine down | Postgres FTS fallback behind kill switch | L | SRCH-T06 chaos |

## 6. Cart, inventory and drops

**Assets:** stock units, reservations, drop fairness, sold-out flags.
**Boundaries:** TB1 (Waiting Room), TB3, TB4, TB5.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| T | Oversell under concurrency | Row-per-unit, `FOR UPDATE SKIP LOCKED`, sorted SKU lock order, one transaction | L | INV-T01 10k concurrent reserves on 100 units → exactly 100, 0 deadlocks (1,000 runs) |
| D | Reservation hoarding (bots fill carts) | Hold only at checkout start, TTL 10 min, sweeper; per-user/device caps per drop SKU | M | INV-T02 |
| S | Bot bypasses the Waiting Room | Signed admission token (15 min), bound to user + device; checked at API | M | INV-T03 forged/expired/other-user token rejected |
| E | Scalper buys above the per-user limit with many accounts | Limits per user + device + payment fingerprint; multi-account graph | M | INV-T04 |
| T | Redis treated as truth | Redis only a sold-out pre-filter; Postgres decides | L | INV-T05 Redis says available, DB empty → no reservation |
| D | Redis down during a drop | Waiting room fails closed (drop paused); normal checkout continues | L | INV-T06 chaos |
| T | Client changes price or quantity in the bag | Server recomputes everything; max 50 lines, 10 units per SKU | L | INV-T07 |

## 7. Checkout, payments and webhooks

**Assets:** payment intents, captured money, PSP credentials, webhook secrets, card-data scope (SAQ A).
**Boundaries:** TB3, TB6 (PSP/BNPL APIs), TB7 (webhooks), PSP hosted page/iframe.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| S | Forged payment webhook marks an order paid | IP allow-list + HMAC over raw body + timestamp ±5 min + dedup by PSP event id; raw body stored | L | PAY-T01 bad HMAC, stale timestamp, replayed id each rejected |
| T | Client-supplied total | Server recompute in `ValidateCart`; webhook amount compared to intent amount and currency | L | PAY-T02 mismatched amount → no PAID, alert |
| T | Double charge on retries or double taps | `Idempotency-Key` (UUIDv7) stored 24 h; same key different hash → 422; PSP key = order_group_id | L | PAY-T03 |
| R | Shopper or PSP disputes what happened | Raw webhook bodies (7 y), ledger entries, audit log | L | PAY-T04 |
| I | Card data reaches our servers or scripts | PSP hosted page / iframe only (SAQ A); strict CSP with nonces, SRI, script inventory, payment-page DOM hash monitor every 5 min | M | PAY-T05 CSP report on injected script; DOM-hash monitor alert |
| D | **Card testing** through intent creation | 5/min per user and device, Turnstile/App Attest, BIN-diversity and decline-rate rules → block | M | PAY-T06 |
| E | Using a BNPL order to cash out via refunds | Refunds to BNPL only via provider (RefundRouter, ledger I8); fraud signals | L | PAY-T07 |
| D | PSP outage | Circuit breaker, timeout 10 s, failover PSP or kill switch per method | M | PAY-T08 chaos |
| T | Saga crash mid-way → paid without stock or stock without pay | Orchestrated saga with compensations; payment-after-expiry auto-claim or auto-refund | L | PAY-T09 kill API mid-saga: no double charge, no oversell |
| T | COD abuse (fake orders, refusals) | Risk score, caps (1,500 EGP first order), WhatsApp/IVR confirm, refusal policy | M | PAY-T10 |

## 8. Ledger and payouts (L3)

**Assets:** journal entries and postings, seller balances, payout instructions, IBANs (P3), bank credentials.
**Boundaries:** TB4, TB6 (bank/PSP payout API), TB9 (finance admins).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| T | Unbalanced or edited entries | Deferred zero-sum trigger; UPDATE/DELETE revoked; reversals only; hash chain | L | LED-T01 (ledger spec I1, I4, I20) |
| T | Float or rounding drift | bigint only, one `roundHalfEven`, residual seller amount, lint rule | L | LED-T02 (I24, I10) |
| S | Attacker changes a seller's IBAN then triggers payout | IBAN change needs passkey step-up, name match, 72 h payout hold after change, notification to all store managers | M | LED-T03 |
| E | Insider pays out to self | Dual approval above threshold; maker ≠ checker enforced by policy; break-glass logged | M | LED-T04 same admin cannot approve own payout |
| T | Double payout | Idempotent `payout:{id}`; state machine `SCHEDULED → ON_HOLD → APPROVED → SENT → SETTLED/FAILED` | L | LED-T05 |
| R | Finance action without trace | Hash-chained audit log to WORM storage | L | LED-T06 |
| I | Seller sees another seller's statement | RLS + policy; statements keyset-paginated by own store only | L | LED-T07 (POL-T01 subset) |
| D | Reconciliation backlog hides loss | Nightly + intraday jobs; unmatched > 3 days = 0 SLO; alert | M | LED-T08 fixture files with missing/duplicate lines |

## 9. Returns and refunds

**Assets:** refund instructions, store credit, return photos, inspection results.
**Boundaries:** TB3, TB6 (PSP refunds, courier pickups).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| T | Refund above what was paid, or twice | Cumulative refund ≤ captured per line (ledger I9); idempotent refund id | L | RET-T01 |
| E | Refund to a different instrument (laundering) | RefundRouter: original method by default; store credit only where legal; BNPL only to provider | L | RET-T02 |
| T | Return window computed from order date | Windows from courier-confirmed `delivered_at` only | L | RET-T03 day 15 change-of-mind refused; day 29 defect accepted |
| S | Fake "defective" claim with stock photos | Photos required; EXIF-stripped copies; reverse image hash check; seller inspection 48 h; dispute to T&S | M | RET-T04 |
| R | Seller rejects a valid return | Rejection needs photos; shopper can dispute; human review in 5 business days | M | RET-T05 |
| D | Serial returner | Published policy (> 60% over ≥ 10 orders / 6 months) | L | RET-T06 |

## 10. Shipping and couriers

**Assets:** shopper addresses and phones (P2/P3), AWBs, COD cash, courier credentials.
**Boundaries:** TB6 (courier APIs), TB7 (courier webhooks), TB11 (international couriers = cross-border transfer).

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| S | Forged tracking webhook marks "delivered" (starts windows, posts COD) | HMAC/token per courier, dedup by courier event id, status transition must be valid; poll on gaps > 48 h | M (some couriers lack HMAC ⚠ V43) | SHIP-T01 |
| I | Seller keeps buyer PII after delivery | Masked phone where courier supports it; access removed 30 days after closure | M | SHIP-T02 |
| T | Under-declared weight | Courier-measured weight difference charged to seller (ledger entry), accuracy score | L | SHIP-T03 |
| I | International courier receives addresses abroad without a basis | DPA + transfer licence (ADR-0002, ⚠ V2); international off by kill switch until then | M | SHIP-T04 |
| E | Restricted goods shipped abroad | Restricted-item check + destination ban list; HS code required | M | SHIP-T05 |
| D | Courier API down | Queue AWB creation, retry with backoff, "label pending" | L | SHIP-T06 replay all webhooks twice → identical state |

## 11. Privacy and DSAR

**Assets:** personal data export ZIPs, deletion jobs, consent records, breach register.
**Boundaries:** TB3, TB9 (DPO console), TB11.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| S | Attacker requests another user's export | Authenticated + recent re-auth (step-up); export only for the session owner | L | PRIV-T01 |
| I | Export link leaked | Signed URL ≤ 24 h, single user, encrypted ZIP, download audited | M | PRIV-T02 |
| T | Deletion leaves PII in logs, search, analytics or backups | Data inventory drives erasure; PII-redacting logger; backups expire per retention | M | PRIV-T03 all P2/P3 columns for a user are null/pseudonymised after the job |
| I | SDKs collect before consent | SDKs load only after the matching consent | L | PRIV-T04 no analytics request before consent (Playwright network log) |
| I | Untagged new column escapes the RoPA | CI fails on an untagged column in `data_inventory.yaml` | L | PRIV-T05 |
| R | Breach missed or late (PDPC 72 h) | Breach runbook, register, quarterly tabletop | M | PRIV-T06 tabletop evidence |

## 12. Admin console (L3)

**Assets:** all data, kill switches, refunds, payouts, role grants, plan and commission config.
**Boundaries:** TB9, TB3.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| S | Phished admin | Passkey mandatory, SSO + device posture, IP allow-list for Finance/Super-admin | L | ADM-T01 |
| E | Self-granted role or money action | Dual approval for role grants, payouts and refunds above threshold, price/commission changes, data exports | L | ADM-T02 |
| I | Browsing PII without reason | Every PII view logged with a reason code; just-in-time elevation | M | ADM-T03 |
| T | CSRF on cookie-auth admin forms | `SameSite=Strict`, CSRF token, Origin check | L | ADM-T04 |
| R | Admin denies an action | Hash-chained audit to WORM | L | ADM-T05 |
| E | Super-admin misuse | Break-glass only, dual approval, alert on use | M | ADM-T06 |

## 13. SEO, public pages and bots

**Assets:** public catalog pages, sitemaps, JSON-LD and feeds, crawl budget, origin capacity.
**Boundaries:** TB1, TB2, TB11.

| STRIDE | Threat | Control | Residual | Test |
|---|---|---|---|---|
| T | **Stale cached price or "% off" in HTML, JSON-LD or feed** | Price/stock never from stale cache (TTL ≤ 5 s + revalidate by tag); reference price only when VRP-verified | M | SEO-T01 CI: JSON-LD price = rendered price = feed price; unverified item has no reference price |
| T | Cache poisoning via unkeyed headers or query | Cache key allow-list; strip unknown headers; private routes `no-store` | M | SEO-T02 |
| D | Bot flood / stampede on ISR | Edge bot score, single-flight revalidation, jittered TTLs, stale-while-revalidate | M | SEO-T03 k6 burst |
| I | Private routes indexed or cached | `robots.txt` disallow + `noindex` + auth; account pages `Cache-Control: private, no-store` | L | SEO-T04 |
| S | Fake "Googlebot" scraping | Verify search bots by reverse DNS / Cloudflare verified bots; training bots blocked by default (owner D8) | L | SEO-T05 |
| T | UGC link spam | `rel="ugc nofollow"`, moderation | L | SEO-T06 |
| I | Open redirect via slug aliases | Redirects only to internal canonical paths from the DB | L | SEO-T07 |

## 14. LLM copilot features (listing copilot MVP; Arabic assistant, defect vision grader V2; NL search parse)

**Assets:** LLM budget, catalog integrity, prompts, any data sent to the vendor (cross-border ⚠ V2).
**Boundaries:** TB6 via `llm-gateway` only.

| STRIDE | Threat | Control (OWASP LLM Top 10 2025) | Residual | Test |
|---|---|---|---|---|
| T | Prompt injection from seller text or seller websites (LLM01) | Untrusted text passed as delimited data; system prompt forbids following embedded instructions; schema-constrained output | M | LLM-T01 injection golden set |
| I | P2/P3 data to the vendor (LLM02) | PII scrubber; no P3 in prompts; vendor in an approved region or licence | M | LLM-T02 scrubber test on AR/EN fixtures |
| T | LLM writes prices, grades or claims (LLM05) | Output validated against catalog; prices and grades never generated; AI may only flag defects, never upgrade | L | LLM-T03 |
| E | Excessive agency (LLM06) | Read-only tools; any write (publish, add-to-bag) needs a human tap | L | LLM-T04 |
| I | System prompt leak (LLM07) | No secrets in prompts | L | LLM-T05 |
| D | Cost blow-up (LLM10) | Per-user and per-feature token budgets, global cost circuit breaker, cache | L | LLM-T06 breaker opens at budget |
| T | Misinformation in the assistant (LLM09) | "AI suggestion" label; product facts come from the catalog | M | LLM-T07 |

---

## 15. Cross-cutting: supply chain and agent safety (anti-vibe-coding)
| Threat | Control | Test |
|---|---|---|
| Hallucinated or malicious package (slopsquatting) | ADR-lite per new dependency, `minimumReleaseAge` ≥ 7 days, `ignore-scripts`, OSV audit, SBOM, signed provenance | SUP-T01 CI rejects a package younger than 7 days |
| Secret committed | gitleaks pre-commit and CI | SUP-T02 |
| Agent touches prod data | No prod/staging credentials in agent env; deny rules (`.env*`, `DROP`/`TRUNCATE`, force push) | SUP-T03 settings test |
| Tests weakened to pass | CODEOWNERS on tests and CI config; `needs-human` on workflow edits | SUP-T04 |
| Unpinned CI actions | Actions pinned by SHA; OIDC to cloud | SUP-T05 |

## 16. Residual risk summary (top 5)
1. **BOLA** on a new route (M): the generated per-route test POL-T01 must exist before the first route with an id ships.
2. **SSRF / rebinding** in Price Watch (M): dual control (app + proxy) and PW-T01/T02 before the crawler goes live (V2 crawler).
3. **Card testing and COD abuse** (M): depends on the edge bot product (⚠ V48) and real data to tune.
4. **Courier webhook authenticity** (M): depends on courier capabilities (⚠ V43).
5. **Cross-border transfers** (LLM vendor, Sentry/PostHog, international couriers) (M): blocked until ADR-0002 and licences (⚠ V2).
