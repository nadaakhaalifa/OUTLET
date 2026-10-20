# Fraud, risk and trust scoring: algorithm specification

- Status: **Proposed** (architecture spec, documents only, nothing built). No real personal data may be processed by anything in this document until ADR-0002 (residency) is accepted and the fraud DPIA (`docs/privacy/dpia-fraud.md`) is signed off.
- Date: 2026-10-16 · Author: architect (Opus, high effort) · Reviewers required: chief-reviewer (money, personal data), DPO, counsel
- Spec refs: master prompt §1, §7, §9.4–9.5, §14, §15.1, §15.4, §17, §19, §20.7, §22, §27, §B1, §B3, §T5, §T6, §T8, §T12
- Related: `docs/specs/referrals.md`, `price-integrity.md`, `promotions.md`, `reviews.md`, `payments.md`, `returns.md`, `docs/privacy/dpia-fraud.md`, `docs/privacy/data_inventory.yaml` (`risk_assessments`, `device_ip_graph_edges`, `cod_refusal_history`), `docs/adr/0026-android-push-and-attestation.md`, `0028-kill-switch-polarity.md`, `0033-redis-usage-and-failure-modes.md`

## 0. Conventions used in this document

- **[U]** marks an **untuned inference**: a starting value chosen by engineering judgement, with no Z-OUTLET data behind it. Every [U] value is admin-configurable, versioned and audited, and must be re-set from shadow-mode data before it drives an adverse action.
- **VERIFY** marks a fact that needs counsel, a provider contract or a primary source. Proposed new register rows are named `VR-FRT-nn` (section 12). This document does not edit the register; the register owner adds them.
- **Money** is integer piastres (`bigint`). **Probabilities and scores** cross module boundaries as integer basis points (`0..10_000`), matching the existing `botScoreBp`, `sellerHealthBp` and `priceTrustBp` conventions. Floating point exists only inside the scoring evaluator and is quantised once, with `floor`, at its output (section 9.3).
- **Adverse action** = any decision that withdraws or worsens a capability for a person or a store: `prepaid_only`, `limit_value`, `block`, withholding a reward, removing free returns, ranking demotion, payout hold, suspension. **Friction** = `require_confirmation`, `require_prepayment` (delivery fee or 20%), step-up authentication. The two are budgeted separately (section 4.5).
- **In-house only.** All models are trained and served by Z-OUTLET with open-source libraries (scikit-learn, LightGBM, igraph/leidenalg, numpy) on infrastructure in the region chosen by ADR-0002. No external fraud, device-intelligence, AI or LLM vendor receives any data. The LLM gateway is **not** used anywhere in this design.

---

## 1. What exists today (verified in the repo on 2026-10-16)

| # | Finding | Evidence | Consequence for this spec |
|---|---|---|---|
| E1 | **No `fraud` module.** `apps/api/src/modules` has 57 directories and none is `fraud` or `risk`. | directory listing | Everything in sections 3–9 is new. |
| E2 | Checkout has a `RiskPort.assessCod({userId, deviceId, total, addressId})` returning `allow | require_confirmation | require_prepayment | prepaid_only | limit_value{maxAmount} | block`. | `apps/api/src/modules/checkout/domain/ports.ts:75-91`, `application/quote.ts:85-100, 230-245` | The decision vocabulary already matches §20.7. Keep it. |
| E3 | The only `RiskPort` implementation is `FakeRisk` (always `allow`), bound only in development; production has no binding. | `checkout/adapters/fakes.ts:83`, `composition/money-wiring.ts:497-509` | Production COD risk is unbuilt. Until it exists, COD must stay behind `kill.payment.cod` (Blocked). |
| E4 | `require_prepayment` is mapped to "COD unavailable, reason `prepayment_required`". There is **no partial-prepayment flow** (deposit plus COD balance). | `quote.ts` `codDecision` | Partial prepayment needs a checkout and ledger design (a split tender of PSP + COD). Out of scope here; flagged as open decision M5. |
| E5 | No COD refusal logic beyond reversing the shopper's COD spend counters on `shipment.rto_*`. No chargeback ingestion anywhere. | `composition/cod-wiring.ts` header; grep for `chargeback` in domain payments | Labels for COD refusal and chargebacks have no source yet (section 3.6). |
| E6 | Referral fraud: unweighted union-find over shared device hashes and payment-fingerprint hashes; component size > 3 withholds the reward; self-referral and same-device rejected silently. | `packages/domain/src/referrals/fraud.ts`, `rules.ts:107`, spec `referrals.md` R10, R12 | Good baseline. Section 3.2 replaces the unweighted link with a weighted, decayed, hub-suppressed link so families and shared Wi-Fi do not merge. |
| E7 | Migration 0026 stores device and payment fingerprints as **unkeyed SHA-256 hex**. | `packages/db/migrations/0026_referrals.sql` | A plain hash of a low-entropy identifier (phone, IPv4, address) is reversible by enumeration. Section 3.2.1 requires keyed HMAC for every new identifier and proposes migrating 0026 (open decision O3). |
| E8 | Price Trust Score v1: `100 − 10·min(violations90d,8) − 5·min(openCrossChannel,3) − floor(correctedPct/5)`, bands 90/70/40. | `packages/domain/src/price-integrity/enforcement.ts:68-92` | No small-sample shrinkage: one corrected claim out of one evaluated costs 20 points. Section 6.3 proposes v2. |
| E9 | Seller Health Score: `stores.health_score` is a nullable column with a badge (good ≥ 80, fair ≥ 50, poor), seeded by fixtures. **No formula exists.** `api-client-gap.md` says it is not on the wire. | `stores/domain/store.ts:89-94`, `research_notes/.../repo_api_data.md:65` | Section 6.2 defines the formula. |
| E10 | Serial returner rule exists: > 60% over ≥ 10 delivered orders in 6 months removes free returns, published policy. | `packages/domain/src/returns/serial.ts` | Keep as a published hard rule; section 6.4 adds shrinkage only for the internal reliability score, never for the published rule. |
| E11 | Gift-card redemption throttle: 5 failures/hour/account, 20/day/device, 50/day/IP hash, admitted atomically. | `packages/domain/src/gift-cards/throttle.ts` | Keep. Section 5.4 adds a distributed-attack detector across accounts. |
| E12 | OTP policy: EG only (`+20`), 3 sends/15 min/phone, 10/day/device, exponential resend, `prefixLength: 6`. The SMS adapter has a `PrefixBudget.tryConsume` hook but its bucket is `phone.slice(0,5)` ("+2010", i.e. 4 digits), and no budget algorithm is implemented. | `packages/auth-core/src/otp-policy.ts`, `apps/api/src/production/adapters/comms/sms.ts:18-31,75` | Two prefix definitions disagree (6 vs 4 digits). Section 5.3 fixes one definition and specifies the budget. |
| E13 | Ads invalid-traffic filter takes `botScoreBp: number | null` and does not block on `null`. | `packages/domain/src/ads/traffic.ts` | Section 5.6 supplies the bot score producer. |
| E14 | The HTTP rate limiter is per process (no shared store). | `research_notes/.../repo_api_data.md:34` | Velocity limits in section 5 need the shared Redis limiter of ADR-0033 before production; per-process limits are multiplied by the replica count. |
| E15 | Kill switches are `kill.<area>.<name>`, **allowed-when-true, default blocked, fail closed** (ADR-0028). No `risk` keys exist. | `packages/feature-flags/src/registry.ts` | Section 8.5 adds `kill.risk.*` keys with the same polarity. |

---

## 2. Requirements, constraints and non-goals

**Must**
1. One risk platform for buyer-side and seller-side abuse, with a single decision record, a single audit trail and per-use-case policies.
2. Deterministic and idempotent decisions: same inputs, same policy version and same model version give a bit-identical decision; a replayed request with the same `decision_key` returns the stored decision.
3. False-positive guardrail from §20.7: **good users hit by an adverse COD action < 0.5%** (definition in section 4.5).
4. Every adverse action carries reason codes, a human-review path and an override, and is written to the hash-chained audit log.
5. No protected or sensitive attribute, and no known proxy for one, is a model input (section 7.2).
6. In-house training and serving; no personal data leaves the ADR-0002 region; no external vendor.
7. Domain code ≥ 90% line coverage; mutation score ≥ 80% (Stryker) on `packages/domain/src/risk/**` and on the trust-score modules, which this spec classifies as critical (they gate money and payouts).

**Must not**
- Use budget-suite data (§12), size measurements (§10), stylist history, analytics or personalization data (purpose limitation: those were collected for other purposes and under other consents).
- Let a model alone cause a `block`, a suspension, a payout hold or a confiscation of value. Those need a hard rule (section 3.3, layer 1) or a human.
- Let uncertainty by itself cause an adverse action (section 4.6).

**Non-goals (this document)**
- Partial-prepayment checkout mechanics (E4), PSP dispute handling flows, courier data-sharing agreements.
- Identity verification (KYC) of shoppers.

---

## 3. Unified risk architecture

### 3.1 Use cases and decision points

| Use case id | Decision point (sync unless noted) | Subject | Allowed decisions | Existing hook |
|---|---|---|---|---|
| `cod_order` | checkout quote and commit when COD is listed | order group + user | allow, require_confirmation, require_prepayment, prepaid_only, limit_value, block | `RiskPort.assessCod` |
| `checkout_payment` | `POST /v1/checkout` before a PSP intent | user + device | allow, step_up (force 3-DS), method_block(card, 24h), block | new |
| `otp_send` | `POST /v1/auth/otp/request` | phone + device + prefix | allow, delay, deny | `evaluateOtpSend`, `PrefixBudget` |
| `signup` | `POST /v1/auth/otp/verify` (account creation) | device + phone | allow, flag_new_account_watch | new (async flag) |
| `promo_redeem` | promotions evaluate at quote | user + device + fingerprint | allow, deny_code (silent same wire shape), flag | promotions abuse controls |
| `referral_attr` / `referral_settle` | attribute; `OrderClosed` (async) | referral | attributed, rejected(reason), withheld_for_review | `evaluateAttribution`, `decideSettlement` |
| `gift_card_redeem` | redeem | user + device + IP | allow, throttle(429) | `REDEMPTION_THROTTLE` |
| `gift_card_purchase` | gift-card checkout | user + instrument | allow, require_3ds, limit, deny | new |
| `bnpl_eligibility` | quote, BNPL method listing | user | allow, hide_bnpl(90d) | new |
| `return_request` | `POST /v1/orders/lines/{id}/returns` | user + line | allow, require_photos, require_inspection_before_refund, flag | serial-returner rule |
| `review_publish` | review pipeline (async) | review + reviewer + store | publish, hold_for_moderation | reviews moderation HELD |
| `drop_admission` | waiting-room admit (sync) | device + user | admit, deprioritise, deny | `waiting-room` bot block |
| `ad_click` | click classify | session | valid, invalid(bot) | `classifyClick` |
| `seller_trust` | nightly batch + on event | store | health score, restrictions ladder (section 6.5) | `price_enforcement_actions` |
| `ring_detection` | nightly batch (async) | community of accounts | open case for human | none |

### 3.2 Entity graph

**Node types.** `user`, `device`, `phone`, `payment_fp` (PSP card fingerprint, already opaque), `address` (normalised to building + floor + apartment), `address_building` (building only, feature-only, never a link), `ip` (/32 for IPv4, /64 for IPv6), `asn` (feature-only, never a link), `store`, `order_group`, `referral_code`, `promo_code`.

#### 3.2.1 Hashed identifiers

Every identifier is stored as `id_hmac = HMAC-SHA256(K_kind,v, canonical(value))`, 32 bytes, with:
- `K_kind,v` a per-kind key (`risk.device`, `risk.ip`, `risk.address`, `risk.phone`, `risk.fp`) held in KMS (ADR-0030 token and key service), version `v` stored next to the hash. Separate keys per kind mean a leaked IP key does not unmask addresses.
- `canonical()` defined per kind: IPv4 dotted quad; IPv6 first 64 bits; address = Arabic-normalised (same folding as search: alef, ya, ta-marbuta, diacritics, Eastern to Western digits) `governorate|district|street|building|floor|apartment`; phone E.164; device = the app-generated install identifier plus the App Attest key id (never IDFA).
- Rotation: yearly; during rotation both versions are computed for 30 days [U] so links survive.
- Why keyed: IPv4 is 2^32 values and Egyptian mobile numbers about 10^9, so an unkeyed SHA-256 (E7) is reversible on a laptop. The address blind index already uses HMAC (`data_inventory.yaml`, `device_ip_graph_edges.address_hash: blind_index_hmac`); this extends that rule to every kind.

#### 3.2.2 Edges, weights and decay

An observation edge `(subject s, identifier i)` is written when s uses i (login, checkout, delivery address, payment). It stores `first_seen_at`, `last_seen_at`, `n_obs`.

Edge strength at time t:
```
w(s,i,t) = beta[kind(i)] * 2^( -(t - last_seen_at) / h[kind(i)] )
```

| kind | beta [U] | half-life h [U] | links users? | hub cutoff D (max distinct users before i stops linking) [U] |
|---|---|---|---|---|
| payment_fp | 1.0 | 365 d | yes | 6 |
| device | 0.9 | 180 d | yes | 8 |
| address (apartment level) | 0.5 | 180 d | yes | 12 |
| ip (/32, /64) | 0.2 | 7 d | yes, weakly | 25 |
| address_building | — | 180 d | no, feature only | — |
| asn | — | — | no, feature only | — |
| phone | identity key of the account; a phone reused across accounts (recycled number, §1) creates a `phone_reuse` feature, not a link | | | |

**User–user link strength** is a decayed Adamic–Adar index (Adamic and Adar, 2003): identifiers shared by many users carry little evidence.
```
deg(i)   = number of distinct users with w(u,i,t) >= eps   (eps = 0.05 [U])
s(u,v,t) = sum over shared i with 2 <= deg(i) <= D[kind(i)] of
             min(w(u,i,t), w(v,i,t)) / log2(1 + deg(i))
link(u,v) iff s(u,v,t) >= theta_link        (theta_link = 0.5 [U])
```
Worked values: one shared card fingerprint used by exactly 2 users, both seen today: `1.0 / log2(3) = 0.63` gives a link. One shared IP today: `0.2 / log2(3) = 0.13`, no link alone; IP plus apartment address: `0.13 + 0.32 = 0.45`, still no link; IP plus device: link. A carrier-NAT IP with 300 users exceeds D and never links (Egyptian mobile carriers use CGNAT widely; VERIFY the scale with real traffic).

Edges with `w < eps` are dropped from the linking graph and purged at the `fraud_signals` retention horizon (24 months, proposed, `retention-schedule.md`).

**Storage.** Postgres tables `risk_identifiers` and `risk_edges` (section 10). The graph stays small (users × few identifiers); a dedicated graph database is not needed at launch. Nightly jobs load it into igraph in the ML service.

### 3.3 Scoring pipeline (per decision)

```
request -> [L0 kill switches / degraded mode]
        -> [L1 hard rules]            deterministic, published or legal; may yield any decision incl. block
        -> [L2 feature assembly]      point-in-time, from feature store; schema-checked, no prohibited fields
        -> [L3 score]                 per use case: scorecard | Bayesian LR | GBDT (stage, section 4.3)
        -> [L4 calibration]           Platt or isotonic -> p in bps
        -> [L5 uncertainty gate]      OOD / low evidence caps the action at friction (section 4.6)
        -> [L6 decision policy]       expected-loss argmin under FPR and friction budgets (section 4.5)
        -> [L7 exploration]           randomised relaxation under caps, propensity logged (section 4.7)
        -> [L8 combine]               final = most restrictive of (L1 result, L6/L7 result)
        -> decision record + reason codes + audit (section 9.4)
```

Combination rule: decisions are totally ordered by restrictiveness, `allow < require_confirmation < require_prepayment < limit_value < prepaid_only < block`. The final decision is the maximum of the hard-rule decision and the model decision, except that exploration (L7) may relax only the **model** decision and never a hard-rule decision.

**Hard rules for `cod_order` (from §20.7, all [U] values are the spec's defaults and remain configurable):**

| Rule | Condition | Decision |
|---|---|---|
| H-COD-1 | first order and total > 1,500 EGP | limit_value(1,500 EGP) |
| H-COD-2 | fewer than 2 delivered orders and total > 3,000 EGP | limit_value(3,000 EGP) |
| H-COD-3 | 1 customer-attributable refusal in 90 days | require_prepayment (delivery fee) |
| H-COD-4 | ≥ 2 customer-attributable refusals in 90 days | prepaid_only for 90 days from the second refusal |
| H-COD-5 | address has no landmark or no map pin | COD not offered until added (a form requirement, not a risk decision) |
| H-COD-6 | address quality score < 50 [U] (section 3.5.1) | require_confirmation (call) |
| H-COD-7 | phone not verified | prepaid_only (spec §1: phone verified before a COD order) |
| H-COD-8 | user in a ring case in state `CONFIRMED` (human-confirmed, section 3.4.3) | block COD |
| H-COD-9 | attestation hard failure (App Attest assertion invalid, or Play Integrity reports no app recognition) | prepaid_only |

"Customer-attributable refusal" excludes courier fault (no attempt, wrong address entered by courier, damaged parcel), seller fault (wrong item, late beyond promised ETA + 2 days [U]) and the shopper's exercise of a legal right (see VERIFY row 7 on the 7-day cancellation and open-box refusal under §20.7 "Open-box on delivery: allowed for apparel"). Refusal after open-box inspection for a defect or mismatch is **not** attributable. This classification needs the courier's refusal reason (VR-11) and is open decision L4.

### 3.4 State machines (explicit tables, in `packages/domain/src/risk/machines/`, XState-style per A2.6)

#### 3.4.1 Risk decision lifecycle (one per `decision_key`)

| From | Event | To | Guard / effect |
|---|---|---|---|
| — | `SCORE` | `ALLOWED` | decision = allow |
| — | `SCORE` | `CHALLENGED` | decision ∈ {require_confirmation, step_up} |
| — | `SCORE` | `RESTRICTED` | decision ∈ {require_prepayment, limit_value, prepaid_only, method_block, hide_bnpl, withheld_for_review} |
| — | `SCORE` | `BLOCKED` | decision = block; requires at least one hard rule fired (guard) |
| CHALLENGED | `CHALLENGE_PASSED` | ALLOWED | |
| CHALLENGED | `CHALLENGE_FAILED` | RESTRICTED | |
| CHALLENGED | `CHALLENGE_EXPIRED` | EXPIRED | COD confirmation not received in 2 h (§20.7; VR-CHK-8) → checkout saga cancels |
| RESTRICTED, BLOCKED | `REVIEW_REQUESTED` | IN_REVIEW | shopper or seller asked for human review |
| IN_REVIEW | `REVIEW_UPHELD` | (previous state) | reviewer reason code required |
| IN_REVIEW, RESTRICTED, BLOCKED | `OVERRIDE_ALLOW` | OVERRIDDEN | trust_safety role; reason code; audit; dual approval when the override releases value above a threshold (open decision M7) |
| ALLOWED, OVERRIDDEN, RESTRICTED, EXPIRED | `OUTCOME_MATURED` | LABELLED | label written (section 3.6); terminal |

Invalid transitions throw `InvalidRiskTransitionError`. A property test asserts that `BLOCKED` is unreachable without a hard-rule reason code and that `LABELLED` is terminal.

#### 3.4.2 Exploration record

`ELIGIBLE → (EXPLORED | NOT_SELECTED)`; `EXPLORED → LABELLED`. Selection is a deterministic function of `HMAC(K_explore, decision_key)` (section 4.7), so replays are idempotent.

#### 3.4.3 Ring case (human investigation)

`OPEN → TRIAGED → (CONFIRMED | DISMISSED)`, `CONFIRMED → ACTIONED → CLOSED`, `DISMISSED → CLOSED`, `CONFIRMED → APPEALED → (CONFIRMED | DISMISSED)`. Only `CONFIRMED` (a human decision) can feed hard rules such as H-COD-8. While `OPEN` or `TRIAGED`, the only automatic effect is **withholding pending, not-yet-issued rewards** (referral, cashback on unsettled orders). Nothing already credited is taken back by the risk system; clawback is the rewards module's existing rule (coins clawed back on return).

#### 3.4.4 Store trust ladder: see section 6.5.

### 3.5 Feature catalogue

All features are computed **as of the decision timestamp** from the feature store (section 9.2). Notation: `cnt_X_{W}` = count over trailing window W; `dist_X_{W}` = distinct count; `ewma` = exponentially weighted with half-life h. Monotone direction (↑ = more risk) is declared per feature and enforced in the GBDT (section 4.1) and in property tests (section 8.3).

#### 3.5.1 Shared building blocks

| Feature | Definition | Dir |
|---|---|---|
| `account_age_days` | now − users.created_at | ↓ |
| `phone_tenure_flag` | recycled-number rule fired (§1: > 180 d unused, new device) | ↑ |
| `delivered_orders_365d` | count | ↓ |
| `cod_refusal_rate_shrunk` | `(k + m·r0)/(n + m)`, k refusals, n COD attempts in 365 d, `m = 10`, `r0` = platform COD refusal prior (VR-12, VR-24; launch placeholder 0.20 [U]) | ↑ |
| `dist_devices_30d`, `dist_fp_30d`, `dist_addresses_90d` | distinct identifiers used by the user | ↑ |
| `accounts_on_device_90d` | distinct users seen on this device | ↑ |
| `linked_component_size` | size of the user's component under `link()` (section 3.2.2) | ↑ |
| `linked_bad_mass` | personalised PageRank mass from confirmed-bad seeds (section 4.2), capped at its 99th percentile | ↑ |
| `asn_is_hosting` | IP's ASN is in the in-house hosting/datacenter list (built from public RIR delegation data and an offline ASN table; no API call) | ↑ |
| `attestation_tier` | 0 none or failed, 1 basic, 2 device, 3 strong (ADR-0026 tiers) | ↓ |
| `address_quality` | 0..100 = pin inside the stated district polygon 30 + landmark 15 + building, floor and apartment present 25 + courier coverage confirmed 20 + address previously delivered successfully 10 [U] | ↓ |
| `order_value_bps_of_cap` | total / current COD cap | ↑ |
| `hour_bucket` | Cairo local hour in 4 buckets | — (no monotone constraint; monitored for fairness, section 7.2) |

#### 3.5.2 Per use case

| Use case | Additional features | Label (section 3.6) |
|---|---|---|
| COD refusal | building blocks; `items_count`; `share_high_resale_value_items`; `minutes_since_signup`; `confirmation_channel_reached` (only for post-confirmation re-scoring, never for the initial decision); `same_address_refusals_365d` (other accounts, apartment level, only if linked) | customer-attributable RTO |
| New-account abuse | `minutes_signup_to_first_order`; `accounts_on_device_90d`; `asn_is_hosting`; `first_order_uses_offer` (first-order or referral promo); `session_screens_before_checkout` | promo or referral abuse confirmed within 60 d |
| Promo abuse | `dist_accounts_per_fp_using_code`; `code_redemptions_per_device_30d`; `refund_then_reuse_attempts`; `order_value_minus_min_threshold` (orders sitting exactly at the threshold) | redemption reversed by T&S or ring-confirmed |
| Referral abuse | current R6–R12 inputs; weighted `linked_component_size`; `referee_orders_at_min_subtotal_share` for the referrer's referees; `referee_cod_refusal_share` | referral rejected on review, or referee refused or refunded |
| Review farming | reviewer–store purchase concentration (share of reviewer's reviews on one store); `reviews_per_store_24h` burst z-score; reviewer linked to store staff devices (graph link user ↔ seller staff); `minutes_delivery_to_review`; rating extremity share (all 5 or all 1) | review removed by moderation for manipulation |
| Gift-card brute force | per account/device/IP failure counts (existing); platform-wide failure rate per minute; distinct accounts failing from one /24 or ASN | — (rules only; no model) |
| BNPL cash conversion (§B3) | `bnpl_orders_90d`; `bnpl_to_return_request_hours`; `share_high_resale_value_items`; `asks_store_credit_on_bnpl_return` (blocked by RefundRouter, but the attempt is a signal); `bnpl_cancellations_90d` | return-after-BNPL pattern confirmed by T&S |
| Card testing | section 5.5 (rules only) | — |
| Seller fake stock | `seller_cancel_after_paid_rate_shrunk`; `oversell_penalties_90d`; stock jumps before a drop (`on_hand` increase > 5× in 24 h before `SCHEDULED`) | oversell or no-stock cancellation |
| Counterfeit | pHash near-duplicates of another store's images (from §9.2 matching); brand authorisation present; price / brand RRP ratio when RRP evidence exists; counterfeit reports per 1,000 orders | notice-and-takedown upheld (§27) |
| Price manipulation | the §9.4 signals (pre-drop spike, ping-pong count, listing duplication reset, robust z of claimed discount vs category) | enforcement action upheld |
| Return fraud (buyer) | `inspection_rejection_rate_shrunk`; returns within 72 h after an event date (wardrobing); `weight_mismatch_reports`; `exchange_to_return_ratio` | inspection rejected and dispute lost |
| Return abuse (seller side) | seller's `return_rejection_rate`; `dispute_overturn_rate` | dispute overturned in the shopper's favour |

### 3.6 Labels, maturity and leakage control

**Label maturity.** An outcome is used for training only once it is final. Training snapshots include only decisions with `decided_at ≤ T_snapshot − M[label]`:

| Label | Positive | Negative | Maturity M [U] | Source |
|---|---|---|---|---|
| COD refusal | customer-attributable RTO | DELIVERED and not refused | 21 days after placement, or terminal shipment state, whichever is later | fulfilment events (courier, VR-11) |
| Chargeback | PSP dispute with fraud reason | no dispute | 120 days (card-scheme dispute windows are commonly about 120 days; VERIFY with the PSP, VR-FRT-04) | PSP dispute feed (not built, E5) |
| Return fraud | inspection rejected and dispute lost or not raised | return accepted | return window (14 or 30 d) + 48 h inspection + 5 business days of dispute ≈ 45 days | returns module |
| Promo or referral abuse | reversed by T&S or ring CONFIRMED | not reversed after 60 d | 60 days | risk cases |
| Seller outcomes | upheld enforcement or takedown | none in 90 d | 90 days | price-integrity, T&S |

**Delayed and partial labels.** Before maturity, an unresolved decision is excluded, never treated as negative (treating it as negative biases the rate down; Dal Pozzolo et al., 2018, on verification latency). For chargebacks, where 120 days is long, a survival-weighted estimate may be used for monitoring only: weight each open case by the empirical probability that a chargeback, if one comes, would already have arrived.

**Leakage rules (tested, section 8.3).**
1. Point-in-time joins only: every feature row carries `as_of`; a feature built from an event with `occurred_at > decided_at` is a test failure.
2. No feature may encode the decision or its consequences (`was_asked_to_confirm`, `prepaid_because_risk`).
3. Splits are by time with a gap of at least M between train and validation, and users that appear in the validation period are not up-weighted in training.
4. Overrides: a human `OVERRIDE_ALLOW` that later delivers is a normal negative. A human `REVIEW_UPHELD` is not a positive label by itself (it is a judgement, not an outcome).
5. Exploration decisions keep their propensity so that they can be re-weighted (section 4.7).

---

## 4. Model choices

### 4.1 Supervised and unsupervised scorers compared

| Option | Complexity | Accuracy (expected) | Cost | Scalability | Explainability | Data need |
|---|---|---|---|---|---|---|
| A. Expert scorecard (fixed weights on binned features) | very low | low to moderate | ~0 | trivial | exact | none |
| B. Bayesian logistic regression with informative priors | low | moderate; good calibration by construction | low (CPU, minutes) | trivial at inference (dot product) | exact additive contributions | works from ~100 positives because priors carry the rest |
| C. GBDT (LightGBM) with monotone constraints, then calibrated | moderate | high on tabular fraud data, usually best | low to moderate (CPU) | microseconds per tree ensemble in-process | TreeSHAP or path contributions; monotone constraints make directions auditable | needs about 1,000+ positives to beat B reliably [U] |
| D. Isolation forest / autoencoder (unsupervised) | moderate | unknown; finds "unusual", not "bad" | low (IF) to moderate (AE) | fine | poor (IF path length; AE reconstruction error) | none, but high false-positive risk |
| E. Explainable boosting machine (GA2M) | moderate | close to C on many tabular sets | moderate | fine | exact per-feature shape functions | similar to C |

**Choice:** stage the scorer by label volume (section 4.3): A plus B at launch, C as the target once labels exist, D only as a triage signal into human queues, never as an input to an automatic adverse action. B first because priors let it start with almost no labels and its contributions are exactly the reason codes; C later because GBDT is the standard winner on tabular fraud data and monotone constraints keep it auditable. E is the fallback if counsel requires exact global explanations that TreeSHAP cannot satisfy.

References: Chen and Guestrin, "XGBoost", 2016; Ke et al., "LightGBM", 2017 (monotone constraints are documented in both libraries); Liu, Ting and Zhou, "Isolation Forest", 2008; Lou, Caruana, Gehrke and Hooker, "Accurate intelligible models with pairwise interactions", 2013; Lundberg et al., "From local explanations to global understanding with explainable AI for trees" (TreeSHAP), 2020.

### 4.2 Graph methods compared

| Method | Finds | Complexity | Failure mode | Use here |
|---|---|---|---|---|
| Connected components (union-find), current E6 | any chain of shared identifiers | O(E α(V)) | chaining through hubs merges unrelated people (NAT, family, office) | keep, but on the weighted, hub-suppressed `link()` graph (section 3.2.2) |
| Label propagation (Zhu and Ghahramani, 2002) | soft membership spreading from labelled nodes | O(E · iterations) | needs labels; can oscillate; spreads guilt widely | not used: PPR gives the same with better control |
| Personalised PageRank from confirmed-bad seeds (Page et al., 1999; push algorithm of Andersen, Chung and Lang, 2006) | proximity to known fraud | local push O(1/(α·ε)) per seed set | guilt by association hits innocent housemates | **feature only** (`linked_bad_mass`), capped, monotone; never a sole reason code for an adverse action |
| Louvain (Blondel et al., 2008) / Leiden (Traag, Waltman and van Eck, 2019) community detection | dense groups of linked accounts | near-linear | Louvain can return disconnected communities; resolution limit | **Leiden**, nightly, to generate candidate rings |
| Dense-subgraph detection, FRAUDAR (Hooi et al., 2016) on bipartite user × target graphs | coordinated groups hitting the same codes, stores or referral codes, robust to camouflage | O(E log V) greedy peeling | needs a meaningful bipartite target | **yes** for referral codes, promo codes and review targets |

**Choice:** online, use 1-hop and 2-hop aggregates plus the weighted components (bounded cost, deterministic); offline nightly, run Leiden on the user–user link graph and FRAUDAR on user × {referral_code, promo_code, store-reviewed} graphs, and send ranked candidate rings to the T&S queue. Rings are acted on only after a human moves the case to `CONFIRMED`. Offline community methods are cheap at this graph size and their output is reviewed by people, so their false positives cost reviewer time, not customer harm.

**PPR parameters [U].** Restart α = 0.15, push tolerance ε = 1e-4, seeds = users with a confirmed-bad label in the last 180 days weighted by `2^(−age/90d)`, graph = bipartite user–identifier with edge weights `w(s,i,t)` and hub identifiers (deg > D) removed. Feature = `r(u)` normalised by the seed mass; capped at the 99th percentile of non-seed users.

**Ring candidate score (Leiden community C) [U], used only to rank the human queue:**
```
z(C) = -4.0 + 1.2*log2(|C|) + 2.0*share_accounts_younger_30d + 2.5*share_sharing_payment_fp
       + 1.5*share_with_reward_or_first_order_offer + 1.0*density(C) + 2.0*cod_refusal_share
rank by sigmoid(z(C)); open a case when sigmoid(z) >= 0.5 and |C| >= 4
```

**FRAUDAR objective (as published).** For a node set S on a bipartite graph with column-weighted edges, `g(S) = f(S)/|S|` with `f(S) = Σ_{(u,t)∈E(S)} 1/log(deg(t) + 5)`; greedily remove the node with the smallest marginal contribution and keep the best `g` seen. The column weighting makes it costly for a ring to hide by adding edges to popular targets.

### 4.3 Decision rule by label volume (launch-stage marketplace)

Let `P_uc` = matured positive labels for a use case in the last 12 months and `N_uc` = matured outcomes.

| Stage | Entry condition [U] | Scorer | Enforcement allowed |
|---|---|---|---|
| S0 pre-launch and first weeks | `P_uc < 100` | hard rules (L1) + expert scorecard A (shadow only) + isolation forest triage to human queues | hard rules only |
| S1 early | `100 ≤ P_uc < 1,000` and ≥ 3 monthly cohorts | Bayesian LR (B) with Gaussian priors centred on the expert weights, σ = 0.5 on standardised features [U]; Platt calibration | friction actions from the model; adverse actions only from hard rules |
| S2 established | `P_uc ≥ 1,000`, ≥ 6 monthly cohorts, and C beats B on the time-split test by a bootstrap 95% CI on cost (section 8.1) | GBDT (C) with monotone constraints; isotonic calibration if the calibration fold has ≥ 1,000 positives, else Platt | model adverse actions under the FPR budget (section 4.5), after 4 weeks of shadow |

Demotion: a model drops one stage automatically if PSI on the score exceeds 0.25, ECE exceeds 2× its acceptance value for 7 days, or the estimated good-user adverse rate exceeds the budget (section 8.4).

**Bayesian priors for rates.** For any per-entity rate (refusal, return rejection, seller cancellation) the shrunk estimate is the Beta–Binomial posterior mean `r̂ = (k + m·r0)/(n + m)`, with `Beta(k + m·r0, n − k + m·(1 − r0))` for credible bounds. Example: a new user with 1 refusal in 1 COD attempt, `m = 10`, `r0 = 0.20`: `r̂ = 3/11 = 0.27`, not 1.0. The prior `r0` is per segment only when the segment is not a protected proxy (section 7.2): for example per product category, never per governorate.

### 4.4 Calibration

- Fit on a held-out, time-later calibration fold, never the training fold.
- **Platt scaling** (Platt, 1999): `p = σ(a·s + b)`; two parameters, stable with few positives. **Isotonic regression** (Zadrozny and Elkan, 2002): non-parametric, overfits under about 1,000 calibration examples (Niculescu-Mizil and Caruana, 2005). Rule: isotonic only if the calibration fold has ≥ 1,000 positives [U], else Platt.
- Acceptance: ECE with 15 equal-mass bins ≤ 0.02 on the test fold [U] (Guo et al., 2017, for ECE); reliability diagram reviewed at model promotion.
- Calibration is checked separately on the explored population (section 4.7), because the allowed population is not representative of high scores.

### 4.5 Thresholds from cost-sensitive decision theory

For each decision `a` and calibrated refusal probability `p`, expected loss (piastres) is `L(a, p)`. The policy picks `argmin_a L(a, p)` subject to the budgets below (Elkan, 2001, for cost-sensitive thresholds).

**Cost terms (all [U]; the real values come from courier contracts VR-11, VR-RC-03 and the unit-economics model):**

| Symbol | Meaning | Placeholder |
|---|---|---|
| M | contribution margin of the order if delivered | 12% of order value |
| C_rto | cost of a refused COD parcel: outbound fee + return fee + handling + reservation opportunity cost + platform-funded first-refusal seller protection | 140 EGP |
| q_c | share of good customers who abandon when asked to confirm | 0.05 |
| e_c | share of would-be refusers who drop out at confirmation | 0.40 |
| q_p | good customers abandoning when asked to prepay the delivery fee | 0.20 |
| f | delivery fee recovered from a prepaying refuser | 60 EGP |
| e_p | would-be refusers who drop out when asked to prepay | 0.50 |
| q_o | good customers abandoning when COD is withdrawn (prepaid only) | 0.50 |

```
L(allow)        = p * C_rto
L(confirm)      = (1-p) * q_c * M + p * (1-e_c) * C_rto
L(prepay_fee)   = (1-p) * q_p * M + p * (1-e_p) * (C_rto - f)
L(prepaid_only) = (1-p) * q_o * M
```

Worked example, order of 1,200 EGP, M = 144 EGP:
```
L(allow)        = 140 p
L(confirm)      = 7.2 (1-p) + 84 p        = 7.2 + 76.8 p
L(prepay_fee)   = 28.8 (1-p) + 40 p       = 28.8 + 11.2 p
L(prepaid_only) = 72 (1-p)
crossovers: allow|confirm p = 0.114 ; confirm|prepay_fee p = 0.329 ; prepay_fee|prepaid_only p = 0.519
```
So, under these placeholder costs: allow below 11.4%, confirm to 32.9%, prepay the fee to 51.9%, prepaid-only above. The crossovers move with M, C_rto and the behavioural rates, which are unknown before launch; this is why S0 enforces only the spec's hard rules. `limit_value` is not chosen by this argmin; it is the hard-rule cap of H-COD-1/2. `block` is never chosen by the model.

All arithmetic runs in integers: `p` in bps, money in piastres, `L = (p_bps * C) / 10_000` with `floor`, ties broken toward the **less restrictive** action (so rounding can never create an adverse action).

**False-positive budget (§20.7: good users blocked < 0.5%).** Definition proposed (open decision L1): a *good user* is one whose matured outcome on the decision is "would have delivered"; the *adverse COD rate* is the share of good users' COD-eligible checkouts that received `prepaid_only` or `block` from the model. Friction (`confirm`, `prepay_fee`) is tracked under a separate *friction budget*: ≤ 10% of good users' COD checkouts [U].

Because outcomes of good users who were sent to prepaid-only are not observed, the adverse rate is estimated from the exploration sample (section 4.7) with inverse-propensity weights. Threshold rule (Neyman–Pearson style; Rigollet and Tong, 2011):
```
t_cost = lowest p at which prepaid_only is the argmin
t_fpr  = smallest t such that UCB95( FPR_good(t) ) <= 0.005, with FPR_good estimated by
         self-normalised IPS on the explored sample and a Clopper-Pearson upper bound
t_prepaid_only = max(t_cost, t_fpr)     # the stricter of the two always wins
```
If `t_fpr` cannot be estimated (too few explored outcomes: fewer than 300 explored good outcomes [U]), the model may not issue `prepaid_only` at all.

### 4.6 Uncertainty handling

A model's output is treated as uncertain when any of the following hold, and then the model decision is capped at friction (`require_confirmation`), never adverse:
- **Out of distribution:** more than 2 features outside the [0.5th, 99.5th] percentile range of training data [U], or an isolation-forest anomaly score above its 99th percentile.
- **Thin evidence:** effective history `n_eff < 3` orders [U] **and** the score is driven mainly by priors (prior-term contribution > 50% of the logit).
- **Score instability:** the bootstrap ensemble (5 models on resampled training sets [U]) disagrees across the prepaid-only threshold.

Principle: uncertainty can delay benefits (for example, a higher COD cap) but cannot impose penalties. For trust scores the same principle is applied by using the posterior mean for penalties and a lower credible bound for benefits (section 6.4).

### 4.7 Selection bias and the exploration policy

We observe COD outcomes only for orders we allowed; a model trained on them learns nothing about the people it restricts, and the restriction becomes self-confirming (the "reject inference" problem; Hand and Henley, 1993). Imputing outcomes for rejected customers is not reliable, so the design collects them with a small, capped, randomised relaxation (counterfactual evaluation in the sense of Bottou et al., 2013):

- **Eligible:** model decision is `prepaid_only` or `prepay_fee`, **no hard rule fired**, order value ≤ 1,500 EGP [U], user not explored in the last 90 days, user not in an open ring case.
- **Treatment:** relax by one step (prepaid_only → prepay_fee; prepay_fee → confirm). Never to `allow` from prepaid_only. Confirmation still applies.
- **Probability:** ε = 5% of eligible decisions [U]; selection `HMAC(K_explore, decision_key) mod 10_000 < ε_bps`, deterministic and idempotent.
- **Caps:** expected exploration loss per Cairo day `Σ L_relaxed − L_policy ≤ X EGP` (open decision M3; placeholder 2,000 EGP/day [U]); per store ≤ 20% of that cap; automatic stop when the realised refusal rate of explored orders over 14 days exceeds 2× its prediction.
- **Logging:** propensity `π0(a|x)` stored on the decision.
- **Estimators:** self-normalised IPS for policy value and FPR (Swaminathan and Joachims, 2015); doubly robust when the outcome model is good enough (Dudík, Langford and Li, 2011). Propensities are clipped at 1/ε to bound variance.
- **Fairness note:** exploration only ever relaxes a restriction, so it cannot treat anyone worse than the policy would have. It is still a randomised difference in treatment between similar customers and is listed in the DPIA (section 7.4) and as open decision L5.

---

## 5. Velocity, sequence and bot rules

### 5.1 Algorithms compared

| Algorithm | Exactness | Memory per key | Burst behaviour | Use |
|---|---|---|---|---|
| Sliding log (store each timestamp) | exact | O(limit) | exact | low-volume, money-critical limits: OTP sends, gift-card failures (already used, E11, E12) |
| Sliding-window counter (two fixed windows, weighted) | approximate, error bounded by one window's share | O(1) | smooth | high-volume per-key counts (API calls, searches) |
| Token bucket / GCRA | exact for rate + burst | O(1) (one timestamp) | allows burst B then rate r | per-route request rate limits |
| Leaky bucket as a queue | exact | O(queue) | smooths output | outbound SMS per prefix (pacing) |
| HyperLogLog distinct count | ±1.6% at 1.5 KB (precision 12) | O(1) | n/a | distinct fingerprints or accounts per IP/ASN at scale; exact sets below 64 elements |

**Choice:** GCRA for request rates (one Redis key, one Lua script, atomic), sliding log where exactness has money effect (already the case), sliding-window counters for velocity features, HLL only for high-cardinality distinct counts. Redis holds only ephemeral counters (ADR-0033); if Redis is down, money-critical limits fall back to the Postgres sliding log (already the gift-card design) and other limits **fail closed** for write routes and open for read routes [U].

Formulas:
```
GCRA (rate r per second, burst tolerance tau):  T = 1/r
  on request at time t: TAT' = max(TAT, t) + T ; allow iff TAT' - t <= tau + T ; if allowed TAT := TAT'
Sliding-window counter (window W, current window started at s):
  estimate(t) = c_prev * (W - (t - s)) / W + c_curr
Token bucket (equivalent view): tokens(t) = min(B, tokens(t0) + r*(t - t0)); allow iff tokens >= cost
Poisson anomaly on a count c in a window with EWMA baseline mu:
  alert iff c >= max(c_min, mu + z*sqrt(mu)), z = 4, c_min = 20   [U]
```
References: ATM Forum Traffic Management 4.0 (GCRA), 1996; RFC 2697, "A Single Rate Three Color Marker", 1999; Cloudflare, "How we built rate limiting capable of scaling to millions of domains", 2017 (sliding-window counter); Flajolet et al., "HyperLogLog", 2007.

### 5.2 Sequence rules

Sequences are encoded as small deterministic automata over typed events with time bounds (a rule is a regular expression over event types plus per-step time constraints), evaluated by the risk consumer on the outbox stream. Each match emits a feature (count in 30 d) and, for the listed ones, a hard rule.

| Id | Pattern [U] | Effect |
|---|---|---|
| SQ-1 | `signup → referral.attributed → checkout(COD, subtotal within 5% above the referral minimum)` within 30 min on a device with `accounts_on_device_90d ≥ 2` | feature; referral settlement `withheld_for_review` |
| SQ-2 | `order(BNPL) → return_requested` within 72 h after delivery, ×2 in 90 d | hide BNPL for 90 d (allowed by §B3: "the model can block BNPL for the user"); human review on request |
| SQ-3 | `promo redeemed → order cancelled before shipping → same promo redeemed` ×2 in 30 d | promo deny for that code (silent same wire shape) |
| SQ-4 | `delivered → review(5★) within 10 min` for ≥ 3 reviews from linked accounts on one store in 7 d | reviews `HELD`; ring case opened |
| SQ-5 | `gift_card.redeem_attempt(wrong)` from ≥ 20 distinct accounts in one /24 or ASN in 10 min | redemption from that /24 requires attestation tier ≥ 2 for 1 h; alert |

### 5.3 OTP and SMS pumping

Keep the existing per-phone and per-device sliding logs (E12). Add:
1. **One prefix definition.** Budget bucket = calling code + the 2-digit mobile operator prefix (`+2010`, `+2011`, `+2012`, `+2015`). Choose this (matches `budgetPrefix` in `sms.ts`) and set `OTP_POLICY.prefixLength` to match, or document why the 6-digit prefix is used for anomaly features only (open decision O4). Engineering fix, not a money decision.
2. **Mobile ranges only.** Reject OTP to Egyptian non-mobile ranges (landline, premium) before any send. This removes the main pumping surface for an EG-only launch. The list of valid mobile prefixes is VERIFY with the SMS vendor and NTRA numbering (VR-FRT-06).
3. **Per-prefix hourly budget:** `B_b(h) = max(B_min, ceil(k · Q95_b(how)))` where `Q95_b(how)` is the 95th percentile of verified sends for bucket b in the same hour-of-week over the last 28 days, `k = 3`, `B_min = 200` [U]. Pre-launch, before history exists, a flat `B_min` per bucket applies.
4. **Conversion guard:** over a sliding hour per bucket, if sends `s ≥ 50` and verifications `v/s < 0.30` [U], halve the bucket's budget for the next hour and alert; two consecutive hours, route the bucket to WhatsApp OTP only and page on-call.
5. **Global spend breaker:** daily SMS spend ≥ 150% of the 28-day daily median [U] stops SMS OTP (WhatsApp fallback remains) and pages.

### 5.4 Gift-card brute force

Keep E11. Add a distributed detector: platform-wide failed redemptions per minute vs EWMA (Poisson rule of 5.1); on alert, require attestation tier ≥ 2 on redemption for 1 h [U] and raise to Security. With 16-character Crockford base32 codes (80 bits), the per-account limits make guessing infeasible; the detector is about credential-stuffed accounts and account farms, not code entropy.

### 5.5 Card-testing detection (SAQ A constraints)

Card data never reaches Z-OUTLET (§B8), so detection uses only what the PSP returns: outcome, decline code, card fingerprint, brand, last4 and, if the PSP provides it, the BIN (VERIFY, VR-FRT-05; storing BIN is not required and should be avoided unless needed). Attempts happen on the PSP's hosted page, so Z-OUTLET controls the *number of payment intents and retries* it creates.

| Rule | Window [U] | Key | Condition | Action |
|---|---|---|---|---|
| CT-1 | 1 h / 24 h | account | ≥ 3 distinct fingerprints attempted in 1 h, or ≥ 5 in 24 h | card method blocked for the account 24 h (`method_block`), other methods stay |
| CT-2 | 1 h | device | ≥ 3 distinct fingerprints across any accounts | card method blocked for the device 24 h |
| CT-3 | 1 h | IP (/32, /64) | ≥ 10 distinct fingerprints | `step_up` (force 3-DS challenge where the PSP supports it) for that IP 1 h |
| CT-4 | 10 min | platform | `n ≥ 50` attempts and `z = (d − n·p0)/sqrt(n·p0·(1−p0)) ≥ 5`, where d declines and p0 the EWMA decline rate | incident: halve CT-1..3 thresholds automatically for 1 h; alert; the human decides whether to block `kill.gift_card_sales` (gift cards are the cash-out target) |
| CT-5 | 24 h | account | ≥ 3 distinct BINs (only if BIN is available) | feature for `checkout_payment` |
| CT-6 | per order group | order group | > 3 new payment intents for one order group | stop creating intents; ask the shopper to contact support |

Gift-card purchases already require 3-DS above 2,000 EGP with new cards (§15.1).

### 5.6 Bot signals on mobile

App Attest and Play Integrity are **attestation** (is this a genuine app on a genuine device?), not behaviour scoring. They are one input among several. Signals, all collected server-side or from the app's own requests, no third-party SDK:

| Signal | Source | Note |
|---|---|---|
| attestation tier | App Attest assertion validity and counter monotonicity; Play Integrity verdict tiers (ADR-0026) | a non-increasing App Attest counter means replay |
| App Attest receipt risk metric | Apple fraud-assessment receipt | VERIFY that the receipt's metric (attested keys per device in a period) is available to us and how it is refreshed (VR-FRT-07) |
| Play Integrity recent device activity | Play Integrity standard request | VERIFY field availability and tiers (VR-FRT-07) |
| accounts per attested key, keys per account | own tables | many accounts on one key = farm |
| request cadence | server timestamps: coefficient of variation of inter-request intervals in a session | scripted clients have low variance |
| API order violations | e.g. `POST /v1/checkout` without a prior quote, drop PDP without feed or deep link | |
| client version and header anomalies | own tables | |
| hosting ASN | offline ASN table | |
| time from app foreground to purchase | app event (consent-free strictly-necessary security telemetry, VERIFY with DPO) | |

Not collected: touch dynamics, keystroke timing, sensor data, contact lists. They add little over the above and raise proportionality questions under the PDPL.

Bot score (S0 scorecard [U]): `z = −3 + 2.5·[attestation_tier = 0] + 1.5·[attestation_tier = 1] + 2.0·[asn_is_hosting] + 1.5·[cadence_cv < 0.15] + 2.0·[api_order_violation] + 1.0·log2(1 + accounts_on_key_30d − 1)`, `botScoreBp = floor(10_000·σ(z))`. Consumers: ads `classifyClick` (already accepts it), waiting-room admission (deprioritise above 7,000 bps, deny above 9,000 bps together with an attestation failure [U]), OTP (delay above 7,000 bps).

---

## 6. Trust scores

Common machinery for all three scores:
- **Decayed counts:** `n_eff = Σ_j 2^(−Δt_j/h)`, `k_eff` likewise, over a hard window (90 d for sellers, 365 d for buyers [U]).
- **Shrinkage:** `r̂ = (k_eff + m·r0)/(n_eff + m)` with category-level priors `r0` (never governorate, section 7.2).
- **Component mapping:** each component maps to 0..100 by a clamped linear ramp between a *floor* (0 points) and a *target* (100 points).
- **Integer arithmetic** at the boundary; scores are integers 0..100; computed in `packages/domain/src/risk/trust/` (pure, mutation-tested).
- **Reason codes:** the components furthest below target, with numerator, denominator, window and the event ids that can be appealed.

### 6.1 Weights are untuned

Every weight, floor and target below is **[U]**: an engineering proposal to start shadow computation, with no data behind it. Owner decisions on them are listed in section 11.

### 6.2 Seller Health Score (SHS, §19)

Components (spec §19 list: dispatch SLA, cancellations, return rate, rating, Price Trust Score), half-life 45 d, window 90 d:

| Comp. | Rate | Prior r0, m | Floor → target | Weight |
|---|---|---|---|---|
| s_D dispatch | on-time dispatch / accepted orders (late caused by a courier pickup failure excluded on evidence) | 0.95, 20 | 0.80 → 0.98 | 0.30 |
| s_C cancellation | seller-caused cancellations (rejected_by_seller, accept SLA miss, no-stock) / paid orders | 0.03, 20 | 0.15 → 0.01 | 0.25 |
| s_R returns | seller-fault returns (defective, not as described, wrong item) / delivered, divided by the category baseline b_cat | ratio 1.0, 20 | 2.5 → 0.5 | 0.15 |
| s_Q rating | Bayesian average `Q̂ = (Σ stars + 10·μ)/(n + 10)`, μ platform mean | — | 3.0 → 4.7 | 0.10 |
| s_P price trust | Price Trust Score (section 6.3) | — | 0 → 100 | 0.20 |

```
ramp(x, floor, target) = 100 * clamp((x - floor) / (target - floor), 0, 1)   # works for decreasing targets too
SHS = round(0.30*s_D + 0.25*s_C + 0.15*s_R + 0.10*s_Q + 0.20*s_P)
provisional (shown "Not enough data", score null) while n_eff(paid orders) < 10
```
Rating has the lowest weight because ratings are the easiest component to farm (section 3.5.2) and arrive slowly. Return rate uses only seller-fault reasons and is relative to the category, because apparel return norms differ by category and the shopper's own change of mind is not the seller's failure. Badges keep the existing thresholds (good ≥ 80, fair ≥ 50, poor), E9. For ranking, a provisional store uses the prior score (the formula evaluated on priors only, about 85 with the values above) and the existing new-seller exploration.

Optional non-compensatory guard (open decision O6): if any component is below 20, cap SHS at 49 so excellent ratings cannot hide a dispatch collapse.

### 6.3 Price Trust Score v2 (§9.4, shadow next to v1)

```
violation severity sev [U]: claim_exceeds_vrp 5, cross_channel_cheaper unresolved after 48 h 10,
                            pre_drop_inflation 10, duplicate-listing history reset 15, severe 30
V   = min(80, Σ_{v in 90 d} sev(v) * 2^(-age(v)/30 d))
ĉ   = (corrected + 20*c0) / (evaluated + 20),  c0 = category auto-correction prior (0.05 placeholder)
PTS = clamp(100 - floor(V) - 5*min(openCrossChannel, 3) - floor(20*ĉ), 0, 100)
```
Differences from v1 (E8): severity instead of a flat 10 per violation; decay inside the window, so old violations count less; shrinkage, so one bad claim out of one evaluated costs about 1 to 2 points instead of 20. The anomaly model of §9.4 (isolation forest and robust z on claimed vs verified discount) produces **investigation cases**, not score points, until labels exist (stage S2 of section 4.3). v2 runs in shadow beside v1; promotion requires the comparison report of section 8.1 and an owner decision (O7), because it changes enforcement inputs.

### 6.4 Buyer Reliability Score (BRS, internal)

Purpose: grant benefits (higher COD caps, skipping confirmation) to proven customers, and feed the COD model. It is **never shown to sellers**, never used for ranking, ads or promotions targeting.

Per behaviour k ∈ {COD refusal, abusive return (inspection rejected and dispute lost), chargeback}: `Beta(a_k, b_k)` posterior with priors `r0_k`, `m_k = 10` [U], window 365 d, half-life 180 d.
```
reliability = Π_k (1 - w_k * r_k),   w = {refusal: 1.0, abusive_return: 0.5, chargeback: 1.0}  [U]
BRS_penalty = floor(1000 * reliability evaluated at the posterior means)          # used as a model feature
BRS_benefit = floor(1000 * reliability evaluated at the 10th percentile, by Monte Carlo
              with a fixed seed derived from user id and as_of)                   # used to grant benefits
```
Benefit tiers proposed (money decision M1): COD cap 1,500 → 3,000 after 2 delivered (spec); 3,000 → 5,000 when `BRS_benefit ≥ 800` and ≥ 5 delivered [U]; skip confirmation when `BRS_benefit ≥ 850` [U]. The serial-returner rule (E10) stays a separate, published, unshrunk rule because it is policy that customers can read.

### 6.5 Store trust ladder (seller enforcement state machine)

| From | Trigger | To | Effect | Human? |
|---|---|---|---|---|
| NORMAL | SHS < 50 for 14 d, or price-integrity "3 violations in 90 d" | WATCH | seller notified with reason codes; ranking demotion per §20.4 weights | no |
| WATCH | SHS < 35 for 14 d, or a severe price event, or counterfeit takedown upheld | RESTRICTED | drops blocked 30 d (§9.5), no new listings, Verified badge removed | no (automatic, reversible) |
| RESTRICTED | severe or repeat (§9.5), ring CONFIRMED with store staff, or 2nd upheld counterfeit | SUSPENSION_PENDING_REVIEW | storefront hidden; payout hold **per Seller Agreement only** | human review within 5 business days (§9.5) |
| SUSPENSION_PENDING_REVIEW | reviewer confirms | SUSPENDED | | yes |
| SUSPENSION_PENDING_REVIEW | reviewer rejects or SLA breached | RESTRICTED (or NORMAL) | storefront restored | yes / SLA |
| WATCH, RESTRICTED | metrics recover above the entry threshold + 5 points for 14 d | previous level | | no |
| any | appeal upheld | recomputed state | | yes |

Conservative default pending VR-15: the system never moves a store to `SUSPENDED` without a human; the automatic maximum is `SUSPENSION_PENDING_REVIEW`, and a breached review SLA **restores** the storefront rather than leaving it hidden. Whether the payout hold may start before human review is a money and legal decision (M4, L3). This interpretation is stricter than §9.5's "store auto-suspended"; it is recorded as Proposed.

### 6.6 Explainability, appeals and fairness for trust scores

- `GET /v1/seller/health` returns score, band, each component's value, numerator, denominator, window, target, and the top three reason codes in Arabic and English (for example `dispatch_late: 7 of 60 orders dispatched after 48 h; target 98%`).
- Appeals are **event-level**: the seller disputes specific events (an order marked late that the courier failed to pick up) with evidence. An upheld appeal excludes the event and recomputes deterministically; the score history keeps both versions.
- Fairness checks for sellers: score distributions and WATCH/RESTRICTED rates by store kind (local vs global), store age and category, reviewed quarterly; a gap above 1.25× between groups with comparable underlying outcomes [U] triggers a review of floors, targets and priors.
- Seller identity, ownership demographics and location are not inputs.

---

## 7. PDPL, profiling and fairness

### 7.1 Legal position (VERIFY throughout)

- Risk scoring is profiling of natural persons and produces automated decisions with significant effect (withdrawing COD, BNPL, rewards; suspending a seller's store). Whether Law 151/2020 and Decision 816/2025 give a right not to be subject to solely automated decisions, require a specific lawful basis, or require prior PDPC consultation is **not verified** (VR-FRT-01). The DPIA already marks legitimate interest as unverified (`dpia-fraud.md` §2).
- Conservative default adopted here, modelled on GDPR Art. 22 safeguards as a comparator (not as Egyptian law): a human-review path for every adverse action; a model alone never blocks, suspends or holds money (section 2); explanations; the right to contest.

### 7.2 Prohibited inputs and proxies

Never model inputs: gender, religion, nationality, ethnicity, health, disability, marital status, exact age or DOB (`age_band` is used only for the legal capacity gates of §B6, never for risk), name or name-derived features, photos, size measurements, budget data, stylist or browsing history, consent choices, language preference, device model or price tier (a wealth proxy), **governorate, city, district or postcode** (location is a socioeconomic and regional proxy), phone operator prefix.

Allowed with monitoring: `address_quality` (it can correlate with informal settlements; it may trigger only friction, never adverse action, H-COD-6), `hour_bucket`, `attestation_tier` (correlates with Android vs iOS, so monitored by platform), `asn_is_hosting`.

Enforcement: a schema allow-list for feature vectors per model version (a feature outside the allow-list fails the build); a dependency-cruiser rule that `budget`, `sizing`, `stylist`, `history` and `analytics-ingest` modules cannot be imported by the risk module (extends the existing budget lint of §12).

**Fairness audit attributes** (used only in offline audits, never as inputs, access restricted to the DPO and the risk lead): governorate (from the delivery address), platform, account age band. Metrics per group: adverse-action rate, friction rate, and (from the exploration sample) false-positive rate on good users. Trigger for review: any group's adverse rate below 0.8× or above 1.25× of the overall rate after adjusting for observed outcome rates [U]. The four-fifths figure is a US employment heuristic (Uniform Guidelines on Employee Selection Procedures, 1978) used here only as a review trigger, not a legal test. Equalised false-positive rates across groups (Hardt, Price and Srebro, 2016) are the target metric, because a fraud false positive is the harm customers experience.

### 7.3 Explanations, human override, data minimisation

- **Shopper-facing:** a short generic reason ("Cash on delivery isn't available for this order. You can pay online, or ask us to review this decision.") plus a review request button. Exact signals are not disclosed to shoppers, to limit gaming; whether the PDPL access right requires more detail is VERIFY (VR-FRT-01). The DSAR export includes the person's risk decisions with decision, date and reason category.
- **Internal:** full reason codes (top contributions: exact for LR, TreeSHAP for GBDT computed at decision time for the top 3 features), rules fired, model and policy versions.
- **Human review:** `POST /v1/me/risk/review-requests`; SLA 2 business days [U] for shoppers; reviewer sees the minimum needed (decision, reason codes, order facts), and every PII view is logged with a reason code (existing `pii-views`).
- **Minimisation:** only `fraud_prevention`-purpose fields; identifiers stored as keyed HMACs; feature snapshots store values, not raw events; IP stored only as HMAC; no third-party data.
- **Retention:** decisions, features and graph edges under `fraud_signals` (24 months rolling, proposed, VERIFY); training snapshots pseudonymised and purged with the same horizon; models trained on purged data are retired within one training cycle of the purge (open decision L6). On erasure: the data inventory says pseudonymise; this spec keeps keyed identifier hashes of a deleted account for the retention period only so that a deleted fraudster cannot re-register cleanly (needs DPO and counsel confirmation, L2).

### 7.4 DPIA entry (to be added to `docs/privacy/dpia-fraud.md` by its owner, the DPO)

Processing description (sections 3–6 of this spec), data list (section 10 tables), new risks to add: R7 randomised exploration treats similar customers differently (mitigation: relax only, caps, logging); R8 graph guilt by association (mitigation: hub suppression, PPR feature-only, human-only ring confirmation); R9 keyed identifiers retained after erasure (mitigation: retention bound, purpose lock); R10 seller-side automated restrictions (mitigation: ladder in 6.5, human review before suspension); R11 model drift causing unfair outcomes (mitigation: PSI, fairness audit, automatic demotion). Review triggers: new feature, new model stage, any change to section 4.5 budgets.

---

## 8. Evaluation, testing and rollout

### 8.1 Offline backtests

- **Time split:** train on months [1..t], calibrate on month t+1, test on month t+2, with a gap ≥ label maturity M between folds; rolling-origin over at least 3 origins.
- **Metrics:** PR-AUC (prevalence is low; Saito and Rehmsmeier, 2015); recall at the operating point; expected cost per 1,000 COD orders under the cost matrix of 4.5, with cost curves over a range of C_rto and M (Drummond and Holte, 2006); ECE and Brier score; good-user adverse rate and friction rate by IPS on explored data; fairness metrics of 7.2.
- **Champion vs challenger:** promote only if cost improves with a bootstrap 95% CI excluding zero, ECE within acceptance, adverse rate within budget, and no fairness metric worse by more than 10% relative [U].

### 8.2 Stability

`PSI = Σ_i (a_i − e_i) · ln(a_i / e_i)` over 10 equal-mass bins of the expected (training) distribution, with ε = 1e-4 added to empty bins. Alert at PSI > 0.10, demote at PSI > 0.25 (common industry heuristics; Yurdakul, 2018). Computed daily for the score and for each top-20 feature.

### 8.3 Tests (Definition of Done)

**Property tests (fast-check in TS domain, Hypothesis in the Python training code):**
1. Monotonicity: increasing any feature declared ↑ (with all else fixed) never lowers the score; for every model artefact, checked on 10,000 random vectors per feature.
2. Decision monotonicity: a higher calibrated `p` never yields a less restrictive decision, for any cost-matrix configuration that passes validation.
3. Determinism: same `(inputs, policy_version, model_version)` gives a bit-identical score in bps and the same decision, across 1,000 runs and across the TS evaluator vs the Python reference implementation (golden vectors).
4. Idempotency: a repeated `decision_key` returns the stored decision without recomputation; exploration selection is stable under replay.
5. Hard rules dominate: the final decision is never less restrictive than the hard-rule decision; exploration never relaxes a hard rule.
6. `block` unreachable without a hard-rule reason; every adverse decision has ≥ 1 reason code.
7. Feature allow-list: no prohibited feature (7.2) appears in any model's input schema; point-in-time: no feature `as_of` later than the decision.
8. Exploration caps: the sum of the expected exploration loss never exceeds the daily cap under arbitrary arrival sequences.
9. Trust scores: SHS, PTS v2, BRS in 0..100 (or 0..1000); monotone in their adverse inputs; shrinkage converges to the raw rate as n grows; an upheld appeal never lowers a score.
10. Graph: adding a hub identifier (deg > D) never merges components; link strength is symmetric.

**Coverage and mutation:** domain ≥ 90% lines; StrykerJS ≥ 80% on `packages/domain/src/risk/**` (policy, rules, trust, machines, exploration selection). **Authorization tests** on every endpoint of section 10.2, including shopper A → shopper B decision = 404, seller → admin risk route = 403, seller A → seller B health = 403/404 per the existing policy pattern.

### 8.4 Adversarial simulation (synthetic ring generator)

A seeded generator in `apps/ml-services/risk/sim/` produces synthetic users, devices, cards, addresses, IPs and event streams, with ground truth. It runs in CI on every model or rule change.

| Parameter | Range [U] |
|---|---|
| ring size | 3–60 accounts |
| identifiers shared inside the ring | per kind probability: device 0.0–0.8, payment_fp 0.0–0.6, address 0.0–0.9, IP 0.2–1.0 |
| device reset rate (new install id per account) | 0–1 |
| camouflage | each ring account adds 0–20 legitimate-looking orders and 0–5 edges to popular identifiers (hub IPs, popular stores) |
| targeting | referral codes, first-order promo, COD refusal, review farming, gift-card redemption |
| timing | burst (minutes) to slow (weeks) |
| **hard negatives (legitimate)** | families of 2–6 sharing a device and address; dormitories and compounds (address shared by 10–200 users, no shared cards); office Wi-Fi and CGNAT IPs shared by 50–5,000 users; one card used by a parent for 2 adult children |

Acceptance [U]: at the operating point, ring recall ≥ 0.8 for rings of size ≥ 5 with device or card sharing ≥ 0.3; hard-negative adverse rate ≤ 0.5%; no family of ≤ 6 merged into a component larger than 6 by the linking rule.

### 8.5 Rollout and kill switches

Phases per use case: **shadow** (score and log, no effect; ≥ 4 weeks and ≥ the stage minimum of 4.3) → **friction-only** → **enforcement** (adverse actions within budgets). Each phase change is an owner-approved, audited flag change.

New registry entries (allowed-when-true, default **blocked**, fail closed, ADR-0028 wording "Allowed / Blocked"):

| Key | Allowed means | Blocked means (default) |
|---|---|---|
| `kill.risk.cod_model` | model contributes to COD decisions | COD decided by hard rules H-COD-* only |
| `kill.risk.enforcement` | model may issue adverse actions | model limited to friction (shadow for adverse) |
| `kill.risk.exploration` | exploration policy active | no exploration |
| `kill.risk.graph_features` | graph features computed and used | graph features absent (models fall back to their no-graph variant) |
| `kill.risk.bot_score` | bot score produced | `botScoreBp = null` (consumers already treat null as "no signal") |
| `kill.risk.seller_auto_restrict` | store ladder may move stores automatically | ladder computed and shown to ops only |
| `kill.risk.card_testing_auto_tighten` | CT-4 auto-halving active | CT-4 alerts only |

Note on "fail closed" for risk: a failure of the risk system must not silently allow everything nor block everyone. The degraded behaviour is "hard rules only", which is the spec's own policy table (section 9.5). `kill.payment.cod` stays the master switch for COD.

---

## 9. Runtime architecture

### 9.1 Where scoring runs

| Option | Latency | Ops cost | Determinism | Failure blast radius |
|---|---|---|---|---|
| A. Python FastAPI scoring service called from checkout over HTTP | +5–20 ms network p95 [U], plus a dependency | another service on the checkout path | depends on two runtimes | checkout depends on ML service availability |
| B. In-process TS evaluator of exported models (LR coefficients, GBDT trees as JSON) inside the API | < 2 ms [U] | none extra | single runtime; golden vectors vs Python reference | none beyond the API |

**Choice: B for synchronous decisions, Python for training and batch graph jobs.** The checkout path keeps one runtime and no extra network hop, and determinism is easier to test. The model artefact is a signed JSON file (SHA-256 recorded, cosign-signed per ADR-0015), loaded at boot and on promotion; the evaluator refuses an artefact whose hash is not the registered one.

Latency budget for `assessCod` (called at quote and at commit): p95 ≤ 25 ms, hard timeout 50 ms [U]. On timeout or error: degraded decision = hard rules only, reason `risk_degraded`, metric incremented.

Asynchronous paths: referral settlement, review moderation, ring detection, trust scores, label maturation, PSI and fairness jobs (nightly, in low-carbon windows where SLAs allow, §T10).

### 9.2 Feature store

- **Online:** Postgres tables of per-entity counters and aggregates (`risk_entity_features`), updated by idempotent outbox consumers (inbox dedup, A2.7) on `order_group.*`, `shipment.*`, `return.*`, `referral.*`, `voucher.*`, `auth.*` events. Short-window velocity counters in Redis (ephemeral, rebuildable). Reads at decision time are a single indexed lookup per entity.
- **Offline:** daily point-in-time snapshots (`as_of` partitions) in the warehouse of ADR-0002's region; the same feature definitions (one source in `packages/domain/src/risk/features/definitions.ts`, mirrored by a generated Python module) so training and serving cannot drift.
- **Training-serving skew test:** a daily job recomputes yesterday's online features offline and fails on any mismatch above 0.1% of rows [U].

### 9.3 Numeric determinism

The evaluator sums tree outputs in a fixed order (tree index ascending) in IEEE-754 doubles, applies calibration, and quantises once: `p_bps = floor(p * 10_000)`. Policy arithmetic is integer only. Golden-vector tests pin outputs for each artefact.

### 9.4 Decision record and audit

Every decision writes, in the same transaction as the business effect where one exists:
- a `risk_decisions` row (section 10.1), with `feature_snapshot_hash = SHA-256(canonical JSON of the feature vector)`;
- an `audit_log` entry (hash-chained, A2.9) for every adverse decision, every override, every model or policy promotion and every exploration selection;
- an outbox event `risk.decision_made` (ids, use case, decision, policy and model version, no features).

### 9.5 Degraded-mode matrix

| Dependency down | Behaviour |
|---|---|
| risk evaluator error or timeout | hard rules only; `risk_degraded` |
| Redis | velocity features from Postgres sliding logs where they exist; other velocity features missing → the model's missing-value path (trained in) ; write-route limits fail closed |
| feature store stale > 15 min [U] | hard rules only for adverse actions; model friction still allowed |
| graph job failed | graph features from the last successful run if < 48 h old, else absent |
| model artefact hash mismatch | refuse to load; previous artefact stays; alert |

### 9.6 Admin dashboards (what ops see)

Extends the admin metric catalogue section F (F1–F4) and G2/G3:
1. **Decisions:** volume by use case and decision, adverse and friction rates vs budgets, rule hit rates, model vs rule share, degraded rate, latency p95.
2. **Outcomes:** COD refusal rate by score band and decision (F1), calibration plot (predicted vs observed) on matured labels, exploration sample size and estimated good-user adverse rate with CI.
3. **Drift:** PSI per score and top features; training-serving skew.
4. **Cases:** ring queue with candidate score, size, shared identifiers (as hashes and counts, not raw values), SLA aging; review-request queue with 2-business-day SLA; overrides log.
5. **Fairness panel** (DPO and risk lead only): group rates of 7.2.
6. **Sellers:** SHS distribution (G2), ladder state counts, suspension queue aging vs 5 business days (G3, exists), appeal outcomes.
7. **Abuse rails:** OTP prefix budgets and conversion ratios, SMS spend, gift-card failure rates, card-testing incidents, bot score distribution in drops.
Each entity drill-down is a PII view (reason code required, logged).

---

## 10. Data model and API contracts (proposals for the builder)

### 10.1 Tables (new migration, expand only; RLS: system writes, ops/trust_safety/dpo read by role)

| Table | Key columns | PII |
|---|---|---|
| `risk_identifiers` | `id uuid`, `kind`, `hmac bytea(32)`, `key_version smallint`, `first_seen_at`, `last_seen_at`; UNIQUE (kind, key_version, hmac) | P2 (one-way keyed) |
| `risk_edges` | PK (`subject_type`, `subject_id`, `identifier_id`), `first_seen_at`, `last_seen_at`, `n_obs`, `source` | P2 |
| `risk_decisions` (supersedes the inventory's `risk_assessments` name; rename the inventory entry) | `id uuidv7`, `decision_key` UNIQUE, `use_case`, `subject_type`, `subject_ref`, `state`, `decision`, `limit_amount bigint NULL`, `score_bps int NULL`, `reason_codes text[]`, `rules_fired text[]`, `policy_version`, `model_version NULL`, `feature_snapshot_hash char(64)`, `features jsonb` (allow-listed), `explored bool`, `propensity_bps int NULL`, `degraded bool`, `latency_ms int`, `created_at` | P2 |
| `risk_outcomes` | PK (`decision_id`, `label_type`), `value smallint`, `matured_at`, `source_event_id` | P2 |
| `risk_cases` | `id`, `kind` (ring, review_request, seller_ladder), `state`, `subjects jsonb` (ids only), `candidate_score_bps`, `opened_at`, `sla_due_at`, `resolved_by`, `resolution_code` | P2 |
| `risk_overrides` | `id`, `decision_id`, `actor_id`, `reason_code`, `approved_by NULL`, `created_at` | P2 |
| `risk_models` | `version`, `use_case`, `stage`, `artefact_sha256`, `model_card_uri`, `approved_by[]`, `promoted_at` | P1 |
| `risk_entity_features` | PK (`entity_type`, `entity_id`), `features jsonb`, `as_of`, `version` | P2 |
| `seller_health_snapshots` | PK (`store_id`, `as_of`), `score NULL`, `components jsonb`, `n_eff`, `formula_version` | P1 |

All new columns must be tagged in `data_inventory.yaml` (CI fails otherwise).

### 10.2 API (all `/v1`, Problem+JSON, cursor pagination)

| Method and path | Auth | Idempotent | Rate limit [U] |
|---|---|---|---|
| internal `RiskPort.assess(useCase, subject, context, decisionKey)` | service | yes (decision_key) | n/a |
| `GET /v1/admin/risk/decisions?use_case=&decision=&from=&cursor=` | ops, trust_safety, dpo | read | 60/min |
| `GET /v1/admin/risk/decisions/{id}` | trust_safety, dpo; PII view logged | read | 60/min |
| `POST /v1/admin/risk/decisions/{id}/override` | trust_safety; dual approval above threshold (M7) | `Idempotency-Key` | 20/min |
| `GET /v1/admin/risk/cases`, `POST /v1/admin/risk/cases/{id}/transition` | trust_safety | key required on POST | 60/min |
| `GET /v1/admin/risk/metrics?panel=` | ops, trust_safety, dpo (fairness panel: dpo and risk lead only) | read | 30/min |
| `GET /v1/admin/risk/models`, `POST /v1/admin/risk/models/{version}/promote` | security + trust_safety, dual approval | key required | 5/min |
| `POST /v1/me/risk/review-requests {decision_ref}` | shopper, self | key required | 5/day |
| `GET /v1/seller/health` | seller grant `read` | read | 60/min |
| `POST /v1/seller/health/appeals {event_ids[], evidence_upload_ids[]}` | seller manager or owner | key required | 10/day |

Events (outbox, ids and enums only): `risk.decision_made`, `risk.override_applied`, `risk.case_opened`, `risk.case_resolved`, `risk.model_promoted`, `seller_health.updated`, `store_trust.state_changed`.

### 10.3 Builder handoff (testable plan, tiers per the user's global rules)

| Step | Work | Tier | Test gate |
|---|---|---|---|
| 1 | `packages/domain/src/risk`: decision ordering, hard rules H-COD-*, cost policy (4.5), exploration selection, state machines (3.4), trust formulas (6) | builder (Sonnet) after this spec is approved; chief-reviewer on the cost policy and ladder | property tests 1–10, coverage 90%, Stryker 80% |
| 2 | Keyed identifier service and `risk_identifiers`/`risk_edges` migration; weighted linking replacing unweighted union-find in referrals | builder; architect reviews migration of 0026 hashes | graph property tests, contract tests on in-memory and PGlite |
| 3 | `fraud` module: `RiskPort` production adapter (hard rules only), decision record, audit, kill switches | builder | negative authz tests; degraded-mode tests |
| 4 | Velocity: shared GCRA limiter (ADR-0033), OTP prefix budget, card-testing rules | builder | fixed-clock tests of each rule |
| 5 | `apps/ml-services/risk`: feature definitions mirror, training (LR, LightGBM), calibration, export to JSON, golden vectors, simulator | builder + tester; architect reviews the first training pipeline | mypy strict, ruff, simulator acceptance (8.4) |
| 6 | Admin and seller endpoints and dashboards | builder | Playwright, authz tests |
| 7 | Shadow-mode run and promotion report | architect + chief-reviewer | section 8.1 criteria |

---

## 11. Open decisions

### 11.1 Money decisions (owner; recorded as Proposed with the safe default in force)

| # | Decision | Safe default until decided |
|---|---|---|
| M1 | COD cap tiers beyond the spec (5,000 EGP tier, confirmation skip by BRS) | spec caps only (1,500 / 3,000); no BRS-based benefits |
| M2 | Cost-matrix inputs (M, C_rto, abandonment rates) and who absorbs refused-COD cost (VR-F1-05) | model may not issue adverse actions (stage S0/S1 rules) |
| M3 | Exploration loss budget per day and per store | exploration Blocked (`kill.risk.exploration`) |
| M4 | Whether payouts may be held automatically at `SUSPENSION_PENDING_REVIEW` before human review | no automatic payout hold; hold only after human confirmation |
| M5 | Partial prepayment (delivery fee or 20%) as a real split tender (E4) | `require_prepayment` keeps meaning "COD unavailable" |
| M6 | Withholding pending referral and cashback rewards while a ring case is open | withhold pending, never claw back issued value via risk |
| M7 | Threshold above which an override that releases value needs dual approval | every override that releases a withheld reward needs dual approval |
| M8 | Seller commission surcharge from the ladder (§9.5) | not applied automatically |

### 11.2 Legal and privacy decisions (counsel and DPO)

| # | Decision | Safe default |
|---|---|---|
| L1 | Definition of "good user blocked" for the 0.5% guardrail, and whether friction counts | adverse = prepaid_only and block; friction budgeted separately (4.5) |
| L2 | Lawful basis for fraud profiling; retention of keyed identifiers after erasure (VR-FRT-01, -02) | process nothing real until resolved; 24-month horizon proposed |
| L3 | Automatic seller restriction and suspension without prior human review (VR-15) | no automatic SUSPENDED; human review within 5 business days; SLA breach restores |
| L4 | Which COD refusals are attributable to the shopper, given open-box and the 7-day cancellation right (VR row 7) | refusal after open-box for defect or mismatch is not attributable; any doubt counts as not attributable |
| L5 | Randomised exploration on real customers | Blocked until counsel and DPO approve |
| L6 | Model retirement after training data is purged or erased | retrain within one cycle; retire models whose training data passed the horizon |
| L7 | Detail of explanations owed to shoppers under the PDPL access right | generic reason + review path + decisions in DSAR export |
| L8 | Cross-courier refusal sharing (already off, `cod_refusal_history.shared_with_other_couriers`) | stays off |

### 11.3 Engineering decisions (architect may decide; listed for visibility)

| # | Decision | Proposal |
|---|---|---|
| O1 | Stage thresholds of 4.3 | as written [U]; revisit at 8 weeks after launch (aligned with VR-24) |
| O2 | In-process TS evaluator vs scoring service | in-process (9.1) |
| O3 | Migrate 0026 SHA-256 hashes to keyed HMAC | yes: expand with `*_hmac` columns, dual-write, backfill impossible for raw values not kept, so new rows only; old rows age out with retention |
| O4 | Single OTP prefix definition (E12) | calling code + 2-digit operator prefix |
| O5 | Python stack for training | scikit-learn, LightGBM, igraph + leidenalg, all self-hosted |
| O6 | Non-compensatory SHS guard | adopt in shadow, decide after comparison |
| O7 | PTS v2 promotion | shadow first; promote with owner sign-off because it feeds enforcement |

---

## 12. Unverified points and proposed register rows

Proposed new rows (for the register owner to add):

| Row | Item | Owner |
|---|---|---|
| VR-FRT-01 | PDPL treatment of profiling and automated decisions with significant effect; lawful basis; explanation content; whether prior PDPC consultation or a formal DPIA is required | Legal / DPO |
| VR-FRT-02 | Retention of keyed identifier hashes after account erasure for fraud prevention | Legal / DPO |
| VR-FRT-03 | Randomised exploration (relaxing restrictions for a random subset) on real customers | Legal / DPO |
| VR-FRT-04 | PSP dispute and chargeback feed: availability, reason codes, timing (card-scheme windows assumed about 120 days) | Finance |
| VR-FRT-05 | Which card attributes the PSP returns (fingerprint stability across tokens, BIN, decline codes) | Finance / Engineering |
| VR-FRT-06 | Valid Egyptian mobile number ranges for OTP and SMS pumping exposure on non-mobile ranges | Ops / SMS vendor |
| VR-FRT-07 | App Attest fraud-assessment receipt metric and Play Integrity device-activity fields: availability, semantics, refresh cadence | Mobile |
| VR-FRT-08 | Courier refusal reason taxonomy (needed for attributable refusal, L4) | Ops (extends VR-11) |

Other points not verified in this task:
- Every numeric parameter marked [U]: no Z-OUTLET data exists (VR-12, VR-24), so none is tuned.
- The scale of carrier-grade NAT on Egyptian mobile networks (affects IP hub cutoffs).
- That Isolation Forest and the graph methods perform well on this marketplace's data: no published Egyptian fashion-marketplace evaluation was found or sought.
- Literature and vendor references in section 13 were cited from prior knowledge and were **not re-fetched** during this task; titles and years should be checked when the builder writes model cards.
- Latency figures in 9.1 are estimates, not measurements.

## 13. References (cited from prior knowledge, not re-fetched in this task)

- Adamic, L. and Adar, E. "Friends and neighbors on the Web." Social Networks, 2003.
- Andersen, R., Chung, F. and Lang, K. "Local graph partitioning using PageRank vectors." FOCS, 2006.
- ATM Forum. "Traffic Management Specification 4.0" (GCRA), 1996. Heinanen, J. and Guerin, R. RFC 2697, "A Single Rate Three Color Marker", 1999.
- Blondel, V. et al. "Fast unfolding of communities in large networks." J. Stat. Mech., 2008.
- Bottou, L. et al. "Counterfactual reasoning and learning systems." JMLR, 2013.
- Chen, T. and Guestrin, C. "XGBoost: A scalable tree boosting system." KDD, 2016.
- Cloudflare blog. "How we built rate limiting capable of scaling to millions of domains." 2017.
- Dal Pozzolo, A. et al. "Credit card fraud detection: a realistic modeling and a novel learning strategy." IEEE TNNLS, 2018.
- Drummond, C. and Holte, R. "Cost curves: an improved method for visualizing classifier performance." Machine Learning, 2006.
- Dudík, M., Langford, J. and Li, L. "Doubly robust policy evaluation and learning." ICML, 2011.
- Elkan, C. "The foundations of cost-sensitive learning." IJCAI, 2001.
- Flajolet, P. et al. "HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm." 2007.
- Guo, C. et al. "On calibration of modern neural networks." ICML, 2017.
- Hand, D. and Henley, W. "Can reject inference ever work?" IMA J. Management Mathematics, 1993.
- Hardt, M., Price, E. and Srebro, N. "Equality of opportunity in supervised learning." NeurIPS, 2016.
- Hooi, B. et al. "FRAUDAR: Bounding graph fraud in the face of camouflage." KDD, 2016.
- Ke, G. et al. "LightGBM: A highly efficient gradient boosting decision tree." NeurIPS, 2017.
- Liu, F. T., Ting, K. M. and Zhou, Z.-H. "Isolation forest." ICDM, 2008.
- Lou, Y., Caruana, R., Gehrke, J. and Hooker, G. "Accurate intelligible models with pairwise interactions." KDD, 2013.
- Lundberg, S. et al. "From local explanations to global understanding with explainable AI for trees." Nature Machine Intelligence, 2020.
- Niculescu-Mizil, A. and Caruana, R. "Predicting good probabilities with supervised learning." ICML, 2005.
- Page, L. et al. "The PageRank citation ranking: bringing order to the Web." Stanford tech report, 1999.
- Platt, J. "Probabilistic outputs for support vector machines and comparisons to regularized likelihood methods." 1999.
- Rigollet, P. and Tong, X. "Neyman-Pearson classification, convexity and stochastic constraints." JMLR, 2011.
- Saito, T. and Rehmsmeier, M. "The precision-recall plot is more informative than the ROC plot when evaluating binary classifiers on imbalanced datasets." PLOS ONE, 2015.
- Swaminathan, A. and Joachims, T. "The self-normalized estimator for counterfactual learning." NeurIPS, 2015.
- Traag, V., Waltman, L. and van Eck, N. "From Louvain to Leiden: guaranteeing well-connected communities." Scientific Reports, 2019.
- US EEOC et al. "Uniform Guidelines on Employee Selection Procedures" (four-fifths rule), 1978. Used only as a review heuristic.
- Yurdakul, B. "Statistical properties of population stability index." PhD dissertation, Western Michigan University, 2018.
- Zadrozny, B. and Elkan, C. "Transforming classifier scores into accurate multiclass probability estimates." KDD, 2002.
- Zhu, X. and Ghahramani, Z. "Learning from labeled and unlabeled data with label propagation." CMU tech report, 2002.
- Apple Developer documentation, "Establishing your app's integrity" (App Attest) and "Assessing fraud risk" (current version at implementation; VERIFY, VR-FRT-07).
- Google Play Integrity API documentation, verdicts and standard requests (current version at implementation; VERIFY, VR-FRT-07).
