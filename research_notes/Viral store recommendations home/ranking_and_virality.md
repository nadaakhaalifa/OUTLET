# Ranking algorithms and virality metrics for a "Recommended stores" home module

Spec constraints read (haul-master-prompt-v3.md): §16 (only truthful social proof, computed from real events; per-user/device purchase limits; bot scoring), §17 (no budget data in promo targeting), §20.4 (Buy Box weights admin-configurable, versioned, A/B-tested), §20.5 (two-stage ranking GBDT first; diversity re-rank of at most 2 consecutive per store; new-seller exploration via Thompson sampling capped at 5% of impressions; bot filtering; A/B with return-rate and complaint guardrails; budget fit never stored as a seller-visible feature; the spec itself notes the ranking stack has no verified sources, "industry standard"), §20.6 (recommendations: batch co-view/co-buy, then two-tower + pgvector, session models in P3), §13 (personalization off means popularity + freshness ranking with no user features), §26 (consent-aware, PII-free events; typed event taxonomy includes store_viewed, add_to_bag, order_delivered, return_requested, referral_shared, referral_converted, drop_joined_queue). §15.4 already defines referral fraud controls and the reward-after-return-window rule. Sponsored placements must be labelled and are outside this organic module.

## 1. Which signals are valid and hard to game, and what is "most viral store"?

### Takeaway
Use signals that cost real money or real logistics to produce: unique verified buyers whose order closed without return or complaint, repeat buyers, and share-link-attributed first purchases. Treat follows, saves, wishlists and add-to-bag as weak, cheap signals (use only as low-weight or tie-break inputs). Define "most viral" as a smoothed per-store K = qualified referred buyers per qualified buyer, gated by a minimum volume.

### Cited Findings
- Viral coefficient: Andrew Chen models growth as u(t) = u(0)·(1 + i·conv)^t, with i = invites per user and conv = invite conversion rate; the per-period ratio is the viral coefficient. The compact K = i × c form (5 invites x 20% = 1.0) appears in third-party guides, not in Chen's post as retrieved. — [Andrew Chen](https://andrewchen.com/facebook-viral-marketing-when-and-why-do-apps-jump-the-shark/); [LaunchList guide](https://blog.getlaunchlist.com/blog/viral-coefficient-k-factor-guide)
- Chen notes conversion falls as the network saturates; one guide warns sustained K > 1 is rare and usually temporary. — [Andrew Chen](https://andrewchen.com/facebook-viral-marketing-when-and-why-do-apps-jump-the-shark/); [LaunchList guide](https://blog.getlaunchlist.com/blog/viral-coefficient-k-factor-guide)
- Order brushing (fake orders to inflate sales counts) is a recognised marketplace abuse; shows that raw "sold count" and order-count signals are gameable, and fake orders are paired with fake reviews. — [Shopee help](https://help.shopee.sg/4/article/121935-%5BResources%5D-How-do-I-report-brushing-activities-on-Shopee); [Racklify](https://racklify.com/encyclopedia/invisible-fraud-the-global-rise-of-the-brushing-scam/)
- Reddit-style/HN velocity with decay: HN score = (points-1)^0.8 / (hours+2)^1.8 with additional penalties. — [righto.com](https://www.righto.com/2013/11/how-hacker-news-ranking-really-works.html?m=0)

### Inferences (not sourced; proposed design)
- Signal tiers by cost-to-fake: (T1) distinct verified buyers with order CLOSED (after return window, per spec §20.1/§22) and no return/complaint; repeat-purchase rate among those buyers; share-link-attributed first purchases that also reach CLOSED. (T2) store follows, wishlist saves, add-to-bag, share clicks: cheap to fake or bot; use only as ratio-normalised, capped, low-weight features, or as tie-breaks. (T3) raw order count, GMV, page views: do not use.
- Exact definition, window W = 28 days, decay weight w = 0.5^(age_days/14), age measured from order CLOSED date:
  - B_s = sum of w over distinct buyers (one credit per buyer per store per window) with a CLOSED, non-returned, non-complained order at store s.
  - R_s = same sum for distinct buyers whose order was returned (non-"changed mind" reasons weighted 1; changed-mind weighted 0.5, inference) or complained.
  - V_s = sum of w over distinct buyers whose FIRST CLOSED purchase at store s was attributed to a share link/referral of store s, from a different sharer, with distinct device, payment fingerprint and address from the sharer.
  - Raw K_s = V_s / B_s (equals invites-per-buyer x invite-to-qualified-purchase conversion, i.e. Chen's i x c, measured only on outcomes that survived the return window).
  - Smoothed K~_s = (V_s + a·k0) / (B_s + a), k0 = platform-wide mean K, a = 20 pseudo-buyers (a is a tunable prior strength).
  - "Most viral store" = argmax K~_s over stores with B_s >= 30, R_s/(B_s+R_s) below platform 90th percentile, and integrity flags clear. Ties break on larger V_s. To rank by confidence rather than point estimate, an equivalent robust alternative is the Wilson lower bound of referred share V_s/B_s.
- Per spec §16 any UI badge ("Trending", "N bought this week") must come from these same real counts and show only above a threshold; never show K itself as social proof.
- Repeat-purchase rate (buyers with >=2 closed orders at the store / B) is a good quality feature but needs a longer window (90 days); at launch use it only after n is adequate.

### Gaps
- No primary source found for a published, validated per-store K-factor for marketplaces; the per-store K definition is my adaptation.
- No benchmark values for Egyptian marketplace share-link conversion found.

## 2. Compare (A) Wilson/Bayesian + time-decayed velocity vs (B) learning-to-rank / two-tower

### Takeaway
At launch scale (sparse data), approach A wins: it is transparent, needs no training data, is safe for the "personalization off" mode, and handles small samples explicitly. Approach B needs interaction volume and cold-start handling, and mainly adds value for personalisation. Recommend A now, add personalised re-ranking (B) as a later phase.

### Cited Findings
- Evan Miller: positive-minus-negative ignores proportions (600/400 scores 200 and loses to 5,500/4,500 scoring 1,000); average rating ignores sample size (2 of 2 positive outranks 100 positive/1 negative). Use the Wilson score lower bound: (p + z²/2n − z·sqrt((p(1−p) + z²/4n)/n)) / (1 + z²/n), z = 1.96 at 95%; works when ratings are few. — [Evan Miller](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html)
- IMDb-style weighted rating: WR = v/(v+m)·R + m/(v+m)·C, shrinking low-vote items to the global mean. IMDb does not disclose its exact method, so the formula is a circulated reconstruction; IMDb says an alternate weighting may apply when unusual voting is detected. — [IMDb Help](https://help.imdb.com/article/imdb/track-movies-tv/weighted-average-ratings/GWT2DSBYVT2F25SK); [Cornell blog](https://blogs.cornell.edu/info2040/?p=29939)
- HN: (points-1)^0.8/(hours+2)^1.8, time exponent larger than vote exponent so scores decay; reranked periodically. — [righto.com](https://www.righto.com/2013/11/how-hacker-news-ranking-really-works.html?m=0)
- LTR/behavioural features are the strongest training signals, which starves new items; Amazon's Empirical Bayes priors from non-behavioural signals increased new-product impressions by 13.53% in an online A/B (CIKM 2022). — [Amazon Science PDF](https://cdn.amazon.science/b5/2f/a9d9581d4f8eab473a4ab4a8ad35/addressing-cold-start-in-product-search-via-empirical-bayes.pdf)
- Practitioner rule of thumb (consultancy, low authority): matrix factorization for about 10k-1M interactions, two-tower for 1M+. Another write-up froze both towers rather than train on thin, biased, shifting engagement data. Instacart's example used content-only towers. — [Machine Learning at Scale](https://machinelearningatscale.substack.com/p/recsys-part-2-two-tower-models-in?open=false); [dev.to](https://dev.to/harshkedia17/the-two-tower-model-minus-the-training-469p)
- Google documents a two-tower reference architecture but not small-data guidance. — [Google Cloud](https://docs.cloud.google.com/architecture/implement-two-tower-retrieval-large-scale-candidate-generation)

### Inferences
- Comparison: A = deterministic, auditable (fits spec's emphasis on explainability and admin-configurable versioned weights), works day 1, resists manipulation through unique-buyer counting; weak at personalisation, can reinforce popularity. B = personalised and learns interactions, but needs volume, offline eval infrastructure, and cold-start mitigation; opaque; if trained on engagement it inherits position/popularity bias and fraud signals.
- Recommendation: Phase 1 (launch to roughly tens of thousands of closed orders): approach A, global non-personalised score; this is also the mandated fallback when personalisation is off. Phase 2: GBDT re-ranker (spec §20.5) over A's score plus user-store affinity features (category, price band, governorate, followed stores), trained on closed-order outcomes with A as a feature and baseline. Phase 3: two-tower retrieval only if the store catalogue is large enough that retrieval, not ranking, is the bottleneck; with a few hundred stores it likely never is (inference).
- Recommended formula (approach A), with worked example below.

#### Recommended score
`Score_s = Q_s x D_s x (1 + min(K~_s, 0.5))`
- Q_s = Wilson lower bound (z = 1.96) of satisfied share p = B_s / (B_s + R_s), n = B_s + R_s.
- D_s = ln(1 + B_s) (diminishing returns to volume, limits winner-take-all).
- K~_s smoothed viral coefficient from section 1, capped at 0.5 so virality is a bounded boost, not the main driver (design choice, inference).

#### Worked example (computed by me; decayed counts; k0 = 0.10, a = 20)
| Store | B | R | n | p | Wilson LB Q | D = ln(1+B) | V | Raw K | Smoothed K~ | Score |
|---|---|---|---|---|---|---|---|---|---|---|
| A (established) | 180 | 20 | 200 | 0.900 | 0.8506 | 5.199 | 18 | 0.100 | (18+2)/(200)=0.100 | 0.8506 x 5.199 x 1.100 = 4.86 |
| B (new, perfect) | 9 | 0 | 9 | 1.000 | 9/(9+3.8416)=0.7009 | 2.303 | 3 | 0.333 | (3+2)/29=0.172 | 0.7009 x 2.303 x 1.172 = 1.89 |
| C (mid) | 60 | 15 | 75 | 0.800 | 0.6959 | 4.111 | 12 | 0.200 | (12+2)/80=0.175 | 0.6959 x 4.111 x 1.175 = 3.36 |
Order A > C > B. A naive average rating would put B (100%) first; Wilson drops it to 70% for n = 9, matching Miller's argument. B's raw K of 0.333 is only 0.172 after smoothing, and B is below the B_s >= 30 gate so it cannot be named "most viral". Wilson check for A: (0.9 + 0.0096 − 0.0427)/1.0192 = 0.8506.

### Gaps
- No Zalando/Pinterest/Airbnb/Etsy engineering post on small-data store ranking was retrieved (searches surfaced none); claims about those companies are omitted rather than guessed.
- Reddit's "hot" formula page returned 403; Reddit constants are not cited here.
- Appropriate half-life (14 d), window (28 d), z, a and the K cap are untuned inferences; tune offline on real data.

## 3. Cold start and new-store exploration

### Takeaway
Reserve the spec's 5% impression budget for new stores and allocate it with Thompson sampling using an informative (not flat) prior; require minimum samples before a store competes on score.

### Cited Findings
- Dynamic Prior Thompson Sampling (Roblox, arXiv 2026) argues a flat prior treats an unseen item as a coin flip and overstates new content quality; they design the prior around how likely a new arm is to beat the current best; delayed batch feedback is a practical complication. — [arXiv 2602.00943](https://arxiv.org/html/2602.00943v1)
- Particle Thompson Sampling frames collaborative-filtering exploration as a bandit (NeurIPS 2015). — [NeurIPS](https://papers.nips.cc/paper/2015/hash/846c260d715e5b854ffad5f70a516c88-Abstract.html)
- Amazon: Empirical Bayes priors from non-behavioural signals lifted new-product impressions 13.53% in an A/B test. — [Amazon Science PDF](https://cdn.amazon.science/b5/2f/a9d9581d4f8eab473a4ab4a8ad35/addressing-cold-start-in-product-search-via-empirical-bayes.pdf)
- Third-party SEO sources claim Etsy gives new listings a temporary boost; unverified. — [eRank](https://help.erank.com/blog/7-factors-that-affect-rank-on-etsy/)

### Inferences
- Design: stores with B_s + R_s < 30 (or under 14 days live) enter an "exploration pool". Spec cap: at most 5% of module impressions go to the pool. Within the pool, Thompson sampling over Beta(alpha0 + successes, beta0 + failures) where the reward is a closed, non-returned order per impression (or add-to-bag as a faster proxy with a conversion-to-order correction), and the prior mean/strength comes from store attributes (category, price band, KYC verified, catalogue quality score) rather than 0.5/0.5. Graduate a store when n >= 30 and it competes on Score_s.
- Cap exposure per store (for example at most 1% of impressions) and require Seller Health and price-trust gates before entering the pool (spec §9/§19).
- Because feedback is delayed (closure after return window), use fast proxies (add-to-bag, order placed) for the bandit reward and the closed-order outcome for the final score (inference).
- UCB is simpler and deterministic but is more exploitable and gives less natural randomisation; Thompson matches the spec (inference).

### Gaps
- No marketplace-specific minimum-sample guidance found; n >= 30 is a conventional rule of thumb, not sourced.

## 4. Anti-manipulation

### Takeaway
Count unique verified buyers (not orders), credit only after the return window closes, dedupe on device/payment/address graphs, cap per-buyer influence, use robust statistics, and run anomaly detection on aggregate distortions. No single defence suffices; the literature itself frames detection as evidence for investigation.

### Cited Findings
- Amazon says its ML models weigh account relationships, sign-in activity and review history; it reports blocking over 275 million suspected fake reviews in 2024; brokers organise off-platform. — [Amazon trustworthy shopping](https://trustworthyshopping.aboutamazon.com/global-action-against-fake-reviews); [Customer Experience Dive](https://www.customerexperiencedive.com/news/amazon-fight-fake-reviews/735980/)
- Fakespot's 42% bogus-review estimate is disputed by Amazon. — [Customer Experience Dive](https://www.customerexperiencedive.com/news/amazon-fight-fake-reviews/735980/)
- A 2026 arXiv preprint ranks accounts whose repeated activity matches distorted aggregate outcomes (account reuse across targets); the authors say it is for integrity analysis, not automatic enforcement, and a high score does not prove intent. — [arXiv 2609.13407](https://arxiv.org/pdf/2609.13407)
- Brushing mechanics: low-value orders from real, throwaway or bot accounts, cheap/empty parcels to create tracking records, then reviews; Shopee bans sellers and buyers involved. A third-party tool flags products with reviews under about 3% (Shopee) or 2% (Lazada) of units sold (a heuristic, not a platform method). — [Racklify](https://racklify.com/encyclopedia/invisible-fraud-the-global-rise-of-the-brushing-scam/); [Shopee help](https://help.shopee.sg/portal/4/article/130116); [Metric.vn](https://hotro.metric.vn/en/support/faqs/data/how-to-filter-fake-abnormal-products)
- IMDb applies an alternate weighting when unusual voting is detected. — [IMDb Help](https://help.imdb.com/article/imdb/track-movies-tv/weighted-average-ratings/GWT2DSBYVT2F25SK)

### Inferences (mapped to spec controls)
- Verified-purchase only plus unique buyers: kills order-count inflation. Credit only at CLOSED (return window plus 3 days, spec §T4/§22) so refund-after-credit rings do not pay off; a courier-confirmed delivery with OTP/photo proof (spec §21) defeats empty-parcel brushing.
- Collusion graph: link buyer-seller via shared device, payment fingerprint, address, phone, IP cluster and referral edges (spec §15.4 graph); exclude buyers linked to the store's owner/staff; drop clusters whose connected component exceeds N.
- Per-buyer cap: one credit per buyer per store per window; a buyer's total influence across all stores bounded; new accounts (<7 days) down-weighted.
- Robust statistics: winsorise daily buyer counts at the store's trailing median + k·MAD; use Wilson LB (already penalises small n); cap K contribution at 0.5.
- Anomaly signals: sudden buyer spikes with low review/return ratio, many first-time accounts from few devices/addresses, high referral share with near-zero repeat, same-minute order bursts, bot scores (spec §16/§T5).
- Viral-specific: share-link conversions counted only for first purchases by new-to-store buyers, distinct from sharer's device/payment/address; referral rings caught by connected-component detector; zero credit for COD orders until delivered and closed.
- Detection outputs feed a review queue and score discount, not instant penalties; keep seller appeals consistent with spec §9.5 fairness.

### Gaps
- No Amazon/Etsy/Shopee published numeric thresholds for engagement-fraud detection; thresholds above are untuned.
- Etsy and Google ranking-integrity sources were not found in this pass.

## 5. Diversity, fairness, and evaluation

### Takeaway
Pure popularity ranking creates rich-get-richer loops; add log-damped volume, a bounded exploration budget, and a store-diversity re-rank, then evaluate offline then online with return and complaint guardrails.

### Cited Findings
- Survey of 123 papers: recommenders over-favour popular items, hurting long-tail providers and reinforcing the effect over time; research is mostly offline computational experiments with assumptions about long-tail value. — [Klimashevskaia et al., arXiv 2308.01118](https://arxiv.org/html/2308.01118v3); [UMUAI](https://link.springer.com/article/10.1007/s11257-024-09406-0)
- Guardrail metrics protect against unintended harm; trust-related guardrails such as sample ratio mismatch (SRM) should be included in every experiment. — [Kohavi et al., Cambridge](https://www.cambridge.org/core/books/trustworthy-online-controlled-experiments/sample-ratio-mismatch-and-other-trustrelated-guardrail-metrics/8DBB0F59AC7729D7BC6B94690DB9CCD5)
- Multi-window burn-rate alerting is in the Google SRE Workbook, already adopted by the spec (§T8); I did not retrieve it in this pass. — spec §T8

### Inferences
- Diversity: re-rank the top-N so no more than 2 consecutive stores share a category or no more than 1 store per "world" (Local/Global) block (spec §20.5 diversity rule); rotate within score bands (for example shuffle stores within 10% of each other's score) to damp position bias; impressions logged with position for later inverse-propensity correction.
- Offline evaluation: replay historic closed-order data: does Score at day t predict next-14-day closed orders and low return rate better than naive best-seller and average-rating baselines (NDCG / rank correlation); check calibration of Q.
- Online A/B: primary = closed-order conversion per home session and 28-day repeat rate; guardrails = return rate, complaint rate, COD refusal rate, share of impressions to top-5 stores (concentration, Gini), new-store sell-through, SRM check, latency; stop on guardrail breach (spec §20.5).
- Ongoing: monitor concentration (Gini of impressions) and mean time for a new store to reach n >= 30.
- Personalisation-off mode (spec §13): serve Score_s only, with no user features; verify with an integration test that the request carries personalized=false.

### Gaps
- Position-bias estimators and fairness-of-exposure methods were only covered via the survey; no specific marketplace paper retrieved.
- No source gives target thresholds for guardrail tolerances; set from baseline variance after launch.
