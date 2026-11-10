# Search bake-off (ADR-0010, tasks P1-04a and P1-04b)

## IMPORTANT: the corpus is synthetic
`queries.v1.jsonl` (500 queries) and `judgments.v1.jsonl` (250 query-to-title-pattern pairs) were **generated from our own lexicon** (`packages/search-bakeoff/scripts/generate-corpus.mjs`, seeded, deterministic). Every row carries `source: "synthetic"`. We have no real search logs yet. The ADR requires **~500 real queries** (waitlist question, brand interviews, WhatsApp Channel, user tests; no scraping, no personal data) and two human labellers (Cohen's kappa >= 0.6). **Replace both files with real data before the engine is chosen.** The numbers below prove the harness works; they do not prove an engine is good. Because queries and fixtures share one lexicon, recall is optimistic.

## Layout
- `queries.v1.jsonl`: `{id, text, script: ar|en|franco|mixed, intent, expected_normalized, expected_filters?, tags, source}`. Mix: 150 Arabic, 100 English, 100 Franco-Arabic, 50 mixed script, 50 with prices and Eastern/Persian digits (tag `digits`/`price`), 50 typos (tag `typo`). `expected_normalized` is the sorted concept ids; `expected_filters.maxPriceMinor` is in piastres.
- `judgments.v1.jsonl`: `{queryId, patterns[], grade, source}`. A fixture product is relevant when every pattern (a regex alternation such as `فستان|dress`) matches its normalised title, and (if the query has a budget) its price fits.
- `results/<date>-<engine>.json` and `results/<date>-summary.md`: output of the harness.
- Code: `packages/search-bakeoff` (text pipeline, engine adapters, harness, fixtures). Engines: `infra/local/search/docker-compose.search.yml`.

## Shared pipeline (same for every engine)
`normalizeArabic` (alef/ya/ta-marbuta folding, tashkeel and tatweel stripped, Eastern/Persian digits to ASCII) -> `parseBudget` ("تحت ١٥٠٠", "under 1500", "a2al men 1500", "up to 1.5k") -> `analyzeQuery` (greedy 1-3 token match against `synonyms.v1.json` AR/EN/Franco, Franco dictionary + rule transliteration, optional fuzzy). Each engine receives the same `engineQuery` (canonical English term per concept, plus unknown tokens) and the same price filter. Docs carry an extra `searchText` field: normalised titles plus every AR/EN/Franco variant of their concepts. The harness runs with fuzzy off so typo tolerance measures the engine, not our resolver.
Acceptance pair (tested): "فستان ابيض لينين تحت ١٥٠٠" and "white linen dress under 1500" give the same concepts (`dress linen white`) and `maxPriceMinor = 150000`.

## Running
- Offline (Postgres FTS on PGlite only): `pnpm --filter @outlet/search-bakeoff bakeoff`. Engines that are unreachable print `engine X not reachable, skipped`.
- All engines: `docker compose -f infra/local/search/docker-compose.search.yml up -d`, then the same command (URLs via `TYPESENSE_URL`, `MEILI_URL`, `OPENSEARCH_URL`). `SEARCH_BAKEOFF_DOCS` sets the fixture size (default 5000).
- Live adapter tests: `SEARCH_BAKEOFF_LIVE=1 pnpm exec vitest run --project search-bakeoff`.
- Regenerate the corpus after editing the lexicon: `pnpm --filter @outlet/search-bakeoff build && node packages/search-bakeoff/scripts/generate-corpus.mjs`.

## Postgres FTS adapter (kill-switch fallback)
Table with `tsv` built by a custom `arabic_simple` text search config (`simple` + `unaccent`), normaliser applied before indexing and to the query, GIN on `tsv`; if no tsquery match, fall back to `pg_trgm` `word_similarity` (threshold 0.4) for typos.

## Not done yet (needs the real data or Docker)
- Real queries and labels; the ADR scoring (Arabic relevance, k6 at 50 QPS on 100k SKUs, ops weight, hybrid vector, licence/cost) and hard gates. The harness measures p50/p95, recall@10, nDCG@10 (binary gain), zero-result rate, typo and Franco hit rates only.
- Docker is not installed on the dev machine used here, so Typesense, Meilisearch and OpenSearch were **never run**; the adapters are tested against mocked HTTP only. API shapes (Typesense import/search params, Meilisearch settings, OpenSearch Arabic analyzer) must be confirmed against the pinned versions on first live run. Typesense has no confirmed Arabic locale; none is set (V47).
- The sparse synthetic catalog (5k docs, up to 5 attributes per query) makes many conjunctive queries return nothing; that inflates the zero-result rate for every engine.
