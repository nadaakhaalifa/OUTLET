# Brand verification (module `brand-verification`)

Spec for ADR-0031 evidence checks. Parent: docs/specs/brand-onboarding.md. Humans decide; this module only produces evidence, conflicts and a risk band. Migration 0052 (`bv_*` tables, no foreign keys; applications are referenced by `application_id` uuid and owned by the sellers module).

## Flow
1. Seller starts website proof for an application it owns: `startBrandDomainVerification` (`dns_txt` or `email`). The domain is the application's `website_domain` (the contract body carries only the method).
2. DNS: record `_zoutlet-verify.<registrable-domain>` TXT `zoutlet-site-verification=<token>`, token = HMAC-SHA256(secret, `application_id|domain|nonce`), valid 7 days. Confirm resolves the TXT (3 s timeout) and stays `pending` on lag or DNS error.
3. Email: a 6-digit code to `admin|info|webmaster|hostmaster@<brand domain>`; only an HMAC of the code is stored; valid 24 h; 5 attempts then `failed` (restart sends a new code). Free-mail and shared-platform domains (gmail.com, instagram.com, myshopify.com ...) are refused for both methods.
4. `runAutoChecks(snapshot)` records trademark evidence, runs sanctions screening, detects duplicates and returns an `AutoCheckReport` (checks, evidence ids, contributions, risk low/medium/high, reasons, `dualApprovalRequired`, `forceManualTrademark`). Provider failure becomes check result `error` (medium risk); never an automatic decision.
5. Admin (`ops`, `trust_safety`, `super_admin`) may run or record a trademark lookup (`adminRecordTrademarkLookup`). Conflict resolution (`adminResolveBrandClaimConflict`) is `trust_safety` and `super_admin` only, as in the OpenAPI description.

## Rules
- Domain validation (SSRF, API7): bare hostnames only; no URLs, ports, credentials, IP literals (including decimal/hex forms), internal TLDs (`local`, `internal`, `lan`, ...), single labels or public suffixes. The service only ever resolves `_zoutlet-verify.<registrable>` TXT; it never fetches a user URL. The public suffix list is a hand-authored subset (VERIFY BEFORE LAUNCH: vendor the full PSL).
- Name matching: casefold, NFKD accent strip, Arabic folding (alef/ya/ta-marbuta/hamza, tashkeel, tatweel, digits), `&` to `and`, punctuation strip, dotted initialisms joined, legal-form tokens stripped. Score 0..100 integers from Jaro-Winkler (60%) and trigram Jaccard (40%) with token-set and subset overrides. Options compared: edit distance only, trigram only, JW plus token logic (chosen: short prefix-heavy names, word order varies).
- Conflicts: same applicant is never a conflict. Same normalised name (score >= 95) or similar (>= 85) in the same country, or same domain, or same trademark key in any country. Priority: verified evidence (earliest of domain verified / trademark matched) beats unverified, then `submitted_at`, then application id. Conflicts open idempotently per application pair and are never shown to applicants.
- Trademark owner vs legal name: `match` >= 90, `weak` >= 70, else `mismatch`. A match stamps the claim (`trademark_matched_at`).
- Dual approval: GLOBAL and (country in `HIGH_RISK_COUNTRIES` or sanctions warn/fail). Blocked countries (`DEFAULT_BLOCKED_COUNTRIES`) fail `country_policy` (422 `country_not_supported` at submit, owned by sellers). Local brands must be EG.
- No enumeration: a domain already verified or claimed by someone else returns the same response shape as a fresh pending claim; a conflict is opened silently. Unknown and foreign applications are both 404 with the same body.

## Ports (all in `domain/ports.ts`, fakes in `adapters/in-memory.ts`)
`BrandVerificationPort` (public, see index), `ApplicationOwnershipPort` (supplied by sellers, `find(applicationId)` returns an `ApplicationSnapshot` incl. `applicantId`), `DnsResolverPort` (production `NodeDnsResolver`, node:dns, 3 s timeout), `TrademarkRegistryPort` (production: Unconfigured, 503 `provider_not_configured`; the fixture is HAND-AUTHORED, every assumption VERIFY BEFORE LAUNCH), `SanctionsScreeningPort` (production Unconfigured; fake uses a tiny SYNTHETIC list), `VerificationEmailPort` (production Unconfigured; adapt notifications' `EmailProvider` when a provider exists), `VerificationSecretPort` (KMS HMAC key in production).

## HTTP
| Operation | Route | Audience | Notes |
|---|---|---|---|
| startBrandDomainVerification | POST /v1/seller/applications/{id}/domain-verification | seller (scope seller:enrol or seller:kyc.write), owner only | idempotent, 5/h per user + 30/h per IP |
| confirmBrandDomainVerification | POST .../domain-verification/confirm | seller, owner only | idempotent, 20/h per user, 10/h per challenge |
| adminRecordTrademarkLookup | POST /v1/admin/brand-applications/{id}/trademark-lookup | admin, passkey, ops/trust_safety | idempotent, 120/min |
| adminResolveBrandClaimConflict | POST /v1/admin/brand-applications/{id}/conflict-resolution | admin, passkey, trust_safety | idempotent, 120/min; returns a conflict summary, the admin module composes `AdminBrandApplication` |
Problem codes: invalid_domain (422, `reason`), domain_not_set, invalid_code (422, `attempts_remaining`), challenge_locked, challenge_expired, verification_not_started, verification_conflict, no_trademark_claimed, conflict_already_resolved, email_unavailable (503), provider_not_configured (503).

## Data and events
Tables: `bv_domain_verifications`, `bv_claims`, `bv_claim_conflicts`, `bv_trademark_lookups` (append-only), `bv_screenings` (append-only), `bv_auto_check_reports` (append-only), `bv_history` (append-only). RLS system-only. Every write commits its outbox events and history rows in the same transaction. Outbox (ids and enums only): `brand_domain.verification_started`, `brand_domain.verified`, `brand_claim_conflict.opened`, `brand_claim_conflict.resolved` (carries `note_sha256`, never the note), `brand_trademark.lookup_recorded`, `brand_verification.checks_completed`.

## Threats
Challenge brute force (row-level attempts + per-challenge rate limit), SMS/email pumping (one mailbox per start, 5/h), SSRF (validator, TXT-only resolver, private-name refusal), enumeration (same shapes, 404 for foreign), replay (idempotency keys), log leakage (codes hashed, notes hashed, no domains in events).

## Production status
Marked `blocked` in `MODULE_BINDINGS` until the sellers module supplies `ApplicationOwnershipPort`; the Kysely store is already in `persistence.ts`. VERIFY BEFORE LAUNCH: sanctions list source, high-risk country list, trademark register API terms, PSL snapshot, name-match thresholds with Trust & Safety.
