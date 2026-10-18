# Ranking and virality: algorithm specification (stores, items, outlets)

Status: **DRAFT for review (architect).** Documents only; no code in this change.
Date: 2026-10-16 (Africa/Cairo).
Spec refs: master prompt §4 (sponsored cap, search), §13 (personalisation off), §16 (truthful social proof, drops), §17 (no budget data in targeting), §20.4 (Buy Box, versioned admin weights), §20.5 (two-stage ranking, diversity, 5% Thompson exploration, bot filtering, guardrails), §20.6 (recommendations), §26 (consent-aware typed events), §B1 (PDPL, residency, k-anonymity, retention), A2 (pure domain, integer piastres, determinism, property and mutation tests).
Inputs read: `reports/Viral store recommendations home.md`, `reports/Viral feed onboarding checkout reviews.md` (part A), `reports/Egypt outlet location filter.md`, `research_notes/Viral store recommendations home/*`, `research_notes/Viral feed onboarding checkout reviews/viral_items_outlets.md`, `docs/specs/search.md`, `docs/specs/stores-worlds.md`, `docs/specs/orders.md`, `docs/specs/commerce-events.md`, `docs/specs/referrals.md`, ADR-0047, and code in `packages/domain/src/{ranking,recommendations,referrals}`, `apps/api/src/modules/{ranking,recommendations,stores,search,referrals}`, `apps/mobile/src/features/{worlds,stores-directory}`.

Owner constraints for this spec: **built in-house, no external AI or ML vendor, no personal data leaves Egypt.** Every algorithm below is closed-form or a small deterministic numeric routine that runs inside Postgres plus the TypeScript domain package. Nothing needs a GPU, a hosted model or a third-party API.

Labels used throughout:
- **[UNTUNED]**: a numeric parameter chosen by reasoning, not fitted on real data. Every parameter in this document carries it until §10's tuning plan has run on real Z-OUTLET data.
- **[LIT]**: the claim comes from the cited literature (full list in §13).
- **[INFERENCE]**: a design judgement with no source.
- **[REPO]**: read from this repository in this pass.
- **[VERIFY]**: could not be confirmed; listed again in §12.

---

## 0. Summary of decisions

| Concern | Options compared | Chosen | Why (2-3 lines) |
|---|---|---|---|
| Base quality score | Wilson lower bound; empirical-Bayes (EB) posterior mean; EB Beta posterior lower quantile | **EB Beta posterior 10% quantile** (Wilson kept as a cross-check) | It has Wilson's penalty for small samples but starts new entities at the category's real satisfaction rate instead of at 0. Unlike the EB mean, it does not let a brand-new store with no evidence tie established stores. It needs only an incomplete-beta inversion, which is about 40 lines of pure TypeScript. |
| Time decay | Exponential half-life; hard sliding window; Hawkes self-exciting process | **Exponential half-life, truncated at the window** | Each update is O(1) incremental and there is no cliff when an event leaves the window. The truncation keeps an honest "recently" label and bounded storage. Hawkes needs per-entity maximum-likelihood fits that are unstable at launch volumes; it stays an offline research option (§3.7). |
| Purchase crediting vs the 33-day close | Credit only at CLOSED; credit at delivery; **survival-weighted credit at delivery, finalised at close** | **Survival-weighted (Kaplan-Meier keep probability)** | CLOSED is `delivered_at + 33 d` ([REPO] `orders.close-delivered`). Credit only at close would make a 28-day "recent" score consist entirely of purchases more than a month old. The survival weight is honest about censoring, and a return pulls the credit back at once. |
| Virality K | Raw V/B; smoothed ratio; **Gamma-Poisson posterior with an EB prior** | **Gamma-Poisson posterior; rank on the 10% quantile; "most viral" needs P(top) >= 0.5** | It is conjugate, gives a closed-form interval (Wilson-Hilferty), and is consistent with the Beta treatment of quality. The P(top) rule stops the badge from being given to noise. |
| Burst detection | Robust z on winsorised counts; CUSUM; Hawkes | **Robust z (spike) + Poisson CUSUM (sustained shift)** | The two tests answer different questions: "an unusual day" and "a level shift". Both are a few lines of arithmetic, and together they give the sustained-vs-spike classification. |
| Local/global blend | Raw local rate; fixed-m shrinkage; **hierarchical Gamma-Poisson shrinkage with m fitted by method of moments** | **Hierarchical shrinkage (city to governorate to national), m by method of moments; marginal likelihood as the offline check** | Method of moments is closed form, deterministic and cheap to run every night. MML is more efficient but needs a 1-D optimiser and is noisy with few areas; it runs offline to validate m. |
| Exploration | Flat-prior Thompson (current code); UCB; **Thompson with an informative EB prior, randomised slot rounding and a hard budget** | **Informative Thompson + token bucket** | The spec mandates Thompson at no more than 5% of impressions. A flat prior overstates new items. Today's floor-based slot count gives 0 exploration slots on rails shorter than 20 ([REPO] `maxExplorationSlots`). |
| Diversity | Greedy store-run constraint (current); MMR; DPP | **MMR with hard constraints** | The spec rule (at most 2 consecutive per store) is a hard constraint, and a DPP does not guarantee it. MMR is O(kN), deterministic and explainable. A DPP needs a kernel and is O(k^2 N). |
| Collusion graph | Connected components (current); label propagation; dense subgraph | **Components on strong edges with hub pruning + Fraudar-style dense-block peeling** | Components alone over-merge through shared hubs. Label propagation is order-dependent, so it is non-deterministic. Dense-block peeling is deterministic, near-linear, and built to resist camouflage. |
| Learning-to-rank | Keep the heuristic; pointwise GBDT; **LambdaMART with monotone constraints** | **Heuristic now; LambdaMART behind the existing shadow/regression gate when the §7.6 data rule passes** | At launch there are no labels. LambdaMART reuses the repo's `TreeEnsembleRanker`, and monotone constraints keep it auditable. |

The resulting organic score for entity `e` (store, product group or outlet) in cohort `c`:

```
Score(e,c) = G(e) * Q(e) * D(e) * Mv(e) * Ml(e,c) * S(e) * (1 - delta(e))
```

| Term | Meaning | Range |
|---|---|---|
| G | hard eligibility gate (§1.6) | {0,1} |
| Q | EB Beta posterior 10% quantile of the kept share (§2) | (0,1) |
| D | ln(1 + B), log-damped volume (§2.5) | [0, inf) |
| Mv | 1 + min(K_lo, c_v), viral boost (§3) | [1, 1.5] |
| Ml | 1 + min(lambda * ln max(L,1), c_l), local lift (§4) | [1, 1.5] |
| S | stock-depth factor, items only (§1.6) | [0.8, 1] |
| delta | graded integrity discount (§6.5) | [0, 0.5] |

Cheap signals (views, saves, follows, add-to-bag, share clicks) never enter `Score`. They are tie-breaks only (§2.6).

---

## 1. Signals, entities and data contracts

### 1.1 Entities

| Entity | Id | Grouping rule | Exists today |
|---|---|---|---|
| Store | `store_id` | n/a | yes ([REPO] `stores`) |
| Product group | `product_group_id` | Offers from several sellers for the same product (GTIN/EAN exact or `product_matches.conf >= tau`, §9.2) collapse into one group. Virality is computed per group, and the Buy Box (§20.4) only picks the offer to show. An unmatched listing is its own group. | partly (`product_matches` is spec; grouping not built) |
| Outlet | `outlet_id` | A physical shop tied to a store; separate score from the online store | **no** (outlet data absent, [REPO] outlet report) |

A store's online score and its outlets' scores are never mixed (§1.5).

### 1.2 Signal tiers by cost to fake

| Tier | Signal | Use |
|---|---|---|
| T1 | Distinct verified buyer identity clusters (§6.2) with a delivered line, credited by keep probability (§1.4); returned or complained lines | `B`, `R` in Q and D |
| T1 | First purchase at the entity through another cluster's share link, line CLOSED and kept | `V` in K (§3) |
| T1 (outlets) | Redeemed signed sample-sale ticket, verified in-store purchase, signed QR check-in | `B_o` (§1.5) |
| T2 | Follows, wishlist saves, add-to-bag, share clicks, outlet directions taps | tie-break only (§2.6); propensity estimation (§5.3) |
| T3 | Raw order count, GMV, page views | **never used** |

GMV is excluded on purpose. Money-weighted popularity rewards expensive items and is easy to inflate with a few large shill orders. Wherever a money value is used as a feature (price band in §7), it is read as integer piastres (`bigint`) and converted to a float score only through `ln(piastres)`. A float is never converted back to money.

### 1.3 Input event contracts

Every event is Zod-typed in `packages/analytics` or in the outbox schema. Field names are snake_case on the wire.

| Event | Source | Exists | Key fields | Dedupe key |
|---|---|---|---|---|
| `shipment.delivered` / `seller_order.delivered` | fulfillment / orders outbox | yes | `seller_order_id`, `delivered_at_ms` (courier-confirmed) | outbox `message_id` (inbox) |
| `order_line.closed` | orders outbox | yes | `order_line_id`, `store_id`, `user_id`, `product_id`, `category_id`, `merchandise_gross` (piastres as string), `refunded_merchandise_gross`, `closed_at_ms` | `message_id`; business key `order_line_id` |
| `return.requested` | returns outbox | spec | `order_line_id`, `reason` (taxonomy §22), `requested_at_ms` | `message_id`; business key `(order_line_id, return_id)` |
| `return.cancelled` / `return.rejected` (final) | returns outbox | spec | `return_id`, `at_ms` | `message_id` |
| `dispute.upheld` (complaint) | returns / T&S | spec | `order_line_id`, `at_ms` | `message_id` |
| `share_link.created` **new** | server, on share | no | `link_id` (UUIDv7), `sharer_user_id`, `entity_type`, `entity_id`, `created_at_ms` | `link_id` |
| `share_link.opened` **new** | server, on deep-link resolve | no | `link_id`, `device_hash`, `opened_at_ms` | `(link_id, device_hash, cairo_day)` |
| `order_line.attributed` **new** | checkout, at placement | no | `order_line_id`, `link_id`, `touch_at_ms` (last qualifying open) | `order_line_id` |
| `rank_impression` **new** | server, logged when a list is served | no | `request_id`, `surface`, `cohort_level`, `cohort_id`, `entity_type`, `entity_id`, `position` (1-based), `band_id`, `exploration` bool, `policy_seed`, `params_version` | `(request_id, entity_id)` |
| `rank_view` **new** | client, `analytics` consent | no | `request_id`, `entity_id`, `visible_ms` | `(device_hash, client_event_id)` |
| `store_followed` / `store_unfollowed` **new** | server, from the `PUT /v1/me/favorite-stores` diff | no | `store_id`, `at_ms` | `message_id` |
| `outlet_checkin` **new** | server, signed ticket validated | no | `outlet_id`, `ticket_id`, `user_id`, `at_ms` | `ticket_id` |
| identity facts | auth, payments, addresses | partly | `user_id` to device hashes, payment fingerprint hashes, HMAC of normalised delivery address, `created_at`, phone verified | `(user_id, identifier)` |
| staff and owner links | sellers, payouts | partly | staff `user_id`s, payout IBAN hash, store address hash, staff device hashes | `(store_id, identifier)` |

Notes:
- `rank_impression` is written by the **server** when it serves a list. It is a record of what the platform did, not shopper behaviour, so it does not depend on client consent. It carries no user id, only `request_id`. Whether a server-side served-list log keyed to a session counts as personal data under PDPL is **[VERIFY]** (§12).
- `rank_view` (actual on-screen visibility) is client analytics and is gated on the `analytics` consent (§B1, §26). When it is missing, examination is modelled from position only (§5.3).
- Attribution rule ([INFERENCE]; no marketplace source found): **last touch within 7 days** of `share_link.opened` to order placement. The sharer's identity cluster must differ from the buyer's (§6.2). Each `(entity, buyer cluster)` pair is credited at most once for life ("first purchase at the entity"). First touch is logged for analysis only.

### 1.4 Event time, processing time, lateness and crediting

**Clocks.** Each fact has an `event_time` and an `ingested_at`.
- Server events: `event_time` is the authoritative domain timestamp (`delivered_at`, `closed_at`, `requested_at`).
- Client events: `event_time = min(client_ts, received_at)`, accepted only if `received_at - client_ts <= 72 h` [UNTUNED]. Older client events are dropped and counted in a metric.

**Batch semantics.** The nightly run at `as_of = T` (03:30 Africa/Cairo [UNTUNED], day buckets per ADR-0047) is a pure function:

```
scores(T) = f({facts : ingested_at <= T and event_time <= T}, params_version, T)
```

Decay is always computed from `event_time`, never from `ingested_at`. A late server event (for example a courier delivery confirmation that arrives 2 days late) is included in the next run with the weight its event time deserves, so results do not depend on arrival order. If the ingestion watermark lag exceeds 6 h [UNTUNED], the run is skipped and the last good lists are served (§11.5).

**Survival-weighted crediting.** A delivered line `l` of category `c`, delivered `t` days ago and not returned, contributes to `B`:

```
credit_B(l) = w(age_l) * s_c(t) * tau(u)
```

- `w(a) = 2^(-a / h)` for `0 <= a <= W`, and 0 beyond. `a` is the age in days from `delivered_at`, `h` is the half-life, and `W` the window (§2.4).
- `s_c(t) = P(kept at close | not returned by day t)`. This is a Kaplan-Meier conditional survival curve [LIT Kaplan & Meier 1958]: `s_c(t) = prod_{d=t+1..33} (1 - haz_c(d))`, where `haz_c(d)` is the daily hazard of a return request on day `d` after delivery for category `c`. It is estimated over the trailing 180 days and shrunk to the platform hazard with a Beta prior of strength 200 line-days [UNTUNED]. `s_c(33) = 1`.
- `tau(u)` is the buyer cluster's trust weight (§6.4).

When `return.requested` arrives, the line's `B` credit becomes 0 at once and it contributes `credit_R(l) = w(age_l) * rho(reason) * tau(u)`:

| Reason (§22 taxonomy) | rho [UNTUNED] |
|---|---|
| defective, not as described, wrong item | 1.0 |
| changed mind | 0.5 |
| too small / too large | 0.5 (fit, not store quality; fit has its own engine §10) |
| late | 0.5 |
| `dispute.upheld` (complaint) | 1.0, additive to any return |

If the return is cancelled or rejected and the final close shows the line kept, the `B` credit is restored. At `order_line.closed` the provisional `s_c(t)` becomes exactly 1 (kept) or the line stays in `R`. Lines that are paid or confirmed COD but **not yet delivered earn nothing**: COD refusals must never inflate a score.

**Viral credit uses CLOSED only.** `V` (§3) counts only CLOSED, kept lines. Its own window is 90 days by `closed_at` with a 30-day half-life [UNTUNED], because a share chain needs time to mature and the badge must rest on settled outcomes.

**Dedupe and unique buyers.** The credit table holds one row per `(entity_type, entity_id, cluster_pid)`, so a buyer cluster counts at most once per entity per window. The row keeps the **most recent** qualifying line, which has the largest decay weight and gives a deterministic choice. `cluster_pid = HMAC-SHA256(k_rank, cluster_root_user_id)`, where the key sits in KMS and rotates yearly with the analytics IDs (§T6). Each source message is applied once through `inbox_processed` (A2.7). Replaying the whole event log twice gives byte-identical credit tables (property P-12).

**Effective sample size caveat.** Decayed weights are used directly as Beta and Gamma pseudo-counts. With uniform ages over `[0, W]`, `W = 28`, `h = 14`: `E[w] = 0.541`, `E[w^2] = 0.338`, so `sum w` is about `0.541 n`, while Kish's effective sample size is `(sum w)^2 / sum w^2`, about `0.866 n`. Using `sum w` as the count therefore **understates** the evidence, which is the conservative direction. This is accepted and documented.

### 1.5 Outlet signals (design only; outlet data does not exist yet)

`B_o` = decayed distinct clusters with a redeemed signed ticket, a verified in-store purchase, or a signed rotating-QR check-in. Limits: one check-in per cluster per outlet per Cairo day, and one credit per cluster per outlet per window. Staff clusters are excluded. `R_o` = upheld outlet complaints. Directions taps and outlet-page visits are tie-breaks only. Distance is used only with explicit opt-in, as a coarse band computed on the device (`<2`, `2-10`, `10-30`, `30+` km [UNTUNED]); the server receives the band, never coordinates. Within a band, outlets rank by `Score`. Bands are sorted ascending only when the shopper picks "nearest". Open-now is a filter, never a boost.

### 1.6 Eligibility gate G and stock factor S

`G(e) = 0` (dropped, not "ranked low") when any of these hold: the entity is not published or is paused; the store is suspended or demoted; an active price-integrity enforcement exists (§9.5); Ops has confirmed fraud (a human decision, §6.5); or, for a product group, the shopper's size has fewer than 3 in-stock units [UNTUNED] (stock and price are rechecked from Postgres at request time, §4). For items, `S(e) = 0.8 + 0.2 * min(1, depth / 10)`, where `depth` is the in-size units of the Buy Box offer [UNTUNED]. Sponsored placements are a separate slot outside this score (§4 cap of 2 in the top 10), and ad clicks or ad-driven orders are excluded from `B`, `R` and `V`. This is consistent with [REPO] `packages/domain/src/search/sponsored.ts`.

---

## 2. Base score

### 2.1 Quantities

For entity `e`: `B` = sum of `credit_B`, `R` = sum of `credit_R`, `n = B + R`, observed kept share `p = B / n`. The prior for entity category `k` (store primary category, product category, or outlet category) is `Beta(alpha0, beta0)` with `alpha0 = mu_k * m_k` and `beta0 = (1 - mu_k) * m_k`.

### 2.2 Three options

**(a) Wilson lower bound** [LIT Wilson 1927; Evan Miller 2009]:

```
W(p, n; z) = ( p + z^2/(2n) - z * sqrt( p(1-p)/n + z^2/(4n^2) ) ) / ( 1 + z^2/n ),   W = 0 if n = 0
```

**(b) Empirical-Bayes posterior mean** [LIT Efron & Morris 1975; Casella 1985]:

```
E[p | data] = (B + alpha0) / (n + m_k)
```

**(c) EB Beta posterior lower quantile (chosen):**

```
Q = F^-1_Beta(q; B + alpha0, R + beta0),   q = 0.10 [UNTUNED]
```

### 2.3 Worked comparison

Illustrative prior `mu = 0.85`, `m = 20` (so `Beta(17, 3)`); `z = 1.96`. Values were computed with a double-precision incomplete-beta implementation (Lentz continued fraction plus bisection) in a scratch script, not repo code.

| Entity | B | R | Wilson | EB mean | **EB q10** | D = ln(1+B) | Wilson x D | **q10 x D** |
|---|---|---|---|---|---|---|---|---|
| A established | 180 | 20 | 0.8506 | 0.8955 | **0.8684** | 5.198 | 4.422 | **4.514** |
| F strong, mid | 40 | 1 | 0.8740 | 0.9344 | **0.8920** | 3.714 | 3.246 | **3.313** |
| C mid, many returns | 60 | 15 | 0.6959 | 0.8105 | **0.7579** | 4.111 | 2.861 | **3.116** |
| B new, perfect | 9 | 0 | 0.7008 | 0.8966 | **0.8209** | 2.303 | 1.614 | **1.890** |
| E tiny, perfect | 2 | 0 | 0.3424 | 0.8636 | **0.7660** | 1.099 | 0.376 | **0.841** |
| N no data | 0 | 0 | 0 | 0.8500 | **0.7435** | 0 | 0 | **0** |

What the table shows:
- **Wilson** punishes E (2 of 2 kept) down to 0.34, below C, a store with a known 20% return problem. It also has no notion of "typical for this category", so a fashion category with an 80% keep rate and one with a 95% keep rate are judged against the same zero.
- **EB mean** puts B, with 9 buyers, level with A (0.897 vs 0.896), E (0.864) close behind, and N, with no data at all, at 0.85, above C (0.81). Opening a fresh store therefore earns a near-average quality score with no evidence. That is a gaming vector (abandon a store with a bad record and open a new one), and the posterior mean is risk-neutral.
- **EB q10** keeps the order A > F > B > E > C on quality, matching intuition. A new store sits at the category prior's 10th percentile (0.74), below proven stores but above a proven bad one. Volume D then keeps new stores low overall, and exploration (§5) is what gives them exposure.

**Decision.** Use (c). Wilson stays as a monitored cross-check: if the q10 order and the Wilson order disagree on more than 20% [UNTUNED] of top-10 pairs in a cohort, an alert fires to check for prior misfit.

**Numerics (pure, deterministic).** `I_x(a,b)` is the regularised incomplete beta via the Lentz continued fraction [LIT Press et al., Numerical Recipes 3rd ed. 2007, §6.4]. `F^-1` is found by bisection on `[0,1]`, 60 iterations, which gives precision of about 1e-18 and is deterministic and branch-stable. A normal approximation is not allowed for `a + b < 50`. Results are quantised to `q_micro = round(Q * 1e6)` (integer) before any comparison.

### 2.4 Fitting the prior (mu_k, m_k)

Per category `k` with `G_k >= 5` graduated entities [UNTUNED; tutorial sources disagree between 3 and 5 groups, see the research notes]:

```
mu_k   = sum_i B_i / sum_i n_i
s2     = sum_i n_i (p_i - mu_k)^2 / N,              N = sum_i n_i
binom  = mu_k (1 - mu_k) * G_k / N                  (expected sampling part)
tau2   = s2 - binom
m_k    = mu_k (1 - mu_k) / tau2 - 1   if tau2 > 0, else m_max
m_k    = clamp(m_k, m_min = 5, m_max = 50)          [UNTUNED]
```

This is the method of moments for a Beta-Binomial, using `Var(p) = mu(1-mu)/(m+1)`. The **offline check** maximises the Beta-Binomial marginal likelihood `sum_i [ lnB(B_i + mu m, R_i + (1-mu) m) - lnB(mu m, (1-mu) m) ]` over `ln m` by golden-section search [LIT Gelman et al., BDA3 2013, ch. 5; Minka 2000]. Worked example on 8 stores `{(180,20), (60,15), (40,1), (120,30), (75,5), (300,45), (25,5), (90,10)}`: `mu = 0.8717`, `s2 = 0.002186`, `binom = 0.000876`, `tau2 = 0.001310`, **MoM m = 84.4**, **MML m = 62.2**, both clamped to 50. The clamp caps prior influence: a store with 50 real (decayed) buyers is weighted half data, half prior. If `G_k < 5`, use the parent category, then the platform (`mu`, `m = 20`).

### 2.5 Volume term and time decay

`D = ln(1 + B)`. Log damping means that **every additional unit of D costs exponentially more buyers**, the main structural defence against rich-get-richer effects and against bought volume (§6.6). An HN-style `(hours + 2)^-g` age penalty [LIT righto.com on HN] was rejected because it decays items rather than evidence and mixes freshness into quality.

Decay options:

| Option | Behaviour | Cost | Verdict |
|---|---|---|---|
| Exponential half-life `h` | smooth; `S(t) = S(t0) * 2^(-(t-t0)/h) + w_new` updates in O(1) | one float per entity | **chosen**, truncated at `W` |
| Sliding window `W` | honest "last W days" label; cliff when a big day exits | per-day buckets | used only if the owner picks a "this week" label (§10.3) |
| Hawkes self-exciting [LIT Hawkes 1971] | separates baseline from triggered events | per-entity MLE, unstable at low counts | offline research (§3.7) |

Defaults: `W = 28 d`, `h = 14 d` for `B` and `R`. The 7-day versus 14-day half-life is an open tuning question from the earlier reports [UNTUNED]. A 28-day decayed score **must not be labelled "this week"**; the label is "recently" (§11.4).

### 2.6 Tie-breaks

Scores are compared on `score_micro = round(Score * 1e6)` (int64). Ties break, in order, on: (1) T2 momentum bucket, `floor(log2(1 + net_follows_28d + saves_28d))`, which is bounded and coarse, so cheap signals can only reorder equals; (2) larger `V`; (3) `entity_id` ascending. The result is a total order, so sorting is deterministic.

---

## 3. Virality

### 3.1 Per-entity K and its posterior

Per entity, over the viral window (90 d by `closed_at`, `h_v = 30 d`):
- `Bc` = decayed distinct clusters with a CLOSED, kept line (closed-only, unlike `B`).
- `V` = decayed distinct clusters whose **first** CLOSED kept purchase at the entity was attributed (§1.3) to a share link of that entity from another cluster.
- Per-sharer cap: one sharer cluster gets at most 3 credited conversions per entity per window [UNTUNED]. This bounds overdispersion and broadcast farming.

`K = V / Bc` is first-generation qualified offspring per qualified buyer: Andrew Chen's invites x conversion, measured only on outcomes that survived the return window [LIT Chen; per-store adaptation is INFERENCE]. Model: `V | K ~ Poisson(K * Bc)`, prior `K ~ Gamma(shape = a_v * k0, rate = a_v)`:

```
K | data ~ Gamma(shape = V + a_v k0, rate = Bc + a_v)
K_mean  = (V + a_v k0) / (Bc + a_v)           (equals the earlier reports' smoothed K~)
K_lo    = Gamma quantile at q = 0.10           (used in Mv)
```

`k0` is the platform K, fitted nightly as `sum V / sum Bc` over graduated entities. `a_v` is fitted by the Poisson-Gamma method of moments (§4.3 formula, with entities as groups) and clamped to `[10, 200]`. The fallback is `a_v = 20`, `k0 = 0.10` [UNTUNED].

Quantile numerics: Wilson-Hilferty [LIT Wilson & Hilferty 1931]: `F^-1(q) = (shape/rate) * (1 - 1/(9 shape) + z_q * sqrt(1/(9 shape)))^3`, with `z_0.10 = -1.2815515655`. For `shape < 5`, use bisection on the regularised lower incomplete gamma (series or continued fraction, Numerical Recipes §6.2). In the worked cases below the approximation error is under 1e-4.

**Worked example** (`k0 = 0.10`, `a_v = 20`, so prior `Gamma(2, 20)`):

| Store | V | Bc | raw K | K_mean | K_lo (q10) | 80% interval | 95% interval |
|---|---|---|---|---|---|---|---|
| A | 18 | 180 | 0.100 | 0.1000 | 0.0726 | [0.073, 0.130] | [0.061, 0.148] |
| C | 12 | 60 | 0.200 | 0.1750 | 0.1184 | [0.118, 0.237] | [0.096, 0.278] |
| B | 3 | 9 | 0.333 | 0.1724 | 0.0839 | [0.084, 0.276] | [0.056, 0.353] |
| G | 30 | 120 | 0.250 | 0.2286 | **0.1786** | [0.179, 0.282] | [0.156, 0.314] |
| H | 9 | 35 | 0.257 | 0.2000 | 0.1276 | [0.128, 0.280] | [0.100, 0.334] |

`Mv = 1 + min(K_lo, c_v)` with `c_v = 0.5` [UNTUNED], so virality is a bounded boost, not the driver. Ranking on `K_lo` rather than `K_mean` means B's 1-in-3 raw rate (n = 9) is worth less than C's steadier 12-in-60.

**Final store scores** (combining §2.3 q10 and D with `Mv`; `delta = 0`): A `0.8684 x 5.198 x 1.0726 = 4.842`, C `0.7579 x 4.111 x 1.1184 = 3.485`, B `0.8209 x 2.303 x 1.0839 = 2.049`. The order is A > C > B, the same as the earlier reports, now with uncertainty handled consistently.

### 3.2 Cascades, depth and branching ratio

Build a referral forest per entity from attribution edges `sharer_cluster -> buyer_cluster` (credited edges only). Roots are non-attributed buyers; generation `g` is the depth from the root.
- **Cascade depth** = max `g` in a tree.
- **Structural virality** `nu(T)` = mean shortest-path distance over all node pairs of tree `T` (the Wiener index divided by `n(n-1)`) [LIT Goel, Anderson, Hofman & Watts 2016]. It separates broadcast from person-to-person spread. For 7 nodes: a star (one sharer, six buyers) gives `nu = 1.714`; a chain gives `nu = 2.667`. Only trees with `n >= 5` are reported. Most cascades are tiny and the size distribution is heavy-tailed [LIT Goel, Watts & Goldstein 2012], so per-entity medians, not means, are reported.
- **Branching ratio** (Galton-Watson offspring mean across generations), Harris-type estimator [LIT Harris 1948; Guttorp 1991; attribution of the MLE form is VERIFY]:

```
R_hat = sum_{g>=1} Z_g / sum_{g=0..G-1} Z_g^mature
```

`Z_g` counts nodes at generation `g`. `Z_g^mature` excludes nodes whose sharing opportunity (30 days after their own close [UNTUNED]) has not elapsed, which handles right-censoring. Example: `Z = (50, 8, 3, 1)`, all mature, gives `R_hat = 12/61 = 0.197`. `K` is the generation-0 special case. `R_hat >= 1` means supercritical, which is rare and usually temporary [LIT Chen; LaunchList guide]. `R_hat`, depth and `nu` are **diagnostics and badge gates**, not score multipliers, because they are noisy at small n.

### 3.3 Burst detection on daily counts

Series: `x_t` = daily credited `B` mass (survival-weighted) per entity per Cairo day, before winsorising. Baseline over the trailing 28 days, excluding the last 7: `med`, `MAD`, `sigma = max(1.4826 * MAD, sqrt(med), 1)`. The Poisson floor `sqrt(med)` stops sparse series from alarming on every unit [LIT Rousseeuw & Croux 1993 for MAD; floor is INFERENCE].

- **Spike (robust z):** `z_t = (x_t - med) / sigma`; spike if `z_t >= 4` [UNTUNED].
- **Sustained shift (Poisson CUSUM)** [LIT Page 1954; Lucas 1985 for counted data]: in-control mean `mu0 = med`, out-of-control `mu1 = 2 mu0` [UNTUNED]; reference `k = (mu1 - mu0) / ln(mu1/mu0)`; `S_t = max(0, S_{t-1} + x_t - k)`; alarm when `S_t > h_c`, with `h_c = 4 sigma` [UNTUNED]. After an alarm, reset `S = 0` once `z_t < 1` for 3 consecutive days.

Worked example, `x = 4,5,3,6,4,5,4,5,4,6,5,4 | 9,11,12,10,13,12 | 5,4`. Baseline `med = 4.5`, `MAD = 0.5`, `sigma = max(0.74, 2.12, 1) = 2.12`. Robust z on days 13-18 is `2.12, 3.06, 3.54, 2.59, 4.01, 3.54`, so only day 17 counts as a spike. Poisson CUSUM with `k = 6.49` gives `S = 2.5, 7.0, 12.5, 16.0, 22.5, 28.1`, so it alarms on day 14 (`> 8.5`). The robust z test would have called this mostly "normal days"; CUSUM correctly calls it a level shift.

### 3.4 Sustained vs spike classification

Over the last 14 days, for an entity whose CUSUM is in alarm or which has a spike day:
- `peak_frac = max_t x_t / sum x_t`
- `afterglow = mean(x_{peak+1..peak+3}) / x_peak`
- `organic = share of V in the window from generation >= 2` (only when `V >= 5`)

| Class | Rule [UNTUNED] | Effect |
|---|---|---|
| **Sustained (endogenous)** | CUSUM alarm on >= 5 of the last 7 days, `peak_frac <= 0.35` | eligible for the "Rising" rail (§3.5) |
| **Exogenous spike** | `peak_frac > 0.5` and `afterglow < 0.25` | no rail boost; excess above the winsor cap (§6.6) is held at half credit until close |
| **Suspicious spike** | exogenous spike **and** (flagged-credit share > 0.2 **or** new-account share > 0.5) | integrity review queue, graded discount (§6.5) |

Rationale: endogenous (word-of-mouth) bursts build and relax slowly, while exogenous shocks jump and decay fast [LIT Crane & Sornette 2008, YouTube views]. Their power-law relaxation exponents are not used here because the series are far too short; only the shape contrast is borrowed [INFERENCE].

### 3.5 "Rising" (momentum) surface

For sustained entities, rank by the lower 80% bound of the recent-to-baseline rate ratio, `r = (x7/7) / (x21/21)` (last 7 days against the prior 21):

```
r_lo = exp( ln r - 1.2816 * sqrt(1/x7 + 1/x21) )      (delta-method log-ratio, Poisson counts)
```

Examples: `x7 = 63, x21 = 84` gives `r = 2.25`, `r_lo = 1.82`; `x7 = 6, x21 = 6` gives `r = 3.0`, `r_lo = 1.43`, so the small entity is correctly discounted. Eligibility: `r_lo >= 1.25`, `x7 >= 10`, G and integrity clear [UNTUNED]. The label is "Rising lately" and never states a multiple or a count.

### 3.6 "Most viral" with uncertainty

Candidates: entities with `Bc >= 30` (undecayed distinct clusters), a return share `R/(B+R)` below the category's 90th percentile, integrity clear (`delta = 0`, no open review), top-sharer share of `V <= 0.5`, and `V >= 5` [UNTUNED].

1. Rank candidates by `K_lo`.
2. Compute `P(top)` for the top 5 by Monte Carlo from their Gamma posteriors: 20,000 draws, Marsaglia-Tsang sampler [LIT Marsaglia & Tsang 2000], fixed seed `= hash(as_of, surface, cohort)`, so the result is reproducible.
3. **Award "most viral" only if the leader's `P(top) >= 0.5`.** Otherwise there is no single winner. The surface may show "Among the most shared" for the set whose 80% upper bound reaches the leader's `K_lo`.

Worked example (stores A, C, G, H above; seed 42, 200,000 draws): `P(top)` is G 0.575, H 0.294, C 0.130, A 0.000. G is awarded. K itself is never shown to shoppers (§16 truthful-social-proof rule).

### 3.7 Rejected or deferred: Hawkes

A univariate Hawkes process `lambda(t) = mu + sum_{t_i < t} phi(t - t_i)`, with branching ratio `n* = integral phi` [LIT Hawkes 1971; Zhao et al. 2015 SEISMIC], could estimate "dark-social" virality: word of mouth with no link, such as WhatsApp screenshots, which link attribution misses. It is rejected for launch because per-entity MLE with tens of events is poorly identified, it needs iterative optimisation that is hard to make deterministic, and it adds no defence against gaming. **Deferred:** an offline quarterly study at platform and category level only, comparing Hawkes `n*` with link-based `R_hat` to size the attribution gap.

---

## 4. Local and global blending

### 4.1 Levels and areas

Levels: L0 national (Egypt), L1 governorate (27, `coverage_governorates`), L2 city or district (`coverage_cities`, the repo's second level), L3 neighbourhood or compound (**not modelled**; the outlet report flags it as unverified). A buyer's area for a credit is the **delivery area code of the credited order** (governorate and city codes only, never the street). This is chosen over the profile's chosen area because it is tied to a real delivery and is harder to fake. Whether the ranking purpose is compatible with the purpose for which the delivery address was collected is **[VERIFY]** for the DPIA.

### 4.2 Estimator (hierarchical Gamma-Poisson shrinkage)

For entity `e` and area `a` with parent `P(a)`: `B_{e,a}` = credited buyer mass of `e` in `a`; `N_a` = decayed distinct active buyer clusters (any purchase) in `a`. The rate is buyers of `e` per active buyer. Model `B_{e,a} ~ Poisson(N_a theta_{e,a})` and `theta_{e,a} ~ Gamma(m_l theta_{e,P}, m_l)`:

```
theta_n      = B_{e,n} / N_n
theta_{e,g}  = (B_{e,g} + m_1 theta_n)      / (N_g + m_1)
theta_{e,d}  = (B_{e,d} + m_2 theta_{e,g})  / (N_d + m_2)
L(e,c)       = theta_{e,c} / theta_n
Ml(e,c)      = 1 + min( lambda * ln max(L, 1), c_l ),   lambda = 0.1, c_l = 0.5   [UNTUNED]
```

Local lift can only promote (`max(L,1)`), so the national order stays the safe floor. The rate is per active buyer, so big areas do not win on volume alone. Limits (property P-5): `N_a -> inf` gives the raw local rate; `N_a = 0` or `m -> inf` gives the parent; `m -> 0` gives the raw local rate.

### 4.3 Choosing m from data

Per level `l` and category `k`, pooled over entities `e` in `k` and child areas `a`:

```
1/m_l = sum_{e,a} [ (B_{e,a} - N_a theta_{e,P})^2 - N_a theta_{e,P} ]  /  sum_{e,a} N_a^2 theta_{e,P}
```

This is the method of moments from `E[(B - N theta_P)^2] = N theta_P + N^2 theta_P / m`, the negative-binomial overdispersion. If the numerator is `<= 0` (no heterogeneity beyond Poisson), `m_l = m_max`, meaning full pooling to the parent. Clamp `m in [5, 500]` [UNTUNED]. A single item's `m` is never fitted, because that is too noisy. **Offline check:** maximise the negative-binomial marginal log likelihood `sum [lnGamma(B + r) - lnGamma(r) - lnGamma(B+1) + r ln(m/(m+N)) + B ln(N/(m+N))]`, with `r = m theta_P`, over `ln m` by golden-section. Alert if MoM and MML differ by more than a factor of 3 [UNTUNED].

### 4.4 Worked example (Sheikh Zayed / 6th of October city in Giza; reproduces and extends the part-A report)

`N_n = 100,000`, `N_g = 6,000`, `N_d = 400`; X is a niche local favourite and Y a national bestseller.

| | X, m = 20 | Y, m = 20 | X, m = 50 | Y, m = 50 |
|---|---|---|---|---|
| B national / Giza / city | 200 / 70 / 12 | 400 / 40 / 1 | same | same |
| theta_n | 0.00200 | 0.00400 | 0.00200 | 0.00400 |
| theta_g | 0.011635 | 0.006658 | 0.011587 | 0.006645 |
| theta_d | 0.029125 | 0.002698 | 0.027954 | 0.002961 |
| L | 14.56 | 0.67 | 13.98 | 0.74 |
| Ml | **1.268** | 1.000 | **1.264** | 1.000 |

With national scores X 5.04 and Y 5.80, the city scores are X `5.04 x 1.268 = 6.39` and Y 5.80, so the order flips locally only. If the city fails the floor (§4.5) and the governorate is used, X's `L = 5.82`, `Ml = 1.176`, score 5.93; Y's `L = 1.66`, `Ml = 1.051`, score 6.10, so Y stays ahead at governorate level. The ranking is not sensitive to m in this range.

### 4.5 Minimum cohorts and the privacy floor

- **Cohort floor:** a cohort list at level `l` for area `a` is published only if `N_a^undecayed >= 50` distinct shopper clusters (`K_ANONYMITY_MIN = 50`, [REPO] `packages/domain/src/sizing/demand.ts`; reuse the constant, never redefine it).
- **Entity floor:** entity `e` uses its own `theta_{e,a}` only if it has `>= 20` distinct purchaser clusters in `a` (undecayed). Otherwise `theta_{e,a} := theta_{e,P(a)}`, inherited from the parent.
- **Label level:** the deepest level at which at least 3 of the first 6 displayed entities pass the entity floor [UNTUNED]. A city label never appears over governorate data.
- **Ladder:** city, governorate, national, then the non-personalised list. The optional `shop_for` dimension, if counsel clears it, is dropped before geography.
- **Output:** ranks and a cohort level only. No counts, scores or rates leave the server. Cohorts form a strict tree (no ad-hoc cohorts), which blunts differencing; publishing only ranks blunts it further. A Laplace-noise differential-privacy release [LIT Dwork et al. 2006] was considered and rejected for launch, because rank lists over a fixed tree with `k >= 50` already release very little and noise would make lists unstable day to day. It can be revisited if counts are ever shown.
- **Sum-to-total:** areas partition their parent. Buyers with no city code go to an `unassigned` child that is counted at the parent and never published, so `sum_children N = N_parent` exactly (property P-7).

---

## 5. Exploration, position bias and fairness

### 5.1 Pool and informative Thompson prior

Pool: entities passing G with `n < 30` (undecayed `B + R` clusters) or live for fewer than 14 days [UNTUNED], plus Seller Health and price-trust gates (§19, §9). Arm reward rate `theta` = kept-purchase probability per **examined** impression.

- Prior `Beta(mu0 n0, (1 - mu0) n0)`. `mu0` comes from an EB regression of graduated entities' first-30-day reward rate on non-behavioural attributes: category, `ln(median price piastres)` band, KYC verified, catalogue-quality score, price-trust bucket. The fit is a cell-mean table with hierarchical shrinkage (no ML vendor) [LIT Amazon EB cold start, CIKM 2022, via the research notes; Roblox Dynamic Prior TS, arXiv 2602.00943]. `n0` comes from the MoM across graduated entities, clamped to `[20, 2000]` examined impressions [UNTUNED].
- Posterior: `Beta(alpha0 + sum r, beta0 + sum ex - sum r)`, where `ex = sum theta_pos` (examination probability of each impression, §5.3) and `r` is the fractional reward. A placed order attributed to the impression within 24 h contributes `s_c(0) * tau(u)` (§1.4). The reward is corrected at close: `+ (1 - s_c(0))` if kept, `-s_c(0)` if returned.
- **Delayed feedback:** only impressions older than 24 h ("matured") update the posterior, which avoids the downward bias from pending rewards.
- Sampler: exact Beta via two Marsaglia-Tsang gamma draws. The current `sampleBeta` downscales counts to 60 or fewer and only handles integer shapes ([REPO] `recommendations/ranking.ts`), which overstates the variance of mature arms and cannot take fractional rewards. Replace it.
- Click rewards (current code) are replaced by kept-purchase rewards. Clicks are a cheap signal.

[LIT Thompson 1933; Chapelle & Li 2011; Russo et al. 2018 tutorial.] UCB was rejected: it is deterministic, and therefore predictable and easier to game ("what do I need to be picked next"), and it does not randomise positions naturally.

### 5.2 Enforcing the 5% cap

Spec §20.5: exploration takes at most 5% of impressions.
- Per request: `e = cap * L_list`; `slots = floor(e) + Bernoulli(e - floor(e))`, drawn from the request-seeded RNG. A 10-card rail gets 1 slot with probability 0.5, so the expected share is exactly `cap`. Today `maxExplorationSlots(10) = 0`, so short rails **never** explore ([REPO]).
- Hard guard: a token bucket per `(surface, cohort)` refilled at `cap x` the served impressions of the trailing hour. Empty bucket means 0 slots. The realised share can never exceed `cap` beyond one bucket's slack.
- Per entity: at most 1% of the surface-cohort's daily impressions [UNTUNED].
- Slot position: drawn uniformly from positions `3..L` (never position 1) and logged, with its propensity, in `rank_impression`.
- Bots (`bot_score >= 700` permille, [REPO] `BOT_SCORE_THRESHOLD_PERMILLE`) get no exploration, and their impressions are not counted as evidence.
- Graduation: `n >= 30` and live for at least 14 days; the entity then competes on `Score`.

### 5.3 Position bias (examination model)

Examination hypothesis [LIT Craswell et al. 2008; Joachims et al. 2017]: `P(interact | e, k) = theta_k * gamma_e`. Today `positionPropensity` is a fixed `1/(1 + 0.5(k-1))` ([REPO] `ranking/eval.ts`); it is a placeholder and must be estimated.

**Estimation by intervention harvesting** [LIT Agarwal et al. 2019]. The band shuffle (§5.4) moves the same entity across positions at random for the same cohort and day. Over pairs `(e, k)` and `(e, 1)` with at least 20 impressions each:

```
theta_k / theta_1 = sum_e h_e * (c_{e,k} / n_{e,k})  /  sum_e h_e * (c_{e,1} / n_{e,1}),     h_e = 2 / (1/n_{e,k} + 1/n_{e,1})
```

`c` = opens (store page or PDP). Cheap signals are fine **for propensity estimation only**. Fit separately per surface type (vertical feed, horizontal rail) and per screen-width bucket. In horizontal rails, slots beyond about 2.5 visible cards need a scroll, so expect a step drop; this is [INFERENCE] to be measured. Then enforce monotone non-increasing `theta_k` by isotonic regression (pool-adjacent-violators). A swap experiment (swap positions 1 and k on 1% of traffic [LIT Joachims et al. 2017; Wang et al. 2018]) is the fallback if harvesting has too little overlap.

**Use.** IPS weight `1/theta_k`, clipped at 10 (as in the current `ipsWeight`), self-normalised [LIT Swaminathan & Joachims 2015], in exposure-normalised conversion for LTR labels (§7) and for counterfactual evaluation. Position bias **does not enter the heuristic Score**, which uses purchases, not clicks.

### 5.4 Diversity re-rank (MMR with hard constraints)

Input: candidates sorted by `score_micro`, top `N = 200`.
1. **Band shuffle:** consecutive candidates whose scores lie within 10% of the band head [UNTUNED] form a band. Shuffle each band with the request-seeded RNG and log `band_id` and `band_size`. This damps position bias and is the randomisation source for §5.3.
2. **Greedy MMR** [LIT Carbonell & Goldstein 1998]: `next = argmax_{e in C\S} [ lambda_d * s_e - (1 - lambda_d) * max_{j in S} sim(e, j) ]`, with `s_e = score_e / score_max`, `lambda_d = 0.8` [UNTUNED], and `sim = 1` (same store), `0.5` (same category), `0.25` (same price band), `0` otherwise. Taking the max over components gives a hand-built similarity; embeddings can replace it later.
3. **Hard constraints, checked before accepting each pick; skip to the next best if violated:**
   - H1, items: at most 2 consecutive from the same store (spec §20.5; already in `diversify`).
   - H2: at most 3 of the same category in any top 10.
   - H3, store rails: at most 2 consecutive stores with the same primary category.
   - H4: sponsored slots are inserted afterwards, at most 2 in the top 10 ([REPO] `sponsored.ts`).
   When a constraint cannot be met (for example only one store is left), it relaxes in the order H3, H2, H1, the same as today's "run is unavoidable" behaviour.

DPP [LIT Kulesza & Taskar 2012; Chen, Zhang & Zhou 2018] was rejected: it needs a positive semidefinite kernel and embeddings, costs O(k^2 N), does not guarantee H1, and its behaviour is hard to explain in a "Why this?" sheet.

**Logged propensities.** Because shuffling, MMR and exploration interact, the propensity of an `(entity, position)` pair is obtained by **policy replay**: the offline job re-runs the deterministic policy with 1,000 seeds on the logged candidate set and counts frequencies. This is exact up to Monte Carlo error, with no closed form needed.

### 5.5 Rich-get-richer controls

1. Log volume `D` (§2.5).
2. **Exposure cap:** if an entity's share of a surface-cohort's trailing-24h impressions exceeds `c_exp = 10%` [UNTUNED], multiply its score by `c_exp / share` for the next build.
3. Exploration (§5.1-5.2).
4. **Exposure-fairness monitor** [LIT Singh & Joachims 2018]: per merit decile (by `Q x D`), the ratio of exposure share to merit share. Alert when the top decile's ratio exceeds 2.0 or the bottom 50%'s falls below 0.5 [UNTUNED].
5. **Gini of impressions** per surface-cohort-day, with an alert on a 7-day upward trend of more than 0.05 [UNTUNED].

Popularity bias and its long-tail harm are well documented [LIT Klimashevskaia et al. survey; Abdollahpouri et al. 2017], but most mitigation evidence is offline, so the effect must be measured online.

---

## 6. Anti-gaming

### 6.1 Threat model (abridged STRIDE: Tampering and Spoofing of popularity)

| Attack | Mechanism | Primary control |
|---|---|---|
| Brushing / self-buying | seller's or friends' accounts buy | staff-link exclusion (§6.3), clusters (§6.2), real delivered and kept orders |
| Refund ring | buy, gain credit, return | credit removed at `return.requested`; returns raise `R`, which lowers Q |
| Sybil accounts | many fresh accounts | one phone per account, identity clusters, new-account weight, per-cluster global cap |
| Share ring | A shares to B shares to C, all controlled | cluster-disjoint edges, per-sharer cap, ring detection, closed-only V |
| Camouflage | shills also buy from popular stores | Fraudar column weighting (§6.3) |
| Burst timing | concentrated shill day before a mega event | winsorising (§6.6), spike classification (§3.4) |
| COD refusal farming | place COD, refuse | undelivered lines earn nothing (§1.4) |
| Bot traffic | inflate impressions or opens | opens never score; bots excluded from bandit evidence |

### 6.2 Identity graph and clusters

Nodes are users and identifiers. Strong edges: `device_hash`, `payment_fp_hash`. Medium: `address_hash` (HMAC of the normalised delivery address). Weak, never unioned: `ip_prefix_hash`. Phone is one per account by rule (§1).
- **Hub pruning:** an identifier shared by more than `H` users (`device > 5`, `payment_fp > 3`, `address > 8` [UNTUNED]) is not used for union. It is likely shared or public (office, dorm, family tablet). It is itself flagged as a hub for review. Today `linkUsersByIdentifiers` has no hub pruning ([REPO] `referrals/fraud.ts`), so one shared tablet can merge hundreds of honest users.
- **Clusters:** union-find (reuse `UnionFind`) over strong edges plus address edges, where an address edge only unions if the two users also share a strong edge or an IP prefix within 7 days [UNTUNED]. This stops families sharing an address from being merged on that alone.
- Credits are per cluster (§1.4). A sybil farm sharing devices or cards collapses to one buyer.

### 6.3 Dense-block detection (brushing rings)

Bipartite graph: clusters x entities, with edge weight = credited mass. Per Fraudar [LIT Hooi et al. 2016], column-weight edges by `1 / ln(deg(entity) + 5)`, so popular entities (camouflage targets) contribute little. Greedy peeling [LIT Charikar 2000]: repeatedly remove the node with the smallest weighted incident mass, track the density `f(S)/|S|`, and keep the densest subgraph. Remove it and repeat up to 10 blocks per night [UNTUNED]. Tie-break is by node id, so the run is deterministic and O(E log V).

A block is **flagged** when its density exceeds the 99.9th percentile of 50 degree-preserving shuffles (configuration-model null, fixed seeds) **and** it has at least 5 clusters and at most 3 entities [UNTUNED].

Label propagation [LIT Raghavan et al. 2007] was rejected: its result depends on update order and random tie-breaks, which conflicts with the determinism requirement.

**Staff link (hard rule):** a cluster sharing any identifier with the store's staff, owner, payout IBAN hash or store address hash gets weight 0 **for that store only**.

**Share rings:** an attribution edge is dropped if sharer and buyer are in the same cluster, if a 2-cycle or 3-cycle of attributions exists among the clusters within 90 days, or if the edge lies inside a flagged block.

### 6.4 Buyer trust weight

```
tau(u) = tau_age * tau_block * tau_bot
tau_age   = min(1, 0.5 + 0.5 * account_age_days / 7)                 [UNTUNED]
tau_block = 0.2 if the cluster is in a flagged block, else 1          [UNTUNED]
tau_bot   = 0   if the order's session bot score >= 700 permille, else 1
```

**Per-cluster global cap:** if a cluster's total credit mass across all entities of one type in the window is `M > C_max = 8` [UNTUNED], scale all its credits by `C_max / M` (mass-preserving). This stops one professional shill account from touching many stores.

Caution: trust-weighting less-established users has been found to filter them disproportionately [LIT Auditing Yelp, arXiv 2308.02129]. `tau_age` therefore recovers fully within 7 days and never goes below 0.5 for humans.

### 6.5 Graceful degradation: discount, not instant penalty

Per entity: `f = flagged mass share = sum_{u flagged} credit(u) / sum_u credit(u)`, computed **before** trust weighting. "Flagged" means in a flagged block, a hub-linked cluster, or a suspicious spike.

```
delta(e) = min( delta_max, kappa * max(0, f - f0) ),   f0 = 0.05, kappa = 1, delta_max = 0.5   [UNTUNED]
```

The discount grows linearly and decays naturally as flagged credits age out of the window. A review-queue item opens when `f > 0.2`. Hard exclusion (`G = 0`) requires an Ops decision (§9.5 human review for suspensions) or a §9 price-integrity enforcement. The algorithm never suspends anyone. Sellers can appeal under the §9.5 flow. Example: store A with `f = 0.25` gives `delta = 0.20`, so its score goes from 4.842 to 3.873.

### 6.6 Outlier clipping and quarantine

Daily credited mass `x_t` is winsorised at `cap_t = med_28 + 6 * max(1.4826 MAD_28, sqrt(med_28), 1)` [UNTUNED]. The excess `x_t - cap_t` is not discarded: it is credited at 50% until those lines close, then credited in full if their clusters are still unflagged. Real viral bursts lose some speed but not their credit; shill bursts lose most of it.

### 6.7 Cost of attack (why log volume plus real orders resists sybils)

To overtake a competitor whose score is `rho` times higher using shill buyers alone (Q and Mv fixed), a store with `B` kept buyers needs `ln(1 + B + dB) >= rho * ln(1 + B)`, which gives `dB = (1+B)^rho - 1 - B`. For `B = 60`: `rho = 1.1` needs 31, `rho = 1.2` needs 78, and `rho = 1.5` needs 415 new **distinct identity clusters**. Each needs a verified phone, a distinct device, card and address, a real paid order that is courier-delivered with OTP or photo proof (§21), and the item kept for 33 days. With `tau_age = 0.5` for fresh accounts the numbers double (62 / 156 / 831). This follows from the formula; it is not a measured result [INFERENCE]. Sybil resistance ultimately rests on the cost of identities [LIT Douceur 2002].

### 6.8 Adversarial simulation (required test suite, `popularity.adversarial`)

Run on the synthetic generator (§8.1) with fixed seeds. Each scenario reports the **rank lift per 1,000 EGP of attacker spend** (spend in piastres, integer), detection precision and recall, and the honest false-positive rate.

| # | Scenario | Pass criterion [UNTUNED] |
|---|---|---|
| A1 | Brushing ring: 20 accounts, shared 3 devices, 40 orders to one store | target's rank lift <= 2 positions; block flagged |
| A2 | Distinct-identity sybils: 50 fresh accounts, distinct device, card and address, same IP /24, all kept | lift bounded by §6.7 (+-10%); `tau_age` applied |
| A3 | Refund ring: 30 buyers, all return on day 12 | target's score after 14 days <= score before the attack |
| A4 | Share ring A to B to C to A, 10 clusters | V contribution 0 |
| A5 | Camouflage: A1 plus each shill buys 3 items from top-10 stores | target still flagged; top-10 stores' delta = 0 |
| A6 | Burst before White Friday: 200 shill buyers in 48 h | classified as a suspicious spike; at least 50% of excess quarantined |
| A7 | Influencer broadcast (honest): one sharer, 60 real converts | not flagged; `nu < 2` (broadcast); per-sharer cap limits V to 3 |
| A8 | Honest viral chain, R = 0.6 | "sustained" classification; most-viral recovered with P(top) >= 0.5 |
| A9 | Shared family tablet: 6 honest relatives | hub pruned; no discount |
| A10 | COD refusal farm: 40 COD orders refused | zero credit |

Global pass: honest entities' mean `delta < 0.01`; honest false-positive flag rate < 1%; detection recall >= 0.8 on A1, A5 and A6.

---

## 7. Later learning-to-rank path

### 7.1 Model

LambdaMART [LIT Burges 2010], gradient-boosted trees with a lambda gradient for NDCG@10, trained in-house. LightGBM [LIT Ke et al. 2017] is open-source and run locally, not a vendor API; no data leaves the region. The trained trees are exported as data and served by the repo's `TreeEnsembleRanker` ([REPO] `packages/domain/src/ranking/model.ts`), keeping serving pure and deterministic.

### 7.2 Features (extends `RANKING_FEATURE_NAMES`; budget and measurement features stay forbidden by `forbiddenFeatureKeys`)

| Feature | Monotone constraint |
|---|---|
| `q_micro` (§2) | + |
| `ln1p_B` | + |
| `k_lo` | + |
| `local_lift_ln` (non-personalised mode: 0) | + |
| `verified_discount_pct` (only when `claimAllowed`) | + |
| `seller_health`, `price_trust` | + |
| `return_rate_permille` | - |
| `delta_bps` (integrity discount) | - |
| `freshness`, `in_stock`, `size_available`, `is_new_seller` | none |
| `ln_price_piastres_band` | none |
| `category_affinity`, `store_affinity` (only when `personalized=true`) | + |
| `exposure_share_24h` | none |

Monotone constraints keep the model consistent with the heuristic's promises (more kept buyers never hurts; more returns never helps) and auditable by partial-dependence checks.

### 7.3 Labels

The query group is a served request (`request_id`). Graded relevance per shown entity, read at close (labels mature 33 days after delivery):

| Outcome | rel | sample weight |
|---|---|---|
| attributed purchase, closed and kept | 3 | 1 |
| kept with partial return | 2 | 1 |
| changed-mind or size return | 1 | 1 |
| no purchase, or defect / not-as-described return, or upheld complaint | 0 | 2 if defect or complaint, else 1 |

Clicks are not labels. Debiasing: per-row weight `w_IPS = min(10, 1/theta_pos)`, self-normalised per query [LIT Joachims et al. 2017; Wang et al. 2018; Hu et al. 2019 Unbiased LambdaMART]. Bot requests are dropped (`dropBotImpressions`). Features are computed point-in-time (as of the request's `params_version`), so there is no leakage.

### 7.4 Counterfactual evaluation

Self-normalised IPS over the logged stochastic policy with policy-replay propensities (§5.4) [LIT Swaminathan & Joachims 2015], using the position-based (item-position) estimator to limit variance [LIT Li et al. 2018]. Valid only within the logging policy's support: band shuffles and exploration slots. A candidate whose rankings fall outside support (for example reordering across bands) is judged by interleaving, not OPE.

### 7.5 Online: interleaving then A/B

Team-draft interleaving [LIT Radlinski, Kurup & Joachims 2008; Chapelle et al. 2012] on 5% of traffic, with credit from **kept-purchase attribution**, not clicks. Decide by a sign test on per-query preferences at alpha 0.05. Then an A/B with the existing guardrails (`evaluateGuardrails`: return-rate +100 bps, complaint +30 bps, minimum 500 orders per arm), plus SRM, Gini of impressions and new-store sell-through [LIT Kohavi, Tang & Xu 2020].

### 7.6 When LTR may replace the heuristic

No source gives a crossover volume for marketplace LTR versus a heuristic **[VERIFY]**. The rule is empirical:
1. First training attempt when at least 20,000 closed attributed purchases and at least 1,000,000 logged impressions with propensities exist [UNTUNED; order-of-magnitude guess].
2. Learning curve: train on 10%, 20%, ..., 100% of a time-ordered training set and evaluate on the most recent 4 weeks.
3. Promote to shadow (existing `compareShadow`) when the lower 95% bootstrap bound of `NDCG@10(LTR) - NDCG@10(heuristic)` is at least 0.01 on **3 consecutive monthly retrains**, and `checkRegression` passes.
4. Promote to traffic only after interleaving wins (§7.5) and the A/B passes its guardrails. The heuristic stays the fallback and the `personalized=false` ranker.

My expectation, unverified, is a crossover between 10^4 and 10^5 purchases.

---

## 8. Offline evaluation

### 8.1 Synthetic data generator spec (`popularity/synthetic.ts`, seeded mulberry32 as in `seededRng`)

| Component | Model [all UNTUNED] |
|---|---|
| Stores | `S = 400`; base demand `d_s ~ Zipf(s = 1.1)` over ranks (power law; fit checks per [LIT Clauset, Shalizi & Newman 2009]); quality `q_s ~ Beta(17, 3)`; return prob `1 - q_s`, split 50% changed mind, 25% size, 25% defect |
| Items | 20-400 per store (log-uniform); product groups with 1-4 offers for 10% of items |
| Geography | 27 governorates; buyer population share `~ Dirichlet` with Cairo, Giza and Alexandria weights x8 (synthetic, not census); about 80 cities; 30% of stores "local-footprint" with area affinity `a ~ LogNormal(0, 0.8)`, others `LogNormal(0, 0.2)` |
| Buyers | 200,000; 1.3 orders/month mean (Poisson-Gamma); 10% Plus (free returns); account ages; devices 1-2; families share addresses (5%) and tablets (2%) |
| Seasonality | weekly profile (Thu-Sat x1.25); Ramadan 30 days x1.4; Eid week x1.8; White Friday 3 days x2.5 |
| Virality | per store true `R_s ~ Gamma(2, 20)` (mean 0.10), 3 stores at 0.6; each kept buyer shares with prob 0.15; conversions Poisson; generations simulated (Galton-Watson); 20% of word of mouth is "dark" (no link) |
| Logistics | delivery 1-5 days; COD 50% of orders, 20% refusal; close at delivery + 33 days |
| Exposure | logging policy = the current heuristic plus band shuffle; examination `theta_k = 1/(1 + 0.6(k-1))` (vertical), with a step at k = 3 for rails |
| Attacks | §6.8 scenarios injected by flag |
| Bots | 5% of sessions, bot score 900 |

Ground-truth utility per (entity, area, day): `u = d_s * a_{s,area} * q_s * season(t)`.

### 8.2 Metrics

| Metric | Definition | Target (initial) [UNTUNED] |
|---|---|---|
| NDCG@10 | against true `u`, gain `2^rel - 1` with rel by true-u quartile [LIT Jarvelin & Kekalainen 2002] (existing `ndcgAtK`) | beats best-seller and average-rating baselines |
| Precision@k | share of top-k in the true top-k | report k = 5, 10 |
| Kendall tau | heuristic order vs true `u` order, per cohort | report |
| Gini of impressions | per surface-cohort-day | no worse than best-seller baseline minus 0.1 |
| Coverage | share of eligible entities with at least 1 impression per week | >= 60% |
| Time to graduate | days for a new honest store of median quality to reach n = 30 | <= 21 |
| Calibration | empirical coverage of 80% intervals for Q, K and theta_local against truth | 0.75-0.85 |
| Most-viral recovery | share of seeds where the true top-R store is awarded, or no award when ambiguous | >= 0.8; wrong award <= 0.05 |
| Attack lift | §6.8 | as listed |

### 8.3 Property tests (fast-check, `packages/domain/src/popularity/*.property.test.ts`)

| ID | Property |
|---|---|
| P-1 | Monotone in kept buyers: adding a kept credit never lowers Score (fixed everything else) |
| P-2 | Anti-monotone in returns: adding an R credit never raises Score |
| P-3 | Bounds: `Mv in [1, 1+c_v]`, `Ml in [1, 1+c_l]`, `delta in [0, delta_max]`, `Q in (0,1)`, Score >= 0 and finite |
| P-4 | Q limits: `B, R -> inf` with fixed p gives Q -> p; `n = 0` gives the prior quantile; Q is increasing in the prior mean |
| P-5 | Shrinkage limits: `N_a = 0` gives the parent rate; large N gives the raw rate; `m -> inf` gives the parent; `theta_local` lies between raw and parent |
| P-6 | Local never demotes: Score(cohort) >= Score(national) |
| P-7 | Sum to total: children's `N` sum to the parent's, including `unassigned` |
| P-8 | Floors: no list is published for `N < 50`; an entity with fewer than 20 purchasers inherits its parent's rate; `K_ANONYMITY_MIN` is imported, not redefined |
| P-9 | One buyer once: duplicating a cluster's lines never changes B; merging two accounts into one cluster never increases B |
| P-10 | Global cap: a cluster's total credit mass <= `C_max` |
| P-11 | Scale and unit invariance: expressing prices in piastres vs EGP x100 does not change ranks; shifting all timestamps by a constant with `as_of` shifted equally does not change output; permuting event order does not change output |
| P-12 | Idempotent replay: applying the event log twice gives a byte-identical credit table and lists |
| P-13 | Determinism: same inputs, params and seed give the same bytes; different seeds change only exploration slots and in-band order |
| P-14 | Exploration: realised share <= cap over 10^5 simulated requests (hard bucket), mean share within +-0.5 pp of cap |
| P-15 | Diversity: H1-H4 hold whenever feasible |
| P-16 | Personalisation off: output is independent of user features (metamorphic: vary user, compare bytes) |
| P-17 | Forbidden features: no vector or log contains budget or measurement keys (`vectorViolations` empty) |
| P-18 | Return pull-back: a `return.requested` for a credited line drops B by exactly that line's credit in the next build |
| P-19 | Undelivered and COD-refused lines contribute 0 |
| P-20 | Most-viral: award only if `P(top) >= 0.5`; P(top) values sum to 1 over candidates (+-MC error) |

### 8.4 Mutation targets (StrykerJS >= 80%, per A2.10 these count as ranking-critical)

Files: `popularity/{credit,quality,decay,virality,cascade,burst,shrinkage,floors,integrity,exploration,diversity,tiebreak}.ts`. Mutants that must be killed by name:
- `>=` vs `>` on the floors 50 and 20 and on graduation at 30
- `min` vs `max` on caps
- quantile `q` vs `1-q`
- sign of R's effect
- decay measured from `ingested_at` vs `event_time`
- `ln` vs `log10` in D
- `max(L,1)` removed
- per-sharer cap off by one
- `floor` vs randomised rounding in slots
- `delta` applied before vs after G
- hub threshold `>` vs `>=`

---

## 9. Data model sketch (expand-only migrations; names indicative)

| Table | Key columns | PII class | Retention |
|---|---|---|---|
| `rank_credits` | `entity_type, entity_id, cluster_pid` (PK), `kind` (b/r), `source_line_id`, `event_time`, `w_decay_micro`, `survival_micro`, `trust_micro`, `area_gov`, `area_city`, `source_message_id` UNIQUE | P2 (pseudonymous) | window + 30 d (max 120 d) |
| `rank_viral_edges` | `entity_type, entity_id, sharer_cluster_pid, buyer_cluster_pid` (PK), `link_id`, `closed_at`, `generation` | P2 | 120 d |
| `identity_clusters` / `identity_cluster_members` | `cluster_pid`, `user_pid`, `size`, `flags`, `computed_at` | P2 | rebuilt nightly; previous 7 days kept |
| `return_hazard` | `category_id, day` (PK), `hazard_ppm`, `as_of` | P0 aggregate | latest + 30 d history |
| `popularity_scores` | `entity_type, entity_id, surface, cohort_level, cohort_id, params_version, as_of` (PK), `score_micro bigint`, `q_micro`, `d_micro`, `k_lo_micro`, `lift_micro`, `delta_bps`, `reason_codes[]`, `label_level` | P1 aggregate, no shopper key | 25 months, then dropped |
| `popularity_lists` | `surface, cohort_level, cohort_id, params_version, as_of` (PK), `entity_ids[]`, `label_level` | P0 | 30 d |
| `popularity_params` | `version` (PK), `json`, `approved_by`, `approved_at` (admin-editable with audit, §20.4) | P1 | forever |
| `rank_impressions` | partitioned daily; fields as in §1.3 | P1 (no user id) | 90 d raw, then aggregates |
| `exploration_stats` | `entity, surface, cohort` (PK), `alpha_micro`, `beta_micro`, `matured_until` | P1 | live |

`store_directory_stats.trending_score` (today without a production writer, [REPO]) is written from `popularity_scores` (store, national, non-personalised) for backward compatibility with `GET /v1/stores?sort=trending` and mobile `sortStores('trending')`. Every new column is tagged in `data_inventory.yaml` (§B1). The budget-table import ban in dependency-cruiser is extended to the new module.

---

## 10. Parameters, tuning plan and owner decisions

### 10.1 Parameter register (all [UNTUNED])

| Param | Default | Range to search | Tuned by |
|---|---|---|---|
| `W`, `h` (B, R) | 28 d, 14 d | W {7, 14, 28}; h {7, 10, 14, 21} | offline NDCG on next-14-day kept purchases |
| `W_v`, `h_v` (V) | 90 d, 30 d | {60, 90, 120}; {21, 30, 45} | most-viral stability |
| `q` (Q quantile) | 0.10 | {0.05, 0.10, 0.20, 0.5 = mean} | NDCG + calibration |
| `m_min`, `m_max` (Beta prior) | 5, 50 | m_max {20, 50, 100} | MML agreement |
| `rho(reason)` | table §1.4 | +-0.25 | return-reason predictive check |
| `c_v`, `c_l`, `lambda` | 0.5, 0.5, 0.1 | c {0.25, 0.5}; lambda {0.05, 0.1, 0.2} | NDCG by cohort; A/B |
| `m` (local) clamp | [5, 500] | n/a | MoM vs MML |
| Floors | 50 cohort, 20 entity | **owner** | owner + DPO |
| Burst `z`, CUSUM `mu1/mu0`, `h_c` | 4, 2, 4 sigma | z {3, 4, 5}; h {3, 4, 5} sigma | false-alarm rate <= 1 per entity per 90 d on null data |
| Winsor `k` | 6 | {4, 6, 8} | A6 vs A8 trade-off |
| Hub `H` | 5/3/8 | +-2 | A9 false positives |
| Trust `tau_age`, `tau_block` | 0.5 to 1 over 7 d; 0.2 | | simulation |
| `C_max` | 8 | {5, 8, 12} | honest heavy-buyer impact |
| `f0`, `kappa`, `delta_max` | 0.05, 1, 0.5 | | simulation + appeals rate |
| Exploration `cap` | 5% | **spec / owner** | fixed |
| Per-entity exploration cap | 1% | {0.5, 1, 2} | time to graduate |
| Prior `n0` clamp | [20, 2000] | | regret in simulation |
| Band width | 10% | {5, 10, 20} | propensity overlap vs NDCG loss |
| `lambda_d` (MMR) | 0.8 | {0.6, 0.7, 0.8, 0.9} | NDCG vs Gini |
| `c_exp` | 10% | {5, 10, 20} | **owner** (fairness policy) |
| Attribution window | 7 d last touch | {1, 3, 7, 14} | **owner** (also referral terms) |
| Per-sharer cap | 3 | {2, 3, 5} | A7 |
| Graduation | n >= 30, 14 d | | time to graduate |
| Late client event limit | 72 h | | ingestion metrics |

### 10.2 Tuning protocol

1. **Phase A, synthetic:** grid or Latin-hypercube search over the ranges on 20 generator seeds. Choose by a lexicographic objective: §6.8 passes first, then NDCG@10, then Gini. Record in `popularity_params` version `syn-1`.
2. **Phase B, real-data replay** (after about 8 weeks of live closed orders): a time-split backtest. Score at day t, evaluate against kept purchases on days t+1 to t+14. Compare with best-seller (raw distinct buyers) and Wilson-only baselines. Report bootstrap confidence intervals.
3. **Phase C, online:** A/B of the tuned version against the previous version with guardrails (§7.5). Changes to the score's weights or caps need a new `params_version`, an audit entry and dual approval (Admin §23 change control) [INFERENCE: weights are business rules].
4. Re-tune quarterly and before mega events. Freeze params 48 h before mega events (§T8 release freeze).

### 10.3 Owner decisions (stop-and-ask items)

1. **Label wording and window:** "recently" with a 28-day decayed score (default) versus "this week", which forces an exact 7-day undecayed window. The two cannot be mixed (CPL 181/2018 misleading-indicator risk; article numbers unverified).
2. **"Most viral" badge:** shown to shoppers at all, or internal and seller-only? Default: internal only until counsel review.
3. **Cohort floors 50/20:** the defaults are proportionate choices, not legal numbers; confirm with the DPO.
4. **Use of delivery area for local cohorts** (versus profile area only): purpose compatibility under PDPL (DPIA).
5. **`shop_for` dimension:** off until counsel and DPIA clear it (earlier report).
6. **Exploration disclosure:** label exploration slots "New on Z-OUTLET" (truthful) or show them unlabelled? Default: label when the entity is under 30 days live.
7. **Exposure cap `c_exp`** and the fairness policy for big brands.
8. **Automatic graded discount** of up to 50% for suspected manipulation, with appeal through the §9.5 flow, versus discount only after human review. Default: automatic discount, human review for any hard exclusion.
9. **Attribution window and the per-sharer cap**, which must align with the Referral Terms.
10. **Sponsored items in popularity rails:** default none; sponsored only in their own labelled slots.

---

## 11. Performance, architecture and failure modes

### 11.1 Placement

- Pure domain: new folder `packages/domain/src/popularity/`, exported through `index.ts`, with no infra imports (dependency-cruiser fitness function). It reuses `UnionFind`, `seededRng`, `K_ANONYMITY_MIN`, `ndcgAtK`, `evaluateGuardrails`, `compareShadow` and `TreeEnsembleRanker`.
- Application and adapters: extend `apps/api/src/modules/ranking` with a `popularity` sub-area (or a sibling module, decided by the builder ADR). Inbox consumers keep `rank_credits` current intra-day. The nightly job runs in `main.worker.ts`. The read endpoint is `GET /v1/popularity/lists?surface=&level=&area=&personalized=` (additive OpenAPI; regenerate the client).
- Kill switches (ADR-0028, default blocked): `kill.popularity_ranking`, `kill.popularity_local`, `kill.popularity_exploration`, `kill.most_viral_badge`.

### 11.2 Nightly batch (Postgres, 03:30 Cairo)

DAG, each step idempotent by `(as_of, params_version)`:
1. Watermark check (§1.4).
2. Identity clusters (§6.2): O(E alpha(V)).
3. Dense blocks (§6.3): O(E log V) per block.
4. Return hazard (§1.4).
5. Recompute survival and trust on `rank_credits` and expire rows outside the window.
6. Fit priors `mu, m`, `k0, a_v`, local `m_l`.
7. Aggregate per (entity, area) and compute Q, D, K_lo, theta_local, Ml, delta, S.
8. Burst and CUSUM state.
9. Most-viral P(top).
10. Build lists per surface-cohort (sorted, top 200) and write them in one transaction with `as_of`.
11. Swap the "current" pointer atomically.

Expected size at launch: about 10^5 credit rows and about 10^3 entities x 110 areas. That is minutes in Postgres. Statement timeout 10 min; isolated `application_name = 'popularity.batch'` (Shopify connection-tagging lesson, §T8).

**Incremental:** decayed sums support O(1) updates (`S <- S * 2^(-dt/h) + w`), so during mega events an hourly mini-build of steps 5, 7 and 10 runs for the national level only.

### 11.3 Serving path (p95 budget 30 ms for this stage [UNTUNED])

Read the cached list for `(surface, level, area, params_version)` from Redis (TTL 26 h); fall back to the Postgres `popularity_lists` table. Then:
1. Fallback ladder (§4.5).
2. Request-time filters: stock and price recheck, size, and the budget-fit filter, which is never stored or logged (§12).
3. Exposure throttle.
4. Band shuffle and MMR (§5.4).
5. Exploration slots (§5.2).
6. Sponsored insertion.
7. Paginate.
8. Log `rank_impression`.

With `personalized=false`, steps 1 and 2 skip all user inputs and serve the national non-personalised list (§13).

### 11.4 Explainability payload ("Why this?")

```
why: {
  level: "city" | "governorate" | "national" | "non_personalized",
  area_id?: string,              // coverage code only
  window_label: "recently" | "this_week",
  reasons: Array<"popular_in_area" | "often_shared" | "rising_lately" | "new_on_platform"
                 | "verified_discount" | "you_follow_store">
}
```

No counts, scores, ranks, K, other shoppers' data or attributes leave the server. Reason codes map to Arabic-first copy keys (native review pending). `often_shared` appears only when `K_lo` is in the platform's top quartile and `V >= 5`; `rising_lately` only for §3.5 entities; `verified_discount` only with a §9 claim; `you_follow_store` only in personalised mode.

### 11.5 Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Batch fails or times out | job status, `as_of` age | serve the last good lists up to 72 h, then the non-personalised baseline (freshness + verified discount), labelled "New and active stores" |
| Ingestion lag > 6 h | watermark | skip the run; alert |
| Prior fit degenerate (`G < 5`, `tau2 <= 0`) | fit status | parent or platform prior; `m = m_max` |
| NaN/Inf in any term | assertion per entity | score 0 for that entity, alert, run continues |
| Identity job fails | status | clusters up to 7 days old; else `tau = 0.5` for accounts newer than 30 days |
| Redis down | client error | read Postgres lists; exploration off (no bucket) |
| Floor violated after data change | floor check at serve | roll up a level |
| Hazard table empty (new category) | row count | platform hazard; if absent, `s = 0.8` |
| DST day (23 or 25 h) | ADR-0047 helper | Cairo-day buckets; decay uses exact elapsed ms |
| Kill switch on | flag | non-personalised baseline; no badge |
| Mass false positives (delta spike across many stores) | alert: more than 5% of entities with delta > 0 | auto-freeze delta at the previous day's values and page the on-call |

### 11.6 Security and privacy notes

- **AuthZ:** the read endpoint is public or shopper-scoped and returns no PII. Admin params endpoints need `admin_api` scope, dual approval and audit. Every endpoint gets negative authorisation tests (A2.10).
- **API6 (abuse of business flow):** rate limits on list reads per device; App Attest on share-link creation and attribution.
- **Residency:** all computation runs in the primary data plane chosen by ADR-0002 (Proposed). Nothing goes to an external ML or LLM API. `cross_border_ml` is not needed.
- **DPIA:** an addendum for engagement ranking (none exists today, per the earlier report) covers the identity graph, delivery-area use and trust weighting.

---

## 12. Open decisions and unverified points

**Open decisions** are listed in §10.3 (10 items). In addition, an engineering ADR is needed for: the `popularity` module placement; survival-weighted crediting replacing "credit at CLOSED" from the earlier reports; replacing `sampleBeta` and `maxExplorationSlots`; and adding hub pruning to `linkUsersByIdentifiers`.

**Unverified [VERIFY]:**
1. Every numeric parameter (all [UNTUNED]); no Egyptian data exists yet.
2. No published per-store K-factor for marketplaces; the per-entity K is an adaptation.
3. No source for a marketplace LTR crossover volume (§7.6); the 10^4 to 10^5 figure is a guess.
4. Attribution of the branching-ratio MLE to Harris (1948); I cite it from memory.
5. Whether a server-side served-list log (`rank_impression`) keyed to `request_id` is personal data under PDPL and Decision 816/2025.
6. Purpose compatibility of using the delivery area for ranking cohorts (PDPL).
7. The legal status of the 50/20 floors: no law fixes them; they are proportionate choices.
8. CPL 181/2018 article numbers for misleading popularity indicators (carried from the earlier reports).
9. The district level below city: not modelled and its data is unverified (outlet report).
10. Horizontal-rail examination curves: no Egyptian or app-specific measurements; the step at slot 3 is a guess.
11. The citations in §13 marked "from memory" were **not re-fetched in this pass** (no web access was used for this spec). Titles, authors and venues should be checked when the bibliography is finalised.
12. Whether Crane-Sornette shape classes (from YouTube views) transfer to purchase series at small counts.
13. Return-reason weights `rho` reflect a value judgement (size returns are not store quality) and have no source.

**Corrections to the earlier reports:**
- Credit at CLOSED alone conflicts with a 28-day "recent" window, because close is 33 days after delivery. This spec replaces it with survival-weighted crediting (§1.4).
- The current `maxExplorationSlots` floors to 0 on rails shorter than 20 cards, so short rails never explore.
- `sampleBeta` approximates by downscaling counts and only takes integer shapes.
- `positionPropensity` is a constant placeholder, not an estimate.
- `linkUsersByIdentifiers` has no hub pruning.

---

## 13. Sources

From the research notes (fetched by earlier researchers; not re-fetched here):
- Evan Miller, "How Not To Sort By Average Rating", evanmiller.org, 2009.
- Andrew Chen, "Facebook viral marketing: when and why do apps jump the shark", andrewchen.com; LaunchList K-factor guide (third-party).
- Amazon Science, "Addressing Cold Start in Product Search via Empirical Bayes", CIKM 2022 (authors not recorded in the notes).
- Roblox, "Dynamic Prior Thompson Sampling", arXiv 2602.00943, 2026.
- Klimashevskaia, Jannach, Elahi, Trattner, "A survey on popularity bias in recommender systems", UMUAI 2024 / arXiv 2308.01118.
- "Auditing Yelp's business ranking and review recommendation", arXiv 2308.02129, 2023.
- arXiv 2609.13407 (2026), account-reuse integrity analysis.
- Shopee help centre on brushing; Racklify on brushing.
- righto.com, "How Hacker News ranking really works", 2013.
- Kohavi, Tang, Xu, *Trustworthy Online Controlled Experiments*, Cambridge University Press, 2020.

From memory (standard literature; not re-fetched in this pass, see §12 item 11):
- E. B. Wilson, "Probable inference, the law of succession, and statistical inference", *JASA* 22, 1927.
- E. B. Wilson, M. M. Hilferty, "The distribution of chi-square", *PNAS* 17, 1931.
- B. Efron, C. Morris, "Data analysis using Stein's estimator and its generalizations", *JASA* 70, 1975.
- G. Casella, "An introduction to empirical Bayes data analysis", *The American Statistician* 39, 1985.
- A. Gelman et al., *Bayesian Data Analysis*, 3rd ed., CRC, 2013.
- T. Minka, "Estimating a Dirichlet distribution", Microsoft Research tech. report, 2000.
- W. H. Press et al., *Numerical Recipes*, 3rd ed., Cambridge, 2007.
- E. L. Kaplan, P. Meier, "Nonparametric estimation from incomplete observations", *JASA* 53, 1958.
- E. S. Page, "Continuous inspection schemes", *Biometrika* 41, 1954.
- J. M. Lucas, "Counted data CUSUM's", *Technometrics* 27, 1985.
- P. J. Rousseeuw, C. Croux, "Alternatives to the median absolute deviation", *JASA* 88, 1993.
- A. G. Hawkes, "Spectra of some self-exciting and mutually exciting point processes", *Biometrika* 58, 1971.
- R. Crane, D. Sornette, "Robust dynamic classes revealed by measuring the response function of a social system", *PNAS* 105, 2008.
- Q. Zhao, M. Erdogdu, H. He, A. Rajaraman, J. Leskovec, "SEISMIC: A self-exciting point process model for predicting tweet popularity", KDD 2015.
- S. Goel, A. Anderson, J. Hofman, D. Watts, "The structural virality of online diffusion", *Management Science* 62, 2016.
- S. Goel, D. Watts, D. Goldstein, "The structure of online diffusion networks", ACM EC 2012.
- T. E. Harris, "Branching processes", *Annals of Mathematical Statistics* 19, 1948; P. Guttorp, *Statistical Inference for Branching Processes*, Wiley, 1991.
- W. R. Thompson, "On the likelihood that one unknown probability exceeds another in view of the evidence of two samples", *Biometrika* 25, 1933.
- O. Chapelle, L. Li, "An empirical evaluation of Thompson sampling", NeurIPS 2011.
- D. Russo, B. Van Roy, A. Kazerouni, I. Osband, Z. Wen, "A tutorial on Thompson sampling", *Foundations and Trends in ML*, 2018.
- G. Marsaglia, W. Tsang, "A simple method for generating gamma variables", *ACM TOMS* 26, 2000.
- N. Craswell, O. Zoeter, M. Taylor, B. Ramsey, "An experimental comparison of click position-bias models", WSDM 2008.
- T. Joachims, A. Swaminathan, T. Schnabel, "Unbiased learning-to-rank with biased feedback", WSDM 2017.
- X. Wang, N. Golbandi, M. Bendersky, D. Metzler, M. Najork, "Position bias estimation for unbiased learning to rank in personal search", WSDM 2018.
- A. Agarwal, I. Zaitsev, X. Wang, C. Li, M. Najork, T. Joachims, "Estimating position bias without intrusive interventions", WSDM 2019.
- A. Swaminathan, T. Joachims, "The self-normalized estimator for counterfactual learning", NeurIPS 2015.
- S. Li, Y. Abbasi-Yadkori, B. Kveton, S. Muthukrishnan, V. Vinay, Z. Wen, "Offline evaluation of ranking policies with click models", KDD 2018.
- J. Carbonell, J. Goldstein, "The use of MMR, diversity-based reranking for reordering documents and producing summaries", SIGIR 1998.
- A. Kulesza, B. Taskar, "Determinantal point processes for machine learning", *Foundations and Trends in ML* 5, 2012.
- L. Chen, G. Zhang, H. Zhou, "Fast greedy MAP inference for determinantal point process to improve recommendation diversity", NeurIPS 2018.
- A. Singh, T. Joachims, "Fairness of exposure in rankings", KDD 2018.
- H. Abdollahpouri, R. Burke, B. Mobasher, "Controlling popularity bias in learning-to-rank recommendation", RecSys 2017.
- M. Charikar, "Greedy approximation algorithms for finding dense components in a graph", APPROX 2000.
- B. Hooi, H. A. Song, A. Beutel, N. Shah, K. Shin, C. Faloutsos, "FRAUDAR: Bounding graph fraud in the face of camouflage", KDD 2016.
- U. N. Raghavan, R. Albert, S. Kumara, "Near linear time algorithm to detect community structures in large-scale networks", *Physical Review E* 76, 2007.
- J. Douceur, "The Sybil attack", IPTPS 2002.
- C. Burges, "From RankNet to LambdaRank to LambdaMART: An overview", Microsoft Research TR-2010-82, 2010.
- G. Ke et al., "LightGBM: A highly efficient gradient boosting decision tree", NeurIPS 2017.
- Z. Hu, Y. Wang, Q. Peng, H. Li, "Unbiased LambdaMART: An unbiased pairwise learning-to-rank algorithm", WWW 2019.
- F. Radlinski, M. Kurup, T. Joachims, "How does clickthrough data reflect retrieval quality?", CIKM 2008.
- O. Chapelle, T. Joachims, F. Radlinski, Y. Yue, "Large-scale validation and analysis of interleaved search evaluation", *ACM TOIS* 30, 2012.
- K. Jarvelin, J. Kekalainen, "Cumulated gain-based evaluation of IR techniques", *ACM TOIS* 20, 2002.
- A. Clauset, C. Shalizi, M. Newman, "Power-law distributions in empirical data", *SIAM Review* 51, 2009.
- C. Dwork, F. McSherry, K. Nissim, A. Smith, "Calibrating noise to sensitivity in private data analysis", TCC 2006.

Worked numbers in §2.3, §2.4, §3.1, §3.3, §3.5, §3.6, §4.4 and §6.7 were computed with a scratch double-precision script outside the repository. They are not repo tests; property tests P-1 to P-20 and dedicated example tests must reproduce them.
