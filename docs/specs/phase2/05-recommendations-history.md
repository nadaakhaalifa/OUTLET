# Spec 05: Recommendations, history, personalization toggle

Refs: §13, §20.5, §20.6, ADR-0023, §B1. Phase 2.

## Flow
Home/PDP modules: "Because you bought", "Similar to what you viewed", "Similar for less" (verified only), "Goes with your purchase", "Restock reminders" (basics), "Price dropped on items you viewed". Me -> History: viewed, searched, saved, bought, returned (reasons), outfits; pause, clear, personalization toggle. Recently viewed syncs across devices.

## Rules
- Retrieval: item-item co-view/co-buy (batch) plus embedding ANN (store per ADR-0023, default pgvector). "Similar" = visual + attribute embedding. "Similar for less" = similar AND price lower AND `claim_allowed` verified (contract test with price-integrity output).
- Ranking (two-stage): candidates (ANN + rules) -> GBDT LTR (offline model, versioned, model card). Features: decayed velocity, verified discount depth, freshness, affinity, size availability, seller health, price trust, return rate. Diversity re-rank (<= 2 consecutive per store); new-seller exploration (Thompson sampling) capped 5% impressions; bot filter.
- **Budget fit never a stored feature**; only a request-time filter via `AffordabilityFilterPort` (spec 03).
- Personalization off: request carries `personalized=false`; ranking receives no user features (popularity + freshness only); verified in an integration test with a spy feature store.
- Clear history: deletes `user_events` and derived `user_features` / style vector within 24h (job with metric). Pause: no new events recorded.
- Consent purpose `personalization` required to build features; analytics events via consent-gated SDK.
- Retention: `user_events` 25 months then aggregated.
- Ranking experiments A/B with guardrails (return rate, complaints). Sponsored slots follow spec 10.

## Edge cases
Cold start -> popularity; deleted/suspended store items filtered at read; items out of user size filtered; kids profile never mixed into adult features; shared device sessions; model rollback by flag.

## Data
`user_events` (partitioned monthly, P2: user_id pseudonymous, type, item_id, ts) · `user_features` (P2) · `item_cooccurrence(item_a, item_b, score, window)` P0 · `ranking_models(version, metrics, status)` P1 · `recently_viewed(user_id, product_id, ts)` P2.

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `GET /v1/feed?personalized=` | shopper | no | 60/min |
| `GET /v1/products/{id}/similar` | any | no | 60/min |
| `GET /v1/me/history?type=` | owner | no | 30/min |
| `DELETE /v1/me/history` | owner | yes | 5/day |
| `PATCH /v1/me/settings {personalization}` | owner | yes | 20/h |
| `POST /v1/me/history/pause` | owner | yes | 20/h |

## Events
`history.cleared`, `personalization.changed`, `recommendation_impression(module, model_version)`, `recommendation_click`.

## Failure handling
Ranker down -> popularity fallback; ANN down -> category rules; feature store stale > 24h -> disable personal features (fail closed to non-personal).

## Security and abuse
BOLA; no budget or measurement features; no P3; event ingestion rate limits; bot filtering; seller-visible data aggregated k >= 50.

## Metrics
CTR per module, add-to-bag rate, diversity, p95 feed < 300 ms; guardrails: return rate, complaints.

## Acceptance
```
Given personalization off, Then feed request has personalized=false and the ranker receives no user features.
Given clear history, Then user_events and user_features are empty within 24h.
Given a similar-for-less card, Then it only appears when claim_allowed is true.
Given budget filter active, Then no budget value is persisted in any feature table.
```

## Build notes (Phase 2 build, recommendations + history)
Modules: `apps/api/src/modules/history` (events, settings, features, clear/pause, recently viewed, jobs), `apps/api/src/modules/recommendations` (feed, similar, goes-with, restock, price drops, clicks, co-occurrence job), pure domain in `packages/domain/src/recommendations`, migration `0040_recommendations_history.sql`.

**Algorithm choices (2-3 lines each).**
- Exploration: Thompson sampling (Beta(clicks+1, misses+1), integer Gamma via exponentials, seeded RNG port) vs epsilon-greedy. Chosen: Thompson, because it spends the 5% budget on arms with uncertainty and decays on its own with data; epsilon-greedy keeps wasting slots on known losers. Hard cap `floor(5% * list size)` is applied before sampling, so exploration is 0 for lists under 20.
- Diversity: greedy "never a third consecutive item of one store while another store remains" vs MMR. Chosen: greedy, because the rule is the spec's literal invariant, is O(n^2) on <= 200 items, keeps score order otherwise and is property-testable; MMR would need an item distance we do not have for stores.
- Personal feature: decayed signed event counts (14-day half-life, permille, category and store only) vs a learned user embedding. Chosen: counts, because they are explainable, deletable per user, and structurally cannot hold budget or measurement data (closed shape plus a DB CHECK).
- Retrieval: ANN neighbors of the last 3 viewed/bought items plus co-buy rows plus popular-in-top-affinity-categories; pure ANN would starve cold items, pure co-occurrence cannot see new SKUs.

**Decisions and deviations.**
- `PATCH /v1/me/settings` currently accepts only `{personalization}` (strict). If the privacy or settings module also owns `/me/settings`, merge the handlers at integration.
- `DELETE /v1/me/history` deletes events, features and recently viewed in one transaction and records a `history_clear_requests` row; the sweeper job re-deletes anything a batch rebuilt before the request time and reports `privacy_history_clear_overdue_total`. Feature builds are refused while a clear is pending.
- Personalization is decided before any user data is read. `personalized=false`, setting off, no consent, kill switch: the feature store, history and sizes are never called, and the ranker receives `features: null` (integration test with a spy).
- Features older than 24h are not served (fail closed). The ranker-down fallback is popularity + freshness; ANN-down falls back to category rules.
- Similar/for-less/goes-with is public and not personalized (no user data is read), so it is cacheable. "For less" requires strictly lower price AND `claim_allowed` from price integrity; `verified_discount_pct` is only emitted when `claimAllowed`.
- Outbox event types use dotted names (`recommendation.impression`, `recommendation.click`, `history.cleared`, `personalization.changed`) because `outbox_events.event_type` is CHECK-constrained to dotted lowercase; analytics names in the spec map 1:1.
- Budget fit: only through `AffordabilityFilterPort.filter` at request time; `isolation.test.ts` asserts that neither module imports the budget module or references budget tables, and `user_features` has a CHECK against budget/measurement keys. The dependency-cruiser rule itself belongs to the budget builder.
- pgvector: `PgVectorIndex` reads `product_embeddings(product_id uuid, vec vector(768))` (owned by the embeddings pipeline, ADR-0023). Its test is skipped on PGlite builds without the `vector` extension and is intended for the real Postgres 16 job.
- `user_events` is range partitioned with a DEFAULT partition only; monthly partition creation belongs to the retention/partition job (same pattern as `size_recommendation_log`).
- Spec gap: "bot filter" for ranking is not built here; click and impression endpoints are rate limited per user and unknown products are ignored. Bot scoring belongs to the edge/anti-abuse layer.
- Spec gap: `GET /v1/feed` has no pagination cursor (single ranked page, max 50); a cursor needs a stable ranked snapshot and is deferred.
