# ADR-0002: Data residency and cross-border transfer (hybrid, cell per market)

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on D4). **No provisioning of any cloud account, region or service without explicit owner approval.**
- Date: 2026-11-07
- Deciders: Owner, counsel, DPO, CTO
- Sources: master prompt §B1, §T3, §T6, §T7; `docs/BUILD-PROMPT.md` §3, §6; `reports/Outlet NK end to end build plan.md` ("Keep personal data in Egypt…"); `research_notes/Outlet NK end to end build plan/cloud_residency.md`; ADR-0006 (cells); `docs/specs/shipping-domestic-international.md` §6.8

## Context

- Egypt's PDPL executive regulations (Decision 816/2025) required full compliance by about **1 November 2026**. That date has passed, so the PDPC licence and DPO are urgent (plan-and-risks Stage 0).
- Personal data may leave Egypt only with a **PDPC transfer licence**. The review takes **up to 90 days** and the fee is reported as 50% of the controller/processor licence fee (Legal500, Clyde & Co, cited in the build-plan report). Fees and categories are not confirmed (V1).
- **No AWS, Azure, Google or Oracle region exists in Egypt** as of November 2026. **Huawei Cloud Cairo** has been live since May 2024 in a Telecom Egypt Tier III facility (Huawei press release). Cloudflare has a Cairo PoP.
- Huawei's managed Postgres is RDS/GaussDB; `pg_cron`, `pgvector`, multi-AZ and KMS are **unverified** (V37). Cairo latency figures are unverified (V38).
- ADR-0006 requires **residency cells per market**: personal data lives in the market's own region; a global layer holds only the public catalog and anonymous data.

## Options considered

| | A. All in AWS UAE (me-central-1) + transfer licence | B. All in Egypt (Huawei Cairo or telco/colocation) | **C. Hybrid (chosen)** |
|---|---|---|---|
| Where P2/P3 and money data live | UAE | Egypt | Egypt |
| Public catalog, images, search | UAE + CDN | Egypt + CDN | Global edge (P0 only) |
| Transfer licence for core data | **Yes, up to 90 days** | No | No (still needed for processors abroad) |
| Managed service maturity | Highest | Unverified (V37) | Same as B for the core |
| Ops burden | Lowest | Highest | Medium: two planes, one strict boundary |
| Regulatory risk | Licence refused or late = launch blocked | Lowest | Low |
| Latency for Egyptian users | ~40–70 ms to the Gulf (UNVERIFIED, V38) | Lowest | Lowest |
| Cost | Estimates only (build-plan report); no quotes yet | No data | Estimates only |

**Choice (2–3 lines):** Option C keeps personal and money data in Egypt, so launch does not depend on the 90-day licence for the core, while the public catalog stays fast worldwide. Building only on containers, plain Postgres, Redis and S3-compatible storage keeps Option A a migration, not a rewrite, if the Huawei spike fails.

## Decision

**Option C (hybrid), organised as cells per market.** The Egypt cell (`EG`) is the only cell at launch.

### Planes

| Plane | Holds | Where |
|---|---|---|
| **Private plane, one per market cell** | Users, phones, DOB, addresses, measurements, budgets (P2/P3); orders, ledger, payouts, inventory units, audit log; KYC documents and return photos (private object storage, signed URLs ≤ 15 min, no CDN); KMS keys; Redis; queues; the in-country OTel Collector | Egypt. Primary candidate **Huawei Cloud Cairo**, after a one-week spike. Fallback **AWS me-central-1** + transfer licence |
| **Public plane (global)** | Products, display prices, defect photos and defect cards, store pages, search index, catalog embeddings, sitemaps — **P0 only** | Global edge (Cloudflare) + S3-compatible public storage (e.g. R2) |

### Where the web app runs
- The **Next.js origin runs in the private plane (Egypt)** for all routes. Cloudflare caches the anonymous public pages (catalog, store, product, passport, price-proof) at the edge. This is a refinement of the build-plan diagram, which drew the web app in the public plane: logged-in pages (bag, checkout, account) handle personal data, so they must render in-country. It also gives Egyptian users the lowest latency.
- A Next.js deployment **outside** the market cell may serve only anonymous public routes and may call only public endpoints. A CI test fails if such a deployment has a route that reads a session.

### The boundary is enforced by code
- Every column has a PII class (P0–P3) and a **residency class** in `data_inventory.yaml`. CI fails on an untagged column.
- The **only** flow from private to public plane is outbox events whose schemas live in `packages/public-events` and contain P0 fields only (Zod + contract test + dependency-cruiser rule F7 in ADR-0001).
- Search queries sent to the search engine carry no user ID, phone, address or session. Rate limiting by user happens in the API, not in the engine.
- Logs and traces go through the in-country OTel Collector, which redacts PII before export. A test fails if a phone-number pattern leaves the collector.
- LLM calls through `llm-gateway` carry no P2/P3 (master prompt §T12).

### Processors abroad are still transfers
Sentry, PostHog, LLM vendors, email and SMS providers hosted abroad count as transfers (BUILD-PROMPT §6). For each one:
1. Prefer **self-hosting in the cell** (e.g. Sentry, PostHog self-hosted), or
2. send pseudonymous data only **and** cover it in the transfer licence, with a DPA and a transfer impact assessment (TIA).
Couriers that receive a shopper's address for an international parcel are a transfer too (shipping spec §6.8, V34).

Recommendation (owner/counsel action, not engineering): **file the PDPC transfer licence early** (the build-plan report says week 2), covering processors and the AWS fallback region. Its up-to-90-day clock then ends before the beta.

### One-week spike (before any production choice)
Pass criteria (from the build-plan report): PostgreSQL 16+ with `pg_cron`; PITR; multi-AZ or equivalent; managed Redis; KMS; an IaC provider usable from OpenTofu; private networking; measured p95 latency from a Cairo probe; a support contract in English or Arabic with an SLA. `pgvector` is **not** required in-country (embeddings are public data). If `pg_cron` is missing, the sweepers run in `apps/workers` instead (ADR-0005).
The spike runs only on an account the owner approves. It uses synthetic data only.

### Fallback
If the spike fails: **Option A (AWS me-central-1)** for the private plane, with **launch gated on the transfer licence**.

### Backups and disaster recovery
Backups stay inside the same legal boundary as the primary. RPO ≤ 15 min, RTO ≤ 1 h, monthly restore drill. If Huawei Cairo has only one region, DR across countries is possible only if counsel confirms that **encrypted backups abroad are not a transfer, or are covered by the licence** (V39). Until then, DR is multi-AZ inside Egypt.

### Until this ADR is accepted
Dev and staging use **synthetic data only**. No real personal data is loaded anywhere. No cloud resources are created without owner approval.

## Consequences

**Good**
- Launch does not depend on the 90-day licence for core data.
- Region is configuration: OpenTofu modules take `data_region` and `edge_region`; no code hard-codes a region.
- A new market is a new cell (ADR-0006).
- A move to AWS, or to an AWS Egypt region if one opens, is a migration, not a rewrite.

**Bad / risks**
- Two planes to run, and a boundary that must be tested in CI.
- Huawei managed-service maturity is unknown (V37). Some partners may object to Huawei (estimate in the build-plan report).
- DR inside one country only, until V39 is answered.
- Cloudflare proxies **all** traffic, including logged-in requests with personal data. Whether TLS termination and request logs at a global CDN count as a transfer is unknown (V68). Options if counsel says yes: Cloudflare regional/data-localisation products (availability for Egypt unverified), or serve authenticated routes on a separate hostname that bypasses the global proxy.

## Verify-register rows
- **V1** PDPC licence category, fees, DPO qualification
- **V2** data residency and cross-border transfer licence; LLM vendor transfer
- **V18** grid-carbon intensity for the chosen region
- **V30** transfers between the EG cell and the next market's cell
- **V34** personal data sent to couriers for international parcels (with destination rules)
- **V37** Huawei Cloud Cairo service catalog (Postgres version, pg_cron, multi-AZ, PITR, KMS, IaC, SLA, price)
- **V38** measured latency Cairo → Huawei Cairo, AWS UAE, Frankfurt
- **V39** whether the PDPC treats encrypted or tokenised data abroad as a transfer; any adequacy list (UAE, EU)
- **V68 (new)** whether proxying personal traffic through a global CDN/WAF (Cloudflare TLS termination and logs) is a transfer, and which regional options exist

## Related
ADR-0001 (architecture), ADR-0006 (cells), ADR-0003 (money data), ADR-0010 (search placement), `docs/specs/shipping-domestic-international.md`.

## Note on sources
An older research run in the reference repo (`/Users/nadakhalifa/OUTLET/docs/adr/0002-data-residency.md`, 2026-10-10) said claims of a Huawei Cairo region were "refuted". The newer build-plan report cites Huawei's own May 2024 press release. The spike (V37) settles this with evidence.
