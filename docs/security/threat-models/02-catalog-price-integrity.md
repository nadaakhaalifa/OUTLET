# Threat model 02: catalog, search and price integrity

Status: Draft for review · Date: 2026-10-11 · Spec refs: §4, §5, §9, §19, §B5, API1/API3/API6 · Code: `apps/api/src/modules/{catalog,search,price-integrity,stores,inventory(stock sync)}` · Older detail: `price-integrity-and-crawler.md`, `sellers-and-kyc.md`.

## Trust boundaries
Seller (untrusted text, images, prices, size charts) to catalog API; shopper to search/PDP; search engine (Typesense or Postgres FTS fallback) to API; external evidence sources to the integrity engine (crawler not built, see 09-crawler.md); LLM parse port to search.

## Threats
| ID | STRIDE | Threat | Existing control | Proving test | Status |
|---|---|---|---|---|---|
| PI-T1 | T | Seller fakes a "was" price to show % off | VRP computed from the internal price ledger; claim hidden without evidence; schema refuses a percentage without a reference above price | `price-integrity/test/service.test.ts`: "hides the discount when there is no evidence at all", "raise then cut inside 30 days: no inflated claim..."; `kysely.pglite.test.ts`: "the schema itself refuses a percentage without a reference above the price" | implemented+tested |
| PI-T2 | T | Stale or missing external evidence silently keeps a claim | Fail closed | service.test.ts: "stale external evidence blocks the claim (fail closed)" | implemented+tested. No live evidence source exists, so only internal ledger evidence is real |
| PI-T3 | T | Price history rewritten | `price_events` and `price_claims` append-only for every role | kysely.pglite.test.ts: "price_events and price_claims are append-only for every role, including the owner" | implemented+tested (PGlite, not real PG16) |
| PI-R1 | R | Dispute about what discount was shown | Claim records, enforcement rows, evidence endpoint | `http.authz.test.ts`: "shopper sees a verified discount with evidence and no seller-private fields" | implemented+tested. Order-line `vrp_snapshot` is a checkout concern (see 03) |
| PI-E1 | E | Seller A reads or writes store B prices/claims/trust score | RLS by store plus guard; foreign = 404 | kysely.pglite.test.ts: "a foreign seller cannot write a price event for store A", "claims and enforcement rows are visible only to their own store"; `http.authz.test.ts`: "owner A sees only store A figures" | implemented+tested |
| PI-E2 | E | Buyer token on seller route / suspended actor | Audience and status checks | http.authz.test.ts: "a seller-audience token is refused on the buyer route", "suspended seller ... are 403" | implemented+tested |
| PI-D1 | D | Search engine down | Postgres FTS fallback; 503 with typed problem when nothing can answer | `search/test/search.http.test.ts`: "returns 503 search_unavailable..."; `search/adapters/postgres-fts.pglite.test.ts` | implemented+tested. Typesense adapter tested against fixtures only (`typesense.test.ts`) |
| PI-D2 | D | Oversized pages / facet abuse | Page size <= 50, query length cap, strict filter schema | search.http.test.ts: "rejects page sizes above 50 and over-long queries", "accepts the filters JSON and rejects invalid ones with pointers" | implemented+tested |
| PI-E3 | E | Sponsored results flood top 10 | Cap of 2 in first 10 across pages | `adversarial.wave3.test.ts`: "never shows more than 2 sponsored results in the first 10 across pages" | implemented+tested |
| PI-I1 | I | Search/NL parse leaks or executes free text | `POST /search/parse` returns Zod-validated filter; LLM only via `LlmGatewayPort`, with `LlmUnavailableError` fallback to keywords | search.http.test.ts: "parses Arabic and English to the same filter", "rejects extra properties and empty text" | implemented+tested with the in-memory gateway only. No real LLM adapter (ADR-0025 Proposed), so injection controls (see 07) are untested |
| PI-T4 | T | Catalog mass assignment / bad bulk CSV | Strict DTOs, import dry-run | `catalog` tests (6 files; VERIFY individual titles) | implemented, partly verified |
| PI-T5 | T | Stock sync from a stale source overwrites newer | Versioned idempotent updates; tenant isolation | `inventory/test/application.test.ts`: "channel sync ignores a stale source version", "never lets one tenant touch another" | implemented+tested |
| PI-T6 | T | Hostile upload (image/CSV formula) | Upload pipeline (type sniff, AV, EXIF strip) | none found | not implemented (VERIFY: catalog import validates rows only) |
| PI-S1 | S | Counterfeit or duplicate listing resets history | pHash/matching | none | not implemented (Phase 2) |

## Residual risk
- The engine has no external evidence, so "Verified discount" can only come from HAUL-observed price history (>= 30 days). Launch inventory must be connected 30 days before launch (spec §P1).
- Seller automatic suspension legality is VR-15, VERIFY BEFORE LAUNCH.
- Image/CSV upload hardening not implemented.
