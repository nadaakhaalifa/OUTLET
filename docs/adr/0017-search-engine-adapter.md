# ADR-0017: Search engine adapter (Typesense behind SearchEnginePort)

Status: Proposed. Builds on ADR-0010 (bake-off) and ADR-0029 (providers stay Unconfigured and fail closed).

## Options
- **Typesense.** Single binary, typo tolerance, facets, synonyms and an Arabic locale out of the box; JSONL bulk import with upsert; hybrid vector search available. Fewer moving parts than a cluster; memory-resident index, so catalog size must fit RAM.
- **OpenSearch.** Most flexible analysis chain and scale-out, but heavy to run (JVM, shards, mappings), a larger security surface and higher cost for an Egypt-first catalog of tens of thousands of listings.
- **Postgres FTS (+ pg_trgm).** Zero new infrastructure and transactionally consistent with the read model, but no real typo ranking, facet counts are costly and Arabic/Franco handling stays hand-built in SQL.

## Decision
Typesense, per BUILD-PROMPT section 4. `TypesenseEngine` (`packages/search/src/adapters/typesense.ts`) implements `SearchEnginePort` plus `upsertDocuments`, `deleteDocuments`, `ensureCollection`, `health`.
- The index is a mirror of `search_documents`, never the source of truth; stock and price are re-read from Postgres at the PDP and bag.
- Documents carry only the allow-listed fields of the read model (no PII); money is int64 minor units.
- Every response is Zod-parsed; 5 s timeout; breaker opens after 5 consecutive failures (transport, timeout, 429, 5xx, unparsable) for 60 s and `reconcileEngine` then parks documents (they stay pending, staleness reports them).
- Enabled only when both `SEARCH_TYPESENSE_URL` and `SEARCH_TYPESENSE_API_KEY` are set on the worker; otherwise `UnconfiguredSearchEngine` and staleness says `search_provider_unconfigured`. The key is never logged.
- Kill switch `search.engine.enabled` (ui class, fail open) skips the mirror; reads then use the Postgres path.

## Fallback
`search.engine.enabled` off (or no engine) means `SearchService` serves from the Postgres read model (`engineFallback = true`, FTS/trigram over `search_documents`, kill switch `search.fts_fallback.enabled`). That path exists today; it has reduced features (no typo ranking beyond trigram).

## Consequences and follow-ups
- Mirroring runs as a bounded (25 documents) best-effort step after each applied sync event. A periodic reconcile tick for backlog after an outage is a follow-up (needs a scheduler scope).
- Version guard: reconcile always sends the current row, so an older seq never overwrites a newer one from this writer; a second writer would need a seq check.
- Production Typesense hosting, region (ADR-0002) and the Query side (`SearchService` reading from the engine) are not part of this change.
