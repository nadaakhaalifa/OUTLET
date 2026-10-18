# Spec P3-08: Visual search

Refs: §4 (visual search Phase 3), §28 wardrobe, §20.6 ("similar" = visual + attribute embedding), ADR-0023 (pgvector vs Typesense vectors), ADR-0025, VR-P3-13. Depends on: embeddings and attributes pipeline (Phase 2 task 7), search (filters, sponsored caps), catalog images, upload pipeline (type sniff, size cap, AV, EXIF strip), recommendations, price-integrity (pHash shares tooling).
Status: buildable now; embedding model is behind an `ImageEmbedderPort` with a deterministic fake for tests. Production model choice and any external vendor need VR-P3-13.

## Flow
Search bar camera icon or Explore "shop this look": take or choose a photo (or a screenshot) -> optional crop box (on-device) per detected garment -> results: visually similar in-stock items (with seller chip, verified price badges, "in my size" filter), grouped by garment category -> refine by filters -> save search or add to wishlist. Also entry from PDP ("find similar") using the product's own embedding without upload.

## Rules
- Pipeline: (1) optional on-device garment detection and crop; (2) image uploaded over TLS to a private, short-lived bucket (or sent inline, never stored by default); (3) embed with a CLIP/SigLIP-class model (768-d, same space as `product_embeddings`, same `model_version`); (4) ANN retrieval top-K with pre-filters (in stock, scope, size, age, category) -> (5) re-rank by attribute match (colour, pattern) and price/discount verified value -> (6) diversity (<= 2 per store consecutive). Options compared: pgvector HNSW vs Typesense vector vs dedicated vector DB; default follows ADR-0023.
- Query images are **P2 personal data**: not retained after the request by default (delete within 1 hour max for debugging only if the user consented; default zero retention), never used for training, never shared with sellers, EXIF/GPS stripped, faces: if a face is detected the crop must exclude it or the request is processed on the garment region only; no face recognition or face embeddings are computed.
- No embedding of the query image is stored with a user id.
- Egress: external embedding vendors receive no user identifiers; whether even the pixels may leave the region is VR-P3-13; default is self-hosted embedder in the ADR-0002 region.
- Sponsored cap and label rules from §4 apply to visual results.
- Model versioning: queries only match products embedded with the same `model_version`; re-embedding runs as a backfill with dual index until cutover.
- Safety: reject NSFW and non-fashion images with a neutral message (classifier); size caps (10 MB, 4096 px) and rate limits.
- Quality gate: coverage and recall@K on a labelled Egyptian-catalog set before enabling (no published accuracy claim is assumed).

## Edge cases
Multiple garments in one photo -> chips per detected item; low-confidence match -> show "closest we have" with a banner, never an exact claim; screenshot of another store's product (allowed; no scraping of that store); mirror/rotated/low light; very dark skin tones and varied body types in detector evaluation (fairness test set); modest wear and printed patterns; user with Local scope and no results -> offer Global; catalog items without embeddings are skipped and listed in coverage metric; duplicated listings grouped by Buy Box; offline camera -> queue not supported (online only).

## Data
`product_embeddings` (existing) · `visual_search_requests(id, user_hash_nullable, ts, latency_ms, result_count, category_guess, model_version)` P1, **no image, no embedding, no user id by default** · `visual_search_eval_pairs` offline only (consented or catalog images).

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `POST /v1/search/visual` (multipart or signed upload id) | shopper | no | 10/min, 100/day |
| `GET /v1/products/{id}/similar?mode=visual` | public/shopper | no | 60/min |

## Events
`visual_search_performed(category, result_count, latency)`, `visual_search_result_clicked(rank)`, `visual_search_no_result`. No image data in events.

## Failure handling
Embedder timeout 1.5 s -> fall back to text-attribute search if the client sent a category hint, else a friendly error; vector index down -> Postgres fallback for `similar` by attributes (kill switch `visual_search`); upload scan failure -> 422; cost/latency budget p95 < 1.2 s.

## Security and abuse
Upload pipeline (type sniff, AV, re-encode, EXIF strip), image bombs and decompression limits, SSRF none (no URL fetch by server in v1; a "paste link" feature would require an allow-list and is out of scope), rate limits and per-user daily caps against catalog scraping, adversarial images (embedding collisions) mitigated by re-rank attribute check, no stored PII. OWASP API4 (resource consumption), API6.

## Metrics
Recall@K on labelled set, result CTR, add-to-bag from visual search, no-result rate, p95 latency, coverage of embedded catalog, embedder cost per query.

## Acceptance
```
Given a photo upload, then after the response no image bytes remain in storage within the retention default (integration test checks bucket and logs).
Given EXIF GPS in the upload, then it is stripped before any processing.
Given an out-of-stock item that is visually closest, then it is excluded from results.
Given products embedded under model v1 and query under v2, then no cross-version similarity is computed.
Given a detected face, then no face region is embedded (fake detector test).
Given kill switch visual_search is on, then the endpoint returns 503 with Problem+JSON and the PDP similar list uses attributes.
```

## Implementation notes (wave A, backend)
- Module `apps/api/src/modules/visual-search`; migrations 0068 (uploads, request telemetry, daily usage), 0069 (optional pgvector `vec_pg` + HNSW, no-op without the extension), 0070 (eval pairs and runs). Kill switch `kill.visual_search`.
- Flow: `POST /v1/search/visual/uploads` (signed private upload, 10 min TTL) then `POST /v1/search/visual {upload_id}`. The server never fetches a URL. Bytes are sniffed, bounded (10 MB, 4096 px), EXIF/XMP/GPS/comments stripped (pure TS for JPEG, PNG, WebP), classified (NSFW, fashion), face boxes passed to the embedder as mask regions, embedded, then the object is deleted in a `finally`.
- The PDP route is `GET /v1/products/{id}/visually-similar` (not `mode=visual` on the recommendations route, to leave that contract untouched).
- Retrieval: oversampled ANN then catalog re-validation for stock, store status, size, scope, budget and age; attribute re-rank; at most 2 consecutive per store. `KyselyVisualIndex` uses pgvector when `vec_pg` exists; otherwise a bounded exact scan only if explicitly allowed (tests), else 503.
- Production ports (embedder, object store facade, safety classifier, face detector, index, catalog, store) are Unconfigured until composed; the feature fails closed.
- Evaluation: `eval/` holds recall@k, MRR and coverage over a deterministic synthetic set with a CI threshold. The real Egyptian labelled set is an owner/data task (VR-P3-13).
