# Model card: ranking v2 (learning-to-rank) and session next-item scorer

Status: offline pipeline and shadow mode only. Nothing in this card is served to shoppers. v1 stays the served ranker until the promotion criteria below are met on real traffic.
Master prompt: section 20.5 (ranking), 20.6 (session-based, Phase 3). Spec: `docs/specs/phase-3/ranking-v2.md`.

## 1. Model details
| Field | Value |
|---|---|
| Name and version | `linear-baseline-v2` (pure TypeScript linear baseline), `tree-ensemble` evaluator for a trained GBDT exported as data, `session-markov-v1` (first-order transition baseline) |
| Owner | Recommendations / ML (Opus design, Sonnet implementation) |
| Type | Pointwise scorer over a closed feature vector, then diversity re-rank and capped Thompson exploration. Sequence model for next item sits behind `SessionNextItemPort` |
| Where it runs | `packages/domain/src/ranking` (pure), `apps/api/src/modules/ranking` (ports, shadow logging, evaluation) |
| Feature schema | `ranking-features-v2.1`, 11 numeric features, closed (see section 3) |
| Training code | Not in this repo yet: a GBDT trainer (Python, `mypy --strict`, `ruff`) is a follow-up. The Python trainer must read `ranking_shadow_items` and emit a `TreeNode[]` JSON the domain evaluator loads |
| Registry | `ranking_models` (0040): `shadow` then `active`; one active row enforced by a unique index |
| License / third party | None. No external model or data |

## 2. Intended use
- Order the already-retrieved candidate pool of the feed and similar-item modules.
- Out of scope: pricing, discount claims, eligibility, fraud decisions, anything that changes what a shopper pays, anything about credit or affordability.
- Never used when personalization is off or consent is missing: the model then receives zero user features (affinity columns are exactly 0).

## 3. Inputs and the privacy constraints (hard)
Features: `popularity`, `freshness`, `verified_discount_pct` (0 unless price integrity allowed the claim), `seller_health`, `price_trust`, `return_rate_permille`, `in_stock`, `size_available` (a label match, never a measurement), `is_new_seller`, `category_affinity`, `store_affinity`.

Not features, by construction and by test:
- Budget, affordability, remaining budget, price ceiling, installments, payday, spending cap. Budget fit is a request-time filter applied after ranking through `AffordabilityFilterPort`; its output is not stored. Requests where it was applied are not shadow logged at all.
- Body measurements, size profiles, income or any P3 financial behaviour.
- Raw user ids, session ids, device ids.

Enforcement: (1) closed feature name list and strict Zod schema; (2) `forbiddenFeatureKeys`; (3) DB CHECK on `ranking_shadow_items.features` and `user_features`; (4) dependency-cruiser rules `budget-isolated-from-targeting-and-ranking` and `budget-isolated-from-ranking-domain`; (5) boundary and integration tests.

## 4. Training and evaluation data
- Offline: seeded synthetic logged impressions (position-biased logging policy, graded relevance 0..3, bot share 5%). Reproducible by seed. Synthetic data proves the pipeline, not the quality.
- Real data (future): `ranking_shadow_items` (30 days retention) joined with click, save and purchase outcomes, with bot-scored requests (`bot_score >= 700`) dropped and position bias corrected by inverse propensity weights (clamped at 10).
- Known limits: no real interaction volume yet; labels are not counterfactual; the synthetic generator is not calibrated to Egyptian traffic.

## 5. Metrics and gates
| Metric | Definition | Gate (default) |
|---|---|---|
| NDCG@10 | Exponential gain `2^rel - 1`, log2 discount, per request, mean | >= 0.50 absolute and not more than 1% (100 bps) below baseline |
| MAP | Average precision over binary relevance (rel > 0) | not more than 1% below baseline |
| Requests | Evaluated request groups (bots excluded) | >= 50 |
| Session hit rate@k | Held-out next item in top k | reported, no gate yet |

Result on the seeded synthetic set (seed 42, 200 requests): see the evaluation endpoint `POST /v1/admin/ranking/evaluations`; the regression gate verdict and reasons are stored in `ranking_eval_runs`.

## 6. Online safety: shadow and A/B guardrails
- Shadow: v1 is served; v2 scores, ranks and overlap are logged. Overlap@10, top-1 agreement and mean rank shift are summarised at `GET /v1/admin/ranking/shadow/summary`. Kill switch `kill.ranking_v2_shadow`; ML kill switch `kill.ml_ranking` still governs all personalization.
- A/B guardrails (config `DEFAULT_GUARDRAIL_CONFIG`): minimum 500 orders per arm; halt when the treatment return rate exceeds control by more than 100 bps or the complaint rate by more than 30 bps (absolute, basis points of orders).
- Exploration: new-seller Thompson sampling is capped at 5% of the list, seeded per request; bot-scored requests get none.
- Diversity: at most 2 consecutive items of one store while another store has items left.

## 7. Fairness and abuse
- New-seller exploration prevents starvation; the store cap prevents one store from dominating a page.
- Popularity feedback loops are bounded by the exploration cap and by price trust and return-rate features.
- Bots: requests with a high bot score are excluded from evaluation and training and receive no exploration, so click fraud cannot steer the model.
- The model never sees seller identity, only seller health.

## 8. Limitations and open items
- No trained GBDT yet; the baseline is hand-weighted.
- Session model is first order; a sequence model adapter is a follow-up behind `SessionNextItemPort`.
- Position-bias estimation uses a fixed examination curve; a randomization experiment is required to estimate it from data.
- Needs real traffic volume before any promotion decision.

## 9. Promotion checklist (shadow to active)
1. Offline regression gate passes on shadow-log data, not only synthetic.
2. Shadow summary stable for 14 days (overlap, no error spikes, ranker latency p95 under 20 ms in the serving path).
3. A/B at 5% then 25% with guardrails green and no `halt`.
4. Owner sign-off; `ranking_models` row moved to `active`; model card updated with real numbers.
5. Rollback: flip `kill.ml_ranking` (rules ranker) or set the registry row back to `retired`.

## 10. Change log
| Date | Version | Change |
|---|---|---|
| 2026-10-12 | `linear-baseline-v2` | Offline pipeline, shadow logging, evaluation gate, guardrails |
