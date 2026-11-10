# ADR-0010: Search engine: decide by a bake-off on real Egyptian queries

- Status: **Proposed** (technical; no owner-decision dependency). The **decision in this ADR is to run the bake-off**; the engine is chosen afterwards and recorded as an update to this ADR.
- Date: 2026-11-07
- Deciders: CTO, SEO lead, Product
- Sources: `docs/BUILD-PROMPT.md` §3 ("run a bake-off … before choosing"); master prompt §4 (Typesense default, Arabic normalisation, Franco-Arabic, p95 < 150 ms, Postgres fallback); `reports/Outlet NK end to end build plan.md` ("Search engine bake-off"); `research_notes/Outlet NK end to end build plan/tech_stack.md`; reference repo `/Users/nadakhalifa/OUTLET/docs/adr/0022-search-engine-primary.md` (Postgres baseline gate idea)

## Context

- Search must handle Egyptian Arabic, English, **Franco-Arabic** ("fostan" → فستان), mixed script, typos and **Eastern Arabic digits** ("تحت ١٥٠٠"). Target p95 < 150 ms; no-result rate < 8% (master prompt §4).
- The master prompt named Typesense as default, but the research **could not verify Typesense's Arabic handling** (its docs host was blocked). Meilisearch documents Arabic article segmentation, diacritics removal and Alef/Yeh/Taa-marbuta normalisation, with no confirmed stemmer. Lucene (behind OpenSearch) ships an Arabic normaliser and stemmer. **None handles Franco-Arabic natively** (tech_stack.md).
- Licences differ and are unverified: Typesense GPL-3.0, Meilisearch MIT with some BUSL parts, OpenSearch Apache 2.0 (build-plan report, all "verify").
- The index holds only **P0 public catalog data**, so it can live in the public plane (ADR-0002). Stock and price are always re-checked from Postgres on the product page and in the bag.

## Options considered

| Option | Good | Bad |
|---|---|---|
| A. Lock in Typesense now (master prompt default) | No delay | Arabic quality unverified; may need a costly switch later |
| B. Use Postgres FTS + pg_trgm only | No new infrastructure | No Arabic stemmer in Postgres (unverified); weaker typo tolerance and synonyms |
| **C. Bake-off: Typesense vs Meilisearch vs OpenSearch, with Postgres FTS as baseline and fallback (chosen)** | Decision based on our own queries; one week of one engineer | One week of work; needs a real query set |

**Choice (2–3 lines):** Arabic relevance is the main risk and nobody has measured it for Egyptian queries, so a one-week test is cheaper than a wrong choice. Postgres FTS joins as the baseline, so we only add a new system if it clearly beats what we already run.

## Decision

Run the bake-off in **Sprint 3** (one engineer, one week, per the build-plan report). Until then, and always as fallback, search runs on **Postgres FTS + pg_trgm behind `SearchPort` and a kill switch**.

### Shared layer (same for every engine, so the test is fair)
- App-side **query normaliser** in a shared package: Arabic letter folding (alef/ya/ta-marbuta), diacritics and tatweel removal, Eastern → Western digits, Franco-Arabic transliteration, and an AR/EN/Franco synonym list. Applied to queries and to an extra indexed field.
- Same catalog, same fields, same facets, same hardware class for each engine.

### Test data
- **Queries (~500, real):** collected from the waitlist sign-up question "what are you looking for?", brand interviews, the WhatsApp Channel and early user tests. Never scraped from other sites. Mix (minimums): 150 Egyptian Arabic, 100 English, 100 Franco-Arabic, 50 mixed script, 50 with prices or Eastern Arabic digits, 50 with typos. Stored without any personal data.
- **Catalog:** real listings from signed launch brands (with their consent), padded with synthetic items to **100k SKUs** for the speed test. Launch categories first (D6), plus some other categories so multi-category behaviour is tested.
- **Labels:** two Egyptian labellers grade the top 10 results per query 0–3. Agreement Cohen's κ ≥ 0.6; disagreements are adjudicated by a third person.

### Criteria and weights (from the build-plan report)
| Criterion | Weight | How measured | Score 0–5 |
|---|---|---|---|
| Arabic relevance | 35% | nDCG@10 over all queries, also reported per group (AR, EN, Franco, mixed, digits, typos); zero-result rate | 5 = best engine; others scaled by their nDCG ÷ best |
| Filter + facet speed | 20% | k6 at 50 QPS on 100k SKUs with typical facet filters; p95 and p99 | 5 if p95 ≤ 75 ms, 3 if ≤ 150 ms, 0 if > 150 ms |
| Ops weight for a small team | 20% | Time to deploy, back up, restore and upgrade; memory per 100k SKUs; HA story | Rubric scored by two engineers, averaged |
| Hybrid vector search | 10% | Same query set with catalog embeddings added; nDCG change | 5 = built in and improves nDCG; 0 = not available |
| Licence and cost | 15% | Licence fits a commercial SaaS-plus-marketplace (counsel, V67); infra cost estimate | 0 if counsel rejects the licence |

### Hard gates (fail any = out)
1. p95 ≤ 150 ms at 50 QPS on 100k SKUs.
2. Self-hostable in our own cell or public plane; no managed service that requires sending user data.
3. Licence accepted by counsel (V67).
4. Handles Arabic normalisation correctly on the 50 digit/letter-folding test queries.

### Decision rule
- Highest weighted score among engines that pass all gates wins.
- **Keep Postgres FTS as primary** unless the winner beats it by **≥ 5% nDCG@10 overall or ≥ 10% on the Franco-Arabic group**. Fewer systems is safer for a small team.
- Tie (≤ 2 points) → the engine with the lighter ops burden (higher ops score) wins.
- Results (scores, raw numbers, hardware, versions, build hash) go to `docs/perf/search-bakeoff/` and are summarised in an update to this ADR.

### After the choice
- The index is fed by outbox events with **P0 fields only** (ADR-0002 rule F7). Staleness SLO < 60 s.
- Search requests carry **no user ID, phone or session**. Personalised re-ranking, if any, happens in the API.
- Postgres FTS stays as automatic fallback behind a kill switch; a chaos test proves it.
- Sponsored results are labelled and capped (master prompt §4).

## Consequences

**Good**
- The engine is chosen on our real queries, not on vendor claims.
- The shared normaliser improves every option, including the fallback.
- If no engine clearly wins, we avoid running an extra system.

**Bad / risks**
- One engineer-week in Sprint 3.
- 500 queries is a small set; it must be re-run after launch with real search logs (anonymised).
- Building the Franco-Arabic transliteration is our own work in every option.

## Verify-register rows
- **V47** Typesense Arabic support (official docs); bake-off result
- **V67 (new)** search engine licences (Typesense GPL-3.0, Meilisearch MIT/BUSL parts, OpenSearch Apache 2.0) for our commercial SaaS-plus-marketplace use

## Related
ADR-0001 (`SearchPort`), ADR-0002 (public plane), ADR-0007 (SEO), master prompt §4.
