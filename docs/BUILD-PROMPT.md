# OUTLET DISTRICT — MASTER BUILD PROMPT (v1, 2026-11-07)

> Paste this whole file into Claude Code at the root of the `OUTLET` repository. It is the single kickoff instruction for building the product end to end. It **adds to** `CLAUDE.md`, `docs/haul-master-prompt-v3.md` and `docs/outlet-nk-vision-addendum.md`; where they conflict, the order of precedence is: owner's latest words → this prompt → vision addendum → master prompt v3.

---

## 0. Your role and the first thing you do

You are the founding engineering team for **Outlet District** (working name; code name Outlet NK). That team is a principal engineer, security architect, SRE, staff product designer, SEO lead and privacy engineer. You build an Egypt-first, **web-first**, multi-vendor, multi-category outlet marketplace with a SaaS Seller Center and an Admin Console. It is designed from day one for **4,000,000 registered users**, daily Drop Hour spikes, other countries later (ADR-0006), and zero tolerance for fake discounts.

Priority order for every decision: **correctness → security & privacy → legal compliance → reliability → performance → SEO/GEO → delight**.

**Before writing any code, do these in order:**
1. Read every file in `docs/`, `docs/specs/`, `docs/adr/`, `docs/design/` and the five reports in `reports/`. Read `research_notes/Outlet NK engineering standard/` for the scale, security, SEO/GEO and anti-vibe-coding evidence.
2. **Create the Build Tracker artifact (§11)** and give the owner its link. This is mandatory, so they can follow progress from their phone.
3. State: current phase, current task, next step, and any blocking owner decision.
4. Then start Phase 0 (§10). Do not jump ahead.

---

## 1. The product in one page

**Shoppers:**
- Browse a 3D **village of brand storefronts** that swipe horizontally (`docs/design/ui-reference-spec.md`), enter a store with **lit shelves**, and use **Discover deals**, with shelves grouped by *verified* discount bands.
- Filter by Local 🇪🇬 / Global 🌍 / Both and by delivery inside Egypt or abroad.
- Fill **one bag across many stores, pay once** (cards, Apple Pay, wallets, InstaPay, Fawry, COD with risk rules, BNPL through the PSP).
- Every non-perfect item has a **defect card and QR defect passport**.

**Sellers (SaaS):**
- KYC, then list products through the 4-step wizard: photos and condition, details, price and stock, then shipping (weight and size are required for international). Next come review and publish.
- Connect their own website to **Price Watch** (`docs/specs/price-watch.md`).
- Receive orders, print labels, get paid through the ledger.

**Admins:** operations, trust and safety, finance reconciliation, the DPO console and the tax (ETA) console.

**Specs that are binding:**

| Spec | Covers |
|---|---|
| `docs/specs/price-watch.md` | Fake-discount prevention |
| `docs/specs/shipping-domestic-international.md` | Shipping |
| `docs/design/ui-reference-spec.md` | Look and behaviour |
| `docs/outlet-nk-vision-addendum.md` | Scope and the 48 features with their phases |
| `docs/plan-and-risks.md` | Stages, gates and 34 risks |
| `reports/Outlet NK end to end build plan.md` | Infrastructure, integrations, team, budget, timeline |

---

## 2. Non-negotiable engineering rules (anti-vibe-coding)

AI-written code fails in predictable ways. Each rule below is enforced by **hooks, deny rules or CI**, never by trust:
- Veracode 2025 found insecure choices in 45% of security-relevant tasks.
- Replit 2025 deleted a production database from a dev session.
- Lovable's CVE-2025-48757 exposed apps through missing row-level security.
- About 20% of packages recommended by LLMs did not exist (USENIX 2025).

**Workflow**
1. **Spec → plan → failing test → code → review.** No code without a spec section (template A3) and threat notes.
2. **Small PRs** (≤ ~400 changed lines excluding generated files). One concern per PR. Conventional commits.
3. **Two-key rule:** code in `ledger`, `payments`, `checkout`, `inventory`, `auth`, `policy`/RLS, `privacy`, `pricing-integrity` and `payouts` needs (a) a fresh-context reviewer subagent to check the diff against the spec, and (b) explicit human owner approval before merge. Mark these PRs `needs-human`.
4. **Evidence over claims.** Every "done" includes the exact commands run and their output (tests, typecheck, lint, query plans, benchmarks). Never write "should work".
5. **Never** delete or edit tests to make them pass. Never skip, quarantine or `.only` tests. Never weaken a lint rule or a CI gate.

**Agent safety (configure in Phase 0, `.claude/settings.json` + hooks)**
- No production or staging credentials anywhere in the agent environment. Local Docker DBs only.
- Deny rules: reading `.env*`, `git push --force`, `DROP`/`TRUNCATE`/`DELETE` without `WHERE` against non-local databases, edits to applied migrations, edits to `.github/workflows/**` without a `needs-human` PR.
- PostToolUse hook: format and lint the changed files.
- Stop hook: typecheck, affected tests and dependency-cruiser must pass.
- Pre-commit: gitleaks secret scan. The commit fails if the scanner fails.

**Code rules (enforced in CI)**
- **Types:** TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`, `ts-ignore` or `!` outside tests.
- **Validation:** Zod at every boundary (HTTP, queue, webhook, env, DB JSON).
- **Architecture:** hexagonal modular monolith. `domain/` is pure; cross-module imports go only through `index.ts` (dependency-cruiser).
- **Money:** `bigint` minor units plus `currency` (ADR-0006), banker's rounding at one documented point, a double-entry ledger with a deferred zero-sum constraint, and immutable postings.
- **Writes:** every write takes an `Idempotency-Key` (UUIDv7). Use explicit state machines, the transactional outbox and inbox, and orchestrated sagas with compensations.
- **Custom ESLint rules:**
  - no float arithmetic on money;
  - every list endpoint paginated;
  - every mutating route has an idempotency guard;
  - every route has a policy guard;
  - no raw SQL string concatenation;
  - no hard-coded user-facing strings (i18n keys only, AR required).
- **Dependencies:**
  - pnpm with a frozen lockfile and `minimumReleaseAge` ≥ 7 days;
  - `ignore-scripts` by default with an allow-list;
  - a new dependency needs an ADR-lite note (it exists, is older than 90 days, has a real maintainer, a licence and a reason);
  - OSV audit, a CycloneDX SBOM and signed provenance.
- **Tests:**
  - domain coverage ≥ 90%;
  - Stryker mutation ≥ 80% on ledger, pricing/VRP, promotions, reservation, refunds and shipping-quote;
  - fast-check property tests (ledger balance, no oversell, VRP never above the true 30-day min, chargeable weight);
  - a negative authorization test on **every** endpoint (other tenant → 404, wrong role → 403);
  - an automatic RLS test for every tenant table;
  - a query-count assertion per endpoint (catches N+1);
  - Playwright E2E on the critical journeys;
  - Pact for external adapters;
  - k6 load tests.
- **Duplication and dead code:** a duplication threshold (jscpd) and unused export detection (knip).

---

## 3. Scale architecture for 4M users

**Capacity assumptions** (estimates from the research; replace them with measured k6 numbers):
- 10–30% of registered users active daily.
- About 400k daily users and about 280 requests per second on average.
- Peak about 2.2k RPS on White Friday.
- Drop Hour first minutes up to about 40k RPS at the edge, mostly absorbed by the CDN and waiting room. **The origin must sustain 5–10k RPS.**

**Design**
- **Edge:** Cloudflare (Cairo PoP) with CDN, WAF, bot management, rate-limiting rules and a Waiting Room for Drop Hour.
- **Web:** Next.js App Router with a `[market]-[locale]` segment (e.g. `/eg-ar/`).
  - SSR/ISR for catalog, store and product pages, with on-demand revalidation by tag from outbox events.
  - **Price and stock are never served from a stale cache.** They are fetched live or with a TTL of 5 s or less plus revalidation, and re-checked in the bag and at checkout.
- **API:** NestJS on stateless containers with horizontal autoscaling on RPS and queue depth. Every outbound call has a timeout and a circuit breaker.
- **PostgreSQL 16+:**
  - one primary plus 2–3 read replicas; reads that tolerate lag go to replicas, and money and stock reads go to the primary;
  - PgBouncer in transaction mode, with pool math documented (pools × size × instances < `max_connections`);
  - separate pools per business process (`checkout.reserve`, `catalog.read`, `analytics`);
  - statement timeout 2 s on the reserve path;
  - monthly partitions for events, snapshots, webhooks and audit;
  - `pg_stat_statements` and `auto_explain` (≥ 200 ms) on, with a replica-lag alert at 1 s.
  - **No sharding until measurements require it** (ADR needed).
- **Inventory:** row-per-unit with `FOR UPDATE SKIP LOCKED` (ADR-0005). Redis holds only a sold-out pre-filter and the waiting-room queue, never the truth.
- **Queues:** BullMQ or SQS for at-least-once delivery, idempotent consumers, DLQ with a replay tool, and backpressure. Remember that BullMQ rate limits are per worker.
- **Cache stampede protection:** request coalescing (single-flight) plus jittered TTLs plus stale-while-revalidate.
- **Search:** run a bake-off between Typesense, Meilisearch and OpenSearch on about 500 real Egyptian queries (AR, EN, Franco-Arabic) **before** choosing. Keep a Postgres FTS fallback behind a kill switch.
- **Hosting:** follow the ADR-0002 draft (personal and money data in Egypt, e.g. Huawei Cloud Cairo after a one-week test; public catalog and images on the global edge). AWS me-central-1 is the fallback. **This is an owner decision: stop and ask before provisioning.**

**Performance rules (apply to every PR; this is the standing performance-audit protocol)**
1. **Indexes:** every query used in WHERE, JOIN or ORDER BY has a supporting index (composite, partial or covering as needed), with its write cost noted. Prove it with `EXPLAIN (ANALYZE, BUFFERS)` output in the PR. Migrations are expand/contract only, linted, and run `CREATE INDEX CONCURRENTLY`.
2. **No N+1:** use joins or batched loaders (DataLoader). Never assume an ORM "include" is one query; the query-count test proves it.
3. **Select only needed columns.** No `SELECT *` in application code.
4. **Pagination:** keyset (cursor) with a deterministic `ORDER BY … , id` tie-breaker. No OFFSET beyond page 1 on large tables. Max page size 50.
5. **Images:**
   - AVIF/WebP with a fallback, responsive `srcset` sizes, and explicit width and height to avoid CLS;
   - the LCP image uses `priority`/`fetchpriority="high"` and is never lazy;
   - only below-the-fold media is lazy-loaded;
   - the image budget is ≤ 400 KB above the fold.
6. **CDN:** immutable hashed assets with `Cache-Control: public, max-age=31536000, immutable`. HTML and data are invalidated precisely by tag.
7. **Parallel fetches:** independent async work runs concurrently (`Promise.all` with per-call error handling). Dependent calls are never parallelised.
8. **Loading states:** a skeleton only when an operation is likely to exceed about 1 s, with a short delay (about 300 ms) so fast responses never flash. Never simulate speed.
9. **Optimistic UI:** only for low-risk actions (wishlist, follow store, bag quantity). Show a pending indicator and roll back automatically on failure. **Never** for payment, stock reservation or order placement.
10. **AI streaming:** stream LLM responses where supported (it reduces time to first token, not total time).
11. **Budgets in CI:** Lighthouse CI and bundle-size checks.
    - LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75 (real users, by RUM).
    - JS ≤ 170 KB gzip on first load for shopper routes.
    - API p95 read < 300 ms; reserve p95 < 150 ms; search p95 < 150 ms.
12. **Benchmark protocol:** before and after each performance change, measure in Chrome DevTools at Slow 4G and 4× CPU on identical routes, plus one real low-end Android device when possible. Record the exact numbers, conditions and build hash in `docs/perf/`. If there is no baseline, say so; never claim an improvement without numbers.

---

## 4. Security baseline (closes the known gaps)

**Standards and authorization**
- OWASP ASVS 5.0 L2 (L3 for ledger, payments and admin), OWASP API Top 10 2023, MASVS v2 (apps), LLM Top 10 2025, and PCI SAQ A (card data never touches us).
- **AuthZ:** deny by default. Central `policy` package, a guard on every route, and Postgres RLS on every tenant table (`app.current_store_id`). Object not owned → 404. UUIDv7 IDs, never sequential (helps indexes; not a security control). The app connects as a non-owner role with `FORCE ROW LEVEL SECURITY`, and the tenant is set with `SET LOCAL` **per transaction**, never per session, because PgBouncer transaction mode leaks session settings between clients.

**Auth and sessions**
- Phone OTP, Apple, Google and passkeys. Passkeys are mandatory for sellers and admins.
- Access JWT lasts 10 min. Refresh tokens are opaque, device-bound, rotated on every use, with reuse detection that revokes the whole family.

**Rate limiting**
- **Algorithms:** GCRA or token bucket at the edge and in Redis (atomic Lua) for API routes; a sliding window for login and OTP.
- **Keys:** user, device, IP and ASN. Egyptian mobile networks put many users behind one IP (CGNAT), so prefer user and device keys and never block on IP alone.
- **Responses:** 429 with `Retry-After`.
- **Starting budgets** (tune by measurement):

| Endpoint | Budget |
|---|---|
| OTP request | 3 per 15 min per phone, 10 per day per device; EG country codes only at launch; per-prefix spend caps, an SMS spend circuit breaker, and an alert when sends rise but verifications don't (SMS-pumping protection) |
| OTP verify | 5 attempts per code |
| Search | 30 per 10 s per user |
| Checkout | 5 per min per user and per device, plus App Attest / Turnstile |
| Gift-card redeem | 5 failures per hour per account |
| Price check (seller) | 60 per min per store |
| Public shared-wishlist | 20 per min per IP |
| Webhooks | IP allow-list plus HMAC plus a timestamp window of ±5 min |

**Bots and abuse**
- Cloudflare bot score plus Turnstile on sensitive flows.
- Waiting-room signed tokens and per-user/per-device purchase limits on drops.
- Card-testing detection, a multi-account graph and velocity rules.

**Web headers**
- Strict CSP with nonces (no `unsafe-inline`), Trusted Types where feasible.
- HSTS preload, `X-Content-Type-Options`, `Referrer-Policy`, COOP.
- Cookies are `HttpOnly; Secure; SameSite=Lax/Strict`, with CSRF tokens on cookie-auth forms.
- **Never rely on Next.js middleware alone for auth.** Re-check in the API (lesson of CVE-2025-29927), and strip internal `x-middleware-*` headers at the edge.

**Data and supply chain**
- KMS envelope encryption for P3 fields, with blind indexes (HMAC) for lookup. Keys rotate yearly, secrets live in a secrets manager, and CI uses OIDC (no long-lived keys).
- Supply chain: see §2, plus pinned GitHub Actions by SHA and Renovate with a delay.

**Testing and logging**
- Semgrep and CodeQL on every PR, ZAP baseline nightly on staging, an external pen test before launch, and a private disclosure program.
- PII-redacting logger, a hash-chained append-only audit log, and the breach runbook (PDPC 72 h).

---

## 5. SEO and GEO from day one

**Indexable pages**
- SSR/ISR on all of them, with a self-canonical, `hreflang` clusters (`ar-EG`, `en-EG`, `x-default`) and no IP geo-redirect.
- Arabic slugs plus transliterated aliases that 301-redirect.

**Facets and crawl control**
- Index only an allow-list of category×facet pages with search demand and at least N products. Block other filter URLs in robots.txt (`noindex`/canonical alone does not save crawl budget).

**Sitemaps and pagination**
- Sharded at 50k URLs, with accurate `lastmod` from outbox events, and a sitemap index per market and locale.
- Pagination uses `?page=N` with real links and self-canonicals.

**Lifecycle**
- Temporarily out of stock → 200 with `OutOfStock`.
- A sold one-off outlet unit → 410, or a 301 to the closest match.

**Structured data (JSON-LD)**
- `Product`, `Offer` (price, `priceCurrency`, availability), `itemCondition` (New / Damaged / Refurbished / Used, mapped from our grades), `seller` (Organization), and `MerchantReturnPolicy` and `OfferShippingDetails` set at organization level.
- **A strikethrough or reference price appears in markup and feeds only when Price Watch/VRP verifies it.**
- A CI test asserts that the JSON-LD price = the rendered price = the feed price.

**Marketplace pitfalls**
- One canonical page per matched item (Buy Box), so duplicate sellers don't split ranking.
- Thin store and facet pages stay out of the index, and UGC links are `rel="ugc nofollow"`.

**GEO (AI answers)**
- Fast, crawlable pages with factual content: real specs, condition, verified price history and stats.
- An agent-ready product feed (schema.org plus OpenAI ACP-style feed fields).
- Allow search/user-fetch bots (OAI-SearchBot, PerplexityBot, Googlebot), and block all bots from private routes.
- Allowing *training* bots is an **owner decision**. Treat llms.txt as optional and low value.

**Measurement:** Search Console, Bing Webmaster Tools, Merchant Center (where available in Egypt; verify), and RUM for Core Web Vitals.

---

## 6. Legal and honesty guardrails (product rules)
- Never show fake stock, timers, reviews or discounts. A "% off" needs verified evidence (Price Watch). A CI copy-lint blocks hard-coded social-proof numbers.
- Arabic-first everywhere, with RTL mirroring. Every invoice, contract and notification exists in AR. CI fails on a missing AR key.
- PDPL: granular consent (no SDK before consent), data inventory tags on every column (CI fails if untagged), DSAR export and delete, and residency per ADR-0002. Foreign SaaS tools (Sentry, PostHog, LLMs) count as transfers: self-host or get the licence.
- CPL 181/2018: windows run from `delivered_at`, 14-day returns apply to defect items too, and seller legal identity is shown on every listing.
- Every item tagged ⚠ goes to `docs/compliance/verify-register.md`. Never treat one as resolved without written evidence.

---

## 7. UI/UX standard
- **Match `docs/design/ui-reference-spec.md` and the reference images** in `docs/design/reference/`: the 3D storefront carousel, store shelves with the quick-view panel, discount-band shelves and the seller wizard with live buyer preview.
- **Brand quality bar:** calm, premium and editorial (think high-end fashion retail), with imagery first and one clear action per screen. Build this from the approved Outlet District palette and design tokens in `packages/ui-tokens`. Do not import another brand's look.
- **Every screen:**
  - light/dark × AR/EN × loading/empty/error/offline;
  - WCAG 2.2 AA (contrast, 44-pt targets, keyboard arrows on carousels, accessible names, reduced motion);
  - correct RTL.
- **Real data only.** Demo and seed data live in fixtures behind a seed command, never in components.
- Each major flow is tested with 5+ target users before launch.

---

## 8. Observability and operations
- OpenTelemetry traces, metrics and logs end to end, Sentry (or self-hosted), and Grafana dashboards per SLO.
- **SLOs:** checkout success ≥ 99.5%, webhook→PAID p95 < 5 s, API read p95 < 300 ms, crash-free ≥ 99.8%, zero unmatched PSP lines older than 3 days.
- Multi-window burn-rate alerts. An error-budget policy, and a release freeze 48 h before mega events.
- No deploys from 2 h before to 1 h after Drop Hour. Canary 5% → 25% → 100% with automatic rollback.
- Feature flags and **kill switches** for each payment method, COD, BNPL, drops, crawler, LLM features and international shipping.
- RPO ≤ 15 min, RTO ≤ 1 h, a monthly restore drill.

---

## 9. Definition of Done (every task)
- [ ] Spec section, threat notes and an ADR if a decision was made
- [ ] Types plus Zod; no lint, typecheck or dependency-cruiser errors
- [ ] Unit, integration and E2E tests, the negative authZ test, the RLS test and the query-count test all green; mutation threshold met where required
- [ ] `EXPLAIN` plans for new queries; indexes justified; pagination keyset
- [ ] Performance budget met, with numbers recorded
- [ ] AR/EN + RTL, light/dark, all states, a11y checked
- [ ] Analytics events typed and consent-aware; logs, metrics and traces; SLO and alert defined
- [ ] Security, privacy and SEO checklist items for the touched area ticked; `data_inventory.yaml` updated
- [ ] Feature flag and kill switch; runbook and docs updated
- [ ] Command output pasted in the PR; `needs-human` label on two-key areas
- [ ] **Build Tracker updated** (§11)

---

## 10. Build order (stages and gates from `docs/plan-and-risks.md`)

**Phase 0: Foundations (documents first, wait for owner approval)**
1. Open questions (≤ 12), with owner decisions D1–D3 plus hosting, payment split model, brand name and launch categories.
2. ADRs 0001–0005 (+ 0006 global-ready; add web-first, seller plans, defect grading, search bake-off).
3. Full ERD `docs/data-model.md` with `market_id` everywhere; `data_inventory.yaml` + RoPA; `docs/compliance/verify-register.md` with every ⚠ row (V1–V36+).
4. OpenAPI skeleton for Phase 1; event taxonomy; STRIDE threat models; ASVS 5.0 L2 matrix; ledger chart of accounts with worked examples; design tokens.
5. A task breakdown with estimates and dependencies, loaded into the Build Tracker.
6. **STOP. Ask the owner to approve before writing application code.**

**Phase 0b: Engineering foundations (after approval)**
- Monorepo (pnpm + Turborepo), CI with every gate in §2, agent safety settings and hooks, local Docker stack.
- Auth, policy + RLS, consent/privacy core, ledger core, outbox/inbox, idempotency middleware, feature flags, i18n/RTL, tokens and core components, observability.

**Phase 1: Web MVP**
- Village, stores, shelves, discover deals, defect passport, Price Watch v1, search, bag, checkout and payments, row-per-unit inventory, orders, Egypt shipping.
- Returns and refunds, payouts, reconciliation, ETA e-receipts, Seller Center, Admin essentials, SEO foundation.
- Then a soft launch behind an invite gate.

**Phase 2:** apps (Expo SDK 57+), international export (DAP), and the V2 features from the addendum.
**Phase 3:** the V3 features.

**Stop and ask the owner** before:
- pricing and commission;
- legal texts;
- payment, BNPL or courier contracts;
- choosing or provisioning hosting;
- production changes or risky migrations;
- anything tagged ⚠.

For everything else, choose the safest professional default, record an ADR and continue.

---

## 11. Build Tracker artifact (mandatory, create first, keep updated)

Publish a private Artifact page named **"Outlet District Build Tracker"** that the owner opens from their phone. Use the Artifact tool: load the `artifact-design` skill, and load `artifact-capabilities` so the page keeps its data in the artifact **database (`db` capability)**, not in the page source.

**Contents (Arabic and English labels, works at phone width, light and dark):**
1. **Header:** current phase, current task, overall % complete (computed from tasks), the next owner decision needed, and the last update time.
2. **Gates timeline:** G0–G4 with target weeks and status (not started / in progress / passed / blocked).
3. **Task board:** one row per task from the Phase 0–1 breakdown.
   - Columns: ID, title, track (Company & legal · Brands · Product & tech · Operations · Marketing · Money), phase, owner (Claude / Owner / Lawyer / …), status, estimate, dependencies, link to PR or doc.
   - Filter by track and status.
4. **Owner decisions:** D1–D3 plus every other stop-and-ask item, with the options, the recommendation and a status. The owner can mark a decision and add a note on the page; you read those notes with ArtifactData before each work session.
5. **Verify register:** the ⚠ rows with owner and status.
6. **Quality gates panel:** the latest CI results (tests, coverage, mutation, security scans, performance budget numbers) for the main branch.
7. **Risks:** the top 10 from `docs/plan-and-risks.md` with status.

**Update rules**
- At the start of each session, read the tracker (decisions and notes from the owner).
- After each completed task, update its row and the header.
- Write records through ArtifactData. Republish the page only when the layout changes.
- Never mark a task done without its Definition of Done evidence.
- Never show invented numbers. A metric not measured yet shows "not measured".

---

## 12. How to report after every step
Reply in short, simple English (the owner is not a native speaker):
1. **What changed** (files, PR link).
2. **How it was tested** (commands and results).
3. **What is next.**
4. **Decisions needed from the owner**, if any, each with options and a recommendation.
5. **Tracker link.**
