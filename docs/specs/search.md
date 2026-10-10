# Spec: Search, filters, saved searches (master prompt section 4)

Status: Phase 1 wave 3. Owner paths: `apps/api/src/modules/search`, `packages/domain/src/search`,
`packages/db/migrations/0023_search.sql`. Vocabulary follows ADR-0018 (tested code wins, then the master prompt).
Product name is Z-OUTLET.

## Scope and hard limits

In: Arabic normalization, Franco-Arabic transliteration and synonyms, the `SearchFilter` schema, a rule-based
natural-language query parser, `SearchPort` with a Postgres FTS + trigram adapter and a Typesense stub, price and
stock re-check, the sponsored cap, no-result relaxation and did-you-mean, saved searches CRUD, per-route rate limits.

Out: any LLM call (only an `LlmGatewayPort` with a fake), PSP, ledger, payouts, refunds, visual search (Phase 3),
embedding retrieval (Phase 2; the port leaves room for it), the Typesense network client.

## Flow

1. Shopper types in the search bar. `GET /v1/search/suggestions?q=` returns queries, stores, categories.
2. Shopper submits. `GET /v1/search?q=&filters=&cursor=&limit=`.
   - `q` is normalized (section "Normalization"), parsed by the rule parser. Constraints found in the text
     (colour, material, "under 1500") are merged into the explicit `filters` (explicit filters win on conflict).
   - The merged filter and the keyword remainder go to `SearchPort`. Primary is Typesense; when it throws
     `SearchUnavailableError` or the kill switch is on, the Postgres FTS + trigram adapter answers and the response
     carries `degraded: true`.
   - Candidate ids are re-checked against live catalog facts (price, stock, store open). Hits that are gone, out
     of stock or from a suspended store are dropped. Price and badge come from the re-check, never from the index.
   - The sponsored cap is applied, then the page is returned.
3. Zero results: relax the least important filter one step at a time (max 5 steps), return `relaxed_filter`
   naming the dropped filter, and `did_you_mean` when a close vocabulary term exists. Log `search_no_result`.
4. "Save search": `POST /v1/me/saved-searches`. A saved search can alert later (alert job is Phase 2).
5. `POST /v1/search/parse` returns the rule-parsed `SearchFilter`, keywords and `unparsed_fragments`.

## Rules

- Normalization (pure, idempotent): NFKC; lower-case Latin; Eastern Arabic and Persian digits to ASCII; strip
  diacritics (harakat, Quranic marks) and tatweel; fold alef variants (آأإٱ to ا), alef maqsura and Persian ya to
  ya (ى ی to ي), ta marbuta to ha (ة to ه), hamza on waw/ya to the carrier, Persian kaf to kaf; punctuation to
  space; collapse whitespace. The function iterates to a fixed point (cap 4) so idempotence holds for all input.
- Franco-Arabic: Latin tokens are folded (repeated letters collapsed, o/u, e/i, y/i equivalence) and looked up in
  a curated lexicon of concepts (category, colour, material). Each concept has AR, EN and Franco forms. The
  canonical id is English (`dress`, `white`, `linen`). `fostan`, `فستان`, `dress` are one concept.
- Parser: no network, no model. Price markers (under, below, max, up to, less than, تحت, اقل من; over, above,
  more than, فوق, اكتر من; between X and Y, من X الي Y) bind to the next number. Currency words are consumed.
  Bare numbers without a marker stay in keywords. Anything a marker could not bind goes to `unparsed_fragments`.
  Prices are integer piastres (`bigint`), never floats. Cap 10,000,000 EGP; larger is unparsed.
- `SearchFilter`: allow-list, unknown keys rejected, max 30 facets (each set scalar counts 1, each array element
  counts 1), max page size 50, query max 300 chars, `filters` JSON max 4,000 chars (API4).
- Relaxation order (least important first): new_arrivals, lowest_30d_only, min_rating, materials, colors,
  free_delivery_eligible, conditions, min_verified_discount_pct, verified_discount_only, installments_available,
  monthly_max, cod_available, payable_with_store_credit, price_min, category_ids. Never relaxed: world, store_ids,
  price_max, budget_max, fits_remaining_budget, my_size_only (hard constraints chosen by the shopper).
- Sponsored: labelled via `sponsored: true`, at most 2 in the first 10 results on the global ranked position (not per page; the cursor carries emitted rank, sponsored count and up to 8 demoted product ids so later pages never re-promote; forged or malformed cursors return 400); extras are demoted to after
  position 10, relative order of everything else is preserved. A sponsored item must still pass the same filters
  and the same re-check (it is in the same candidate set).
- A result never shows a % off unless the re-check returns `badge = verified_discount` with a reference price
  (same rule as section 5; the wire mapper forces plain price otherwise).
- Staleness: the index is fed by outbox events with a 60 s SLO; price and stock are always re-read.
- Saved searches: max 50 per user, name 1..80, filter validated by the same schema, alert flag default false.

## Edge cases

- Mixed script "dress أبيض 1500 under": handled token by token; marker and number may be in different scripts.
- Eastern Arabic numerals ("١٥٠٠"), thousands separators ("1,500", "١٬٥٠٠"), "1.5k".
- Empty query with filters only: allowed (browse by filter). Empty query and empty filter: allowed, ranked by the
  index default order (freshness).
- Index returns an id the catalog no longer knows: dropped silently, total estimate unaffected (it is an estimate).
- Page size above 50: 400. Cursor tampered: 400. Over 30 facets: 400 (validation) with a pointer.
- Typesense down: degraded response, never an error. Both adapters down: 503 `search_unavailable`.
- Another user's saved search id: 404, identical to a missing id.
- RTL and Arabic output: all user-visible strings come from the catalog's `LocalizedText`; the module formats none.

## Data

See `docs/privacy/data_inventory.yaml` (tables `saved_searches`, `search_documents`) and migration 0023.

| Table | Key columns | Class | RLS |
|---|---|---|---|
| `saved_searches` | id, user_id, name, query_text, filter_json, alert_enabled, last_run_at | P2 (filter can reveal sizes) | owner (class A), per verb |
| `search_documents` | product_id, store_id, title_ar_norm, title_en_norm, search_text, tsv, price_amount, colors, materials, conditions, category_ids, verified_discount_pct, sponsored, world, in_stock | P0/P1 projection of the public catalog | select for app roles, write system only |

Indexes: GIN on `tsv`; GIN trigram on `search_text` when `pg_trgm` is installed (feature-detected, PGlite and
minimal servers skip it); btree on (store_id), (price_amount).

## API (contract in docs/api/openapi.yaml; no new operations)

| Operation | Scope | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/search` | shopper:catalog.read | no | 30 / 10 s per user |
| `GET /v1/search/suggestions` | shopper:catalog.read | no | 30 / 10 s per user |
| `POST /v1/search/parse` | shopper:search.parse | no | 10 / 60 s per user |
| `GET/POST /v1/me/saved-searches` | shopper:search.read / write | no | 120 / 60 s, 60 / 60 s |
| `GET/PATCH/DELETE /v1/me/saved-searches/{id}` | owner | no | 120 / 60 s, 60 / 60 s |

Authorization: every route is authenticated (`buyer_api`). Saved-search routes are owner-scoped in the repository
(`user_id = caller`), so a non-owned id is a 404. The central policy has no `saved_search` resource type yet (see
Gaps); until it does, ownership is enforced in the adapter and by RLS, and tested in the negative authz matrix.

## Events

Outbox/analytics (PII-free, Zod-typed by the integrator): `search_performed(result_count, degraded, latency_ms)`,
`search_no_result(locale, normalized_query)` (demand gaps, spec 4), `saved_search.created`, `saved_search.deleted`.
This module emits through `SearchEventPublisher`; the in-memory publisher is the dev fixture.

## Failure handling

- Typesense timeout 300 ms, no retry on the read path (fallback instead). Fallback is Postgres FTS+trigram.
- Catalog facts failure: 503 `catalog_unavailable` (never serve stale prices).
- LLM gateway failure or absence: parse stays rule-based; no user-visible error.
- Repository failure: 5xx generic problem; no partial writes (single statements).

## Security and abuse

- API1/API3: saved searches are owner-scoped; DTOs are strict allow-lists; responses use explicit mappers.
- API4: facet, page-size, string-length limits above; per-route rate limits declared on every route.
- API6: query scraping is bounded by the 30/10 s limit and the 50 page cap.
- LLM01/05/10 (for the future gateway): user text is data; output must pass `SearchFilterSchema`; no tools; the
  fake gateway is the only implementation here.
- SQL: the FTS adapter builds `tsquery` text from tokens restricted to letters and digits and passes it as a bound
  parameter; no string interpolation of user input.
- Query text is P2 until a scrubber exists; it is not written anywhere by this module except the user's own
  saved search and the no-result event.

## Metrics

Search p95 < 150 ms (SLO), no-result rate < 8%, zero-result relaxation success rate, degraded-mode rate,
sponsored-in-top-10 violations (must be 0), saved-search creation rate.

## Acceptance

- "فستان ابيض لينين تحت ١٥٠٠" and "white linen dress under 1500" parse to equal filters and equal keywords.
- Eastern Arabic numerals are parsed. `fostan` finds items titled فستان.
- 31 facets rejected; limit 51 rejected.
- Any result list has at most 2 sponsored items in the first 10 (property test).
- `normalize(normalize(x)) == normalize(x)` for arbitrary strings (property test).
- Typesense stub failing yields `degraded: true` served by the Postgres adapter.
- A result whose live price changed shows the live price; an out-of-stock hit is absent.
- A saved search of user A is 404 for user B on get, patch, delete, with no side effect.

## Decisions (ADR-style notes)

- Normalization algorithm: considered (a) per-character table only, (b) NFKC plus table to a fixed point. Chose
  (b): NFKC folds presentation forms (ﻻ) and the fixed-point loop makes idempotence a guarantee, not a hope.
- Retrieval fallback: considered (a) `ILIKE '%q%'`, (b) FTS `simple` config with prefix match plus trigram
  similarity. Chose (b): index-assisted, Arabic has no stemmer in stock Postgres so `simple` plus our own
  normalization is the honest baseline; trigram rescues typos where `pg_trgm` exists.
- Query understanding: considered (a) LLM-first parse, (b) deterministic lexicon parser with the LLM as an optional
  refinement behind a port. Chose (b): testable, free, no residency question; the master prompt requires schema
  constrained output anyway.
