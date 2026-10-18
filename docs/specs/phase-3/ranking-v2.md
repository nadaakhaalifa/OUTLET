# Spec: LTR ranking v2 offline pipeline and session scorer (Phase 3 wave B)

Master prompt 20.5 and 20.6, plan item 6 and 17. Backend only. Model card: `docs/ml/model-cards/ranking-v2.md`. Migrations 0079, 0080.

## Flow
1. Feed serving (v1) decides and returns the list as today.
2. After v1 has decided, an optional `ShadowObserverPort` is called without awaiting: it builds the closed feature vector per candidate, scores with the v2 model, compares with the served order, and logs the run (no user key) and the top 50 items with ranks, scores and features.
3. Ops runs `POST /v1/admin/ranking/evaluations` (seeded synthetic logs) to compare a candidate model with a baseline on NDCG@k and MAP and apply the regression gate; verdicts are stored.
4. `GET /v1/admin/ranking/shadow/summary` shows overlap, top-1 agreement and rank shift of v2 against served v1.
5. `POST /v1/admin/ranking/guardrails/evaluate` evaluates A/B guardrails (return rate, complaint rate) for a treatment against control.

## Rules
- Feature vector is closed (11 names, schema version `ranking-features-v2.1`). No budget, affordability, installment, measurement or identity field can exist (Zod strict, `forbiddenFeatureKeys`, DB CHECK).
- `personalized=false` means the user object is not read; affinity features are 0; logged rows carry `personalized=false`.
- Requests where the budget filter was applied are not shadow logged.
- Diversity: at most 2 consecutive items per store. Exploration: Thompson sampling over new sellers, at most floor(5% of list), seeded RNG per request, none for bot-scored requests (bot score >= 700 permille).
- v2 never changes the served list in this phase. Failures in shadow scoring are swallowed.
- Evaluation: exponential gain NDCG@k, MAP, bots dropped, regression gate: NDCG@k >= 0.50, within 1% of baseline on NDCG and MAP, at least 50 requests.
- Session scorer: `SessionNextItemPort` called only for personalized requests; the pure first-order transition baseline is the fake adapter.

## Options compared
| Decision | Options | Choice |
|---|---|---|
| Scoring contract | (a) async model service only, (b) pure sync `RankerModel` in domain plus async port in API | (b): deterministic tests and a no-service default; a remote GBDT is an adapter |
| Shadow trigger | (a) duplicate the feed call, (b) hook after v1 decision | (b): no second candidate pull, no latency in the response path |
| Position bias | (a) ignore, (b) inverse propensity weights with a fixed examination curve | (b) with a clamp; curve is replaced by experiment data later |
| Session model | (a) RNN now, (b) Markov baseline behind a port | (b): honest baseline, real model is an adapter |

## Data
`ranking_shadow_runs`, `ranking_shadow_items` (30 days), `ranking_eval_runs`. All system role only (RLS). Classes in `docs/privacy/data_inventory.yaml`.

## API (internal, admin audience, roles ops and super_admin)
| Route | Idempotent | Rate |
|---|---|---|
| `GET /v1/admin/ranking/shadow/summary` | n/a | 30/min |
| `GET /v1/admin/ranking/evaluations` | n/a | 30/min |
| `POST /v1/admin/ranking/evaluations` | yes, plus `request_key` | 10/min |
| `POST /v1/admin/ranking/guardrails/evaluate` | yes (pure) | 30/min |

## Threat notes (STRIDE, short)
- Information disclosure: budget conditioned data leaking into logs or models. Controls above plus tests. Seller visibility: none of these tables or routes is reachable by seller tokens (negative tests).
- Tampering: eval verdicts are append only for the app role; replays return the stored row.
- DoS: evaluation capped at 2000 requests, 10 per minute; shadow top 50 items, best effort.
- Elevation: marketing and support admins get 403 even on the admin audience.
- Abuse: bot-scored traffic excluded from evaluation and exploration.

## Acceptance
Covered by `apps/api/src/modules/ranking/test/*` and `packages/domain/src/ranking/ranking.test.ts`.

## Gaps
Real GBDT trainer and artifact loader; real session model; retention job wiring for `PurgeShadowLogs`; production sampling rate for shadow (currently every non-budget feed request).
