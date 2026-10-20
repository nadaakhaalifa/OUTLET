# Extending store-level virality ranking to items and outlets, blended with the shopper's region

Builds on `reports/Viral store recommendations home.md` (store formula, Wilson x ln(1+B) x (1+min(K~,0.5)), fallback ladder, k=50/20 floors, 5% exploration) and `reports/Egypt outlet location filter.md` (27 governorates; city = "city or district" second level; district level and mall seed UNVERIFIED). Neither is redone here. Research budget was small (6 searches); web evidence is thin, so most design points are labelled inference.

## 1. Item-level signals that are hard to game

### Takeaway
Reuse the store definition one level down: count only distinct verified buyers whose order reached CLOSED and was not returned, with share-attributed first purchases as a capped boost. Cheap signals (views, saves, add-to-bag, shares) are tie-breaks or cohort-eligibility checks only, never score inputs. Items must pass a hard "can be bought" gate before scoring.

### Cited Findings
- Raw order counts are gameable: "order brushing" (fake orders to inflate sales) is a recognised abuse on Shopee-type marketplaces — [Shopee help](https://help.shopee.sg/4/article/121935-%5BResources%5D-How-do-I-report-brushing-activities-on-Shopee); [Racklify](https://racklify.com/encyclopedia/invisible-fraud-the-global-rise-of-the-brushing-scam/) (from the prior store report).
- Evan Miller: positive-minus-negative and average rating ignore sample size/proportion; use the Wilson lower bound — [Evan Miller](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html) (from the prior store report).
- Pure popularity ranking over-favours head items and hurts the long tail; the survey covers causes, metrics and mitigation — [Klimashevskaia et al., arXiv 2308.01118](https://arxiv.org/pdf/2308.01118v2). It also notes most mitigation evidence is offline, so real-world effect is under-tested (same source).
- Yelp filters reviews via "recommendation software" (conflicts of interest, solicited reviews, reliability, usefulness) into a hidden "Not Recommended" section, and an academic audit found reviews from less-established users are disproportionately filtered — [Auditing Yelp, arXiv 2308.02129](https://arxiv.org/html/2308.02129v2). Precedent for weighting by account trust, with the caveat that it can bias against new users.
- Airbnb's ranker (KDD 2018) used graded outcomes (booking highest, then contact, click, view=0, host rejection negative), per a secondary summary — [Airbnb KDD'18 summary](https://lib.nbt.edu.cn/subject/show/showdetail.php?id=32695); Airbnb's own post on guest-journey personalization: [airbnb.tech](https://airbnb.tech/ai-ml/personalizing-airbnb-search-by-learning-from-the-guest-journey/). Supports ordering signals by cost/commitment (purchase >> save >> view).
- Spec rules that constrain this: no fake data and CI copy-lint (A2.13), return window from `delivered_at` and CLOSED after window plus 3 days (§B5, §T4), referral fraud graph (§15.4), Buy Box score `a·price_norm + b·(−delivery_days) + c·seller_health + d·rating + e·price_trust`, tie-break on stock depth (§20.4), ranking features include decayed velocity, verified discount depth, size availability, return rate, with new-seller Thompson sampling capped at 5% (§20.5) — `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md`.

### Inferences
- Item inputs per window W=28d, half-life 14d (untuned, same as stores): B_i = decayed distinct buyers with CLOSED non-returned non-complained line; R_i = distinct buyers who returned/complained (changed-mind = 0.5); V_i = distinct first-time-for-this-item buyers arriving through a share/deep link of item i from a different person (different device, payment fingerprint, address).
- Attribution: use last-touch share link within a 7-day window for credit, but require the sharer to differ from the buyer and credit each (item, buyer) once; log first-touch for analysis only. Dedupe by buyer-item pair. (No marketplace source found; design choice.)
- Eligibility gate (item not scored, not "ranked low"): published, stock depth >= threshold of in-size units (e.g. >= 3 units), seller active, price-integrity enforcement absent, not paused. Rationale: spec §5 and §20.5 "do not rank what cannot be bought".
- Photo-review rate and wishlist/save velocity: use only as capped tie-breaks (bounded +/-5% multiplier) because they are cheap to farm; photo reviews only from verified purchases (§27).
- Price-integrity: a verified-discount badge may add a small bounded bonus, a Price Trust Score below a cutoff multiplies score by 0; the label never implies a "% off" without §9 evidence.
- Return/complaint guardrail: exclude items whose return share R/(B+R) exceeds the category 90th percentile; Wilson Q already penalises high return share.

### Gaps
- No marketplace publishes numeric thresholds for share-attribution windows, return gating or save-velocity weights; all parameters are untuned.
- Yelp's exact ranking weights are unpublished; SEO-site percentages conflict and were not used.

## 2. Blending global and local virality

### Takeaway
Use hierarchical (empirical-Bayes) shrinkage of per-shopper-base purchase rates: district toward governorate toward Egypt, then convert the local lift over the national rate into a bounded multiplier. The national score stays the base so tiny districts cannot dominate, and the existing 50/20 cohort floors plus fallback ladder still decide whether a local view may be shown.

### Cited Findings
- Empirical-Bayes shrinkage forms each group's estimate as a weighted blend of its own mean and the overall mean, with small-sample groups pulled hardest; the prior is estimated from the data; shrinkage beats raw means in squared error for k >= 3 groups (James-Stein); caveat: hyperparameter uncertainty is ignored — tutorial sources, [MetricGate EB shrinkage](https://metricgate.com/docs/empirical-bayes-shrinkage/), [MetricGate hierarchical Beta-Binomial](https://metricgate.com/docs/hierarchical-beta-binomial-baseball/). Sources disagree on minimum group count (3 vs 5). No primary paper (Efron-Morris, Gelman) was retrieved.
- Amazon reported that empirical-Bayes priors improved cold-start product search (+13.53% in an A/B test) — [Amazon Science](https://cdn.amazon.science/b5/2f/a9d9581d4f8eab473a4ab4a8ad35/addressing-cold-start-in-product-search-via-empirical-bayes.pdf) (from the prior store report).
- Google local results are based primarily on relevance, distance and prominence; Google gives no weights; distance is measured from the searched location or an estimate of the user's position — [Google Business Profile help](https://support.google.com/business/answer/7091?hl=en). Third-party claims of radius behaviour in dense vs rural areas are unverified — [Localo](https://localo.com/local-seo-course/module-1/understanding-google-local-search-algorithm).
- Location-based recommenders show popularity bias, venue exposure polarisation and geographic-distance polarisation — Sanchez, Bellogin, Boratto, via [Comillas repository summary](https://repositorio.comillas.edu/xmlui/handle/11531/105315) (no arXiv version found).
- Etsy engineering describes a two-stage (retrieval, ranking) personalised search with offline and A/B gains; location as a ranking input is NOT stated in Etsy's own sources (only seller blogs claim it) — [Code as Craft](https://codeascraft.com/2020/10/29/bringing-personalized-search-to-etsy/), [Etsy WWW'21 paper](https://www.dsml.etsy.com/s/WWW_21_short_paper_personalized_search.pdf).

### Inferences
**Proposed item score (all numeric parameters untuned inferences):**

Score_i,c = G_i x Q_i x D_i x (1 + min(K~_i, 0.5)) x (1 + min(lambda x ln(max(L_i,c, 1)), 0.5)) x S_i x P_i

- Q_i = Wilson lower bound (z=1.96) of B/(B+R); D_i = ln(1+B_i); K~_i = (V_i + a·k0)/(B_i + a), k0=0.10, a=20 (store values reused).
- G_i = 1 if the eligibility gate passes (section 1), else the item is dropped.
- Hierarchy: pi_n = B_n / N_n; pi_g = (B_g + m·pi_n)/(N_g + m); pi_d = (B_d + m·pi_g)/(N_d + m), where B is the item's distinct buyers in the area and N is distinct buyers of anything in the area in W. m = 20 pseudo-buyers, lambda = 0.1, boost cap +0.5. L = pi_d / pi_n (local lift).
- S_i in [0.8,1] stock-depth factor (1 when depth >= 10 in-size units); P_i = 0 or 1 price-integrity/enforcement gate (small bounded verified-discount bonus optional). Treat both as 1 in the example.
- Local lift never lowers a score (max(L,1)): local relevance can only promote, so the national view stays the safe fallback. Using demand per active-buyer base (N) avoids ranking big districts above small ones simply on volume.
- Tiny districts: cohort must have >= 50 distinct shoppers and >= 20 distinct purchasers of the item (store-report floors); otherwise use the governorate pi (shrinkage already handles it), then national. Fallback ladder unchanged: city with shop_for, governorate with shop_for, city, Egypt, non-personalised.

**Worked example (Sheikh Zayed cohort; k0=0.10, a=20, m=20, lambda=0.1, S=P=1):**

| | Item X (niche, local fave) | Item Y (national bestseller) |
|---|---|---|
| National B / R / V | 200 / 20 / 20 | 400 / 40 / 40 (assume Q=0.88) |
| Wilson Q (n=220 for X) | 0.8637 | 0.88 (assumed) |
| D = ln(1+B) | 5.303 | 5.994 |
| K~ | (20+2)/(200+20)=0.100 | 0.100 |
| National score = Q·D·(1+K~) | 5.04 | 5.80 |
| pi_n (N_n=100,000) | 0.00200 | 0.00400 |
| Giza B_g / N_g=6,000 | 70 | 40 |
| pi_g | (70+0.04)/6020 = 0.011635 | (40+0.08)/6020 = 0.006658 |
| District B_d / N_d=400 | 12 | 1 |
| pi_d | (12+0.2327)/420 = 0.029126 | (1+0.1332)/420 = 0.002698 |
| Lift L = pi_d/pi_n | 14.56 | 0.67 (below 1, no boost) |
| Local multiplier 1+min(0.1·ln L, 0.5) | 1+0.268 = 1.268 | 1.000 |
| **Local score** | **6.39** | **5.80** |

Nationally Y beats X (5.80 vs 5.04); in Sheikh Zayed X beats Y (6.39 vs 5.80). The arithmetic for X's Wilson bound: p=0.909, center 0.9177, margin 0.0390, denominator 1.0175, Q=0.8637. Hand-calculated, not run in code; a property test should confirm. If pi_g had been used instead of pi_d (district below floor), X's lift would be 5.82, multiplier 1.176, score 5.93.

### Gaps
- No primary-source evidence found for how Airbnb, Yelp, Zalando, Instacart or Talabat blend local and global popularity; their location ranking internals are not published in anything retrieved. Zalando, Instacart, Talabat searches were not run.
- No empirical-Bayes primary literature retrieved; the shrinkage form here is the standard Beta-Binomial style, justified by tutorials only.
- m, lambda, cap and floors are untuned; no Egyptian data exists to tune them. "District" below city is not modelled in the repo (outlet-filter report), so initial cohorts are governorate and city.

## 3. Outlet (physical store) ranking

### Takeaway
Rank outlets with the store formula plus offline-intent signals that need no precise location (outlet-page visits, directions taps, QR ticket redemption), and use distance only when the shopper volunteers it. Without a location, rank within the chosen governorate or city using the same blended score. Open-now is a filter or a mild demotion, not a score input.

### Cited Findings
- Google ties local ranking to relevance, distance and prominence, with no published weights — [Google Business Profile help](https://support.google.com/business/answer/7091?hl=en).
- Spec: signed QR tickets for store events and sample sales with offline validation (§28.10, P3); "Local" means seller registered and stock held in Egypt (§3); precise location is a separate consent purpose `location_precise`, and budget data is excluded from ranking (§B1, §12) — `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md`.
- Prior outlet-filter report: no outlet data exists in the backend, the production screen shows an honest empty state, mall locations are UNVERIFIED, manual picker (not device location) is recommended, and Apple `accuracyAuthorization` allows approximate location — `/Users/nadakhalifa/OUTLET/reports/Egypt outlet location filter.md`.

### Inferences
- Outlet signal ladder by commitment (inference, modelled on Airbnb's graded-outcome idea): redeemed sample-sale ticket or verified in-store purchase > in-store QR check-in > directions tap > outlet-page visit. Only the first two enter B_o (distinct verified visitors, once per visitor per outlet per window, time-decayed); directions taps and visits are capped tie-breaks because they are bot-able.
- Outlet-specific anti-gaming: QR check-ins need a signed rotating ticket, one per visitor per day, same-device rule, and a velocity cap; sellers' own staff accounts excluded.
- Distance: do not sort by raw distance unless the user opts in; with opt-in, use on-device coarse distance bands (e.g. <2, 2-10, 10-30, 30+ km) and send only a band to the server, never coordinates. Distance acts as a multiplier on the cohort ranking, not a different system.
- Opening hours: closed outlets stay listed with "Opens at ..." and a mild demotion; no ranking boost for open-now to avoid timing games.
- Online store vs outlet: different lists and different cohorts; an online store with an outlet shares the Wilson/volume parts but outlets add the offline signals above. Keep separate scores to avoid mixing delivery-driven and visit-driven demand.
- Privacy: location signals are P2/P3-adjacent; aggregate before use (cohort floor 50/20), store no per-shopper trace in the ranking table, and gate any check-in analytics behind the `analytics` consent and precise location behind `location_precise`.

### Gaps
- No source found on how Yelp, Google or Talabat weight directions taps or check-ins; Google's help page lists no behavioural signals beyond prominence.
- Whether Egyptian law treats location as sensitive is unresolved (already on the verify register).
- Outlet data and QR tickets do not exist yet, so everything here is design only.

## 4. Anti-gaming for items, including multi-seller items

### Takeaway
Credit distinct, trusted, independent buyers at CLOSED time, run the existing referral/cluster fraud graph over share edges, winsorise per-item daily counts, and aggregate multi-seller listings at the product level for virality while using the Buy Box only to choose which offer to show.

### Cited Findings
- Brushing is the named abuse pattern — [Shopee help](https://help.shopee.sg/4/article/121935-%5BResources%5D-How-do-I-report-brushing-activities-on-Shopee).
- Yelp-style trust weighting exists in practice but disadvantages less-established users — [arXiv 2308.02129](https://arxiv.org/html/2308.02129v2).
- Spec: Buy Box score and tie-break on stock depth (§20.4), cross-channel and counterfeit controls (§9, §27), self-referral blocking and cluster detector (§15.4), Thompson sampling exploration capped at 5% (§20.5).
- Prior store report: reuse `suspiciousClusters`, exclude staff-linked buyers, down-weight accounts under 7 days, winsorise daily counts at median + k·MAD, anomaly scores feed review not instant penalty, no platform publishes numeric fraud thresholds.

### Inferences
- Share rings: count V_i only for edges where sharer and buyer differ on device, payment fingerprint and address; cap any single sharer's credited conversions per item per window (e.g. 3); drop clusters flagged by the graph.
- Bought clicks: share clicks never score; only closed orders do. Attribution requires an install/open event plus a purchase within 7 days.
- Self-buying and seller-owned accounts: exclude buyers linked to the store's staff, payout IBAN or address; exclude orders with courier proof failures.
- Per-item caps: B contributions per buyer = 1; per-day winsorisation; the K boost is capped at +0.5, local boost at +0.5, so no single lever can dominate.
- Multi-seller items: group offers by product (GTIN match, §9.2); product-level B and Q are summed over offers (a buyer counts once), and the shown offer is the Buy Box winner among offers that pass gates. Store virality on the store page still uses store-level counts. This stops sellers from splitting listings to dilute or farm score; an unmatched duplicate listing gets its own cold-start prior.
- Rich-get-richer: log damping, exploration pool, and diversity (below) address it; monitor impression Gini.

### Gaps
- No source gives validated numeric thresholds (caps, MAD multiplier); all untuned.

## 5. Honest labelling, legal and spec consistency

### Takeaway
Labels must name the level and window actually used; the item ranking is "ordered by recent verified purchases" and never exposes counts at launch. Sponsored items sit outside the organic score and are labelled. Personalisation off gives the national, non-personalised list.

### Cited Findings
- Regulators treat popularity claims as urgency claims judged on truth and freshness; the UK CMA lists "14 sold in the last 24 hours" as an example — [GOV.UK](https://www.gov.uk/government/news/shoppers-urged-to-call-out-online-rip-offs-as-cma-unveils-red-lines) (from the prior store report; UK guidance, not Egyptian law).
- Egypt CPL 181/2018 treats acts or omissions creating a misleading impression as deceptive; exact article numbers unconfirmed — [Andersen text](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf), [Chambers](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt).
- Spec: sponsored results labelled and capped at 2 in the top 10 (§4); personalization off means non-personalised ranking and no user features (§13); budget tables not importable from ranking/promotions/ads modules (§12); social proof computed from real events and shown only above a threshold (§16); CI copy-lint blocks hard-coded numeric social proof (A2.13).
- The Etsy WWW'21 and Code-as-Craft sources show that personalised ranking is separated from relevance, supporting a separate organic score — [Etsy](https://codeascraft.com/2020/10/29/bringing-personalized-search-to-etsy/).

### Inferences
- Label vocabulary tied to real windows (drafts, need native Arabic review): "Trending in {district}" only if the cohort level used was district and the window matches the label; with a 28-day decayed score use "Popular in {area} lately" (الأكثر طلبًا في {المنطقة} مؤخرًا); "Most shared this week" only if computed on a true 7-day share-attribution window with an exact 7-day score, otherwise "Often shared".
- Level honesty: if a district falls back to governorate, the label changes to the governorate name; never show the district label for governorate data.
- Sponsored items: separate slot, "إعلان / Sponsored", excluded from B, V and Q so ads cannot manufacture organic rank; ad clicks never count.
- Surfaces: search results (relevance first, virality as a bounded feature), explore feed (virality plus freshness plus diversity), store page (items ordered by store-level item score), outlet list (section 3), home rails (the cohort rail with "Why this?"). Budget data and measurements are not read by any of these.
- Report and weight outcomes, not clicks: purchase conversion with return rate, complaint rate and "not interested" as guardrails.

### Gaps
- Egyptian article numbers for misleading indicators and for sponsored labelling are unconfirmed (existing verify-register item).
- Arabic copy not reviewed by a native speaker.

## 6. Diversity, fairness and exploration

### Takeaway
Keep volume log-damped and boosts capped, add a diversity re-rank and a 5% Thompson-sampling pool for new items and stores, and watch concentration metrics.

### Cited Findings
- Popularity-only ranking harms the long tail; mitigation techniques are surveyed in [arXiv 2308.01118](https://arxiv.org/pdf/2308.01118v2), with a warning that real-world benefits are under-tested.
- Location recommenders suffer exposure polarisation as well as popularity bias — [Comillas summary](https://repositorio.comillas.edu/xmlui/handle/11531/105315).
- Thompson sampling with an attribute prior for cold-start exploration — [arXiv 2602.00943](https://arxiv.org/html/2602.00943v1) (from the prior store report); spec caps exploration at 5% of impressions and re-ranks for diversity (<= 2 consecutive items per store) (§20.5).
- Amazon's empirical-Bayes cold-start result (+13.53%) — [Amazon Science](https://cdn.amazon.science/b5/2f/a9d9581d4f8eab473a4ab4a8ad35/addressing-cold-start-in-product-search-via-empirical-bayes.pdf).

### Inferences
- New items (B+R < 30 or < 14 days live) enter an exploration pool at <= 5% of rail impressions, with a prior from category and store attributes; rewards use fast proxies (order placed) and promotion to organic uses closed orders.
- Re-rank so no more than 2 consecutive items share a store, no more than 3 in top 10 share a category; shuffle inside 10% score bands to damp position bias.
- Fairness across areas: show the local list only when the cohort floors pass; otherwise fall back, so small districts are not served noisy lists.
- Monitor Gini of impressions per item and per store, share of impressions from the exploration pool, and sample-ratio mismatch in experiments.

### Gaps
- No online evidence that these settings avoid rich-get-richer in Egyptian fashion; offline replay, then an A/B vs the non-personalised baseline, is needed.
