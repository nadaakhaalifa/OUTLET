# Size profiles, size charts and fit v1 (spec section 10)

Status: Phase 1 wave 1, synthetic data only, in-memory adapters, nothing deployed · Module: `apps/api/src/modules/sizing` · Pure domain: `packages/domain/src/sizing` · Migration: `0017_sizing.sql` · Data model: `docs/data-model/sizing.md` · API: `docs/api/openapi.yaml` tag `Fit` plus `/v1/seller/size-charts` · Privacy fragment: `docs/privacy/fragments/sizing.yaml` · DPIA: `docs/privacy/dpia-fit.md`

Scope of this wave (P-10 + P-11): profiles, measurement validation, structured charts, fit v1 (chart matching + item flags + brand shift from the user's own history). Out of scope and left to Phase 2/3: latent-size IRT model, learned brand bias table, photo measurement (`body_scan_captures`).

## Flow
1. Shopper creates one or more size profiles (`me`, `partner`, `child`) with a label (nickname), fit preference (`snug`, `regular`, `loose`), `modest_fit`, optional measurements and an optional usual size ("quick start").
2. Seller catalog staff submit a structured chart per product type (`POST /v1/seller/size-charts`). Inches are normalised to cm, the chart is validated and saved. A failing chart is saved as a draft (`validated=false`, `validation_errors`), never rejected, and only blocks recommendations.
3. At the PDP or from the stylist, the client calls `GET /v1/products/{id}/fit?profile_id=` or `GET /v1/fit/recommend?sku_group=&profile_id=`. The engine returns `{size, confidence, explanation[], alternatives, community_fit, model}`.
4. After delivery the shopper submits `POST /v1/orders/lines/{id}/fit-feedback`. Feedback updates the item flag counters, and the user's own history (brand shift) for the next recommendation.
5. Sellers read aggregated size demand only (`GET /v1/seller/size-demand`), cells below 50 do not exist.

## Rules
| # | Rule |
|---|---|
| R1 | A user has at most 6 live profiles (422 `profile_limit_reached`). Limit enforced in the use case and by a trigger. |
| R2 | `label` 1..40 chars after trim. A `child` profile holds only label, fit preference and measurements. The schema is strict, so a date of birth, photo or any other key is a 400. There is no DOB or media column in the table. |
| R3 | Measurements are P3. They are encrypted per profile through `FieldCipherPort` (envelope encryption, AAD = profile id + purpose) before they reach the repository. The repository and the database only ever see ciphertext. They never appear in logs, events, outbox payloads or seller-facing responses. |
| R4 | Storing measurements or a usual size requires the `measurements` consent (422 `measurements_consent_required`). Withdrawing consent stops the engine from reading them (the recommendation reports `measurements_consent_required`), data erasure is the DSAR flow. |
| R5 | Measurement ranges are the OpenAPI `Measurements` ranges. Out of range, non finite or unknown keys are rejected (400 with pointer). Cross checks: `under_bust_cm <= bust_cm`, `high_hip_cm <= hip_cm`, height/weight BMI between 8 and 80. Values are rounded to 0.1 cm. |
| R6 | Units: the API is cm and kg. Chart input accepts `cm` or `in` per chart. Inches are converted once with 2.54 and rounded to 0.1 cm. The stored chart is cm only, the original unit is kept in `unit_entered`. |
| R7 | Chart validity (all rows in the chart's unit, after normalisation): size labels unique and 1..12 chars; every measure required by the product type template present on every row; values in range; each measure non-decreasing in row order; at least one required measure strictly increases between consecutive rows; the delta between consecutive rows does not exceed the plausible maximum per measure (bust, waist, hip 12 cm; inseam 6; shoulders 5; sleeve 5; foot length 2.5; height 20). Failing rows return `{size_label, code}` with codes `missing_measure`, `out_of_range`, `not_monotonic`, `no_progress`, `delta_too_large`, `duplicate_size_label`, `unknown_product_type`. |
| R8 | A product type without a template cannot be validated (`unknown_product_type`). Templates live in the domain (`size_chart_templates` table is seeded with the same set). |
| R9 | Recommendation only from a validated chart. No validated chart: 404 `fit_unavailable`, no guess. |
| R10 | Item flag (Beta-Binomial, uniform Beta(1,1) prior): shown as `community_fit` only with n >= 20, together with `sample_size`. Below 20 the flag is `insufficient` and has no influence on the size. |
| R11 | Confidence is in [0, 1] and rounded to 2 decimals. Below 0.6 the response leads with the "not sure, check the size chart" explanation and the UI shows the check-the-chart state. |
| R12 | Brand shift from the user's own history: among the user's feedback in the same brand, `net = too_small - too_large`. `net >= 2` moves the recommendation one size up, `net <= -2` one size down, with an explanation that cites the count. Only the profile's own feedback counts. |
| R13 | Feedback only for a delivered line of the user (404 otherwise, never revealing another user's line). One feedback per order line (second is 409). Replays with the same idempotency key return the first response. |
| R14 | Seller demand cells exist only with `demand_count >= 50` (k-anonymity at source, table CHECK and use case). `demand_count` counts DISTINCT shoppers per cell, not requests (ADV-1: repeat calls by one shopper do not raise it). Sellers can never read profiles, measurements, per-user feedback or user ids. |
| R15 | Model use of measurements requires the `measurements` consent every time a recommendation is computed, because the usual size label is under the same consent. Without it the response is 422 `measurements_consent_required`. |

## Algorithm choice (chart matching)
| Option | How | Verdict |
|---|---|---|
| A. Nearest row | Euclidean distance between body measurements and each chart row, pick the smallest | Treats 2 cm too tight like 2 cm too loose, ignores fit preference, stretch and modest cut, so it recommends "closest number" rather than "the size that fits". Rejected. |
| B. Ease-aware asymmetric penalty (chosen) | Target garment size = body + ease(fit preference, modest) - stretch credit. Weighted mean penalty per row, too tight costs 3x too loose, pick the minimum | Matches how garments are actually sold and is explainable per measure. Costs a few constants (documented, admin tunable later). Deterministic, no training data needed (cold start). |

Constants: ease for circumferences snug 0 / regular 4 / loose 10 cm, modest +4 cm; shoes foot length + 0.5 / 1.0 / 1.5 cm; stretch credit none 0 / some 2 / high 5 cm; tight penalty factor 3; weights bust 1.0, waist 1.0, hip 1.0, shoulders 0.6, sleeve 0.5, inseam 0.8, foot_length 1.5, height 0.8. Modest fit adds a x2 penalty when sleeve or inseam is shorter than the body.

### Between sizes rule
When the two best rows differ by 1.0 cm of penalty or less: `snug` or (`regular` with stretch `some`/`high`) takes the smaller size; `loose`, `modest_fit`, or `regular` with no stretch takes the larger size. The explanation says why.

### Confidence
`coverage` = weighted share of chart measures that the profile supplies. `quality = 1 / (1 + penalty / 2)`. `separation = min(1, margin / 3)` where margin is the penalty gap to the second best row (single row chart: 0.5). `confidence = 0.2 + 0.6 * coverage * quality * (0.5 + 0.5 * separation) + 0.1 * [item flag known] + 0.1 * [own history of at least 2 events in brand]`. Maximum 1.0, minimum 0.2 when any data exists. A profile with only a usual size (consent given) starts at 0.40, bonuses included it is capped at 0.55, so it is always flagged not sure.

### Item flag shift
With n >= 20: `m_small = (nSmall + 1) / (n + 2)`, `m_large = (nLarge + 1) / (n + 2)`. `runs_small` if `m_small >= 0.30` and `m_small - m_large >= 0.15`, symmetric for `runs_large`, else `true_to_size`. A tendency other than true to size shifts the size by one in that direction (up for runs small). Combined shift (item flag + own history) is clamped to +/-1 so a stack of signals cannot run away; the index is then clamped to the chart bounds, so the answer is always a size that exists in the chart.

## Edge cases
- Between two sizes: rule above. Single size chart: that size, separation 0.5.
- Profile without any measurement the chart needs: 422 `measurements_required`.
- Chart edited after sales: a new `chart_version` row, `fit_feedback.size_chart_id` stays bound to the version used. Item flags are per `(product_id, size_chart_id)`.
- Profile deleted: ciphertext and the profile row are removed. Aggregates (flags, demand) stay because they hold no personal data. Feedback rows keep their `profile_id` as NULL (`ON DELETE SET NULL`).
- Impossible measurement (waist 300 cm): 400 with pointer `/measurements/waist_cm`.
- Kid profile with `date_of_birth` in the body: 400 (strict schema).
- Concurrent update of a profile: `If-Match` carries the ETag, mismatch is 412, missing is 428 (conforms to the OpenAPI operation).
- Seller with several stores: the module resolves the actor's first brand grant. A store selector is a gap reported in `needs`.
- Withdrawn consent mid-session: the next fit call returns 422, nothing cached.

## Data
See migration `0017_sizing.sql` and `docs/privacy/fragments/sizing.yaml`.
| Entity | Key columns | PII | Tenancy |
|---|---|---|---|
| `size_profiles` | id, user_id, kind, label, measurements, quick_start (bytea ciphertext), fit_pref, modest_fit, version, deleted_at | P3 | owner (RLS class A) |
| `size_chart_templates` | product_type, version, required_measures | P0 | none |
| `size_charts` | id, store_id, product_type, chart_version, unit_entered, rows (cm), validated, validation_errors | P0 | store (class B), validated rows publicly readable |
| `fit_feedback` | id, order_line_id UNIQUE, user_id, profile_id, product_id, brand_id, product_type, size_chart_id, size_label, rating, area | P2 | owner, never seller |
| `item_fit_flags` | (product_id, size_chart_id), n_small, n_ok, n_large | P0 | public read, system write |
| `seller_size_demand_agg` | (store_id, product_type, size_label, week), demand_count >= 50 | P0 | store |
| `size_recommendation_log` | id, occurred_at, pseudonymous_id, product_id, recommended_size, confidence | P1 | platform only |

Deviation from `docs/data-model/sizing.md`: `fit_feedback` gains `brand_id`, `product_type`, `size_label` snapshots (needed for the brand history rule without a cross-module join); `k_anon_ok` is dropped because the CHECK makes it always true; `brand_size_bias`, `user_latent_sizes`, `body_scan_captures` arrive in Phase 2/3.

## API
Conforms to existing operations (no edit to `openapi.yaml`).
| Operation | Route | Authz | Idempotent | Rate limit |
|---|---|---|---|---|
| listSizeProfiles | `GET /v1/me/size-profiles` | buyer, self | n/a | 120/min user |
| createSizeProfile | `POST /v1/me/size-profiles` | buyer, self | optional key | 60/min user |
| getSizeProfile | `GET /v1/me/size-profiles/{profileId}` | buyer, owner (404 otherwise), ETag | n/a | 120/min |
| updateSizeProfile | `PATCH /v1/me/size-profiles/{profileId}` | buyer, owner, `If-Match` | optional key | 60/min |
| deleteSizeProfile | `DELETE /v1/me/size-profiles/{profileId}` | buyer, owner | optional key | 60/min |
| recommendFit | `GET /v1/fit/recommend?sku_group=&profile_id=` | buyer, self | n/a | 120/min |
| getProductFit | `GET /v1/products/{productId}/fit?profile_id=` | buyer, self | n/a | 120/min |
| submitFitFeedback | `POST /v1/orders/lines/{orderLineId}/fit-feedback` | buyer, owner of line | required key | 60/min |
| listSellerSizeCharts | `GET /v1/seller/size-charts` | seller brand role read, store scoped | n/a | 120/min |
| createSellerSizeChart | `POST /v1/seller/size-charts` | seller owner/manager/catalog, store scoped | optional key | 60/min |
| (not in OpenAPI) seller size demand | `GET /v1/seller/size-demand` | seller read roles, store scoped | n/a | 30/min |

The size-demand route comes from `docs/data-model/sizing.md` API table and is missing in `openapi.yaml`: reported as a deviation.

Other deviations to report: `recommendFit` and `getProductFit` document no 404 on `recommendFit` and no 422 on both; this module returns 404 `fit_unavailable` (no validated chart or unknown product) and 422 `measurements_required` / `measurements_consent_required`. `FitRecommendation` has no `not_sure` flag and forbids extra properties, so "not sure" is `confidence < 0.6` plus the first explanation line.

## Events
Outbox (domain): `size_profile.updated` (ids only, no measurement), `size_chart.validated`, `fit_feedback.submitted` (ids, rating, brand id). Analytics (exists in `docs/analytics/event-taxonomy.md`): `size_recommended {product_id, confidence}` server side, needs `measurements` consent (already enforced by the call itself). `fit_feedback_submitted {product_id, fit_outcome}` is client emitted, not emitted here.

## Failure handling
Cipher unavailable: 503, nothing stored (no plaintext fallback). Catalog port unavailable: 503 `catalog_unavailable`. Feedback ingestion idempotent on `order_line_id`. Event publisher failure never fails the request after commit (events are best effort in the in-memory adapter; production uses the outbox in the same transaction).

## Security and abuse
Threat notes (STRIDE short form):
- Spoofing: audience enforced by the guard (`buyer_api` vs `seller_api`); a buyer token on a seller route is 401.
- Tampering: strict Zod allow lists (API3), ranges per field, `If-Match` on update. Seller charts are untrusted input: labels are `[A-Za-z0-9 ./+-]` only (1..12 chars, rejected with 400 at the boundary, and again in the domain), no HTML.
- Repudiation: every authorization decision is audited by the platform guard; feedback keeps submit time.
- Information disclosure (main risk): measurements are P3. Encrypted before persistence, absent from logs and events, owner-only RLS, no seller route can reach profile or feedback tables, demand aggregates have k >= 50 at source, response `Cache-Control: no-store` (platform). The stylist/LLM gets a size label only (LLM02), this module returns the label, not measurements.
- DoS: 120/min on recommend, chart size capped at 30 rows, profile cap 6, body cap by Express default.
- Elevation: BOLA on `profileId`, `orderLineId`, `chartId`: other owner or tenant gives 404, never 403. Feedback poisoning: delivered lines only, one per line, rate limited, count-capped shift (+/-1).
- OWASP API: API1 BOLA (owner scoped repo plus resolver), API3 property level (explicit wire mappers), API4 (limits above), API5 function level (brand roles), API6 (feedback is a business flow, one per line).

## Metrics
Size-related return rate (target -10% vs control), recommendation coverage (share of PDP views with a validated chart and a profile), calibration (ECE < 0.05 from `size_recommendation_log`), acceptance, feedback rate, share of responses below 0.6. SLO: recommend p95 < 150 ms.

## Acceptance (Gherkin, mapped to tests)
- Given a user who submitted `too_small` twice for brand X, when they ask for a recommendation for another brand X product, then the size is one step above the chart match and the explanation cites "2" returns (api test `shifts up after two too_small in the same brand`, domain test `history shift`).
- Given a product without a validated chart, then the response is 404 `fit_unavailable` (api test).
- Given waist 300 cm, then 400 (domain + api test). Given inches input, the stored cm equals value x 2.54 rounded to 0.1 (domain test).
- Given a child profile with a date of birth, then 400 (api test).
- Given no measurements consent, creating a profile with measurements gives 422 (api test).
- Given 19 feedback events no `community_fit`, given 20 it appears with `sample_size` 20 (domain + api test).
- Given any valid inputs the recommended size is a size label of the chart and confidence in [0, 1] (property tests).
- Given 49 units of demand no cell is returned, given 50 it is (api test).
- Every endpoint: 401 unauthenticated, 401 wrong audience, 403 wrong brand role, 404 other owner or tenant (api negative authorization tests).
- Mutation score on `packages/domain/src/sizing/fit.ts` at least 80%. Stryker config: `packages/domain/src/sizing/stryker.config.mjs` (run `pnpm exec stryker run src/sizing/stryker.config.mjs` from `packages/domain`). Result of the wave 1 run: Stryker's dry run passed (59 tests) but the mutation phase crashed in this sandbox with `spawn pgrep EAGAIN` (tree-kill), so the score was measured with a hand-rolled operator mutation harness (194 mutants on fit.ts: comparison, arithmetic, logical, boolean, numeric constant and Math.min/max swaps): 183 killed, 11 survived = 94.3%. All 11 survivors are equivalent mutants (comment text, string literal, return type annotation, a sentinel `-1` that is only tested with `< 0`, an unused coverage value, `gap < 0` vs `<= 0` at gap 0, a sort tie-break that the between-sizes rule symmetrises, a clamp bound that is unreachable). The official Stryker score still has to be recorded by the integrator on a machine where it can spawn processes.
