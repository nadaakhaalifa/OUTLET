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
