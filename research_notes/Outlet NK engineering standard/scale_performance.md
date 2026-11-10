# Scale and performance engineering for Outlet NK (as of 2026-11-07)

Note: the session network blocked shopify.engineering, so the primary Shopify posts could not be fetched; Shopify figures below come from Shopify's own press release (via search snippets) and secondary write-ups. Several topics were covered by secondary sources only and are flagged.

## Capacity math: registered users -> DAU -> peak RPS -> nodes

### Takeaway
No published standard ratio exists. Working assumptions (unverified rules of thumb): 10-30% of registered users daily active, 5-8x peak-to-average for Black Friday and 10-50x for flash drops. Real peers (Shopify, Flipkart) publish request rates, but not ratios.

### Cited Findings
- Shopify BFCM 2025 (official release): peak of 489M requests/min at the edge, >117M req/min on app servers, 31.8M API req/min; 14.8T DB queries and 1.75T DB writes across the weekend (totals, not peaks) — [Shopify press release 2025](https://www.shopify.com/news/bfcm-data-2025); [SEC exhibit](https://sec.gov/Archives/edgar/data/1594805/000159480525000090/a2025bfcmpressrelease.htm)
- Shopify 2024 BFCM: 284M req/min edge, 80M app servers; 10.5T DB queries, 1.17T writes (from search snippet of Shopify Engineering readiness post, not fetched) — [Shopify Engineering BFCM readiness 2025](https://shopify.engineering/bfcm-readiness-2025)
- Shopify's final 2025 pre-BFCM load test targeted p99 of 200M RPM (test figure, not the measured peak; snippet only) — [Shopify Engineering](https://shopify.engineering/bfcm-readiness-2025); summary in [ByteByteGo](https://blog.bytebytego.com/p/how-shopify-prepares-for-black-friday)
- Shopify DB peak QPS: a 45M QPS figure (year unclear) and 19M MySQL QPS for 2023 come only from secondary sources, UNVERIFIED — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/shopify-black-friday); [DEV Community](https://dev.to/techlogstack/shopifys-engineers-hunted-deadlocks-at-19-million-queries-per-second-1ogc)
- Flipkart (official, year not stated): ~1.5M requests/s at sale open, prepared for >2,000 orders/s — [Flipkart Stories Q&A](https://stories.flipkart.com/innovation-customer-first-qna-jeyandran-venugopal)
- Flipkart 2022: 1.6M concurrent users at sale start (secondary) — [IBTimes](https://www.ibtimes.co.in/big-billion-days-2022-flipkart-sales-peak-1-6-mn-per-second-witnessing-record-high-9-years-852545)
- Flipkart 2023 sale: 666M visits, ~110 orders/s averaged across the sale (secondary) — [Zee News](https://zeenews.india.com/companies/flipkart-big-billion-days-sale-records-666-million-visits-110-orders-placements-per-second-2319321.html/amp)
- Flipkart 2024: 95M TPS on Aerospike (vendor-announced, DB-level, not comparable to HTTP RPS) — [CIOL](https://ciol.com/news/flipkart-achieves-95-million-tps-with-aerospike-on-kubernetes-7511122)
- Rules of thumb (teaching and blog material, not measured): 10-30% of registered users are DAU; shopping DAU/MAU 8-20% (Mixpanel ~20%); peak 5-8x average on Black Friday, 10-50x for flash sales; add 20-50% headroom — [api-design capacity lesson](https://api-design.pages.dev/lessons/rel-13-capacity-estimation); [pmtoolkit DAU/MAU](https://pmtoolkit.ai/calculators/dau-mau)

### Inferences
- Worked example for Outlet NK (assumptions, to be replaced by analytics): 4M registered x 10% = 400k DAU (conservative low end, because the share of registered users who visit daily is usually lower for a new marketplace). Assume ~1.5 sessions/DAU x ~40 API calls/session = 24M requests/day ≈ 280 RPS average (requests spread across 24h). At 8x (White Friday) ≈ 2,200 RPS; a 9 pm Drop Hour concentrating 20% of DAU (80k users) into 10 minutes with ~1 request/2 s per user ≈ 40k RPS at the edge in the first minutes. Most of that should be CDN/waiting-room absorbed. Plan origin API capacity for ~5-10k RPS and checkout writes for a few hundred orders/s.
- Order of magnitude: Outlet NK peak is roughly 1/1000 of Shopify's app-server peak (117M/min ≈ 1.95M RPS). One well-tuned Postgres primary (large instance) plus 2-3 read replicas and roughly 10-30 NestJS pods (assuming ~300-800 RPS per Node pod for I/O-bound JSON, an UNVERIFIED estimate that must be benchmarked) should suffice. No sharding at this scale.

### Gaps
- No Noon, Jumia or Zalando peak-RPS figures were found in this pass.
- No authoritative per-Node-process RPS benchmark was gathered; it must come from k6 against our own code.

## PostgreSQL at scale

### Takeaway
Use PgBouncer transaction mode with small server pools sized from measurement, keyset pagination everywhere, and vertical scale plus replicas long before Citus.

### Cited Findings
- PgBouncer defaults: default_pool_size=20 (per db/user pair), max_client_conn=100. Each pool adds its own server connections, and multiple PgBouncer instances multiply them — [OneUptime 2026](https://oneuptime.com/blog/post/2026-01-21-postgresql-pgbouncer-config/view); [pulse.support](https://pulse.support/kb/postgresql-connection-pooling-pgbouncer)
- Postgres slows past its useful concurrency, so the pool is a concurrency limit; raise default_pool_size only with measurement — [privatedevops](https://privatedevops.com/articles/pgbouncer-pooling-without-surprises)
- Azure (managed) starting default_pool_size: ~6-12 for 8 vCores up to 40-60 for 48 vCores — [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/adforpostgresql/-/4453323)
- Keyset pagination filters on the last-seen key instead of skipping rows; OFFSET cost grows with depth. Its main drawback is that you cannot jump to an arbitrary page — [use-the-index-luke](https://use-the-index-luke.com/no-offset); [Cybertec](https://www.cybertec-postgresql.com/en/?p=43728)
- Secondary benchmark: OFFSET 20,000 ≈ 5.8 ms vs keyset ≈ 0.1 ms (setup unverified). Use composite index (created_at DESC, id DESC) as a tie-breaker — [DEV](https://dev.to/scion01/optimizing-pagination-in-postgresql-offsetlimit-vs-keyset-21dp)
- Shopify (2025) found connection exhaustion, not query speed, was the reservation bottleneck (already cited in the master prompt §20.2) — [Shopify Engineering](https://shopify.engineering/scaling-inventory-reservations)

### Inferences
- Rules: total server connections = pools x pool_size x pgbouncer instances ≤ ~0.8 x max_connections; separate pools for checkout.reserve vs catalog.read vs analytics.
- Money and stock reads (reserve, claim, ledger, bag recheck) always go to the primary. Replicas serve catalog and browse only, with a lag alert (assumed 1 s threshold, unverified).
- CI should run EXPLAIN on key queries and fail on Seq Scan over large tables; production should enable pg_stat_statements and auto_explain (log_min_duration about 200 ms). These are assumed defaults, not sourced here.

### Gaps
- No primary sources were fetched on: replica-lag norms, partial/covering index write overhead, auto_explain overhead, Citus thresholds, Prisma/Drizzle/Kysely N+1 behaviour or DataLoader. These need a follow-up pass using the PostgreSQL docs.

## Caching (CDN, Next.js, Redis)

### Takeaway
Cache pages and catalog at the CDN with stale-while-revalidate and tag-based invalidation from outbox events. Never trust cached price or stock at bag/checkout.

### Cited Findings
- Next.js 16 supports time-based revalidation via cacheLife, and on-demand invalidation via revalidateTag, updateTag and revalidatePath. revalidateTag(tag, 'max') gives stale-while-revalidate — [Next.js docs](https://nextjs.org/docs/app/getting-started/revalidating.md)
- Third-party: the second revalidateTag argument is a cacheLife profile and now has to be awaited (secondary) — [noqta guide 2026](https://noqta.tn/en/tutorials/nextjs-16-cache-components-use-cache-guide-2026)

### Inferences
- Outbox event `price.changed` / `inventory.*` → a worker calls revalidateTag(`product:{id}`) plus CDN purge by surrogate key. The PDP renders price/stock via an uncached client fetch or a short TTL (≤ 5 s, matching master prompt §5).
- Stampede control: request coalescing (single-flight lock in Redis, SET NX PX), jittered TTLs and serve-stale-on-error. This is standard practice; no source was fetched in this pass.

### Gaps
- Redis stampede literature (e.g. probabilistic early expiry) and CDN surrogate-key docs were not fetched.

## Queues and async work

### Takeaway
BullMQ has built-in rate limiting and lower latency, but needs self-run Redis. SQS is managed, with DLQs and visibility timeouts. Both are at-least-once, so consumers must be idempotent (inbox table).

### Cited Findings
- BullMQ has built-in rate limiting; SQS needs it manually — [OneUptime 2026](https://oneuptime.com/blog/post/2026-01-21-bullmq-vs-other-queues/view)
- The BullMQ limiter is per worker, so N replicas multiply the effective rate; use a shared store for fleet-wide limits — [DEV](https://dev.to/peterparker8991/nodejs-rate-limiting-library-and-api-combo-for-recoverable-nightly-queue-consumers-5cmm)
- SQS standard is at-least-once, so duplicates are normal and need idempotency keys — [Dragonfly FAQ](https://www.dragonflydb.io/faq/bullmq-vs-amazon-sqs)

### Inferences
- Because the master prompt says Redis is never a source of truth, the Postgres outbox stays the durable record; BullMQ is only the transport. Losing Redis means the relay re-publishes.

### Gaps
- No benchmark numbers were found for either queue.

## Frontend performance

### Takeaway
At p75 of field data: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 (poor thresholds are > 4 s, > 500 ms and > 0.25). The same thresholds apply on mobile and desktop.

### Cited Findings
- The thresholds above and the p75 assessment, with no split by device — [web.dev](https://web.dev/articles/defining-core-web-vitals-thresholds) (updated May 2025)
- INP replaced FID in March 2024 — [hidekazu-konishi](https://hidekazu-konishi.com/entry/web_performance_checklist_core_web_vitals.html)

### Gaps
- next/image priority/AVIF docs, bundle budget norms, streaming SSR guidance and low-end Android/Slow 4G test methods were not sourced in this pass.

## Load testing, SLOs, chaos, drop readiness

### Takeaway
Shopify's model is to load-test above the expected peak (a 200M RPM p99 test in 2025 against a measured 117M app RPM peak, roughly 1.7x, inferred), run game days and freeze code before the event.

### Cited Findings
- Shopify's 2025 readiness programme included load tests up to 200M RPM — [ByteByteGo summary](https://blog.bytebytego.com/p/how-shopify-prepares-for-black-friday)

### Inferences
- Outlet NK should k6-test at ≥ 2x the forecast Drop Hour peak (the master prompt asks for 20x baseline), including a drop scenario and chaos on PSP, Redis and search.

### Gaps
- Detailed k6 methodology and Shopify game-day specifics need the blocked shopify.engineering host.
