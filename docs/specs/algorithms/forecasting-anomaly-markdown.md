# Algorithm spec: demand forecasting, anomaly detection, markdown and price-elasticity advice

- Status: **Proposed** (architect draft, 2026-10-16). Documents only; no code changed by this spec.
- Phase: Phase 3 (§20.8 forecasting, §19.1 aging and markdown advice) plus the §23 anomaly alerts and §9.4 price anomalies. Everything stays behind kill switches that default to Blocked (ADR-0029 fail closed).
- Spec refs: master prompt §9 (Price Integrity), §19.1, §20.5, §20.7, §20.8, §23, §T3, §T6, §T8, §T10, §T12, A2.4 (integer piastres), A2.10 (tests); `docs/specs/phase-3/demand-forecasting.md` (P3-05); `docs/specs/price-integrity.md`; `docs/specs/seller-analytics.md`; ADR-0002 (residency), ADR-0025 (LLM residency), ADR-0045 (dashboard read path), ADR-0047 (analytics time zone); VR-P3-14 (cross-seller aggregates).
- Existing code this spec extends (read before building):
  - `packages/domain/src/forecasting/*`: `prepareSeries` (censored and flagged days become `null`, missing days are genuine zeros), minimum history `MIN_COMPARABLE_UNITS = 20`, `MIN_OBSERVED_DAYS = 28`, models `seasonal_naive`, `ets_seasonal` (additive level plus weekly seasonal, grid α ∈ {0.1, 0.2, 0.3, 0.5}, γ ∈ {0.1, 0.3}), `croston_sba` (α = 0.1), intermittency rule "zero share ≥ 0.5", rolling-origin backtest on 7-day sums (min train 14 days), gate `beatsBaseline` (strictly lower WAPE and no worse pinball), normal-approximation 80% interval with Poisson variance floor, `reconcileTopDown` (largest-remainder integer apportionment), k-anonymity release gate for governorate cells (`FORECAST_K_MIN = 50`). Model version `baseline-v1`.
  - `apps/api/src/modules/forecasting/*`: nightly build per store, scopes `sku | category | category_size | category_governorate`, tables `forecast_demand_series`, `demand_forecasts`, `forecast_runs` (migrations 0064, 0065), kill switch `kill.demand_forecasting`, ingest schema that rejects `user_id`, `measurements` and `budget`.
  - `packages/domain/src/seller-analytics/markdown.ts`: `heuristic_v1` markdown (10/20/30% steps by aging severity, hold at sell-through ≥ 70%, whole-pound rounding after banker's rounding, seller floor), `showsPercentOff: false` as a type-level literal, bilingual `MARKDOWN_NOTICE`.
  - `packages/domain/src/price-integrity/vrp.ts`: `computeVrp` (EU prior-price model, 30-day window, `floor((VRP − p)·100/VRP)` on bigint piastres, claim only if ≥ 5%).
- No anomaly-detection module exists today (research note `ai_features_pdpl.md`). No SLO burn-rate implementation was found in code.

## 0. Constraints that shape every choice

| # | Constraint | Consequence |
|---|---|---|
| C1 | Built in-house. No external AI vendor. | Only open-source libraries run inside our own containers (Python: numpy, scipy, statsmodels, statsforecast, lightgbm, scikit-learn, numpyro or PyMC; TS: our own domain code). No hosted forecasting, AutoML or LLM API in any numeric path. The LLM gateway is not used by anything in this spec. |
| C2 | No personal data leaves Egypt. | All training and serving runs in the ADR-0002 data plane. Better still, every input in this spec is P0/P1 aggregate data (SKU-day units, prices, counts). No P2/P3 column is an input; the ingest schemas stay strict and reject `user_id`, measurements and budget. Budget and affordability data are never features (§12). |
| C3 | Money is integer piastres, banker's rounding once, at a documented point. | Floats are allowed inside the statistical models (they produce unit and elasticity estimates, not money). Any price leaving a model is converted to bigint piastres by one function (`toAdvicePrice`, §3.7) that applies banker's rounding once, then whole-pound flooring, then the floor clamp. |
| C4 | A markdown must never create an unverified "% off" claim (§9, §17). | Advice carries `showsPercentOff: false` as a literal type. The only thing that can display a percentage is the VRP engine at read time, over the real `price_events` ledger. A preview of what the VRP engine *would* say is computed by calling `computeVrp` on a hypothetical history, and is labelled as a preview. |
| C5 | Served only if it beats the baseline; refuse rather than guess. | Every model has a seasonal-naive (or event-aligned seasonal-naive) baseline and a backtest gate. Below the data thresholds no number is produced. |
| C6 | Every parameter here is untuned. | Each numeric default is marked **UNTUNED (inference)**. They are starting points for the synthetic and shadow backtests in §4, not claims. |
| C7 | Advice only, seller acts. | Nothing in this spec changes a price, stock level, payout or order. Applying advice goes through the existing authenticated price-change path with an Idempotency-Key and audit. |

Reading guide: §1 forecasting, §2 anomaly detection, §3 markdown and elasticity, §4 offline evaluation, §5 architecture, §6 parameter register, §7 open decisions, §8 unverified points, §9 references.

---

# 1. Demand forecasting

## 1.1 Problem shape

Off-price fashion data is the hard case for forecasting:
- **Lots, not lines.** Most SKUs are one-off lots (overstock, samples, end of season) with a fixed starting stock that is never replenished. Many SKU series end in a stock-out, so late zeros are censored demand, not zero demand.
- **Short life.** A typical SKU lives weeks, not years. Year-over-year seasonality cannot be learned per SKU, only per category.
- **Sparse and intermittent.** At SKU × size × day most cells are 0 or 1.
- **Moving events.** Ramadan, Eid al-Fitr and Eid al-Adha follow the Hijri calendar and move about 11 days earlier each Gregorian year (a lunar year is about 354.37 days, so the shift is about 10.9 days). A 364-day seasonal naive is therefore misaligned with the most important events in Egypt.
- **Price-driven spikes.** Drops, flash hours, vouchers and verified discounts cause spikes that are partly planned (known in advance) and partly not.

Forecast targets (unchanged from P3-05, extended):
- Horizons h ∈ {7, 14, 28} days, daily granularity summed to the horizon.
- Scopes: `category`, `category_size`, `category_governorate` (k-gated), `sku`, and new `sku_size` (needed by the markdown DP and by FBH restock advice).
- Output: an integer interval at quantiles {0.1, 0.5, 0.9} (the served 80% interval), plus internally {0.05, 0.25, 0.75, 0.95} for nested-interval checks and for the DP. There is still no standalone point estimate type.

## 1.2 Notation

- `y_{s,t}`: net units (gross minus returns attributed to the order day) for series s on Cairo day t; integer ≥ 0.
- `a_{s,t} ∈ [0, 1]`: availability, the share of the selling day on which the SKU (or the size) had at least one unit available to reserve. New input, see §1.6. Today only the boolean `censored` exists; `censored = (a < 1 and the SKU sold out that day)`.
- `c_{s,t} ∈ {0, 1}`: censored flag. `f_{s,t} ∈ {0, 1}`: promotion/drop flag (existing).
- `x_{s,t}`: regressors (calendar events, price index, promotion indicators, age since listing).
- `ŷ_{s,t+h|t}`: forecast made at origin t for day t+h. `Y_{s}(t,h) = Σ_{k=1..h} y_{s,t+k}`: horizon sum.
- `q_τ`: forecast quantile at level τ.

## 1.3 Options compared

| Option | Fits our data? | Complexity | Accuracy evidence | Cost | Scalability | Verdict |
|---|---|---|---|---|---|---|
| (a) Seasonal naive / event-aligned seasonal naive | Always defined with ≥ 7 days | Trivial | The benchmark everything must beat (Hyndman & Koehler 2006 scale MASE by it) | ~0 | Postgres or TS | **Mandatory baseline** (exists) |
| (b) ETS / Holt-Winters (additive level + weekly season, no trend) | Smooth series with ≥ 4 weeks; fails on intermittent zeros | Low | Strong on M3/M4-type data (Hyndman et al. 2002; Makridakis et al. 2020) | Very low | TS domain, per series | **Keep** for smooth series (exists) |
| (c) Croston / SBA / TSB | Built for intermittent demand. SBA removes Croston's upward bias (Syntetos & Boylan 2005). TSB updates the demand probability every period, so it decays toward zero when an item stops selling, which suits obsolescence and end-of-lot behaviour (Teunter, Syntetos & Babai 2011) | Low | Standard for spare-parts-like demand | Very low | TS domain | **Keep SBA, add TSB**; TSB preferred for lots past their peak |
| (d) Hierarchical reconciliation (bottom-up, top-down, MinT) | Required: sellers compare SKU, size and category numbers | Medium (MinT needs a covariance estimate) | MinT with shrinkage beats bottom-up and top-down on most hierarchies (Wickramasuriya, Athanasopoulos & Hyndman 2019) | Low | Python, per store hierarchy | **Top-down stays v1; MinT-shrink (non-negative) for v2** where all nodes pass |
| (e) Poisson / negative-binomial GLM, Bayesian hierarchical with partial pooling across size, colour, store, category | Best fit for sparse counts with short history: SKUs borrow strength from siblings and parents (Gelman & Hill 2007; Chapados 2014); NB handles overdispersion (Snyder, Ord & Beaumont 2012) | Medium-high | Strong for slow movers when the hierarchy is informative | Medium (MAP + Laplace nightly, full posterior monthly) | Python ml-service | **Chosen as the main v2 model for R1/R2 regimes** |
| (f) Gradient boosting (LightGBM) with quantile or Tweedie loss, one global model across series | Needs many series and months of history; learns events, price and age effects jointly | Medium | Dominated the M5 accuracy competition, which was Walmart retail unit sales (Makridakis, Spiliotis & Assimakopoulos 2022) | Medium | Python, one model per category group | **Chosen for the R3 regime only**, behind the same gate |
| (g) Size-curve and launch-profile models, analogue cold start | Only option for SKUs with no history. Fashion new-product forecasting from analogue attributes is documented at a flash-sales retailer (Ferreira, Lee & Simchi-Levi 2016); early-sales updating is classic (Fisher & Raman 1996) | Medium | Good when analogues are close; poor otherwise | Low | Postgres (conjugate update) + Python (analogue search) | **Chosen for R0** |
| (h) Deep global models (DeepAR, transformers) | Need far more data than we will have at launch | High | Strong at scale (Salinas et al. 2020) | High (GPU) | Python | **Deferred** (no data to justify it) |

**Choice in 3 lines.** Keep the existing TS baselines (seasonal naive, ETS, SBA, plus TSB) as the always-available `baseline-v2` path. Add a hierarchical negative-binomial model with partial pooling as the main learned model, because it is the only option that is principled at 0–2 units per SKU-day and degrades gracefully to its parent. Add LightGBM quantile only once data volume justifies it, and use analogue launch profiles plus a Gamma-Poisson early-sales update for items with no history. Every model passes the same backtest gate, and intervals come from conformal calibration instead of a normal approximation.

## 1.4 Data regimes and the decision rule

Classify each series nightly. Counts use **comparable units** (units on usable days) and **observed weeks** (weeks with ≥ 4 usable days), measured at the series' own grain.

Intermittency classes follow Syntetos, Boylan & Croston (2005): ADI = mean interval between non-zero days and CV² = squared coefficient of variation of non-zero sizes. The cut-offs ADI = 1.32 and CV² = 0.49 are taken from that paper.
- smooth (ADI < 1.32, CV² < 0.49), erratic (ADI < 1.32, CV² ≥ 0.49), intermittent (ADI ≥ 1.32, CV² < 0.49), lumpy (ADI ≥ 1.32, CV² ≥ 0.49).
- This replaces the present "zero share ≥ 0.5" test. The two agree closely on daily data, because a zero share of 0.5 implies ADI of about 2.

| Regime | Rule (UNTUNED inference) | Candidate models (baseline always included) | What the seller sees |
|---|---|---|---|
| **R0 cold start** | `comparableUnits < 20` OR `observedDays < 28` (the existing gate) | Analogue launch profile (§1.9), size curve (§1.10), Gamma-Poisson early-sales update | SKU: no number (unchanged refusal). Drop or lot: a launch-profile band "based on similar items in your store", only if the analogue backtest passes (§1.9.4). Otherwise `insufficient_history`. |
| **R1 short** | 20 ≤ units, 4–11 observed weeks | seasonal naive, ETS (smooth/erratic), SBA and TSB (intermittent/lumpy), hierarchical NB (§1.7) | Interval at h = 7, 14 and 28 if the gate passes. Below 8 weeks, h = 28 is served only at category scope. |
| **R2 medium** | 12–51 observed weeks | R1 set + NB with promotion and price regressors | All horizons |
| **R3 long** | ≥ 52 observed weeks at **category** level, with at least one Ramadan and one White Friday observed in the store's category history, AND a global training pool of ≥ 200 series × 26 weeks in the category group | R2 set + LightGBM quantile (§1.8) | All horizons; event effects from own history rather than platform priors |

SKU-level series almost never reach R3 (lots don't live a year). In practice, R3 applies to category and category × size nodes, and SKUs inherit from them through the hierarchy (§1.11).

## 1.5 Baselines

1. **Seasonal naive (weekly)**: `ŷ_{t+k} = y_{t+k−7⌈k/7⌉}`, latest usable same-weekday value (exists).
2. **Event-aligned seasonal naive** (new, R3 only): for a day inside an event window E (for example Ramadan day 12), use the value at the same event offset in the previous occurrence of E, scaled by the ratio of the 28-day pre-event levels:
   ```
   ŷ_{t+k} = y_{prev(E, offset(t+k))} · L_pre(current E) / L_pre(previous E)
   L_pre(E) = mean of usable y over the 28 days ending 7 days before E starts
   ```
   Outside event windows it falls back to the weekly seasonal naive. The baseline that a model must beat is whichever of (1) and (2) has the lower backtest scaled pinball. This prevents a model from "beating" a baseline that is known to be broken during Ramadan.

## 1.6 Censored demand and stock-out correction (unconstraining)

The current code throws censored days away (`null`). That is unbiased only if stock-outs are unrelated to demand, which is false: the hottest items sell out first, so dropping their days biases demand downward (the classic revenue-management unconstraining problem; Talluri & van Ryzin 2004, ch. 9; Weatherford & Pölt 2002).

**New input.** `availability_bps` per (sku, size, day): the share of the store's selling hours (Cairo 00:00–24:00 by default) during which `inventory_units` had at least one unit `available` for the size. It is computed from inventory reserve and claim events by the series feeder. It is P1 data with no personal component. `censored` stays and becomes derived: `censored = availability_bps < 10000 AND the size ended the day sold out`.

**Method, chosen by option comparison:**
- (i) Drop censored days (current behaviour): simple, but biased low on hot items.
- (ii) **Exposure offset**: treat availability as exposure. `y_{s,t} ~ NB(a_{s,t} · μ_{s,t}, φ)`, so `log E[y] = log a + log μ`. Exact under a constant within-day intensity, cheap, and it fits directly into the GLM of §1.7.
- (iii) **EM / Tobit-style unconstraining**: treat `y` as right-censored at observed sales when the size sold out, so `D ≥ y`. The E-step replaces `y` by `E[D | D ≥ y; μ, φ]`. More faithful when the stock-out happened late in the day after a demand burst.

**Chosen:** (ii) as the default in all learned models, with (iii) only for days where `a ≥ 0.5` and the size sold out (demand burst then stock-out), capped at 3 EM iterations (UNTUNED). Days with `a < 0.05` carry no information and stay `null` (UNTUNED). The TS baselines keep behaviour (i) because they cannot take an offset. Backtest actuals are only taken from windows with no censored day (as now), so evaluation is never computed against imputed numbers.

E-step for an NB(μ, φ) with variance `μ + μ²/φ`, censored at `y`:
```
E[D | D ≥ y] = ( μ − Σ_{d=0}^{y−1} d · P(D=d) ) / P(D ≥ y)
```
This is computed exactly from the NB pmf (y is small). The imputed value is never written to `forecast_demand_series`; it lives only inside the fit.

**Size substitution** (demand for M moving to L once M sells out) is real but not modelled in v1. Its effect is that sibling sizes look over-demanded after a stock-out. Mitigation: size-level series include an indicator `sibling_size_out` as a regressor in NB and GBDT, so this effect is absorbed rather than learned as a demand shift. Open item O-7.

## 1.7 Hierarchical negative-binomial model (main learned model)

Fitted per store and category group, nightly, at **sku_size × day** grain. All other scopes are aggregates of it.

```
y_{i,t} ~ NegBin(mean = a_{i,t} · μ_{i,t}, dispersion φ_g)          variance = μ + μ²/φ_g
log μ_{i,t} = β_0
            + u_cat(i) + u_sku(i) + u_size(cat(i), size(i)) + u_colour(cat(i), colour(i))
            + s_{cat(i)}[dow(t)]                                        weekly profile per category
            + Σ_e β_{e, cat(i)} · E_e(t)                                 event regressors (§1.12)
            + β_price,cat(i) · log(p_{i,t} / p^{ref}_i)                   price index (§1.13)
            + Σ_m β_m · P_m(i,t)                                          promotion indicators (§1.13)
            + g_cat(i)(age_{i,t})                                         life-cycle curve, natural spline, 4 knots at 7/14/28/56 days
            + β_sib · sibling_size_out_{i,t}

Partial pooling (random effects):
u_cat ~ N(0, σ_cat²)    u_sku ~ N(0, σ_sku²)    u_size ~ N(0, σ_size²)    u_colour ~ N(0, σ_col²)
β_{e,cat} ~ N(β̄_e, τ_e²)        β_price,cat ~ N(β̄_price, τ_p²)
log φ_g ~ N(log 2, 1)
```
- `colour` is the catalog colour family (a small closed enum), never free text.
- The `store` effect enters only through the per-store fit. Cross-store pooling (a platform-level prior for a category's `β̄_e`, `β̄_price` and life-cycle curve) needs VR-P3-14 to be resolved. Until then, the hyper-priors are fixed weakly informative values (below), and the flag `forecast.cross_seller_priors` stays Blocked.
- Weakly informative fixed hyper-priors (UNTUNED inference): `σ_* ~ HalfNormal(1)`, `β̄_e ~ N(0, 0.5²)`, `β̄_price ~ N(−1.5, 1²)` (see §3.3 for the source of the elasticity prior), `τ ~ HalfNormal(0.5)`.

**Fitting procedure** (cost-bounded; choice between full MCMC nightly and approximate inference):
1. **Nightly**: MAP estimate of all coefficients with the variance components held fixed. That is a ridge-penalised NB GLM (L-BFGS, statsmodels or scipy). Then a **Laplace approximation** of the posterior covariance for the fixed and random effects of each SKU.
2. **Monthly**: re-estimate variance components (σ, τ, φ) with NumPyro stochastic variational inference (or NUTS on a 10% stratified sample). The result is versioned in `forecast_model_registry`.
3. **Predictive distribution** for horizon h: draw M = 500 samples (UNTUNED) of coefficients from the Laplace posterior. For each draw, draw daily NB counts with planned regressors (future events and scheduled drops are known; unplanned promotions are set to 0; availability is set to 1 for the forecast of *demand*). Sum to `Y(t,h)` and take empirical quantiles. This is the raw interval, which is then conformalised (§1.14).
4. **Lot cap**: the *sales* forecast used by the markdown DP and stock cover is `min(D, on_hand)` per sample path. The *demand* forecast shown on the forecast card is unconstrained, labelled "demand". Both are stored, and they never mix.

**Why not full MCMC nightly**: about 10⁴–10⁵ sku_size series per large store would make NUTS too slow for a nightly window on CPU, so we use MAP with a Laplace approximation. Laplace under-states tails for small counts. The conformal step corrects coverage empirically, so the cost of the approximation is a wider calibrated interval, not a wrong one.

## 1.8 Gradient boosting with quantile loss (R3 only)

- One LightGBM model per (category group, quantile τ ∈ {0.1, 0.5, 0.9}) trained on all series in the group with pinball loss `ρ_τ(u) = u(τ − 1{u<0})` (Koenker & Bassett 1978). The alternative is one Tweedie-loss mean model plus conformal intervals; choose by backtest. Default: quantile models with CQR (§1.14), because they give conditional, heteroscedastic widths.
- Target: daily units at sku_size grain, with availability as a feature and censored days removed from the target.
- Features (all P1): lags 7, 14, 28 (only those available at the origin), rolling means 7/28, age since listing, log price index, verified-badge indicator (from VRP at that day), promotion indicators, event regressors and event offsets (§1.12), day of week, Cairo payday window, category, size, colour family, condition, size-run position, store age. **Forbidden features** (CI lint on the feature list): anything from `budget`, `sizing`, `users`, `consent`, `addresses`, `identities`; any per-shopper aggregate.
- Quantile crossing is fixed by sorting the three predicted quantiles per row (rearrangement, Chernozhukov, Fernández-Val & Galichon 2010).
- Horizon sums: quantiles of a sum are not sums of quantiles. Use the daily median sum for p50, and obtain horizon intervals by **conformalising the horizon sum directly** (§1.14) instead of adding daily quantiles.

## 1.9 Cold start: analogues and launch profiles (R0)

### 1.9.1 Lot sell-through curve
For a lot listed with starting stock S_0 at day 0, cumulative sell-through in a category follows a life-cycle curve. Use a Weibull cumulative curve (UNTUNED choice; compared with a Bass diffusion curve, Bass 1969, which needs a third parameter that our data cannot identify):
```
F(d; λ, k) = 1 − exp(−(λ d)^k)       fraction of potential demand realised by day d
expected cumulative demand by day d:  M · F(d; λ, k)       M = latent lot demand (units)
```
- `(λ, k)` is a per-(category, price band, condition) launch profile, estimated from completed lots in the store, using lots with ≥ 28 days or a sell-out. Sell-out lots are right-censored observations of M, handled by the same exposure logic as §1.6.
- `M` scales with the size of the lot. Use `M = S_0 · m`, where `m` is the lot's demand-to-stock ratio, `log m ~ N(μ_m, σ_m²)` per profile.

### 1.9.2 Analogue selection
Distance between a new SKU and completed SKUs in the same store and category, over a fixed attribute vector:
- brand tier, price band (price ÷ category median, log), colour family, season tag, condition, size-run breadth, discount verified (yes/no), drop vs regular listing.
- Distance is Gower distance (mixed categorical and numeric). Take the K = 20 nearest analogues (UNTUNED), each with weight `w_j ∝ exp(−d_j / h)` and bandwidth h = median distance.
- Later option: add the in-house SigLIP image embedding (ADR-0023) as a cosine-distance term, once visual search is composed. Not in v1.

The launch prior is the weighted average of the analogues' `(log λ, log k, log m)`, with a weighted variance plus the profile's residual variance. With fewer than 8 analogues in the store (UNTUNED), use the category profile only. With fewer than 8 completed lots in the category, return `insufficient_history`.

### 1.9.3 Early-sales update (Gamma-Poisson, runs in Postgres)
After listing, update the lot's demand scale from observed sales (Fisher & Raman 1996 show that early sales sharply reduce uncertainty for fashion items). With `(λ, k)` fixed from the prior, daily demand intensity is `M · F'(d)`. Put a Gamma prior on M:
```
M ~ Gamma(α_0, β_0)      matched to the analogue prior mean and variance: α_0 = mean²/var, β_0 = mean/var
observed: n = Σ_{d ≤ t} y_d over available exposure  E_t = Σ_{d ≤ t} a_d · (F(d) − F(d−1))
posterior: M | data ~ Gamma(α_0 + n, β_0 + E_t)
predictive demand over (t, t+h]:  NegBin(r = α_0 + n, p = (β_0 + E_t)/(β_0 + E_t + ΔF))   ΔF = Σ_{d=t+1}^{t+h} (F(d) − F(d−1))
```
This is a closed form, so it can run as SQL or in the TS domain with no Python dependency. It is the fallback when the ml-service is killed.

### 1.9.4 Gate for cold start
Run a leave-one-lot-out backtest over completed lots in the category. For each lot, predict days 1–14 sales from its analogues before listing, and days 8–21 after a 7-day early-sales update. Serve the launch band only if:
- its scaled pinball beats the "category average lot curve" baseline, and
- conformal coverage of the 80% band on those lots is within [0.70, 0.90] with ≥ 30 lots (UNTUNED).

## 1.10 Size curves

Allocating a SKU (or lot) forecast across sizes uses a Dirichlet-multinomial size curve (Minka 2000 for estimation):
```
θ_sku ~ Dirichlet(κ · π_cat)                          π_cat = category size-share curve; κ = concentration
after n_s units sold per size s (on available days only):
E[θ_s | data] = (κ π_cat,s + n_s) / (κ + Σ n)
```
- `π_cat` comes from the store's category history, weighting each size's sales by `1/availability` to avoid the sold-out bias. It falls back to a flat curve over the size run when there are fewer than 50 category units (UNTUNED).
- `κ` is estimated per category by the Minka fixed-point on completed SKUs, with a starting value of 20 (UNTUNED).
- One-size items: a single size, curve = 1.
- The seller "size-curve analysis" (`sizeCurve`, `gapBps`) stays as the descriptive view. The posterior shares become the *predictive* size curve for restock and lot-mix advice.

## 1.11 Hierarchy and reconciliation

Hierarchy per store: `store → category → category×size`, with `category → sku → sku×size`, plus a grouped dimension `category×governorate` (k-gated, never below k = 50).

Options compared:
- **Bottom-up** (sum the sku×size forecasts): coherent by construction, but noisy at low levels.
- **Top-down by forecast proportions** (exists): stable at the top, but loses the children's own information on the split. It is unbiased only if the proportions are right (Athanasopoulos, Ahmed & Hyndman 2009).
- **MinT** (minimum trace): `ỹ = S (S' W⁻¹ S)⁻¹ S' W⁻¹ ŷ`, with W the base-forecast error covariance shrunk toward its diagonal (Wickramasuriya, Athanasopoulos & Hyndman 2019; shrinkage per Schäfer & Strimmer 2005). It is optimal among linear unbiased reconciliations under the model, but can produce negative values.
- **Non-negative MinT**: the same objective subject to `ỹ ≥ 0`, solved as a quadratic program (Wickramasuriya, Turlach & Hyndman 2020).

**Chosen:**
- v1 keeps top-down on medians (exists).
- v2 uses **non-negative MinT-shrink on means** where every node of a category subtree has status `ok` and ≥ 8 backtest origins (UNTUNED). W is estimated from the in-sample one-step residuals of the same backtest.
- After reconciliation, integerise with the existing largest-remainder apportionment (deterministic tie-break by key), so integer children sum exactly to the integer parent.

**Intervals under reconciliation.** Quantiles are not additive, so reconciled quantile intervals are not coherent in general (Panagiotelis, Gamakumara, Athanasopoulos & Hyndman 2023).
- In v2, generate S = 500 joint sample paths at the bottom level: Laplace draws for NB, or bootstrapped residual blocks for TS models.
- Reconcile each path with the same projection, clip at 0 and re-project once.
- Take quantiles per node, then conformalise each node separately.
- Invariant: reconciled *medians* sum exactly. Intervals are monitored for plausibility (parent p90 ≤ Σ child p90 and parent p10 ≥ Σ child p10 is expected under positive dependence but is **not** asserted as an invariant).

## 1.12 Seasonality and events, including the Hijri shift

### 1.12.1 Calendar table
New table `calendar_events(event_code, occurrence_year, start_day, end_day, calendar 'hijri'|'gregorian'|'commercial', status 'provisional'|'confirmed', source, confirmed_by, confirmed_at)`.

Admin-maintained and audited. Seeded events:
- **Hijri:** `ramadan` (1–29/30 Ramadan), `eid_al_fitr` (1–3 Shawwal), `eid_al_adha` (10–13 Dhu al-Hijja), `islamic_new_year`, `mawlid`.
- **Gregorian, fixed:** `mothers_day_eg` (21 March), `coptic_christmas` (7 January), `sham_el_nessim` (computed from Coptic Easter, the Monday after), `revolution_days`.
- **Commercial, admin-set each year:** `white_friday` (the platform's own campaign window), `eleven_eleven`, `back_to_school_eg` (start of the school year), `summer_season`, `payday_window` (default: last 3 days of the month and first 2 days, UNTUNED inference), HAUL mega drops.

**Hijri to Gregorian.** Provisional dates are computed with the tabular or Umm al-Qura conversion (the `hijri-converter` Python package or an equivalent algorithm), with ±1 day uncertainty. In Egypt, Dar al-Ifta announces the actual start of Ramadan and Shawwal after moon sighting. A provisional occurrence switches to `confirmed` only when an admin records the announced date. Forecasts covering a provisional event add reason code `event_date_provisional`, and the event regressor is spread over the ±1 day window (weights 0.25 / 0.5 / 0.25, UNTUNED).

### 1.12.2 Event regressors
For each event e and day t, use a small set of **phase indicators** relative to the event start, rather than one dummy. This lets the model learn pre-event shopping (the Eid outfit peak in the last 10 days of Ramadan) and the post-event lull:
```
ramadan:     pre_7 (−7..−1), r_1_10, r_11_20, r_21_end, eid_fitr_1_3, post_fitr_4_10
eid_al_adha: pre_10 (−10..−1), adha_1_4, post_5_10
white_friday:pre_3, wf_window, post_3
back_to_school: pre_21 (−21..−1), bts_1_7
payday_window, mothers_day_pre_7, mega_drop(d) (scheduled from the drops module)
```
- Event effects are multiplicative (log-link coefficients) in NB and features in GBDT.
- In ETS and seasonal naive they are absent. This is one reason those models are expected to lose during events, and it is why the event-aligned baseline exists.
- **Moving-holiday treatment**: because these events move against the Gregorian year, a Gregorian annual seasonal term is *not* used for SKU or category models with less than 3 years of data. Annual climate seasonality (summer vs winter apparel) enters through the category `season tag` and a smooth day-of-year spline at category level only (R3), estimated jointly with the Hijri event terms. With one year of data the spline and the Ramadan effect are confounded. This is the same identification problem as lunar holidays in Gregorian series (Lin & Liu 2003 for Chinese New Year; X-13ARIMA-SEATS moving-holiday regressors, U.S. Census Bureau). Therefore the spline is only switched on at R3 with 2+ years.
- **Unobserved event**: if the store and category have never seen an event (for example the first Ramadan after launch), the coefficient is its prior (`β̄_e`, platform prior only if VR-P3-14 allows, otherwise 0 with prior sd 0.5). The forecast carries reason code `event_unobserved`, and conformal calibration uses the event-segment residual pool, which is empty, so the interval is widened by the fallback rule in §1.14.4.

### 1.12.3 Intraday
Ramadan changes the hour-of-day profile (late-night shopping after iftar). Demand forecasting is daily, so this only matters for anomaly detection (§2.4), where the hour-of-week profile is keyed by `regime ∈ {normal, ramadan}`. Egypt reinstated daylight-saving time in 2023, so hourly profiles are keyed by Cairo local hour (ADR-0047), and DST-change days are excluded from hourly baselines (⚠ VERIFY the current DST rule each year).

## 1.13 Promotions and price as regressors

- `price_index_{i,t} = log(p_{i,t} / p^{ref}_i)`, where `p^{ref}_i` is the SKU's own median price over its first 14 listed days (UNTUNED). This is not the VRP: the VRP is a legal reference for display, while the index is a modelling quantity. They are never interchanged.
- `badge_{i,t} ∈ {none, launch, lowest_30d, verified}`: from VRP output on that day (a display effect, separate from the price effect).
- Promotion indicators: `in_drop`, `flash_hour`, `voucher_eligible` (store or platform voucher applicable to the SKU), `sponsored` (ads), `homepage_featured`, `plus_early_access`.
- **Known vs unknown at forecast time**: scheduled drops, planned store vouchers and calendar events are known and enter the forecast. Ad-hoc vouchers and sponsored bids are not, and are set to their 28-day base rate. A forecast made with a planned promotion carries reason code `planned_promotion_included`.
- The TS baselines keep excluding flagged days from learning (existing behaviour), so the baseline is a "regular-price" forecast. This is documented on the card.

## 1.14 Probabilistic outputs and calibration (conformal prediction)

The present interval is `mean ± z·sd` with a Poisson variance floor and independent daily errors. It is labelled nominal because its coverage is unmeasured. v2 calibrates every model's interval empirically.

### 1.14.1 Split conformal on horizon sums (all models)
For a segment g = (category group, regime, horizon h, model), collect calibration pairs from the rolling-origin backtest (§1.15). Each pair is the actual horizon sum `Y` and the model's raw interval `[L, U]` (or raw quantiles) at that origin, from windows with no censored day.

Conformalised quantile regression score (Romano, Patterson & Candès 2019):
```
E_j = max( L_j − Y_j , Y_j − U_j )                  j = 1..n
Q̂ = the ⌈(n+1)(1−α)⌉-th smallest E_j               α = 0.2 for the served 80% interval
calibrated interval: [ max(0, ⌊L − Q̂⌋) , ⌈U + Q̂⌉ ]
```
- For models that give only a mean (ETS, SBA, TSB), use normalised residual scores (Lei et al. 2018): `E_j = |Y_j − Ŷ_j| / σ̂_j`, with `σ̂_j = sqrt(max(Ŷ_j, 1) + s_j²)` from the in-sample residual scale, and interval `Ŷ ± Q̂·σ̂`.
- p50 is not conformalised; it is the model median (rounded half-even to an integer).
- The finite-sample guarantee `P(Y ∈ C) ≥ 1−α` holds under exchangeability of calibration and test scores (Vovk, Gammerman & Shafer 2005). Time series are not exchangeable, so the guarantee is approximate. Hence (1.14.2) and the monitoring in §4.5.

### 1.14.2 Adaptive conformal for drift
Track coverage online per segment with adaptive conformal inference (Gibbs & Candès 2021):
```
α_{t+1} = α_t + γ (α − err_t)       err_t = 1 if the realised horizon sum fell outside the interval at origin t
γ = 0.005 (UNTUNED); α_t clamped to [0.05, 0.35]
```
The served quantile uses `α_t` in place of α. This keeps long-run coverage near the target under distribution shift (for example after a platform-wide traffic change).

### 1.14.3 Nested quantile set
Compute calibrated intervals at α ∈ {0.5, 0.2, 0.1} (50/80/90%), using the same scores and quantiles at the three levels. Nesting `C_{50} ⊆ C_{80} ⊆ C_{90}` holds by construction because Q̂ is monotone in α. Property-tested (§4.2).

### 1.14.4 Too few calibration points
- With `n < 20` in the segment (UNTUNED), pool to the parent segment (drop the model, then the regime).
- If still `< 20`, serve the raw interval widened by a factor of 1.5 (UNTUNED), with reason code `coverage_unmeasured`. The UI label "nominal 80% range, not yet measured" stays as today.
- If `n < 20` even at platform level for this horizon, the horizon is not served.

### 1.14.5 Count-specific calibration diagnostics
Use the randomised PIT histogram for count forecasts (Czado, Gneiting & Held 2009) and reliability per quantile level τ: the share of actuals below `q_τ` should be ≈ τ. This is reported per segment in the admin model-health view.

## 1.15 Evaluation and the serving gate

### 1.15.1 Rolling-origin backtest (Tashman 2000)
- Origins every 7 days, expanding window, minimum training of 28 days (raised from the current 14), up to the last 26 origins (UNTUNED).
- Each origin forecasts h ∈ {7, 14, 28}. The test window must be fully uncensored, otherwise it is skipped and counted in `skipped_censored`.
- Fixed train/calibration split per origin: models are fit on data up to origin o. Their conformal scores at origin o use calibration pairs from origins < o only (no peeking).

### 1.15.2 Metrics (all stored in basis points or milli-units, integers)
With `e = Ŷ − Y` and in-sample scale terms computed on the training part of the series:
```
MASE   = mean|Y − Ŷ| / ( (1/(n−m)) Σ_{t>m} |y_t − y_{t−m}| ),  m = 7          (Hyndman & Koehler 2006)
RMSSE  = sqrt( mean (Y − Ŷ)² / ( (1/(n−1)) Σ (y_t − y_{t−1})² ) )             (M5; Makridakis et al. 2022)
pinball_τ(Y, q) = τ (Y − q) if Y ≥ q else (1 − τ)(q − Y)
SPL    = (1/|T|) Σ_τ mean pinball_τ / ( (1/(n−1)) Σ |y_t − y_{t−1}| ),  τ ∈ {0.1, 0.5, 0.9}   (scaled pinball, M5 uncertainty)
WSPL   = Σ_s w_s · SPL_s,  w_s = series revenue (piastres, bigint) over the last 28 days / total   (weighted scaled pinball)
WAPE   = Σ|Y − Ŷ| / Σ Y       (kept for continuity with v1)
bias   = Σ (Ŷ − Y) / Σ Y      (positive = over-forecast)
coverage_{α} = share of origins with Y inside C_{1−α}
```
- If a scale denominator is 0 (a series with no change in training), the series is excluded from MASE, RMSSE and SPL and judged on WAPE and pinball (v1 rule).
- Interval quality also uses the interval score `IS_α = (U − L) + (2/α)(L − Y)1{Y<L} + (2/α)(Y − U)1{Y>U}` (Gneiting & Raftery 2007), so that a wide interval cannot win on coverage alone.

### 1.15.3 Gate: "served only if it beats the baseline" (v2 rule)
A candidate model c is served for series s only if **all** of the following hold:
1. `origins ≥ 4` (UNTUNED; v1 used ≥ 1).
2. `SPL_c ≤ 0.95 · SPL_base` (a 5% margin, UNTUNED) **and** `MASE_c < MASE_base`. If scales are undefined, the v1 rule applies: `WAPE_c < WAPE_base` and pinball no worse.
3. The calibrated 80% coverage of c on its segment is within [0.70, 0.90] (UNTUNED), or the segment has fewer than 20 calibration points and c is the baseline itself.
4. `|bias_c| ≤ 2000 bps` (UNTUNED).
5. A paired loss test across origins does not favour the baseline. This is a one-sided Diebold-Mariano test on per-origin pinball differences with the small-sample correction of Harvey, Leybourne & Newbold (1997), applied only when origins ≥ 8. A `p > 0.5` result in favour of the baseline blocks the candidate. With fewer origins only rules 1–4 apply.

Among the candidates that pass, the lowest SPL is served. Ties go to the simpler model in this order: seasonal naive < ETS < SBA < TSB < NB < GBDT. If no candidate passes, the baseline is served (as now) with its calibrated interval, or `insufficient_history` if the baseline has no valid backtest. Combination of models (Makridakis et al. 2020) is deferred to v3 for explainability.

### 1.15.4 Shadow mode
Every new model version first runs in shadow for 4 weekly origins on live data (UNTUNED). It writes `demand_forecasts_shadow` rows that are never served. Promotion requires the gate to pass on live shadow origins as well as on history, and is recorded in `forecast_model_registry` with the approver.

## 1.16 Outputs to sellers (derived quantities)

- **Stock cover days** for a SKU with `on_hand` units: `cover_p50 = on_hand / (p50_28 / 28)`. The cover range is inverted from the interval: `[on_hand / (p90_28/28), on_hand / (p10_28/28)]`. When `p10 = 0` the upper end is shown as "more than 28 days". Integer days, floor.
- **FBH restock advice** (only for Fulfilled-by-HAUL replenishable SKUs, not lots): reorder quantity = `max(0, q_{0.9}(lead_time + review_period) − on_hand − on_order)`, from the sales forecast (lot-capped is irrelevant here). Advice only; liability per VR-P3-14.
- **Reason codes** (extended set): `weekly_seasonality`, `intermittent_demand`, `lumpy_demand`, `stockout_days_unconstrained`, `promotion_days_excluded`, `planned_promotion_included`, `event_included:<code>`, `event_unobserved`, `event_date_provisional`, `baseline_served`, `model_beat_baseline`, `analogue_launch_profile`, `coverage_measured`, `coverage_unmeasured`, `reconciled_to_parent`, `not_reconciled_partial_children`, `pooled_from_category`.

---

# 2. Anomaly detection

## 2.1 Scope and the three tiers

| Tier | What | Method | Can it be killed? |
|---|---|---|---|
| **T-1 Invariants** | Ledger trial balance ≠ 0, a hash-chain break, store-credit projection ≠ postings, payout > seller payable, refund > captured amount, oversell > 0, reconciliation unmatched > 3 days | **Deterministic rules, not statistics.** These already live in the ledger-integrity, reconciliation and inventory modules (ADR-0046). This spec only routes them into the same alert inbox. | **No.** Never behind an anomaly kill switch. |
| **T-2 SLO journeys** | Checkout success, reserve latency, webhook → PAID, API latency, search, crash-free, refunds within 24h (§T8) | **Multi-window, multi-burn-rate alerts** (SRE Workbook, Beyer et al. 2018) | Owned by observability, not by this module |
| **T-3 Business and risk KPIs** | GMV, orders, AOV, refunds (count, amount, rate), payout failures and holds, COD refusal, conversion, checkout volume, fraud signals (card-testing auths, OTP sends per prefix, gift-card failed redemptions, referral clusters), price anomalies (§9.4) | **Statistical detectors** (this section) | `kill.anomaly_detection`; price ML under `kill.price_anomaly_ml` |

**Burn rate (T-2), for completeness and deduplication.** `burn = error_rate_window / (1 − SLO)`:
- Page when burn > 14.4 over both 1h and 5m, or burn > 6 over both 6h and 30m.
- Ticket when burn > 1 over both 3d and 6h.

These tier values are the SRE Workbook's commonly cited defaults for a 30-day budget. The project's checkout SLO uses a 28-day window, so the multipliers scale by 28/30 (⚠ the research note says the tier numbers came from secondary summaries; verify against the Workbook text).

## 2.2 Options compared

| Option | Strength | Weakness for us | Verdict |
|---|---|---|---|
| (a) Robust z on deseasonalised values: `z = (y − median)/(1.4826·MAD)` (Rousseeuw & Croux 1993; Leys et al. 2013) | Simple, robust to past outliers | Needs a seasonal adjustment first; Gaussian thresholds are wrong for small counts | Used **as the residual scaler** inside (c), not standalone |
| (b) STL decomposition + seasonal hybrid ESD (Cleveland et al. 1990; Rosner 1983; Hochenbaum, Vallis & Kejariwal 2017) | Proven for seasonal operational metrics; handles multiple anomalies | Batch-oriented; holiday-unaware unless events are removed; STL needs ≥ 2 full seasons | **Admin backfill and weekly review** only |
| (c) Forecast-residual control charts: seasonal, holiday-aware baseline forecast → standardised residual → point test plus CUSUM/EWMA for persistent shifts (Page 1954; Roberts 1959; Lucas & Saccucci 1990) | Online and incremental; reuses the event calendar from §1.12; detects both spikes and small sustained shifts; ARL theory gives a principled false-alarm rate | Only as good as the baseline; needs a burn-in | **Chosen as the primary detector for T-3** |
| (d) Isolation forest (Liu, Ting & Zhou 2008) | Multivariate, no distributional assumption | Unlabelled scores are hard to explain and to set budgets for; poor for one time series | **Chosen only for multivariate entity scoring** (sellers' pricing behaviour §2.8, fraud features §2.9), as a signal, never an automatic action |
| (e) Bayesian online change-point detection (Adams & MacKay 2007) | Detects regime changes and gives run-length posteriors | Hazard and prior choice are sensitive; heavier compute | **Chosen as a v2 annotator**: marks level shifts so baselines re-anchor after a real regime change (for example, a new PSP going live), not as a pager |

**Choice in 3 lines.** Forecast-residual control charts are the only option that is online, holiday-aware by reusing the §1.12 calendar, and comes with a false-alarm theory (ARL) that maps to an alert budget. Count and ratio metrics use exact NB and beta-binomial tail probabilities instead of Gaussian z, so low-volume sellers and night hours do not page. Isolation forest and BOCPD stay in supporting roles where they are strong (multivariate entities, regime marking).

## 2.3 Metric catalogue for T-3 (v1 set)

| Metric | Grain | Type | Dimensions for "what changed" | Model |
|---|---|---|---|---|
| GMV (piastres) | 15-min tick over hourly buckets; daily | money | category, store, governorate (k-gated), payment method, platform/app version | Decomposed: orders (count) × AOV (log robust) |
| Orders placed | hourly, daily | count | same + world (local/global) | NB tail |
| Checkout attempts (volume) | 15 min | count | platform, app version, payment method | NB tail (catches traffic loss the SLO ratio misses) |
| Checkout success rate | 15 min | ratio | payment method, PSP, 3-DS, app version | Beta-binomial tail; **suppressed while a T-2 burn alert is open** |
| Refund count and amount | daily | count, money | reason, payment method, store, courier | NB tail; amount via log robust z |
| Refund rate | daily | ratio (refunds / delivered lines, by delivery cohort) | category, store | Beta-binomial |
| Payout failures, holds | daily | count | PSP/bank rail | NB tail (T-1 handles amount correctness) |
| COD refusal rate | daily | ratio | governorate, courier, first order or not | Beta-binomial |
| Conversion (purchases/sessions) | hourly | ratio | source, platform | Beta-binomial + shift-share explanation |
| Card-test signal: auth failures across distinct BINs per IP/device bucket | 5 min | count | BIN country, PSP | NB tail + CUSUM |
| OTP sends per country prefix | 5 min | count | prefix, SMS provider | NB tail (§1 SMS pumping) |
| Gift-card failed redemptions | 15 min | count | none (global), account bucket | NB tail |
| Referral cluster growth | daily | count | none | rule from §15.4 graph + CUSUM |
| Seller pricing behaviour | daily | multivariate | per store | Isolation forest score (§2.8) |

## 2.4 Baseline for each metric

For metric m at tick t, the baseline forecast `ŷ_t` is:
```
log ŷ_t = level_t + profile[regime(t), weekday(t), hour(t)] + Σ_e β_e E_e(t) + planned_drop_uplift(t)
```
- `level_t`: ETS level on log(1+y) daily totals, α = 0.1 (UNTUNED), updated only with ticks that were not flagged anomalous (to avoid baseline poisoning).
- `profile`: hour-of-week share, keyed by `regime ∈ {normal, ramadan}`. It is a median over the last 8 same-regime weeks; with fewer than 4 weeks it falls back to the other regime (UNTUNED).
- Event terms: the same `calendar_events` table and phase indicators as §1.12.2, with coefficients estimated from past occurrences (or set to 0 with the reason `event_unobserved`).
- `planned_drop_uplift`: from the drops module schedule. During a scheduled drop window, the baseline is multiplied by the median uplift of the last 5 drops of similar size (UNTUNED), and the alert threshold is relaxed one level (§2.6).
- Partial current bucket: compare cumulative-so-far against the baseline's cumulative share of the bucket, never a partial bucket against a full one.

## 2.5 Detectors

### 2.5.1 Point test on counts (exact tail)
With `μ = ŷ_t`, and φ estimated from the last 28 days of residuals (method of moments, floored at 1, UNTUNED):
```
p_hi = P(Y ≥ y_t | NB(μ, φ))        p_lo = P(Y ≤ y_t | NB(μ, φ))        p = 2·min(p_hi, p_lo) capped at 1
```
Exact tails behave correctly at low volume: with `μ = 0.3`, observing 0 is never anomalous, and observing 1 rarely is.

### 2.5.2 Point test on ratios (beta-binomial)
For s successes out of n trials, with baseline rate `r̂` and overdispersion `ρ` (intra-class correlation from the last 28 days, UNTUNED floor 0.001):
```
a = r̂ (1−ρ)/ρ,  b = (1−r̂)(1−ρ)/ρ,   p_lo = P(S ≤ s | BetaBin(n, a, b)),  p_hi = P(S ≥ s | …)
```
No alert is raised when `n < n_min = 30` attempts in the tick (UNTUNED).

### 2.5.3 Money amounts
Test `log(1 + amount)` residuals with a robust z: `z = (r_t − median(r))/(1.4826 · MAD(r))` over the last 28 same-regime days. Prefer decomposition: GMV is tested as orders (2.5.1) and AOV (robust z on log AOV) separately, and a GMV alert carries which factor moved.

### 2.5.4 Persistent shift (two-sided CUSUM on standardised residuals)
Convert each tick's p-value to a signed normal score `r_t = Φ⁻¹(1 − p_hi)`, clipped to [−6, 6]. Then:
```
C⁺_t = max(0, C⁺_{t−1} + r_t − k)      C⁻_t = max(0, C⁻_{t−1} − r_t − k)      alarm when C⁺ > h or C⁻ > h
k = 0.5, h = 5   (UNTUNED; for N(0,1) these give an in-control ARL of about 465 ticks and an ARL of about 10 ticks for a 1σ shift, per Montgomery's CUSUM tables; ⚠ verify the table values)
```
The CUSUM resets to 0 after an alarm is raised and acknowledged.

EWMA (`Z_t = λ r_t + (1−λ) Z_{t−1}`, alarm at `|Z_t| > L sqrt(λ/(2−λ))`, λ = 0.2, L ≈ 2.96 for ARL₀ ≈ 500 per Lucas & Saccucci 1990, ⚠ verify) was compared. It is equivalent in power for moderate shifts. CUSUM was chosen because its statistic accumulates evidence, which is easy to explain as "evidence has been building for N hours".

## 2.6 False-alarm control

1. **Per-tick multiplicity (cross-section).** At each tick, all (metric × dimension-value) tests are corrected with Benjamini-Hochberg at q = 0.05 (UNTUNED; Benjamini & Hochberg 1995). Only discoveries continue to step 2.
2. **Over time: persistence plus budget, not online FDR.** Online FDR rules (alpha-investing, Foster & Stine 2008; LORD, Javanmard & Montanari 2018) were compared. They are rejected for v1 because their "wealth" state is hard to explain to on-call staff. Instead:
   - **Persistence:** a point alert needs 2 of the last 3 ticks to be significant (UNTUNED), unless `p < 1e−6` (an immediate spike).
   - **Cooldown:** 6 hours per (metric, dimension, direction) (UNTUNED).
   - **Alert budget:** at most 3 business-KPI pages per day across the platform and 10 digest items per day (UNTUNED). Beyond the budget, alerts drop into the daily digest ranked by severity. Invariants (T-1) are outside the budget.
   - **Calibrating thresholds to the budget:** on the 90-day synthetic and shadow replay (§4.1), set the point-test p threshold per metric so that the expected number of false alarms is ≤ 1 per metric per 30 days. With 96 ticks/day and the persistence rule, this needs a per-tick p of about 1e−4 (UNTUNED starting value).
3. **Hierarchical deduplication.** If both a parent (platform GMV) and children (category GMV) fire, emit one alert at the **highest node** whose explanation (§2.7) attributes ≥ 67% of the deviation to fewer than 3 children (UNTUNED, following Adtributor's succinctness idea, Bhagwan et al. 2014). The children are listed inside that alert. Dedup key: `(metric_root, direction, floor(t / cooldown))`.
4. **Suppression rules.**
   - Checkout success is suppressed while a T-2 burn alert for checkout is open.
   - Any metric during a declared incident is linked to the incident instead of paging.
   - Metrics during the 48h release freeze before mega events keep event baselines (§T8).
5. **Holiday awareness**: through the baseline (§2.4). In addition, during the first observed occurrence of an event the threshold relaxes one level (p × 10) and alerts are digest-only, because the baseline has no past occurrence.

## 2.7 Explainability: "what changed"

**Additive metrics** (orders, GMV, refunds), `Y = Σ_d y_d` over values d of one dimension D:
```
Δ = Y − Ŷ = Σ_d (y_d − ŷ_d)            contribution c_d = (y_d − ŷ_d) / Δ
surprise_d = JS-divergence term between expected share p_d = ŷ_d/Ŷ and actual share q_d = y_d/Y:
    S_d = ½ [ p_d log(2p_d/(p_d+q_d)) + q_d log(2q_d/(p_d+q_d)) ]
```
Per dimension D, sort the values by `S_d` and keep values (with `c_d ≥ 0.10` each, UNTUNED) until `Σ c_d ≥ 0.67`. Score the dimension by `Σ S_d` over the kept set, and report the top 2 dimensions with the fewest values (Bhagwan et al. 2014). Example output: "Orders −38% vs expected; 81% of the gap is payment_method = card on PSP = primary".

**Ratio metrics** (conversion, checkout success, refund rate), `r = Σ w_d r_d` with weights `w_d` = share of trials. Use the shift-share decomposition:
```
Δr = Σ_d (w'_d − w_d) r_d    [mix effect: traffic moved to segments with a different rate]
   + Σ_d w'_d (r'_d − r_d)   [rate effect: the segment itself got worse]
```
This tells ops whether the conversion drop is a traffic-mix change (for example a campaign bringing low-intent users) or a real breakage.

**Privacy of explanations.**
- Shopper-derived dimension cuts (governorate, source) use ADR-0045's k ≥ 50 release (`releaseShopperTable`); smaller cells fold into "other".
- Explanations naming a store are admin-only. A seller sees only anomalies on its own store's metrics (RLS).
- No explanation names a shopper, device or IP. Fraud alerts carry bucket ids, with drill-down through the existing audited admin fraud tools (PII view logged with a reason code, §23).

## 2.8 Price anomalies (§9.4)

The deterministic VRP rules (pre-drop inflation, claim above VRP, cross-channel parity) **stay the only inputs to the enforcement ladder**. The ML layer adds signals:
- **Per-category robust z** of the claimed discount depth versus the category's distribution of verified discount depth: `z = (log(1−d_claim) − median)/(1.4826 · MAD)` per (category, condition) over 90 days. An alert (admin digest) fires at `|z| > 4` (UNTUNED).
- **Seller pricing-behaviour isolation forest** (daily, per store). Features (all P1): price changes per SKU per 30 days, ping-pong count (raise followed by a cut within 30 days), share of SKUs with a raise in the 30 days before a drop, median raise before a cut, share of new listings matching a delisted SKU by pHash (when price-matching is composed), share of SKUs with `launch_price` badges among listings older than 30 days (relisting). 200 trees, subsample 256, contamination not set (score only); the defaults follow Liu, Ting & Zhou 2008 (UNTUNED).
- **Output:** `price_behaviour_score ∈ [0, 1]` (isolation score). It feeds the Price Trust Score **only as an advisory input visible to Trust & Safety**, never as an automatic penalty. The ladder in `decideEnforcement` is unchanged. Rationale: an unexplained ML score must not trigger automatic seller suspension (§9.5 already requires a human for suspensions, and ⚠ VR on automatic suspension legality).

## 2.9 Fraud signals

The fraud module's decisions (§20.7) stay rule- and GBDT-based. This module only monitors aggregate rates for spikes (card testing, SMS pumping, gift-card brute force) and pages Trust & Safety. Card testing specifically: CUSUM on the count of distinct BINs with auth failures per 5-minute bucket, on top of the NB tail. It is fast to detect gradual ramps.

## 2.10 Severity scoring

```
impact_bps   = |Y − Ŷ| over the anomaly window / Ŷ_day(metric)  × 10_000       (money metrics: piastres, bigint math)
surprise     = −log10(p_adj)   capped at 12
persistence  = hours since first significant tick
severity = sev1 if T-1 invariant, or (money metric and impact_bps ≥ 2000 and surprise ≥ 6)
           sev2 if impact_bps ≥ 1000 and surprise ≥ 4, or a fraud signal with surprise ≥ 6
           sev3 if surprise ≥ 3 (digest)
           sev4 otherwise (log only)          all thresholds UNTUNED
```
Routing: sev1 pages on-call and Finance (money). sev2 pages within business hours and goes to the digest out of hours, except fraud (always pages). sev3 and sev4 go to the digest only.

## 2.11 Data, API and events (anomaly)

- `anomaly_metric_definitions(metric_code, grain, type, dimensions[], owner_role, slo_linked bool, kill_scope)`: config, versioned, audited.
- `anomaly_baselines(metric_code, dimension_key, regime, profile jsonb, level, dispersion, updated_at)`: no personal data.
- `anomaly_alerts(id, metric_code, dimension_key, direction, window_start, window_end, observed, expected, p_adj, severity, status 'open'|'acked'|'resolved'|'suppressed', dedup_key UNIQUE, linked_incident_id, created_at)`: amounts in piastres BIGINT.
- `anomaly_explanations(alert_id, dimension, value_label, contribution_bps, surprise_milli)`: k-gated labels only.
- API: `GET /v1/admin/anomalies?status=&severity=` (scope `ops.read`), `POST /v1/admin/anomalies/{id}/ack` (idempotent), `GET /v1/seller/anomalies` (own store; GMV, orders, refunds and conversion only; never fraud or price-behaviour scores).
- Outbox events: `anomaly.detected`, `anomaly.resolved`. Analytics events: `anomaly_alert_viewed`, `anomaly_alert_acked`.

---

# 3. Markdown and price-elasticity advice

## 3.1 What the advice is and is not

- **Is**: for an aging SKU or lot, a suggested price path (one price now, or a short ladder over the next weeks) chosen to maximise the seller's expected net proceeds before a clearance deadline. It comes with an 80% range of units sold and proceeds, the assumptions, and a VRP preview.
- **Is not**:
  - an automatic price change;
  - a "% off" claim;
  - a price above the current price;
  - a personalised price (one price for all shoppers; HAUL never prices by shopper);
  - a use of budget, measurements or any shopper-level data.

## 3.2 Notation

For SKU (or lot) i at weekly period t:
- price `p_t` (bigint piastres), on hand `x_t`, deadline T (weeks).
- Seller-provided unit cost `c_i` (optional, P1 seller data), salvage value per unit `v_i` (optional; default 0), holding cost per unit-week `h_i` (FBH storage fee if FBH, else 0).
- Commission rate `κ_i` (snapshot) and the payment-fee estimate `f_pay`.
- Seller's net per unit at price p: `n(p) = p·(1 − κ_i) − f_pay(p) − c_i`. Commission is VAT-exclusive per §T4; the VAT treatment follows the tax module.

## 3.3 Elasticity estimation

### 3.3.1 Model
Price affects demand mainly through **conversion**; ranking and placement affect **traffic**. Because §20.5 ranking uses verified discount depth, a price cut can raise traffic by itself, which is a feedback loop. To separate the two, model purchases conditional on product views:
```
purchases_{i,t} ~ NegBin( views_{i,t} · π_{i,t}, φ )        offset = log(views)
log π_{i,t} = α_i + ε_{c(i)} · log(p_{i,t} / p^{ref}_i)
            + δ_badge · badge_{i,t} + γ' w_{i,t} + g(age_{i,t}) + event terms (§1.12)
ε_c = −exp(η_c),  η_c ~ N(η̄_group, τ_η²),  η̄_group ~ N(log 1.5, 0.6²)
```
- `α_i` is a SKU fixed effect, so the price coefficient is identified from **within-SKU price changes** only.
- `ε_c < 0` is enforced by the log-normal parameterisation (law of demand). The prior median of −1.5 and the 80% prior range of about [−3.3, −0.7] are UNTUNED inference. They are informed by meta-analyses of brand-level price elasticities: mean about −1.76 in Tellis (1988), and about −2.62 in Bijmolt, van Heerde & Pieters (2005). Neither is about Egyptian off-price apparel; ⚠ no local figure was found.
- `δ_badge` separates the display effect of a VRP badge from the price effect. **Advice uses `badge = none`** unless the VRP preview (§3.6) says the new price would carry a badge. Even then, the badge uplift is shown as a separate, labelled scenario and is never folded into the headline.
- `w`: controls for traffic source mix (feed, search, stylist, ads), Plus early access, drop membership.
- Pooling hierarchy: category group → category → (optionally) store × category. A store with fewer than 10 within-SKU price changes in the category (UNTUNED) uses the category posterior.
- Total effect for the DP: demand = traffic × conversion. Traffic is forecast by §1 at the current price. The traffic response to price (through ranking) is **not** credited to the advice by default. Option O-5 would add it with an explicit "ranking uplift" scenario.

### 3.3.2 Price-variation sources and identification problems
| Source of variation | Problem | Treatment |
|---|---|---|
| Seller-initiated markdowns | Endogenous: sellers cut when sales slow, which biases ε toward 0 (the cut looks ineffective), and sellers may cut before known peaks (bias away from 0) | SKU fixed effects + age curve + event terms; exclude changes within 3 days of a drop or featured slot; sensitivity analysis reported in the model card |
| Drops and flash hours | Price and traffic both change; massive placement effect | Drop days excluded from elasticity estimation (they inform the drop forecast instead) |
| Vouchers | Shopper-specific effective price; selection into voucher use | Use the list price only; voucher eligibility as a control; never the per-shopper paid price (that would be shopper-level data) |
| Our own advice | Self-confirming loop: if the model only sees prices it recommended, it can never learn it was wrong | Log `advice_id` on every price change (new nullable column on `price_events`, §5.3). Keep a **randomised advice holdout**: 10% of eligible SKUs per store (UNTUNED) are randomly assigned "no advice shown this cycle". The randomisation is of *advice visibility*, never of *prices shown to shoppers* (see O-6). Estimate ε with and without advice-driven changes, and alert when they diverge |
| Ranking feedback | Cut → badge → ranking boost → traffic | Conversion-per-view model (above); `δ_badge` separate; ranking position as a control in `w` |

**Causal caveat** (shown in the model card and in seller copy): elasticities come from observational price changes. Even with fixed effects they can be biased by unobserved timing reasons. The interval shown to the seller reflects statistical uncertainty, not this bias. Double/debiased ML (Chernozhukov et al. 2018) was considered for v2: nuisance models for price and demand given controls, with cross-fitting. It is deferred until there are enough within-SKU changes. Instrumental variables (Hausman-style: the same brand's price in other stores; Berry 1994) need cross-seller data and are blocked by VR-P3-14.

### 3.3.3 Fitting
- Weekly refit. MAP + Laplace (as in §1.7). Monthly full-posterior refit of `τ_η` with NUTS.
- Output per category (and store × category when pooled): posterior median of ε, 80% credible interval, effective number of price changes, and the share of changes that came from advice.
- **Informativeness rule**: elasticity is "informative" when the posterior 80% interval width < 1.5 (UNTUNED) **and** it is based on ≥ 30 within-SKU price changes across ≥ 10 SKUs (UNTUNED). Otherwise the DP is not used (§3.5).

## 3.4 Sell-through model under a price path

For a candidate price `p` in week t, expected weekly *demand*:
```
μ_t(p) = μ̂_t · (p / p_now)^{ε}        μ̂_t from the §1 demand forecast at the current price (sales-capped later), ε from §3.3
D_t(p) ~ NegBin(μ_t(p), φ̂)            sales_t = min(D_t, x_t)
```
For lots in R0/R1, `μ̂_t` comes from the launch profile with early-sales update (§1.9.3), so aging items get a declining μ through `F'(age)`.

## 3.5 Clearance optimisation

### 3.5.1 Options compared
| Option | Description | Strength | Weakness | Use when |
|---|---|---|---|---|
| (R1) Fixed-step heuristic (`heuristic_v1`, exists) | 10/20/30% step by aging severity, hold at sell-through ≥ 70% | No model needed; predictable | Ignores demand, stock and deadline; no outcome estimate | Forecast not served, or elasticity not informative and sell-through projection unavailable |
| (R2) Sell-through target rule | If the projected sell-through by the deadline (from §1 at the current price) is < target (default 80%, UNTUNED), step down one ladder rung | Uses the forecast; explainable | Ignores elasticity, so it can over- or under-cut | Forecast served, elasticity **not** informative |
| (DP) Finite-horizon dynamic programming over a price ladder | Maximise expected net proceeds with a stock constraint and a markdown-only ladder (Smith & Achabal 1998; Gallego & van Ryzin 1994 for the stochastic model; Caro & Gallien 2012 for a fashion clearance deployment) | Optimal under the model; gives outcome distributions | Only as good as ε and μ̂; costlier | Forecast served **and** elasticity informative |

**Choice in 3 lines.** A tiered policy: DP only when both the demand forecast passed its gate and the elasticity is informative, R2 when only the forecast is trustworthy, and the existing heuristic otherwise. The DP is small (stock × ladder × weeks), exact and explainable as "price path + expected outcome range". Gallego & van Ryzin show that a well-chosen fixed price is asymptotically near-optimal for large inventories, so a short ladder of a few markdowns should capture most of the value (inference from their result, to be confirmed in the §4.1 regret test).

### 3.5.2 Price ladder
`P = {p_0 = p_now > p_1 > … > p_K}`, K ≤ 6 (UNTUNED):
- Rungs at 10% steps of `p_now`. Each is computed in bigint piastres by `toAdvicePrice` (§3.7), so all rungs are whole pounds and distinct.
- Truncated below at the **floor** `p_floor = max(seller_floor, cost_floor, platform_floor)`:
  - `seller_floor`: the existing optional `floorPriceMinor`;
  - `cost_floor`: the price at which `n(p) = margin_min · p`, with `margin_min = 0` by default (seller-editable), only when the seller provided `c_i`;
  - `platform_floor`: 30% of the 30-day VRP-window low price (UNTUNED). This guards against fire-sale advice that could look like dumping. ⚠ VERIFY whether Egyptian competition law (Law 3/2005) has below-cost rules relevant to marketplaces.
- Markdown-only: prices can only move down the ladder. The DP state carries the current rung, so a path can never raise a price. This also guarantees the advice never produces the "raise then cut" pattern that the Price Integrity Engine penalises.

### 3.5.3 Bellman recursion
Periods t = 0..T−1 (weeks, T ≤ 12, UNTUNED), state `(x, k)` = units on hand, current rung:
```
V_T(x, k) = v · x                                              salvage at the deadline (v = 0 unless the seller provides it)
V_t(x, k) = max_{j ∈ {k, …, K}} Σ_{d=0}^{∞} P(D_t(p_j) = d) · [ n(p_j) · min(d, x) − h · (x − min(d, x)) + V_{t+1}(x − min(d, x), j) ]
```
- The sum over d is truncated at `d = x` (all mass ≥ x is lumped: `P(D ≥ x)` contributes `n(p_j)·x + V_{t+1}(0, j)`).
- Complexity: `O(T · X · K² · X)` with X = on-hand units. For X ≤ 2,000, K ≤ 6, T ≤ 12 this is ≈ 1.7·10⁹ basic operations at worst. Large lots are therefore solved on a grid: x in steps of `⌈X/400⌉`, with linear interpolation of V (UNTUNED). Exact for X ≤ 400.
- **Posterior robustness**: instead of plugging in the point ε, average the transition over S = 200 posterior draws of (ε, μ̂ scale) (UNTUNED), i.e. a Bayes-optimal policy under the posterior predictive. Report the policy's outcome distribution by simulating 2,000 paths under fresh posterior draws.
- Output: optimal rung `j*(0, x_0, k_0)` for **this week** plus the planned path (the most likely rung sequence). Only this week's price is actionable; the plan is re-solved weekly with new data.

### 3.5.4 Compare to simple rules, every time
For every DP recommendation, also evaluate R1 and R2 and "hold" under the same simulation. Show the DP only if its expected net proceeds exceed the best of the others by ≥ 2% **and** its P10 proceeds are not below hold's P10 (UNTUNED). Otherwise show the best simple rule with its own simulated outcome. This keeps a model error from producing advice that is worse than doing nothing.

## 3.6 What the seller sees (and the VRP preview)

For each SKU with advice:
- Current price, suggested price this week (piastres → formatted EGP), basis (`dp_v1`, `sell_through_rule_v1`, or `heuristic_v1`).
- **Expected outcome (80% range)**, shown only for `dp_v1` and `sell_through_rule_v1`, and only when the sell-through forecast has measured coverage in [0.70, 0.90] on its segment:
  - "Expected to sell 34–61 of 80 units in the next 4 weeks"
  - "Estimated proceeds after commission EGP 9,200–15,800"
  - "Chance to clear ≥ 80% by {deadline}: 35–55%". This is the §19.1 "clear 80% in 7 days" line, with the probability's own uncertainty taken from the posterior spread across draws. It is never shown as a bare point.
- Comparison line: "If you hold the price: 18–40 units".
- Assumptions: "Based on N price changes in {category}; elasticity estimate −1.9 (80% range −2.8 to −1.1); excludes ranking and badge effects".
- **VRP preview**: `computeVrp` evaluated on the SKU's real history plus a hypothetical new price event at `now`. It is displayed as "If you apply this price, shoppers will see: {plain price | Lowest price in 30 days | Verified discount X%}", with the label "preview, recalculated when the price changes". The advice object itself keeps `showsPercentOff: false`. The real display is always recomputed by the VRP engine from `price_events` at read time.
- Mandatory notice: the existing `MARKDOWN_NOTICE` (AR/EN) verbatim.
- Actions: **Apply this price** (calls the price-change use case with an Idempotency-Key, `source = 'seller'`, `advice_id` set; audited), **Dismiss** (reason enum), **Change floor**.

## 3.7 Guard-rails (all enforced in the pure domain, mutation-tested)

1. `showsPercentOff: false` literal on every advice type (exists; keep).
2. `suggestedPriceMinor < currentPriceMinor` or the action is `hold`. Never a raise.
3. `suggestedPriceMinor ≥ p_floor`, bigint comparisons only.
4. Money conversion `toAdvicePrice(p_model: number, p_now: bigint)`:
   - compute the ratio `r = p_model / p_now` as a rational with 4 decimal places → `bps = round_half_even(r · 10_000)`;
   - `price = divideRoundHalfEven(p_now · bps, 10_000n)`;
   - floor to a whole pound;
   - clamp to the floor.
   Banker's rounding happens once, in step 2. No float reaches a stored money column.
5. No advice while the SKU is in a drop in state `SCHEDULED` or later (§16 locks prices), while the store is suspended, or while the SKU has an open `cross_channel_cheaper` finding (fixing parity comes first).
6. At most one advice per SKU per 7 days (UNTUNED); the advice expires after 7 days.
7. No advice for SKUs listed fewer than 14 days (UNTUNED). Too early: the item is still in its launch curve.
8. Advice never uses budget, sizing or shopper-level data (CI import lint, as in §12).
9. Seller approval is required. There is no auto-apply mode, and none may be added without a new ADR and owner sign-off.
10. Kill switches: `kill.markdown_elasticity` → fall back to R2/heuristic; `kill.markdown_advice` → no advice at all (aging list still shown).

## 3.8 Data, API, events (markdown)

- `elasticity_estimates(id, scope 'category'|'store_category', scope_key, model_version, eps_p10_milli, eps_p50_milli, eps_p90_milli, n_changes, n_skus, advice_share_bps, informative bool, fitted_at)`: integers (elasticity × 1000).
- `markdown_advice(id, store_id, sku_id, as_of_date, basis, current_price_minor BIGINT, suggested_price_minor BIGINT NULL, floor_price_minor BIGINT, ladder jsonb, units_p10, units_p50, units_p90, horizon_weeks, proceeds_p10_minor BIGINT, proceeds_p50_minor BIGINT, proceeds_p90_minor BIGINT, clear_prob_p10_bps, clear_prob_p90_bps, hold_units_p10, hold_units_p90, vrp_preview_badge, vrp_preview_pct NULL, holdout bool, expires_at, model_version)`.
  - CHECK: `suggested_price_minor < current_price_minor` when not null; `suggested_price_minor >= floor_price_minor`; ordered quantiles; outcome columns null unless basis ∈ (`dp_v1`, `sell_through_rule_v1`).
  - There is **no** column for a display percentage other than the preview (which is labelled as a preview).
- `markdown_advice_actions(id, advice_id, actor_id P2, action 'applied'|'dismissed'|'floor_changed', reason, price_event_id NULL, idempotency_key UNIQUE, ts)`.
- `price_events.advice_id uuid NULL` (expand-only migration). This links a change to the advice that prompted it, for the feedback-loop analysis in §3.3.2.
- API:
  - `GET /v1/seller/markdown-advice?cursor=` (own store, RLS, 30/min)
  - `POST /v1/seller/markdown-advice/{id}/apply` (Idempotency-Key required; re-validates guard-rails and the floor at apply time; calls the price-change use case; 409 if the advice expired or the price moved)
  - `POST /v1/seller/markdown-advice/{id}/dismiss`
  - `GET /v1/admin/markdown/elasticities`
- Events: `markdown_advice.generated` (batch), `markdown_advice.applied`, `markdown_advice.dismissed`; analytics `markdown_advice_viewed(basis)`.

---

# 4. Offline evaluation plan

## 4.1 Synthetic data generator (spec)

Location (to build): `tooling/ml/synth/` (Python, seeded, pure, no network). The output is a parquet bundle and an equivalent JSONL for the TS tests. Fully deterministic given `(seed, scenario)`.

**Entities and parameters (each drawn per scenario, defaults UNTUNED):**
- Stores: 1–200. Store size ~ LogNormal. Store type ∈ {lot_seller, replenishing_fbh}.
- Categories: 12 (tops, dresses, abayas, jeans, shoes, bags, kidswear, etc.), each with:
  - weekly profile (Fri/Sat weekend effect);
  - size run and Dirichlet size curve (κ ∈ [5, 50]);
  - true elasticity `ε_c ~ −LogNormal(log 1.8, 0.4)`;
  - life-cycle Weibull (λ, k);
  - dispersion φ ∈ [0.5, 10].
- SKUs as lots: starting stock S_0 ~ NegBin; listing day uniform; colour family; price band; condition; demand-to-stock ratio m ~ LogNormal.
- Calendar: 2024-01-01 to 2028-12-31, Cairo days.
  - Ramadan, Eid al-Fitr and Eid al-Adha from the tabular Islamic calendar, with a random ±1-day "announcement" offset per year.
  - True phase multipliers (for example Ramadan r_21_end ×1.6, Eid days ×0.6).
  - White Friday (a configurable week in November), back to school, payday window, 21 March.
- Price paths:
  - (i) seller markdown driven by slow sales (endogenous);
  - (ii) exogenous random markdowns (to test identification);
  - (iii) drops with traffic uplift;
  - (iv) raise-then-cut patterns (to check that the price-integrity interplay never yields a claim);
  - (v) advice-applied changes.
- Traffic: views ~ NB with ranking feedback `views ∝ (1 + ρ_rank · verified_depth)`. This tests whether the conversion-per-view model removes the loop.
- Conversion: logit with true ε and badge effect δ.
- Stock-outs: sales = min(demand, stock), with intraday arrival times uniform per day, so availability `a` is observed exactly.
- Returns: return probability per category, return lag ~ shifted geometric. Net units attributed to the order day.
- Fraud: injected fake orders (excluded by the feeder) to test that they never enter series.
- **Anomaly injections, labelled**:
  - spikes (×3 for 1 hour);
  - level shifts (−30% persisting);
  - ramps (+5%/day for 7 days);
  - PSP outage (checkout success → 40% on one method);
  - SMS-pumping burst on a foreign prefix;
  - gift-card brute-force burst;
  - mix shift (traffic moves to a low-conversion source with no rate change).
  The ground truth `(start, end, metric, dimension, type)` is stored.

**Scenario matrix:** {cold-start heavy, intermittent heavy, smooth replenishing, first Ramadan after launch, second Ramadan, no price variation, endogenous-only price variation, heavy stock-outs (60% of lots sell out), drift (traffic doubles mid-period)} × 20 seeds.

**Truth-recovery tests (pass criteria UNTUNED):**
- Forecast: the served model's 80% calibrated coverage is in [0.75, 0.85] on the smooth and intermittent scenarios after 26 origins. On "first Ramadan", coverage ≥ 0.70 with the `event_unobserved` widening.
- Unconstraining: on the heavy stock-out scenario, the bias of the NB demand forecast with the offset is ≤ 5% vs true demand, while the v1 drop-days approach is reported for comparison (expected larger downward bias).
- Elasticity: on scenario (ii), the 80% credible interval covers true ε in 70–90% of categories. On endogenous-only (i), the model card reports the measured bias.
- DP: expected regret vs an oracle DP that knows true ε and μ ≤ 10% of oracle proceeds on the scenario median. The DP also beats R1 and R2 on average proceeds in ≥ 60% of seeds, or the DP tier stays off.
- Anomaly:
  - recall ≥ 0.9 for spikes and outages within 2 ticks;
  - ≥ 0.8 for level shifts within 12 ticks (CUSUM);
  - false alarms ≤ 1 per metric per 30 days on anomaly-free replays;
  - explanation top-1 dimension correct for ≥ 80% of injected dimension-specific anomalies;
  - the mix-shift injection is classified as mix (not rate).

## 4.2 Property tests (fast-check in TS domain; Hypothesis in Python)

| Property | Statement |
|---|---|
| Non-negativity and integrality | Every served quantile is an integer ≥ 0; every money output is bigint ≥ 0 |
| Quantile ordering | `p05 ≤ p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90 ≤ p95` |
| Interval monotonic in confidence | `C_{50} ⊆ C_{80} ⊆ C_{90}` for every series and horizon |
| Horizon monotonicity | For non-negative demand, `p50_7 ≤ p50_14 ≤ p50_28` and the same for p90 |
| Additivity under reconciliation | Reconciled integer child medians sum exactly to the parent median; ordering preserved per child (exists for top-down; extend to MinT) |
| Scale invariance (metrics) | Multiplying every value of a series by an integer c > 0 leaves MASE, RMSSE, SPL, WAPE, bias and coverage unchanged (exact, up to rounding at bps), and multiplies ETS and SBA means by c. Not asserted for count intervals, because the Poisson variance floor is deliberately not scale-invariant (documented) |
| Time-shift invariance | Shifting all days by 7·n, with calendar events shifted identically, gives identical outputs |
| Permutation invariance and determinism | Input row order never changes outputs; equal inputs give byte-equal outputs |
| Censoring monotonicity | Marking an extra sold-out day as censored never lowers the unconstrained demand estimate for the next horizon |
| Refusal | Below the R0 thresholds, no number is ever produced (exists) |
| Gate | A candidate identical to the baseline is never served as "model beat baseline"; the baseline always remains servable when it has origins |
| Conformal | With n calibration scores, the empirical coverage on the calibration set itself is ≥ ⌈(n+1)(1−α)⌉/n − 1/n |
| Markdown | `showsPercentOff === false` for all inputs; suggested price < current or hold; ≥ floor; whole pounds; the ladder is strictly decreasing; more stock (x↑) never yields a higher optimal price at the same state (monotone policy, a property of this DP with log-concave demand, tested empirically) |
| VRP interplay | For any history and any advice applied, the resulting VRP claim (computed by `computeVrp`) never exceeds the true 30-day prior minimum (reuse the price-integrity property harness) |
| Anomaly | Replaying identical ticks twice creates no new alert (dedup idempotent); a series equal to its seasonal baseline never alerts; adding a constant multiplicative factor to both baseline history and current values (scale) does not change NB-based alerts beyond tolerance once φ is re-estimated |
| Elasticity sign | The posterior of ε is strictly negative |

## 4.3 Mutation targets (StrykerJS on TS, mutmut on Python; break ≥ 80, matching other critical modules)

- TS: `forecasting/forecast.ts` (gate), `interval.ts`, new `conformal.ts`, `reconcile.ts`, `series.ts` (censoring and availability), `regime.ts` (ADI/CV² thresholds), `launch.ts` (Gamma-Poisson update), `seller-analytics/markdown.ts` and new `advice-guard.ts` (floors, clamps, rounding, markdown-only), anomaly `tails.ts`, `cusum.ts`, `dedup.ts`, `severity.ts`, `explain.ts`.
- Python: the DP Bellman step, ladder construction, NB likelihood with offset, EM E-step, conformal quantile index, ACI update.

## 4.4 Pact and boundary contracts

The ml-service writes to staging tables. The TS promoter validates every row with Zod (ordered quantiles, integer, non-negative, enums, no extra keys) before it reaches serving tables. This is the unsafe-consumption control (API10), applied to our own service. A Pact-style contract test pins the staging row schema between the Python writer and the TS promoter.

## 4.5 Drift and live monitoring

- **Performance drift (primary):**
  - weekly realised coverage per segment, with a binomial 95% interval;
  - WSPL vs backtest WSPL;
  - bias.
  - Rule: coverage outside [0.70, 0.90] with its binomial interval excluding 0.80 for 2 consecutive weeks (UNTUNED), or WSPL worse than baseline for 2 weeks, means the segment automatically falls back to the baseline model (`reason: auto_fallback_drift`), and an admin ticket is opened.
- **Input drift:**
  - Population Stability Index on price index, age at sale, category mix, availability distribution, event-phase mix. PSI > 0.2 is a ticket; 0.1–0.2 is a watch. These are industry conventions, ⚠ not from a peer-reviewed source.
  - Kolmogorov-Smirnov on continuous features.
  - Concept-drift background per Gama et al. 2014; shift-detection approach per Rabanser, Günnemann & Lipton 2019.
- **Elasticity drift**: the posterior median moves by more than its own 80% interval width between refits, or the advice-driven share of price changes exceeds 70% (feedback-loop risk). Either one makes the DP tier off for the category until reviewed.
- **Calendar drift**: any event used in a forecast still `provisional` 2 days before its start opens a ticket to the admin who owns `calendar_events`.
- **Anomaly detector health**: alert counts vs budget, ack time, share of alerts marked "not useful" (target ≤ 30%, UNTUNED), detection delay on synthetic canaries. One synthetic canary per week is injected into a shadow metric copy, never into real metrics.

## 4.6 Model cards

One per model version in `docs/ml/model-cards/<model>-<version>.md`, following Mitchell et al. (2019), with:
- intended use and out-of-scope uses (for example "not for credit, not for shopper-level decisions");
- training data (tables, date ranges, regimes; "no personal data" statement with the ingest schema reference);
- features and forbidden features;
- metrics by segment (MASE, SPL, coverage, bias) with baseline comparison;
- calibration plots (reliability, randomised PIT);
- known failure modes (first Ramadan, size substitution, endogenous prices);
- fairness across sellers (small vs large stores: coverage and error split by store-size quintile);
- parameters with UNTUNED markers;
- approver and date;
- kill switch and fallback.

---

# 5. Architecture

## 5.1 What runs where

| Component | Runtime | Why |
|---|---|---|
| Series feeder (orders, returns, availability, flags), fraud-flag exclusion | API workers (TS), outbox consumers → Postgres | Same transaction discipline as other read models (ADR-0045); P1 only |
| Baselines (seasonal naive, event-aligned naive, ETS, SBA, TSB), regime classification, conformal application, reconciliation (top-down), Gamma-Poisson launch update, gate, serving | TS domain (`packages/domain/src/forecasting`), invoked by the existing nightly batch | Always available and dependency-free; it is the fallback when the ml-service is killed or down |
| Hierarchical NB, LightGBM quantile, MinT-nn, unconstraining EM, elasticity, clearance DP, isolation forest, BOCPD, STL+ESD backfill | New Python batch service `apps/ml-services/forecasting` (FastAPI for health and admin triggers; batch entrypoint; `mypy --strict`, `ruff`, pydantic v2; pinned deps with a `MODEL_LICENSES.md` like `bg-removal`) | Needs numerical libraries that do not exist in TS. Runs inside the ADR-0002 region with **no egress** except to Postgres (network policy deny-all egress) |
| Anomaly detection (T-3) tick evaluation: tails, CUSUM, BH, dedup, severity, explanations | TS worker every 5/15 min over `platform_metrics_hourly` and `seller_analytics_hourly` rollups (ADR-0045) | Low latency, simple maths, close to the alert routing; baselines refreshed nightly by the ml-service or TS |
| Invariants (T-1) | Existing ledger-integrity, reconciliation and inventory jobs | Unchanged; this spec only routes them |
| Burn-rate (T-2) | Observability stack (ADR-0017) | Unchanged; dedup link only |

The ml-service reads a **read replica** under a dedicated role `ml_reader`. Its `SELECT` grants cover only the series, rollups, price-event, calendar and catalog-attribute tables; it has no access to `users`, `addresses`, `sizing`, `budget` or `consent`. It writes only to `ml_*_staging` tables through role `ml_writer` (INSERT only). The TS promoter (system role) validates and copies rows to serving tables. A compromised or buggy model therefore cannot write a malformed or out-of-policy number to a seller-visible table.

## 5.2 Batch schedule (Africa/Cairo; UNTUNED; low-carbon windows per §T10)

| Time | Job | Idempotency key |
|---|---|---|
| continuous | Series feeder (outbox consumers), availability accumulation | inbox `message_id` |
| 01:30 daily | Close D−1 series; restate the last 14 days for late returns | `(store, day)` upsert |
| 02:00 daily | TS baseline forecasts (existing batch, extended to v2 baselines and regimes) | `(store, as_of)` in `forecast_runs` |
| 02:30 daily | ml-service: NB forecasts, unconstraining, MinT; writes staging | `(store, as_of, model_version)` |
| 03:30 daily | Promoter: validate staging, run gate and conformal, reconcile, write `demand_forecasts` | `(store, scope, key, horizon, as_of)` unique |
| 04:00 daily | Calibration and coverage update, ACI step, drift report | `(segment, as_of)` |
| 04:30 daily | Anomaly baselines refresh; isolation-forest pricing scores | `(metric, dim, as_of)` |
| */15 min | Anomaly tick (5 min for fraud signals) | `(metric, dim, tick)` |
| Saturday 05:00 weekly | Elasticity refit; markdown DP and advice for the coming Sunday-to-Saturday working week (Egypt weekend Fri–Sat) | `(store, week)` |
| 1st of month | Variance components (NumPyro), LightGBM retrain (R3), model-card regeneration | `model_version` |

A failure leaves the previous outputs in place and marked stale with a timestamp (existing P3-05 behaviour), and the run is recorded `failed` in `forecast_runs`.

## 5.3 Storage (new and changed tables; expand-only migrations, numbers assigned at build time per `packages/db/migrations/RESERVED`)

| Table | Change | PII |
|---|---|---|
| `forecast_demand_series` | + `availability_bps smallint NOT NULL DEFAULT 10000 CHECK 0..10000`, + `sibling_size_out boolean`, + `price_minor bigint NULL`, + `badge text NULL`, + `promo_flags text[]` | none |
| `demand_forecasts` | `model` CHECK extended (`tsb`, `nb_hier`, `lgbm_q`, `analogue_launch`), + `scope 'sku_size'`, + `regime`, + `interval_method ('normal_nominal','conformal','conformal_pooled','widened')`, + `p05,p25,p75,p95`, + `mase_milli, spl_milli, baseline_spl_milli`, + `demand_or_sales ('demand','sales')`. The existing numbers CHECK is kept and extended to the new quantile ordering | none |
| `demand_forecasts_shadow` | New; same shape; never read by serving APIs | none |
| `forecast_calibration` | New: `(segment_key, horizon, as_of) → n_cal, q_hat_milli, alpha_t_bps, coverage_13w_bps` | none |
| `forecast_model_registry` | New: `model_version, kind, params jsonb, trained_on, metrics jsonb, status ('shadow','served','retired'), approved_by, approved_at` | approver id P2 (staff) |
| `launch_profiles` | New: `(store, category, price_band, condition) → lambda_milli, k_milli, mu_m_milli, sigma_m_milli, n_lots` | none |
| `calendar_events` | New (§1.12.1), audited | confirmer id P2 (staff) |
| `ml_*_staging` | New, one per output kind; truncated after promotion | none |
| Anomaly tables | §2.11 | none (fraud buckets are opaque ids) |
| Markdown tables | §3.8; `price_events.advice_id` | actor id P2 (seller staff), as for existing price events |

All new tables follow 0064's RLS pattern: sellers read own store rows, only `system` writes, and admin reads are by scope. `data_inventory.yaml` gets a row per new column (CI fails otherwise).

## 5.4 Kill switches and flags (all default Blocked)

| Key | Blocked behaviour |
|---|---|
| `kill.demand_forecasting` (exists) | Whole forecasting batch does nothing; reads answer 503 `demand_forecasting_disabled`; stored rows kept |
| `kill.forecast_ml` (new) | ml-service outputs ignored; TS baselines served (`baseline-v2`) |
| `kill.forecast_cold_start` (new) | No launch bands; R0 always `insufficient_history` |
| `forecast.cross_seller_priors` (new flag) | Platform-level priors off; per-store priors only. Allowed only after VR-P3-14 |
| `kill.anomaly_detection` (new) | T-3 detectors off; T-1 invariants and T-2 burn alerts unaffected |
| `kill.price_anomaly_ml` (new) | Isolation-forest pricing score not computed; VRP ladder unaffected |
| `kill.markdown_elasticity` (new) | DP off; R2 or heuristic only; no outcome ranges |
| `kill.markdown_advice` (new) | No advice; aging list still shown |

## 5.5 Feeding the dashboards

- **Seller Center → Inventory → Forecast**:
  - interval band chart (p10–p90 band, p50 line, never a bare line), horizon selector, stock cover range, reason codes rendered from an AR/EN string table (no LLM);
  - "coverage measured: 78% over 13 weeks" or "range not yet measured" badge.
  - Reads `GET /v1/seller/forecasts` (exists, extended fields).
- **Seller Center → Aging inventory → Markdown advice**:
  - table with current and suggested price, basis, outcome ranges, hold comparison, VRP preview, notice, Apply/Dismiss.
  - Reads `GET /v1/seller/markdown-advice`.
- **Seller Center → Anomalies** (own store; GMV, orders, refunds, conversion): reads `GET /v1/seller/anomalies`, with "what changed" limited to own-store dimensions.
- **Admin → Model health**: per model and segment WSPL vs baseline, coverage, bias, drift PSI, shadow vs served, registry approvals.
- **Admin → Anomaly inbox**: severity-sorted, deduplicated, with explanations, links to incidents and SLO burn alerts, and ack. The daily digest page is linked from the morning ops email; the email carries the link only, never data (research note).
- **Admin → Category forecasts and FBH restock**: category × size, governorate (k-gated).
- **Admin → Elasticities**: category posteriors with n changes and advice share (feedback-loop watch).
- All money values are formatted from bigint piastres in the UI layer only (`١٬٢٠٠ ج.م` / `EGP 1,200`). All copy is Arabic-first.

## 5.6 Security and abuse notes (STRIDE summary)

- **Tampering with training data**: fake purchases to inflate demand signals. Fraud-flagged orders are excluded by the feeder (exists). The isolation forest flags sellers whose own-store demand diverges from views (purchase/view ratio outlier).
- **Information disclosure**:
  - cross-seller leakage through priors (blocked by flag pending VR-P3-14);
  - geography cells (k ≥ 50, exists);
  - anomaly explanations (k-gated, store names admin-only).
- **Repudiation**: advice applications carry `advice_id`, actor and idempotency key in the audit log.
- **Elevation**: the ml-service roles have no write path to serving tables; the promoter validates.
- **DoS / cost**: DP grid cap; per-store compute budget (max 20 CPU-minutes per store per night, UNTUNED). If it is exceeded, the store falls back to baselines with the reason `compute_budget_exceeded`.
- **OWASP API**: every new endpoint has a BOLA negative test (seller A → seller B advice = 404) and BFLA (seller → admin anomalies = 403).

---

# 6. Parameter register (every value is UNTUNED inference unless it comes from a cited source)

| Parameter | Default | Source / status |
|---|---|---|
| Min comparable units / observed days (R0 gate) | 20 / 28 | Existing code; untuned |
| ADI / CV² cut-offs | 1.32 / 0.49 | Syntetos, Boylan & Croston 2005 |
| Regime week thresholds R1/R2/R3 | 4 / 12 / 52 weeks | UNTUNED |
| R3 global pool | 200 series × 26 weeks | UNTUNED |
| Croston/SBA/TSB smoothing | α = 0.1 (SBA, exists); TSB α_z = 0.1, β_p = 0.05 | UNTUNED |
| NB hyper-priors | σ ~ HN(1), τ ~ HN(0.5), log φ ~ N(log 2, 1) | UNTUNED |
| Posterior samples (forecast / DP / outcome sim) | 500 / 200 / 2000 | UNTUNED |
| Unconstraining EM | a ≥ 0.5 and sold out; ≤ 3 iterations; a < 0.05 = null | UNTUNED |
| Analogues | K = 20, min 8, Gower distance, bandwidth = median | UNTUNED |
| Cold-start gate | ≥ 30 lots, coverage [0.70, 0.90] | UNTUNED |
| Size-curve concentration κ start / flat-curve fallback | 20 / < 50 units | UNTUNED |
| MinT eligibility | all nodes ok, ≥ 8 origins | UNTUNED |
| Hijri ±1 day weights | 0.25 / 0.5 / 0.25 | UNTUNED |
| Payday window | last 3 + first 2 days of month | UNTUNED; ⚠ verify Egyptian pay conventions |
| Price reference for index | median of first 14 listed days | UNTUNED |
| Conformal α / min n / widen factor | 0.2 / 20 / 1.5 | α by spec (80%); others UNTUNED |
| ACI γ, α clamp | 0.005, [0.05, 0.35] | UNTUNED |
| Backtest origins / min train | ≤ 26 / 28 days | UNTUNED (v1: 14 days) |
| Gate | origins ≥ 4, SPL margin 5%, coverage [0.70, 0.90], abs bias ≤ 2000 bps, DM test if ≥ 8 origins | UNTUNED |
| Shadow period | 4 weekly origins | UNTUNED |
| Anomaly BH q / point p / persistence / cooldown / budget | 0.05 / 1e−4 / 2-of-3 / 6h / 3 pages + 10 digest per day | UNTUNED |
| CUSUM k, h | 0.5, 5 | Classic textbook values (Montgomery); ⚠ verify ARL table numbers |
| Ratio min trials | 30 | UNTUNED |
| Severity thresholds | §2.10 | UNTUNED |
| Explanation thresholds | c_d ≥ 0.10, cumulative ≥ 0.67 | UNTUNED, after Adtributor's design |
| Price robust-z alert | abs(z) > 4 | UNTUNED |
| Isolation forest | 200 trees, subsample 256 | Liu, Ting & Zhou 2008 defaults; untuned for us |
| Elasticity prior | ε = −exp(η), η̄ ~ N(log 1.5, 0.6²) | Informed by Tellis 1988 and Bijmolt et al. 2005 means; not local; UNTUNED |
| Elasticity informative rule | 80% width < 1.5, ≥ 30 changes, ≥ 10 SKUs | UNTUNED |
| Advice holdout | 10% of eligible SKUs | UNTUNED |
| Ladder | K ≤ 6, 10% steps, whole pounds, platform floor 30% of VRP-window low | UNTUNED; ⚠ legal check on floors |
| DP horizon / grid | T ≤ 12 weeks, exact to 400 units, else step ⌈X/400⌉ | UNTUNED |
| DP vs simple-rule margin | +2% expected, P10 ≥ hold P10 | UNTUNED |
| Advice cadence / min listing age / expiry | 7 days / 14 days / 7 days | UNTUNED |
| Drift | PSI 0.1 / 0.2; 2 consecutive weeks for auto-fallback | Industry convention; untuned |
| Compute budget | 20 CPU-min per store per night | UNTUNED |

---

# 7. Open decisions (owner, counsel, or later ADRs)

| # | Decision | Owner | Safe default until decided |
|---|---|---|---|
| O-1 | Write ADR "Forecasting v2 model family and gate" (this spec §1.3, §1.15) and ADR "In-house ML service boundary" (§5.1: Python batch, read replica, staging-and-promote) | Architect → Tech Lead | Spec stands as Proposed; only TS baselines run |
| O-2 | VR-P3-14: may forecasts, priors, launch profiles and elasticities for seller A use other sellers' sales (as anonymised priors with ≥ 10 sellers / k ≥ 50)? | Legal / Product | Per-store only (`forecast.cross_seller_priors` Blocked) |
| O-3 | Should the seller see "chance to clear ≥ 80%" at all (perceived as a promise)? Liability wording in the Seller Agreement | Legal / Product | Shown only with measured coverage, with a range and disclaimer |
| O-4 | Platform price floor for advice (30% of the VRP-window low) and any below-cost rule under Egyptian competition law | Legal | Floor on; advice never below seller floor |
| O-5 | Credit the ranking traffic uplift to markdown advice as a scenario? It strengthens the feedback loop | Product / Architect | Not credited; shown at most as a separate labelled scenario in v2 |
| O-6 | Any randomised **price** experiment (switchback across matched SKUs, seller opt-in) to identify elasticity. Raises consumer-protection and fairness questions | Legal / Owner | **No price randomisation**; only advice-visibility holdout |
| O-7 | Model size substitution (demand moving to sibling sizes after stock-out) | Architect (v3) | Indicator regressor only |
| O-8 | Seller-entered unit cost (`c_i`) and salvage value: collect them? (sensitive commercial data) | Product | Optional; without them, proceeds are shown before cost |
| O-9 | Who owns `calendar_events` confirmation (Ramadan/Eid dates, White Friday window) | Ops | Marketing ops admin role; provisional dates flagged |
| O-10 | Seller-visible anomalies: which metrics, and does it add alert fatigue for small sellers | Product | Digest-only, own GMV/orders/refunds/conversion, sev ≥ 2 |
| O-11 | Python dependencies and licences (statsforecast, lightgbm, numpyro/PyMC, scikit-learn, hijri-converter) | Tech Lead | Pin and review before the ml-service is built |

---

# 8. What I could not verify

- **Literature figures quoted from memory, not re-read in this pass:**
  - meta-analysis elasticity means (Tellis 1988 ≈ −1.76; Bijmolt et al. 2005 ≈ −2.62);
  - CUSUM ARL values for k = 0.5, h = 5 (≈ 465 in control, ≈ 10 for a 1σ shift) and EWMA L for λ = 0.2;
  - the revenue uplifts reported by Caro & Gallien (2012, Zara) and Ferreira et al. (2016, Rue La La), which are therefore deliberately not quoted as numbers;
  - the exact SRE Workbook burn-rate tiers (the research note sourced them from secondary summaries).
  Titles, authors and venues in §9 are given to the best of my knowledge and must be checked when the ADRs are written.
- **No published accuracy, elasticity or intermittency figures for Egyptian or MENA off-price fashion** were found. Every threshold is UNTUNED.
- **Egyptian calendar facts:**
  - how Dar al-Ifta announces Ramadan and Shawwal starts and how often the date differs from the computed tabular or Umm al-Qura date;
  - whether DST is still in force in Egypt and its exact transition rule;
  - typical payday conventions;
  - school-year start dates;
  - the market convention for "White Friday" dates.
- **Legal:**
  - legality and fairness of automated markdown advice with outcome probabilities (liability);
  - below-cost or floor rules (Law 3/2005);
  - price experimentation;
  - use of cross-seller data (VR-P3-14);
  - whether isolation-forest pricing scores may inform Trust & Safety reviews of sellers (automated profiling of businesses is not PDPL personal data, but seller staff are individuals).
- **Data availability**: whether inventory events give enough resolution to compute `availability_bps` per size per day, and whether `views` per SKU per day is recorded at the needed grain (the funnel has `impression` and `view` stages, but the per-SKU-day grain was not verified). If views are not available per SKU-day, the conversion-per-view elasticity model in §3.3 falls back to a units model with ranking position as a control, with a stronger causal caveat.
- **Compute sizing** for the NB fit and the DP at the largest expected store was not benchmarked.
- **Library licences and versions** were not checked.

---

# 9. References

Forecasting and intermittent demand
- Croston, J. D. "Forecasting and stock control for intermittent demands." *Operational Research Quarterly* 23(3), 1972.
- Syntetos, A. A., Boylan, J. E. "The accuracy of intermittent demand estimates." *International Journal of Forecasting* 21(2), 2005.
- Syntetos, A. A., Boylan, J. E., Croston, J. D. "On the categorization of demand patterns." *Journal of the Operational Research Society* 56(5), 2005.
- Teunter, R. H., Syntetos, A. A., Babai, M. Z. "Intermittent demand: Linking forecasting to inventory obsolescence." *European Journal of Operational Research* 214(3), 2011.
- Snyder, R. D., Ord, J. K., Beaumont, A. "Forecasting the intermittent demand for slow-moving inventories: A modelling approach." *International Journal of Forecasting* 28(2), 2012.
- Hyndman, R. J., Koehler, A. B., Snyder, R. D., Grose, S. "A state space framework for automatic forecasting using exponential smoothing methods." *International Journal of Forecasting* 18(3), 2002.
- Hyndman, R. J., Athanasopoulos, G. *Forecasting: Principles and Practice*, 3rd ed. OTexts, 2021.
- Hyndman, R. J., Koehler, A. B. "Another look at measures of forecast accuracy." *International Journal of Forecasting* 22(4), 2006.
- Tashman, L. J. "Out-of-sample tests of forecasting accuracy: an analysis and review." *International Journal of Forecasting* 16(4), 2000.
- Makridakis, S., Spiliotis, E., Assimakopoulos, V. "The M4 Competition: 100,000 time series and 61 forecasting methods." *International Journal of Forecasting* 36(1), 2020.
- Makridakis, S., Spiliotis, E., Assimakopoulos, V. "M5 accuracy competition: Results, findings, and conclusions." *International Journal of Forecasting* 38(4), 2022.
- Makridakis, S., et al. "The M5 uncertainty competition: Results, findings and conclusions." *International Journal of Forecasting* 38(4), 2022.
- Salinas, D., Flunkert, V., Gasthaus, J., Januschowski, T. "DeepAR: Probabilistic forecasting with autoregressive recurrent networks." *International Journal of Forecasting* 36(3), 2020.
- Ke, G., et al. "LightGBM: A highly efficient gradient boosting decision tree." *NeurIPS* 2017.
- Koenker, R., Bassett, G. "Regression quantiles." *Econometrica* 46(1), 1978.
- Chernozhukov, V., Fernández-Val, I., Galichon, A. "Quantile and probability curves without crossing." *Econometrica* 78(3), 2010.
- Harvey, D., Leybourne, S., Newbold, P. "Testing the equality of prediction mean squared errors." *International Journal of Forecasting* 13(2), 1997.
- Diebold, F. X., Mariano, R. S. "Comparing predictive accuracy." *Journal of Business & Economic Statistics* 13(3), 1995.

Hierarchical forecasting and pooling
- Hyndman, R. J., Ahmed, R. A., Athanasopoulos, G., Shang, H. L. "Optimal combination forecasts for hierarchical time series." *Computational Statistics & Data Analysis* 55(9), 2011.
- Athanasopoulos, G., Ahmed, R. A., Hyndman, R. J. "Hierarchical forecasts for Australian domestic tourism." *International Journal of Forecasting* 25(1), 2009.
- Wickramasuriya, S. L., Athanasopoulos, G., Hyndman, R. J. "Optimal forecast reconciliation for hierarchical and grouped time series through trace minimization." *Journal of the American Statistical Association* 114(526), 2019.
- Wickramasuriya, S. L., Turlach, B. A., Hyndman, R. J. "Optimal non-negative forecast reconciliation." *Statistics and Computing* 30, 2020.
- Panagiotelis, A., Gamakumara, P., Athanasopoulos, G., Hyndman, R. J. "Probabilistic forecast reconciliation: Properties, evaluation and score optimisation." *European Journal of Operational Research* 306(2), 2023.
- Schäfer, J., Strimmer, K. "A shrinkage approach to large-scale covariance matrix estimation and implications for functional genomics." *Statistical Applications in Genetics and Molecular Biology* 4(1), 2005.
- Gelman, A., Hill, J. *Data Analysis Using Regression and Multilevel/Hierarchical Models.* Cambridge University Press, 2007.
- Chapados, N. "Effective Bayesian modeling of groups of related count time series." *ICML* 2014.
- Minka, T. "Estimating a Dirichlet distribution." Technical report, MIT, 2000.

New products, censoring, events
- Ferreira, K. J., Lee, B. H. A., Simchi-Levi, D. "Analytics for an online retailer: Demand forecasting and price optimization." *Manufacturing & Service Operations Management* 18(1), 2016.
- Fisher, M., Raman, A. "Reducing the cost of demand uncertainty through accurate response to early sales." *Operations Research* 44(1), 1996.
- Bass, F. M. "A new product growth for model consumer durables." *Management Science* 15(5), 1969.
- Talluri, K. T., van Ryzin, G. J. *The Theory and Practice of Revenue Management.* Springer, 2004.
- Weatherford, L. R., Pölt, S. "Better unconstraining of airline demand data in revenue management systems for improved forecast accuracy and greater revenues." *Journal of Revenue and Pricing Management* 1(3), 2002.
- Dempster, A. P., Laird, N. M., Rubin, D. B. "Maximum likelihood from incomplete data via the EM algorithm." *Journal of the Royal Statistical Society B* 39(1), 1977.
- Lin, J.-L., Liu, T.-S. "Modeling lunar calendar holiday effects in Taiwan." *Taiwan Economic Forecast and Policy* 33(1), 2003. (⚠ not re-verified)
- U.S. Census Bureau. *X-13ARIMA-SEATS Reference Manual* (moving-holiday regressors).

Calibration and conformal prediction
- Vovk, V., Gammerman, A., Shafer, G. *Algorithmic Learning in a Random World.* Springer, 2005.
- Lei, J., G'Sell, M., Rinaldo, A., Tibshirani, R. J., Wasserman, L. "Distribution-free predictive inference for regression." *Journal of the American Statistical Association* 113(523), 2018.
- Romano, Y., Patterson, E., Candès, E. J. "Conformalized quantile regression." *NeurIPS* 2019.
- Gibbs, I., Candès, E. J. "Adaptive conformal inference under distribution shift." *NeurIPS* 2021.
- Barber, R. F., Candès, E. J., Ramdas, A., Tibshirani, R. J. "Conformal prediction beyond exchangeability." *Annals of Statistics* 51(2), 2023.
- Gneiting, T., Raftery, A. E. "Strictly proper scoring rules, prediction, and estimation." *Journal of the American Statistical Association* 102(477), 2007.
- Gneiting, T., Balabdaoui, F., Raftery, A. E. "Probabilistic forecasts, calibration and sharpness." *Journal of the Royal Statistical Society B* 69(2), 2007.
- Czado, C., Gneiting, T., Held, L. "Predictive model assessment for count data." *Biometrics* 65(4), 2009.

Anomaly detection and alerting
- Rousseeuw, P. J., Croux, C. "Alternatives to the median absolute deviation." *Journal of the American Statistical Association* 88(424), 1993.
- Leys, C., Ley, C., Klein, O., Bernard, P., Licata, L. "Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median." *Journal of Experimental Social Psychology* 49(4), 2013.
- Cleveland, R. B., Cleveland, W. S., McRae, J. E., Terpenning, I. "STL: A seasonal-trend decomposition procedure based on loess." *Journal of Official Statistics* 6(1), 1990.
- Rosner, B. "Percentage points for a generalized ESD many-outlier procedure." *Technometrics* 25(2), 1983.
- Hochenbaum, J., Vallis, O. S., Kejariwal, A. "Automatic anomaly detection in the cloud via statistical learning." arXiv:1704.07706, 2017.
- Page, E. S. "Continuous inspection schemes." *Biometrika* 41(1/2), 1954.
- Roberts, S. W. "Control chart tests based on geometric moving averages." *Technometrics* 1(3), 1959.
- Lucas, J. M., Saccucci, M. S. "Exponentially weighted moving average control schemes: Properties and enhancements." *Technometrics* 32(1), 1990.
- Montgomery, D. C. *Introduction to Statistical Quality Control*, 8th ed. Wiley, 2019.
- Liu, F. T., Ting, K. M., Zhou, Z.-H. "Isolation forest." *IEEE ICDM* 2008.
- Adams, R. P., MacKay, D. J. C. "Bayesian online changepoint detection." arXiv:0710.3742, 2007.
- Benjamini, Y., Hochberg, Y. "Controlling the false discovery rate: a practical and powerful approach to multiple testing." *Journal of the Royal Statistical Society B* 57(1), 1995.
- Foster, D. P., Stine, R. A. "α-investing: a procedure for sequential control of expected false discoveries." *Journal of the Royal Statistical Society B* 70(2), 2008.
- Javanmard, A., Montanari, A. "Online rules for control of false discovery rate and false discovery exceedance." *Annals of Statistics* 46(2), 2018.
- Bhagwan, R., Kumar, R., Ramjee, R., Varghese, G., Mohapatra, S., Manoharan, H., Shah, P. "Adtributor: Revenue debugging in advertising systems." *USENIX NSDI* 2014.
- Beyer, B., Murphy, N. R., Rensin, D. K., Kawahara, K., Thorne, S. (eds.). *The Site Reliability Workbook.* O'Reilly, 2018 (chapter "Alerting on SLOs").

Pricing, elasticity and markdowns
- Tellis, G. J. "The price elasticity of selective demand: A meta-analysis of econometric models of sales." *Journal of Marketing Research* 25(4), 1988.
- Bijmolt, T. H. A., van Heerde, H. J., Pieters, R. G. M. "New empirical generalizations on the determinants of price elasticity." *Journal of Marketing Research* 42(2), 2005.
- Rossi, P. E., Allenby, G. M., McCulloch, R. *Bayesian Statistics and Marketing.* Wiley, 2005.
- Berry, S. T. "Estimating discrete-choice models of product differentiation." *RAND Journal of Economics* 25(2), 1994.
- Villas-Boas, J. M., Winer, R. S. "Endogeneity in brand choice models." *Management Science* 45(10), 1999.
- Chernozhukov, V., Chetverikov, D., Demirer, M., Duflo, E., Hansen, C., Newey, W., Robins, J. "Double/debiased machine learning for treatment and structural parameters." *The Econometrics Journal* 21(1), 2018.
- Gallego, G., van Ryzin, G. "Optimal dynamic pricing of inventories with stochastic demand over finite horizons." *Management Science* 40(8), 1994.
- Smith, S. A., Achabal, D. D. "Clearance pricing and inventory policies for retail chains." *Management Science* 44(3), 1998.
- Caro, F., Gallien, J. "Clearance pricing optimization for a fast-fashion retailer." *Operations Research* 60(6), 2012.
- den Boer, A. V. "Dynamic pricing and learning: Historical origins, current research, and new directions." *Surveys in Operations Research and Management Science* 20(1), 2015.
- Chaney, A. J. B., Stewart, B. M., Engelhardt, B. E. "How algorithmic confounding in recommendation systems increases homogeneity and decreases utility." *ACM RecSys* 2018.
- Bottou, L., et al. "Counterfactual reasoning and learning systems: The example of computational advertising." *Journal of Machine Learning Research* 14, 2013.

Evaluation, drift, documentation
- Mitchell, M., et al. "Model cards for model reporting." *ACM FAT\** 2019.
- Gama, J., Žliobaitė, I., Bifet, A., Pechenizkiy, M., Bouchachia, A. "A survey on concept drift adaptation." *ACM Computing Surveys* 46(4), 2014.
- Rabanser, S., Günnemann, S., Lipton, Z. C. "Failing loudly: An empirical study of methods for detecting dataset shift." *NeurIPS* 2019.
- MacIver, D. R., Hatfield-Dodds, Z., et al. "Hypothesis: A new approach to property-based testing." *Journal of Open Source Software* 4(43), 2019.
