# ADR-0023: Recommendation retrieval store: pgvector vs Typesense vectors

- Status: **Proposed**
- Date: 2026-10-11
- Deciders: CTO, ML lead
- Spec refs: §20.6, §11, Phase 2 specs 04 and 05

## Context and problem statement
Similar items, complete-the-look and stylist candidates need ANN over 768-d embeddings (SigLIP/CLIP). Catalog is small to mid (tens to low hundreds of thousands of SKUs).

## Considered options
1. **pgvector (HNSW) in the primary Postgres cluster / a read replica.**
2. Typesense vector fields (couples to ADR-0022 option 2).
3. Dedicated vector DB (Qdrant/Milvus).

## Decision (proposed default)
Option 1 on a **dedicated read replica**, with filters (store scope, size in stock, world) applied via SQL and a partial-index strategy; embeddings tagged with `model_version`. Revisit when p95 ANN > 50 ms at 500k vectors or replica load threatens checkout. Residency and ACID with catalog come for free; no extra system. Option 2 only if ADR-0022 picks Typesense and benchmarks win; option 3 rejected for operational cost.

## Consequences
Good: one datastore, transactional consistency, simple deletion for DSAR. Bad: HNSW build cost and memory on the replica; recall/latency tuning needed; filtered ANN can degrade recall (mitigate with oversampling).

## Owner decision required
None blocking; confirm replica budget.

## Safe default if no answer
Option 1.
