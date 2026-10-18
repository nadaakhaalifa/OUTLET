# Spec P3-05: Demand forecasting

Refs: §20.8, §19.1 (aging inventory, size curves), §21 (Fulfilled-by-HAUL), §26. Depends on: seller-analytics (warehouse feed), inventory, orders, returns, search (no-result demand gaps), catalog, price-integrity (markdown advice must not create unverified "% off"). VR-P3-14.
Status: buildable now on synthetic or seeded history; production usefulness needs real sales history (months), so initial release is shadow mode.

## Flow
Seller Center -> Inventory -> "Forecast": per SKU/size or per category/size/governorate, shows expected units for the next 7/14/28 days with a p10-p50-p90 interval, stock cover days, suggested reorder or markdown with confidence, and the reason codes. Admin sees category-level and Fulfilled-by-HAUL stock advice. Nothing is automatic: advice only; seller or ops acts.

## Rules
- Options compared (record in ADR note): (a) seasonal-naive / ETS baseline per series, (b) gradient-boosted quantile regression with calendar and price features, (c) deep or hierarchical Bayesian model. Default (a) as the mandatory baseline, then (b) must beat (a) on rolling-origin backtest WAPE and pinball loss per segment to be served; (c) deferred. Hierarchical reconciliation across category > SKU > size so totals agree.
- Intermittent demand (most off-price SKUs are one-off lots with short life): use Croston/TSB-style or lot-level survival ("sell-through curve vs days since listing") rather than time-series on sparse counts; new SKUs borrow from category-size priors.
- Features: days since listing, price index vs VRP (verified), discount depth, events calendar (Ramadan, Eid, White Friday, payday), stock-out censoring flag (sales under stock-out are censored, not zero demand), size availability, governorate mix. Budget/affordability and size measurements are never features.
- Output always shows the interval; point forecasts alone are not shown (§20.8).
- Markdown advice states "the new price will not show % off unless verified" (§19.1).
- Cold start: fewer than N=20 comparable units -> "insufficient history", no number.
- Fairness across sellers: a seller sees forecasts built from own data plus anonymised category priors; cross-seller raw numbers never exposed; priors require >= 10 contributing sellers or k-anonymity >= 50 units (VR-P3-14 pending).
- Model cards, versioned features, shadow deploys, drift monitoring per T3.

## Edge cases
Stock-out censoring; returns (net demand vs gross); promotions and drops spikes (flagged, excluded from base level); size-curve for one-size items; cancelled COD refusals; lot-based sellers with a single batch; negative or zero history; timezone and day boundaries (Cairo); deleted SKUs; seller changes price mid-horizon; forecast for FBH where inbound lead time is long.

## Data
`demand_series(sku_id, size, day, units_gross, units_net, censored bool, price_idx, events[])` warehouse table P1 · `demand_forecasts(id, scope, scope_id, horizon_days, model_version, p10, p50, p90, created_at)` · `forecast_actions(id, forecast_id, actor, action, ts)` for audit of advice taken. No personal data in features.

## API
`GET /v1/seller/forecasts?scope=sku|category&id=` (seller, own data, RLS) · `GET /v1/admin/forecasts?category=` · `POST /v1/seller/forecasts/{id}/acknowledge`. Read-only; 30/min.

## Events
`forecast.generated` (batch), `forecast_viewed`, `forecast_action_taken`. Metrics emitted per model: WAPE, pinball loss, interval coverage, bias.

## Failure handling
Nightly batch idempotent by `(scope, horizon, as_of_date)`; failure leaves the previous forecast marked stale with timestamp; serve baseline when ML model fails evaluation gate; warehouse lag SLO <= 15 min per §19.1, forecasts tolerate 24 h.

## Security and abuse
Tenant isolation (RLS by store); scraping of forecasts by competitors impossible via ownership checks; no LLM in the numeric path (LLM may only phrase explanations from structured reason codes, validated); seller manipulation risk: sellers could game demand signals with fake purchases -> orders flagged by fraud are excluded from series.

## Metrics
Interval coverage near nominal (80% interval covers 75-85%), WAPE improvement vs naive, % advice acted on, stock-out and aged-inventory reduction for adopting sellers vs control, FBH holding cost.

## Acceptance
```
Given a backtest on synthetic seasonal data, then the served model beats seasonal-naive on WAPE or the baseline is served.
Given fewer than 20 comparable units, then the API returns insufficient_history and no numbers.
Given stock-out days, then they are flagged censored and not treated as zero demand (unit test).
Given hierarchy reconciliation, then size forecasts sum to the SKU forecast within rounding.
Given seller A requests seller B's SKU, then 404.
```
