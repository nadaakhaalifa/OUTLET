# ADR-0022: Search engine primary: Typesense vs Postgres FTS

- Status: **Proposed**
- Date: 2026-10-11
- Deciders: CTO, Product
- Spec refs: §4, §T3, `docs/specs/search.md`, Phase 2 specs 05 and 10

## Context and problem statement
Phase 1 shipped search on Postgres FTS (`search_documents.tsv`, trigram). The master prompt names Typesense as default with Arabic normalisation, Franco-Arabic transliteration, typo tolerance and hybrid vector retrieval. Phase 2 adds sponsored slots, similar items and stylist retrieval that raise query load and relevance needs.

## Decision drivers
Arabic quality, p95 < 150 ms, operational burden, residency (ADR-0002), one source of truth for stock/price (always rechecked from Postgres), fallback story.

## Considered options
1. **Keep Postgres FTS as primary**, add trigram + pgvector for hybrid.
2. **Typesense primary**, Postgres FTS as kill-switch fallback (spec default).
3. OpenSearch/Elasticsearch managed.

## Decision (proposed default)
Option 2 only when the Phase 2 relevance gate fails on Postgres; until then **stay on option 1** behind the existing `SearchPort`. Gate: on a 500-query AR/EN/Franco golden set, Postgres FTS must reach nDCG@10 within 5% of a Typesense prototype and p95 < 150 ms at 20x baseline. If it fails, adopt Typesense self-hosted in the ADR-0002 region, fed by outbox events (staleness SLO < 60 s) with Postgres FTS as automatic fallback.

## Consequences
Good: no new infra until needed; port keeps both paths testable. Bad: Franco-Arabic and typo tolerance stay weaker on option 1; two paths to test if adopted. Option 3 rejected: heavier ops and cost for the scale.

## Owner decision required
Approve the gate-based approach (cheap) or commit to Typesense now.

## Safe default if no answer
Option 1 with the gate.
