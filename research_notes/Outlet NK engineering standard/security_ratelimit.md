# Security, rate limiting and abuse prevention (Outlet NK, as of 2026-11-07)

Method note: sources marked [searched] were returned by web searches in this session (2026-11-07). Sources marked [not re-fetched] are canonical references from prior knowledge (cutoff June 2026), cited by URL but not re-checked in this session. Treat their details as UNVERIFIED until someone checks them.

## Rate limiting algorithms, distributed limits, keys and headers

### Takeaway
Use GCRA, or a token bucket that is equivalent to it, in Redis through one atomic Lua script for most per-user, device and route API limits. Use sliding-window counters for long, coarse budgets such as OTP per day and gift-card failures per hour. Put Cloudflare rate-limiting rules in front as the first, IP/ASN-level layer. Return 429 with `Retry-After`. Treat the IETF RateLimit headers as still a draft (-10, Sep 2025).

### Cited Findings
- GCRA is a variant of the leaky bucket. It stores one "theoretical arrival time" (TAT) per key, needs no background drip process, gives a rolling window, and allows a sustained rate plus bursts. redis-cell exposes it as `CL.THROTTLE key burst count period` — [brandur/redis-cell](https://github.com/brandur/redis-cell) [searched]
- Informal benchmark: `CL.THROTTLE` takes a little under 2× the time of a plain Redis SET (figure from the module README; year not stated) — [redis-cell](https://github.com/brandur/redis-cell) [searched]
- A native Redis `GCRA key max-burst tokens-per-period period` command was drafted for Redis 8.8 and based on redis-cell. However, a May 2026 docs patch reverts the GCRA 8.8 content, and a commit is titled "Hold GCRA out of the release". Native availability is UNVERIFIED — [redis/docs PR 3293](https://github.com/redis/docs/pull/3293.patch) [searched]
- Cloudflare rate-limiting rules count by characteristics: IP, IP with NAT support, country, ASN, host, path, JA3/JA4 and a JSON body value. JA3/JA4 needs Enterprise with Bot Management. Advanced Rate Limiting (Enterprise) adds custom counting expressions and complexity-based (score) counting. A visitor who passes a challenge has their counter reset. IP and IP-with-NAT cannot be combined in one rule — [Cloudflare rate limiting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) [searched]
- The IETF draft-ietf-httpapi-ratelimit-headers-10 (updated 2025-09-27) defines the `RateLimit-Policy` and `RateLimit` fields. It is Standards Track, still a draft and not an RFC. A third-party mirror shows a newer "-latest" from 2025-10-13 that is unconfirmed on the datatracker — [IETF datatracker -10](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-10) [searched]
- 429 Too Many Requests with an optional `Retry-After` is defined in RFC 6585 (2012) — [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) [not re-fetched]
- Unrestricted resource consumption is API4:2023, and unrestricted access to sensitive business flows is API6:2023 — [OWASP API Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) [not re-fetched]

### Inferences
- Algorithm choice by endpoint (recommendation, not sourced):
  - **GCRA/token bucket:** search (30/10 s per user), catalog reads and the general API. It allows bursts and costs O(1) memory.
  - **Sliding-window counter (two fixed buckets weighted):** OTP sends (3/15 min per phone, 10/day per device), gift-card failed redemptions (5/h per account, 20/day per device), referral attribution and reviews. Exact long windows matter more here than burst smoothing.
  - **Sliding-window log (sorted set):** only for very low-volume, high-value limits that need exact counts, such as admin export or a payout approve. Memory is O(n).
  - **Fixed window:** avoid. It allows a 2× burst at the window edge.
  - **Leaky bucket as a queue:** use for outbound shaping (SMS provider, courier and PSP calls), not for inbound limits.
  - **Concurrency limits** (semaphore in Redis with TTL): use for checkout per user (1 in flight) and drop admission.
- **Layering:** Cloudflare edge (IP/ASN/JA4 and path, coarse, cheap) → NestJS guard with Redis Lua (user ID, device ID from attestation, route, phone hash) → domain limits in Postgres (per-user drop SKU caps, enforced transactionally).
- **Keys:** use a composite of `route:actor`. Prefer an authenticated user or device over IP, because Egyptian mobile carriers use heavy CGNAT. IP-only limits will hurt real users, so use "IP with NAT support" or high IP thresholds plus ASN anomaly alerts.
- **Fail mode:** if Redis is down, fail open with a conservative in-process limiter for reads, and fail closed for OTP send, gift-card redeem and drops. This is consistent with the master prompt §T9.
- **Headers:** always send `Retry-After`. Emit the draft `RateLimit`/`RateLimit-Policy` behind a flag because the syntax changed across drafts. Don't make the clients depend on it.

### Gaps
- Native Redis GCRA status in the current Redis release. Check the release notes.
- Which Cloudflare plan Outlet NK will buy. JA4 counting needs Enterprise + Bot Management, and pricing was not researched.

## OTP/SMS pumping, checkout, gift cards and search protection

### Takeaway
Decide before the SMS is sent: allow-list +20 (Egypt), require attestation or Turnstile, apply exponential resend delays and per-prefix budgets, and alert on a falling send-to-verify ratio. Industry guidance is vendor-led, and there is no formal standard.

### Cited Findings
- Treat OTP issuance as a protected risk event. Score before dispatch, not with after-the-fact reconciliation — [NHI journal](https://nhimg.org/faq/how-should-security-teams-stop-sms-pumping-before-otp-messages-are-sent/) [searched]
- Use exponential delays between OTP requests to the same number, retry buffers of 30 s to 1 min, and a country-code allow-list — [Unifonic docs](https://docs.unifonic.com/articles/products-documentation/no-sms-fraud/) [searched] (Unifonic is a MENA SMS provider.)
- Detection signals: a collapse in the send-to-verify ratio, sudden concentration on one destination country, and CAPTCHA before send — [Message Central](https://www.messagecentral.com/blog/sms-pumping-fraud-prevention) [searched, vendor claim]
- More than 3 SMS requests per profile is a pumping signal — [Sumsub docs](https://docs.sumsub.com/docs/prevent-sms-pumping-fraud) [searched, vendor]
- Sequential-number patterns and unexpected geographies are further signals. Use adaptive rate limits — [Prelude via plushcap](https://www.plushcap.com/content/prelude/blog/prelude-sms-pumping-fraud-what-it-is-how-to-detect-it-and-how-to-prevent-it) [searched, vendor]
- There is no universal cross-provider standard for this. Searches found no GSMA primary guidance — [NHI journal](https://nhimg.org/?p=67609) [searched]

### Inferences
- The OTP rules in the master prompt §1 (+20 allow-list, 3 per 15 min per phone, 10 per day per device, App Attest) match this guidance. Add these:
  - A global daily SMS spend circuit breaker.
  - A send-to-verify ratio alert, for example when it falls below 60% over 15 min. The threshold is an assumption.
  - Turnstile on web OTP.
  - A WhatsApp fallback only after the attestation check.
- **Checkout:** 1 concurrent checkout per user, about 5 per 10 min per user/device, attestation or Turnstile, and Idempotency-Key. Run card-testing heuristics: many small auths, BIN diversity, and many declines per device. Hosted PSP pages limit exposure, but do not stop auth floods against the intent-creation endpoint.
- **Gift cards:** HMAC'd codes with ≥ 80 bits of entropy (16 Crockford base32 characters), failed-attempt limits per account, device and IP/ASN, and a global anomaly alert. Never reveal whether a code exists separately from whether it is valid.
- **Search:** set the edge limit per IP/ASN high, and the app limit per user. Return cursor-only pagination with a max page size of 50 to block bulk scraping. Price data is public by design (price-proof page), so the goal is to stop cost abuse, not to hide data.

### Gaps
- Egypt-specific SMS pumping incident data: none found.
- Real Egyptian OTP delivery costs and pumping exposure for the chosen SMS provider.

## Bot and abuse management (scalpers, credential stuffing, card testing, scraping, fake accounts)

### Takeaway
Combine edge bot scoring (Cloudflare), client attestation (App Attest / Play Integrity on mobile, Turnstile on web), per-identity purchase limits in Postgres, and a device/payment graph. Proof-of-work is a fallback only.

### Cited Findings
- Passing a Cloudflare challenge resets the rate-limit counter for that visitor, and visitors who trigger the rule again get a new challenge — [Cloudflare](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) [searched]
- JA3/JA4 TLS fingerprints can be used as rate-limit keys (Enterprise + Bot Management) — [Cloudflare](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) [searched]
- Turnstile is Cloudflare's CAPTCHA alternative. Its token must be validated server-side through siteverify, and each token is single-use and short-lived — [Cloudflare Turnstile docs](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) [not re-fetched]
- App Attest (DeviceCheck) gives an Apple-signed attestation of key/app integrity plus per-request assertions — [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity) [not re-fetched]
- The Play Integrity API returns app, device and account integrity verdicts — [Android Play Integrity](https://developer.android.com/google/play/integrity/overview) [not re-fetched]
- API6:2023 (sensitive business flows) explicitly covers scalping and automated purchase of limited stock — [OWASP API Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) [not re-fetched]

### Inferences
- **Drops:** waiting-room token (signed JWT) + attestation + per-user/device/payment-fingerprint/address SKU caps, enforced in the same transaction as reservation. Redis is only a pre-filter.
- **Credential stuffing:** risk is low because logins are passwordless (OTP/passkey). The main risk moves to OTP abuse and SIM-swap or recycled numbers, which master prompt §1's 180-day rule covers.
- **Fake accounts:** phone + device + payment fingerprint graph, plus connected-component detection (already in §15.4).
- **Proof-of-work (e.g. ALTCHA-style):** consider it only where Turnstile is unavailable. It raises cost for bots, but hurts low-end Android phones, which are common in Egypt.

### Gaps
- Waiting-room vendor and pricing (master prompt register #16) not researched.
- Effectiveness data for Turnstile vs PoW: none found.

## OWASP API Top 10 2023, ASVS 5.0 and BOLA prevention

### Takeaway
ASVS 5.0.0 (announced late May 2025) restructured and renumbered every requirement, so map controls fresh and do not reuse v4 IDs. For BOLA, use deny-by-default policy guards plus Postgres RLS, return 404 for objects not owned, and use UUIDv7 as an identifier (not as a security control).

### Cited Findings
- ASVS 5.0 was formally introduced at OWASP Global AppSec EU on 2025-05-30. It is the first major release in about 5 years (one source says 6). It adds new chapters, rebalances the levels, lowers the barrier to Level 1, and provides a two-way v4↔v5 mapping — [AppSec EU session](https://owasp2025globalappseceu.sched.com/event/1whCc/introducing-the-50-release-of-the-asvs) [searched]
- Requirements were renumbered, deduplicated and almost all reworded. v4 L1 had 131 controls — [SoftwareMill](https://softwaremill.com/whats-new-in-asvs-5-0/) [searched]
- Intertek describes 5.0 as a comprehensive restructure with new components — [Intertek](https://assuranceinaction.intertek.com/post/102kghm/owasp-release-version-5-0-of-the-application-security-verification-standard-asvs) [searched]
- The master prompt says "ASVS 5.0.0 (June 2025)". The sources point to a late-May 2025 announcement. This is a minor date conflict, and the exact tag date is unverified.
- API Top 10 2023 list: API1 BOLA, API2 Broken Authentication, API3 BOPLA (object property level), API4 Unrestricted Resource Consumption, API5 BFLA, API6 Sensitive Business Flows, API7 SSRF, API8 Misconfiguration, API9 Inventory, API10 Unsafe Consumption of APIs — [OWASP](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) [not re-fetched]
- Postgres RLS policies apply per row using session settings, for example `current_setting('app.current_store_id')`. Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set, and superusers and BYPASSRLS roles always bypass it — [PostgreSQL docs: Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) [not re-fetched]
- UUIDv7 (time-ordered) is defined in RFC 9562 (May 2024). The RFC warns that UUIDs should not be treated as security capabilities — [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562) [not re-fetched]

### Inferences
- **RLS rules:**
  - The app connects as a non-owner role with no BYPASSRLS.
  - Use `FORCE ROW LEVEL SECURITY` on tenant tables.
  - Set `SET LOCAL app.current_store_id` per transaction. This is required with PgBouncer transaction mode, because a session-level SET leaks across clients.
  - Add a CI test that every tenant table has a policy.
- **Policy layer:** a central `policy` package checks ownership + role + tenant in a NestJS guard. RLS is defense in depth, not the only check.
- **404 vs 403:** return 404 for an object that is not owned or does not exist (prevents enumeration). Return 403 for a role/function denial on a known route (BFLA), as the master prompt A2.10 already states.
- **UUIDv7:** good for index locality. It leaks creation time, which is acceptable for orders but should be avoided for share tokens and gift codes, which use 128-bit CSPRNG values stored hashed. Never rely on unguessability instead of authorization.
- **BOPLA (API3):** explicit DTO allow-lists in and serializers out, matching master prompt §T3.

### Gaps
- Exact ASVS 5.0 chapter list and the release tag date: not fetched.

## Web security headers for Next.js (CSP nonces, Trusted Types, COOP/COEP, HSTS, cookies, CSRF, CVE-2025-29927)

### Takeaway
Generate a per-request nonce in middleware (`proxy.ts` on Next.js 16, unverified) for a strict CSP, and accept dynamic rendering on pages that use nonces. Never rely on middleware alone for authorization: CVE-2025-29927 let attackers skip it entirely with one header.

### Cited Findings
- CVE-2025-29927 (March 2025): Next.js trusted the internal `x-middleware-subrequest` header on external requests, so an attacker could skip middleware, including auth checks. No authentication was needed and exploitation was trivial — [Trevor Lasn](https://www.trevorlasn.com/blog/cve-2025-29927-nextjs-middleware) [searched]; [PoC repo](https://github.com/aydinnyunus/CVE-2025-29927) [searched]
- Patched in 12.3.5, 13.5.9, 14.2.25 and 15.2.3. The affected range starts at 11.1.4, and sources differ on the end point. Mitigation: upgrade, strip or block the header at the proxy, and alert on its presence — [hiperlinx](https://hiperlinx.com/cve/cve-2025-29927-next-js-middleware-bypass-vulnerability/) [searched]
- The official Next.js CSP guide: middleware creates a nonce, sets it in the CSP header and an `x-nonce` header, and Next applies it to its scripts. Server Components read it with `headers()`. Nonces require dynamic rendering. The middleware matcher should exclude prefetches and static assets — [Next.js CSP guide](https://nextjs.org/docs/15/app/guides/content-security-policy) [searched]
- A third-party source says Next.js 16 renames middleware to `proxy.ts`, and that nonce CSP conflicts with `cacheComponents`/PPR static shells. UNVERIFIED against official docs — [c15t](https://c15t.com/docs/frameworks/next/content-security-policy) [searched]
- `Strict-Transport-Security` preload list requirements: max-age ≥ 31536000, includeSubDomains, preload — [hstspreload.org](https://hstspreload.org/) [not re-fetched]
- Trusted Types (`require-trusted-types-for 'script'`) blocks DOM-XSS sinks. Browser support was Chromium-only for years; whether Firefox and Safari support it in 2026 is unverified — [MDN Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) [not re-fetched]
- CSRF: SameSite cookies are defense in depth, not a full CSRF defense. Use tokens or Origin checks for state-changing requests — [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) [not re-fetched]

### Inferences
- **Header baseline for web apps:**
  - `Content-Security-Policy: default-src 'self'; script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-to …`. Payment pages need the PSP's frame/connect origins only.
  - HSTS with preload.
  - `X-Content-Type-Options: nosniff`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Permissions-Policy` minimal.
  - `Cross-Origin-Opener-Policy: same-origin`. Use `same-origin-allow-popups` on pages that open PSP/3-DS popups.
  - Skip COEP `require-corp` unless SharedArrayBuffer is needed. It breaks third-party images and the PSP iframe.
  - Trusted Types in report-only first.
- **Cookies:** `__Host-` prefix, Secure, HttpOnly, SameSite=Lax for the session (Strict for admin), short-lived access token, and rotating refresh token.
- **CSRF:** check Origin/`Sec-Fetch-Site` on all non-GET requests, plus a double-submit token for cookie-authenticated endpoints. Next.js Server Actions compare Origin and Host, but keep the explicit check in the NestJS API.
- **CVE lesson:**
  - Authorization lives in the API (NestJS guard + RLS), never only in Next.js middleware or proxy.
  - Strip `x-middleware-subrequest` and other internal headers at Cloudflare.
  - Pin Next.js to patched versions and subscribe to its advisories.
- Use public product pages with static/ISR and hash-based CSP or no inline scripts, and apply nonce CSP to the account and checkout pages. This keeps the SEO pages cacheable.

### Gaps
- The official Next.js 16 `proxy.ts` and PPR + nonce behaviour were not confirmed.
- Current cross-browser Trusted Types support was not confirmed.

## Supply-chain attacks 2025–26 and mitigations

### Takeaway
Two separate September 2025 npm incidents (the chalk/debug phish on 8 Sep and the self-replicating Shai-Hulud worm on 15–16 Sep) make these mandatory: a release-age delay (pnpm `minimumReleaseAge`, default 1440 min since pnpm 11), install scripts off by default, a frozen lockfile, OIDC/trusted publishing, and no long-lived tokens in CI.

### Cited Findings
- 2025-09-08: a maintainer ("qix") was phished, including the 2FA code. Malicious versions of chalk, debug, ansi-styles and others were published with a browser crypto-stealer. chalk and debug each have more than 250M weekly downloads. Sources say about 18 packages — [Semgrep alert via plushcap](https://www.plushcap.com/content/semgrep/blog/semgrep-security-alert-chalk-debug-and-color-on-npm-compromised-in-new-supply-chain-attack) [searched]; [Pulsedive](https://blog.pulsedive.com/npm-compromise-the-wrath-of-the-shai-hulud-supply-chain-attack/) [searched]
- 2025-09-15/16: the Shai-Hulud worm compromised at least 187 packages, including some in the CrowdStrike namespace. It stole npm tokens, GitHub PATs and cloud credentials, and created rogue `shai-hulud.yaml` GitHub Actions workflows. It self-propagated. GitHub removed more than 500 packages, and CISA issued an alert on 2025-09-23. Package counts conflict between sources (180–500+) — [CNCF TAG Security catalog](https://deploy-preview-1497--tag-security.netlify.app/community/catalog/compromises/2025/npm-ecosystem) [searched]; [AWS blog](https://aws.amazon.com/jp/blogs/news/defending-against-supply-chain-attacks-like-chalk-debug-and-the-shai-hulud-worm/) [searched]
- pnpm `minimumReleaseAge` (minutes) arrived in 10.16 (Sep 2025) with a default of 0. pnpm 11 (reported April 2026) defaults to 1440. Related settings: `minimumReleaseAgeExclude` (globs), `minimumReleaseAgeStrict` (v11) and `minimumReleaseAgeIgnoreMissingTime` (v10.19). One unverified report says it is silently ignored with `shared-workspace-lockfile=false` (pnpm#10008) — [pnpm settings](https://pnpm.io/settings) [searched]; [lilting.ch](https://lilting.ch/en/articles/pnpm-11-minimum-release-age-default-shai-hulud-defense) [searched]
- JFrog Artifactory may block npm packages published in the last 24 hours — [JFrog](https://jfrog.com/help/r/artifactory-recently-published-npm-packages-may-be-blocked-for-24-hours-new-client-enforcements) [searched]
- pnpm 10 stopped running dependency lifecycle scripts by default. Allowed scripts are set with `onlyBuiltDependencies` — [pnpm settings](https://pnpm.io/settings) [not re-fetched for this specific point]
- npm provenance (Sigstore-signed build attestations) and trusted publishing via OIDC — [npm docs: provenance](https://docs.npmjs.com/generating-provenance-statements) [not re-fetched]

### Inferences
- **Outlet NK rules:**
  - pnpm ≥ 11 with `minimumReleaseAge: 1440` (consider 4320 for non-security updates).
  - Exclude only internal `@outletnk/*` packages.
  - `onlyBuiltDependencies` allow-list.
  - `pnpm install --frozen-lockfile` in CI.
  - Renovate with a matching `minimumReleaseAge` plus a security-update fast lane that a human reviews.
  - OSV/Socket-style malicious-package scanning.
- **CI:**
  - No npm or GitHub PATs stored. Use OIDC to the cloud and short-lived tokens.
  - Pin third-party GitHub Actions by commit SHA.
  - Restrict `GITHUB_TOKEN` permissions.
  - Alert on new workflow files. Shai-Hulud created workflows.
  - Use egress allow-lists on build runners.
- Developer machines need secret scanning and should store no cloud keys at rest. The worm harvested local credentials.

### Gaps
- Any 2026 npm worm waves after September 2025 (for example later "Shai-Hulud 2.0" reports) were not searched in this session. Check them.

## Secrets, key rotation, envelope encryption, PII field encryption and blind indexes

### Takeaway
Use a KMS-backed envelope: a KEK in KMS and per-tenant or per-table DEKs, with AES-256-GCM per field and a key-version prefix. HMAC blind indexes with a separate key allow equality lookup. Rotate yearly and on incident, and support lazy re-encryption.

### Cited Findings
- Envelope encryption (data keys encrypted by a KMS key) is the AWS KMS pattern — [AWS KMS concepts](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html#enveloping) [not re-fetched]
- Blind indexes are a keyed hash (HMAC) of the plaintext, stored next to the ciphertext so equality search is possible. Truncating them trades false positives for less leakage — [Paragon IE, CipherSweet blind indexing](https://ciphersweet.paragonie.com/security) [not re-fetched]
- OWASP Secrets Management and Cryptographic Storage cheat sheets cover rotation, no hard-coded secrets and AEAD — [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) [not re-fetched]

### Inferences
- **Phone:** E.164 normalisation → HMAC blind index (unique constraint) + AES-GCM ciphertext. Store the key ID in the ciphertext header so rotation does not require downtime.
- **Separate keys** for encryption, the blind index and the audit hash chain.
- **Never log plaintext.** Redact at the logger level.
- **Secrets:** cloud secrets manager, workload identity, and no `.env` in images.
- **Residency:** the KMS region follows ADR-0002.

### Gaps
- Which KMS options exist in-country in Egypt (ties to ADR-0002) was not researched.

## Incident response, PII-free logging and security testing cadence

### Takeaway
The PDPL 72-hour regulator and 3-day subject notification clock (from the master prompt §B1) sets the IR design: detect and triage within 4 hours, structured logs with pseudonymous IDs, and a security testing cadence of SAST per PR, DAST nightly on staging, a pen test before launch and yearly, and a private bug bounty at launch.

### Cited Findings
- CISA's 2025-09-23 npm alert is an example of the external advisories IR must watch — [CNCF TAG catalog](https://deploy-preview-1497--tag-security.netlify.app/community/catalog/compromises/2025/npm-ecosystem) [searched]
- OWASP Logging Cheat Sheet: never log session tokens, passwords, or full PII. Use pseudonymisation and prevent log injection — [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) [not re-fetched]
- NIST SP 800-61 Rev. 3 (April 2025) aligns incident response with CSF 2.0 — [NIST SP 800-61r3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) [not re-fetched; date UNVERIFIED]

### Inferences
- **Log schema:**
  - request_id, trace_id, pseudonymous user ID (HMAC, rotated yearly), device ID hash, route, status, latency and the rate-limit decision.
  - No phone numbers, addresses, OTPs, tokens or PSP payloads containing PII.
  - Security events go to an append-only, hash-chained audit store with WORM storage.
- **Cadence:**
  - **Every PR:** Semgrep/CodeQL, secret scan, dependency and malicious-package scan.
  - **Nightly:** ZAP DAST on staging.
  - **Every build:** IaC scan.
  - **Quarterly:** IR tabletop.
  - **Pen test:** external, before launch, yearly, and before each new money feature.
  - **Bug bounty:** private at launch, public after about 6 months of stability. This is an assumption.

### Gaps
- Egyptian requirements for security testing or reporting outside PDPL were not researched.
