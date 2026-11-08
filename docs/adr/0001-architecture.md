# ADR-0001: Architecture: web-first hexagonal modular monolith

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on D0, D4, D6)
- Date: 2026-11-07
- Deciders: Owner, CTO
- Sources: `docs/BUILD-PROMPT.md` §2, §3, §10; master prompt §A2, §T1, §T3; `reports/Outlet NK end to end build plan.md` (architecture, module map, stack); `research_notes/Outlet NK engineering standard/scale_performance.md`; ADR-0006

## Context

Outlex is an Egypt-first, **web-first**, multi-vendor, multi-category outlet marketplace (ADR-0007). It must:
- keep money, stock and personal data correct and in one transaction boundary;
- handle **4,000,000 registered users** and a daily **Drop Hour** spike;
- keep personal and money data in Egypt (ADR-0002) and be ready for other markets (ADR-0006);
- be built and run by a small team (about 5 engineers, per the build-plan report).

The older code on branch `feat/phase-0-foundations` in `/Users/nadakhalifa/OUTLET` is **reference only** (owner decision D0). Reviewed parts (ledger, inventory, idempotency) may be ported later, each with fresh tests and two-key review.

## Capacity math (BUILD-PROMPT §3)

These are **estimates** from `scale_performance.md`. They are rules of thumb, not measurements. k6 results replace them.

| Step | Assumption | Result |
|---|---|---|
| Daily users | 4M registered × 10% daily active (range 10–30%) | ~400k DAU (upper case 1.2M) |
| Requests per day | 1.5 sessions × ~40 API calls per session | ~24M requests/day |
| Average load | 24M ÷ 86,400 s | **~280 RPS** (upper case ~830 RPS) |
| White Friday peak | ~8× average | **~2.2k RPS** (upper case ~6.7k RPS) |
| Drop Hour first minutes | 20% of DAU (80k users) in 10 min, ~1 request / 2 s each | **~40k RPS at the edge**, mostly absorbed by CDN + Waiting Room |
| Origin target | What reaches the API | **5–10k RPS sustained** |
| API pods | ~300–800 RPS per Node pod (UNVERIFIED, must be benchmarked) | ~10–30 stateless pods at peak |
| Checkout writes | Orders during a drop | a few hundred orders/s |

Conclusion: one large PostgreSQL primary plus 2–3 read replicas is enough. Outlex's peak is roughly 1/1000 of Shopify's app-server peak (scale_performance.md). **No sharding until measurements require it** (needs its own ADR).

### PgBouncer pool math (rule, with example numbers)
Rule: `pools × pool_size × PgBouncer instances ≤ 0.8 × max_connections` on each database server. Pools are split by business process (`application_name`): `checkout.reserve`, `orders.write`, `catalog.read`, `workers`, `analytics`.

Example only (size by measurement): primary `max_connections = 400` → budget 320. `checkout.reserve` 2 × 40 = 80, `orders.write` 2 × 40 = 80, `workers` 2 × 30 = 60, `admin/analytics` 2 × 10 = 20, ops reserve 20 → **260 ≤ 320**. `catalog.read` uses the replicas with its own budget. Reserve path statement timeout = 2 s.

## Options considered

| Option | Good | Bad |
|---|---|---|
| **A. Custom hexagonal modular monolith (NestJS) + Next.js web** | One ACID boundary for ledger, stock and orders; full control of row-per-unit stock, VRP/Price Watch, defect cards and Egyptian PSPs; one TypeScript language; cheap to run | Catalog, cart and admin CRUD must be built (about 3–5 extra engineer-weeks, estimate from the build-plan report) |
| B. Medusa v2 + Mercur marketplace layer | Catalog, cart, vendor dashboards for free | Quantity-based stock (row-per-unit means fighting core workflows); payouts assume Stripe Connect, which does not exist in Egypt; Egyptian PSPs, BNPL, ETA, VRP and defect grading are custom anyway; vendor KYC reportedly in a paid licence (UNVERIFIED) |
| C. Microservices from day one | Independent scaling and deploys | Distributed transactions on the money path; far too much ops for 5 engineers |
| D. Serverless functions per endpoint | No servers to manage | Connection storms on Postgres (Shopify's bottleneck was connections), cold starts on the Drop Hour path, weak transaction story |

**Choice (2–3 lines):** the hard and differentiating parts are money, stock and price integrity, and no engine handles them for Egypt. Option A keeps them in one ACID database with the least ops, and its CI-enforced boundaries keep a later split cheap. Option B stays a reference design; an optional one-week Medusa spike in Sprint 1 may confirm this with evidence.

## Decision

Option A.

### Shape
- **Monorepo:** pnpm + Turborepo. Frozen lockfile, `minimumReleaseAge ≥ 7 days`, `ignore-scripts` by default (BUILD-PROMPT §2).
- **Apps:** `apps/web` (shopper, Phase 1), `apps/seller-web`, `apps/admin-web`, `apps/api` (NestJS), `apps/workers` (outbox relay, sagas, sweepers, reconciliation, ETA queue). Phase 2: `apps/mobile` (Expo SDK 57+), `apps/crawler`, `apps/ml-services`.
- **Packages:** `domain`, `validation` (Zod), `api-client` (generated from OpenAPI), `ui-tokens`, `ui-web`, `ui-native` (Phase 2), `i18n`, `analytics`, `config`, `policy` (authz), `public-events` (the only schemas allowed to cross into the public plane, see ADR-0002).
- **Layers per module:** `domain/` (pure) → `application/` (use cases and ports) → `adapters/` (HTTP, DB, PSP, courier…).

### Web
- **Next.js App Router** with a **`[market]-[locale]` route segment** (e.g. `/eg-ar/`, `/eg-en/`, later `/sa-ar/`). The segment also sets `lang` and `dir` on `<html>`. Never a cookie-only locale (next-intl caveat in the build-plan report).
- SSR/ISR for catalog, store and product pages. On-demand revalidation by tag, driven by outbox events.
- **Price and stock are never served from a stale cache.** They are dynamic holes, fetched live or with TTL ≤ 5 s plus revalidation, and re-checked in the bag and at checkout.
- Never rely on Next.js middleware alone for auth. The API re-checks every request (CVE-2025-29927 lesson).

### API and data
- **NestJS** on stateless containers, autoscaled on RPS and queue depth. REST + OpenAPI generated from code, Problem+JSON errors, `/v1` versioning, cursor pagination (max page 50), default timeout 10 s, a circuit breaker on every outbound call.
- **PostgreSQL 16+** is the single source of truth for money, stock, orders and users. One primary + 2–3 read replicas. Money and stock reads go to the primary; lag-tolerant catalog reads go to replicas (replica-lag alert at 1 s). Monthly partitions for events, snapshots, webhooks and audit. `pg_stat_statements` and `auto_explain` (≥ 200 ms) on.
- **DB access:** Kysely (typed SQL) for money and stock paths, because `SKIP LOCKED`, advisory locks and deferred constraint triggers need hand-written SQL. One query tool for the whole API keeps it simple.
- **RLS:** the app connects as a non-owner role with `FORCE ROW LEVEL SECURITY`. The tenant is set with `SET LOCAL` **per transaction**, never per session, because PgBouncer transaction mode leaks session settings.
- **Redis:** cache, rate limits, sold-out pre-filter, waiting-room queue and BullMQ transport. **Never a source of truth.** If Redis is lost, the outbox relay re-publishes.
- **Queues:** BullMQ (or SQS if we end up on AWS). At-least-once, idempotent consumers with an inbox table, DLQ with a replay tool, backpressure. BullMQ rate limits are per worker, so fleet-wide limits use a shared store.
- **Consistency:** transactional outbox + inbox; orchestrated sagas with compensations for checkout, refund, payout and cancellation (master prompt §A2.7–8).
- **Cache stampede protection:** single-flight request coalescing, jittered TTLs, stale-while-revalidate.

### Edge
- **Cloudflare** (Cairo PoP): CDN, WAF, bot management, rate-limit rules, Turnstile, and a Waiting Room for Drop Hour. Plan tier and price are open (V16, V48). Residency question about proxying personal traffic: V68 (ADR-0002).

### Search
Behind a `SearchPort`. The engine is chosen by the bake-off (ADR-0010). Postgres FTS + pg_trgm is the fallback behind a kill switch.

### Modules

| Group | Modules | Plane (ADR-0002) | Phase 1 |
|---|---|---|---|
| Market and config | **market** (ADR-0006), feature-flags | Private (config), public (market list) | Yes |
| Identity and privacy | auth, users, privacy (consent, DSAR, deletion), age-policy | Private | Yes |
| Sellers and SaaS | sellers (KYC), **seller-plans** (ADR-0008), storefront (Brand Street builder), channel-guard | Private (KYC), public (storefront) | Yes |
| Catalog and trust | catalog (multi-category taxonomy, D6), **condition-grading** (ADR-0009), pricing-integrity (VRP + Price Watch), trust-safety, reviews | Public (listing), private (evidence) | Yes |
| Discovery | search-sync, **village** (map, Brand Streets, Drop Hour, Outlet Parties), **calendar** (Ramadan–Eid), recommendations-gateway | Public | Search, village, calendar |
| Buying | cart, checkout (saga), promotions, wishlists | Private | Yes |
| Money | payments, ledger, payouts, store-credit (ADR-0003), refunds, tax-eta, reconciliation | Private | Yes |
| Stock | inventory (row-per-unit, ADR-0005) | Private | Yes |
| Delivery | orders, fulfillment (`CourierPort`), **shipping** (quote, zones, rate cards), returns | Private | Yes (Egypt only) |
| Risk | fraud (COD rules), referrals (core) | Private | Rules only |
| Comms | notifications (WhatsApp, SMS, email; push in Phase 2) | Private | Yes |
| B2B | **lots**, B2B gift cards | Private | No (V2 ⚠ V24) |
| Subscriptions | plus (ADR-0004) | Private | No (Phase 2) |
| AI | llm-gateway, listing copilot | Public data only | Listing copilot |
| Ops | admin, DPO console, tax console, VoC, analytics-ingest | Private | Essentials |

A module becomes its own service only when an ADR shows a measured load or team-ownership need.

### Fitness functions (dependency-cruiser, run in CI and in the Stop hook)

| # | Rule | Why |
|---|---|---|
| F1 | A module may import another module **only through its `index.ts`** | Boundaries stay real, so a split is a refactor |
| F2 | `**/domain/**` must not import `@nestjs/*`, `kysely`, `pg`, `ioredis`, `bullmq`, HTTP clients, `node:` I/O modules, or any `application/` or `adapters/` path | Domain stays pure and fast to test |
| F3 | `application/` must not import `adapters/`; it uses ports only | Hexagonal rule |
| F4 | No circular dependencies anywhere | Keeps build order and reasoning simple |
| F5 | `packages/*` must not import `apps/*`; `apps/web`, `apps/seller-web`, `apps/admin-web` must not import `apps/api` source (only `packages/api-client`) | One-way dependencies |
| F6 | `promotions` and any ads module must not import `budget` (master prompt §12) | Budget data never targets shoppers |
| F7 | `packages/public-events` and any code that writes to the public plane may import only P0 schemas (checked against `data_inventory.yaml` tags) | Residency boundary is testable (ADR-0002) |
| F8 | Client components must not import `server-only` modules | No secrets in the browser bundle |

Two-key folders (`ledger`, `payments`, `checkout`, `inventory`, `auth`, `policy`, `privacy`, `pricing-integrity`, `payouts`) are enforced with CODEOWNERS and the `needs-human` label, not dependency-cruiser (BUILD-PROMPT §2).

## Consequences

**Good**
- One deployable and one transaction boundary for the money path.
- Expansion to a new market is config + adapters (ADR-0006).
- Boundaries are machine-checked from the first commit.

**Bad / risks**
- One bad release can affect everything. Mitigation: canary 5% → 25% → 100% with automatic rollback, kill switches, and no deploys from 2 h before to 1 h after Drop Hour.
- Postgres is on the hot path of every drop. Mitigation: pool math above, a 20× load test and a drop simulation before launch.
- The pod and RPS numbers are unverified. Mitigation: k6 numbers replace them, recorded in `docs/perf/`.
- Two data planes add ops work (ADR-0002).

## Verify-register rows
- V2 (residency and transfer), V14 (Expo SDK version, now proposed as SDK 57+ in the build-plan report), V16 (waiting-room vendor and Cloudflare plan), V37 (Huawei Cloud Cairo service catalog), V38 (measured latency), V48 (Cloudflare plan pricing), V68 (Cloudflare proxying of personal traffic).

## Related
ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0007, ADR-0010.

## Revisit when
A module's latency or deploy cadence is held back by the monolith; a single primary cannot sustain measured peak load; or a separate team owns a module.
