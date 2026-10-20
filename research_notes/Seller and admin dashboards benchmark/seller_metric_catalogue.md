# Seller-side metric catalogue and chart choices (Z-OUTLET / HAUL, Egypt off-price marketplace)

Labels: DOCUMENTED (URL), REPO (path), INFERENCE. Money = integer piastres (bigint), banker's (half-even) rounding at one point; rates in basis points (bps). Window default: whole UTC days (REPO: `docs/specs/seller-analytics.md` snaps windows to days, max 366 days; Cairo-day display is INFERENCE and is an open item, see Gaps). Freshness SLO for every warehouse-served metric: <= 15 min (spec 19.1, DOCUMENTED in `docs/haul-master-prompt-v3.md` section 19.1). Exceptions are noted per row.

Common conventions (INFERENCE unless stated):
- Every response carries `meta.freshness` (REPO: seller-analytics spec). Stale beyond SLO shows a "data delayed" banner, never silently old numbers.
- K = 50 distinct shoppers gate (REPO: `packages/domain/src/seller-analytics/kanon.ts`, `K_ANONYMITY_MIN = 50`) applies to every shopper-derived breakdown (source, geography, search terms, demographics, stylist inclusion).
- Privacy class uses spec A3: P0 public, P1 internal (seller's own business), P2 personal, P3 sensitive.
- Chart rule of thumb: trend = line/area, composition of a total = stacked bar or sankey for flows (avoid pie > 5 slices), ranking = horizontal bar, distribution = histogram/box, two-measure comparison = paired bar, geography = choropleth of 27 governorates plus a sorted bar fallback (accessible), KPI = number tile with sparkline and delta.

## 1. Which metrics exist, what do they mean, what chart (catalogue)

### Takeaway
About 60 metrics across 15 groups. The repo already serves roughly a third (traffic, funnel, sales core, sell-through, size curve, aging, returns by SKU, search terms, geography, CSV export, ad CTR/CPC/ROAS, stylist inclusion, order SLA clocks, payout statements). The rest need new events or read models, mostly SLA/courier, health score, review/seller-reply, followers and finance dashboards.

### Cited Findings (benchmarks)
- Amazon seller health targets: Order Defect Rate under 1%, Late Shipment Rate under 4%, Pre-fulfillment Cancel Rate under 2.5%; on-time delivery floor of 90% (sources disagree on whether 95% is a floor or a recommended target); third-party summaries, not Amazon's live policy page — [Feedvisor](https://feedvisor.com/university/seller-performance-measurements/), [Amazon account health PDF (older)](https://m.media-amazon.com/images/G/02/rainier/help/legal/Monitor_your_account_health_English_170320_Redlined.pdf), [SalesDuo](https://salesduo.com/blog/amazon-seller-metrics-guide). Amazon surfaces them under Performance, Account Health ([Feedvisor](https://feedvisor.com/university/seller-performance-measurements/)).
- Shopify: session = visits less than 30 min apart; conversion rate = share of sessions that ended in an order; returning customer rate = returning customers / customers who ordered; AOV = (gross sales - discounts) / orders — [Shopify Help Center analytics fields](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields). Secondary sources differ (orders/sessions vs checkouts/sessions; AOV on revenue vs net of discounts) — [Polar Analytics](https://www.polaranalytics.com/post/shopify-analytics-guide). Decision for HAUL: net of discounts, VAT-inclusive consumer price basis stated explicitly (INFERENCE).
- Spec baseline lists the metrics sellers must see: traffic, funnel, sales, sell-through, size curve, aging with AI markdown, stylist inclusion, search terms, return reasons, ranking percentiles, geography, demographics k>=50, ads, Price Trust, scheduled reports, CSV watermarked and audited, carbon P2; served from ClickHouse via a semantic layer with RLS by store — REPO: `docs/haul-master-prompt-v3.md` section 19.1.

### Catalogue

Legend for "Data exists?": YES = built and tested; PART = domain or events exist but no seller read model; NO = not found. Paths are REPO evidence.

#### A. Traffic
| ID | Metric | Question | Definition / formula | Grain, windows | Chart and why | Drill-down | Alert | Privacy | Data exists? |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Store views | Is the storefront being discovered? | count `store_view` events | store x day; 7/28/90d | Line with prior-period dashed overlay: trend + comparison | by source, by world (Local/Global) | -30% vs 7d median | P1 | YES `apps/api/src/modules/seller-analytics` (`store_view` in `domain/ports.ts`) |
| A2 | Product views | Which products attract attention? | count `view` events | product x day | Ranked horizontal bar (top 20) + sparkline per row | product -> funnel | none | P1 | YES (same) |
| A3 | Unique visitors | How many distinct people? | COUNT DISTINCT `shopper_key` (never exposed) | store x day; not summable across days, recompute per window | Line; tile for window total | source | -- | P1; counts only (REPO: shopper_key not in any wire type) | YES |
| A4 | Traffic by source | Where do visits come from? | views grouped by feed, search, stylist, shared_link, ads, creators, my_stores; cells with < 50 shoppers folded via `kAnonymizeAdditive` | store x source x window | 100% stacked bar over time (composition shifts); table for exact counts | source -> product | -- | P1, k>=50 | YES for generic source code; the named 7-source taxonomy is not enforced in the event schema (INFERENCE from `source: code` optional) |
| A5 | Followers (total, net adds) | Is the audience growing? | `followerCount`; net = follows - unfollows | store x day | Area (total) + diverging bar (net adds) | -- | net negative 3 days | P1 aggregate only; no follower identities | PART: count only, `apps/api/src/modules/stores/application/public.ts` (`followerCounts`); no history, no seller route |
| A6 | My Stores reach | How many shoppers have me as favorite and how many visited since last seen? | favorites count; "new since" counters are per-user | store x day | Tile + line | -- | -- | P1 aggregate | PART (favorites repo exists; no seller read model) |

#### B. Funnel (per product and per drop)
| ID | Metric | Question | Definition | Grain | Chart | Drill-down | Alert | Privacy | Exists? |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Stage counts impression, view, save, bag, checkout, purchase | Where do shoppers drop? | counts of each stage event per product | product (and drop_id) x window | Horizontal funnel bars with stage-to-stage conversion labels in bps | product -> size -> source | view->bag below category p25 | P1 | YES `funnel.ts`; but `impression`, per-store `checkout` and `purchase` events are not yet published (spec gaps list) so impression and checkout are empty in practice |
| B2 | Stage conversion bps | Which transition leaks? | next / previous * 10_000, null on zero denominator | same | Same chart; table sortable | -- | -- | P1 | YES (`funnel.ts`) |
| B3 | Drop funnel | Did the drop convert? | B1 filtered by drop; admission rate = admitted / queued | drop x minute for live drops (freshness <= 1 min is a recommended exception, INFERENCE) | Funnel + line of purchases per minute | size | sell-out time | P1 | PART: drops module `apps/api/src/modules/drops`, waiting-room module exist; no drop dimension in analytics events |
| B4 | Save-to-purchase lag | How long intent takes | median days between first save and purchase | product | Histogram | -- | -- | P1 | NO |

#### C. Sales
| ID | Metric | Definition (piastres) | Chart | Notes / alert | Privacy | Exists? |
|---|---|---|---|---|---|---|
| C1 | GMV | sum(line gross) of PAID/CONFIRMED_COD seller-order lines; VAT-inclusive consumer price; excludes cancelled | Line + tile with delta | shown net of cancellations on a separate series | P1 | YES `sales.ts` |
| C2 | Returns/refunds-adjusted GMV | C1 - refunded lines, attributed to original order date (spec 15 rule) | Line, two series (gross vs net) | -- | P1 | PART (returns data exist, not joined in `sales.ts`) |
| C3 | Net payable after commission, fees, VAT | gross - commission - platform fees - VAT on commission (14%) = seller_payable | Waterfall: shows exactly where each piastre went | reconcile to ledger `seller_payable` (REPO `docs/specs/ledger-chart-of-accounts.md`) | P1 | PART: commission/net in `sales.ts`; fees/VAT breakdown in payouts statement `packages/domain/src/payouts/statement.ts` |
| C4 | Units | sum qty | Line | -- | P1 | YES |
| C5 | Orders | count seller_orders | Line | -- | P1 | YES |
| C6 | AOV | (gross - discounts) / orders, half-even (Shopify definition) | Line + tile | null if 0 orders | P1 | YES (half-even); discount netting is INFERENCE |
| C7 | Items per order | units / orders | Tile + histogram of basket size | -- | P1 | PART (derivable) |
| C8 | New vs returning customers | returning = shopper with a prior purchase from this store | Stacked bar per week | counts only | P1, k>=50 for rate | PART |
| C9 | Repeat rate | returning / purchasers, bps; withheld below 50 shoppers | Line with "insufficient data" gap | -- | P1 k>=50 | YES (REPO spec: withheld below 50) |
| C10 | Sales by payment method (COD / prepaid / BNPL) | GMV share | 100% stacked bar | COD share drives RTO risk | P1 | PART (payments module) |
| C11 | Cross-store basket partners | co-purchased stores, aggregated | Horizontal bar (top 10) | k>=50 | P1 aggregate | NO |

#### D. Order pipeline and SLA timers
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| D1 | Orders by state | counts PAID, ACCEPTED, PACKED, SHIPPED, OUT_FOR_DELIVERY, DELIVERED, CLOSED, plus exceptions (CANCELLED, REJECTED_BY_SELLER, DELIVERY_FAILED, RTO, RETURNED_TO_SELLER, DISPUTED) | Stage bar (current snapshot, a kanban-like count strip) + trend line | exception > 5% | PART: state machine `packages/domain/src/orders/lifecycle.ts`, `types.ts`; no seller aggregate |
| D2 | Accept-by timer (24h) | `paid_at + ACCEPT_SLA_MS (24h)`; time remaining | Sorted list with countdown bars (bullet/gauge per order) | red < 4h; auto-cancel at 0 | YES clocks: `ACCEPT_SLA_MS` in `packages/domain/src/orders/types.ts`; `acceptDeadline` in `lifecycle.ts`. Aggregates NO |
| D3 | Dispatch-by timer (48h) | `DISPATCH_SLA_MS (48h)` | Same | red < 6h | clock YES (`types.ts`), aggregate NO |
| D4 | Accept rate within SLA | accepted <= 24h / orders | Line + tile bps | < 95% | NO |
| D5 | Dispatch SLA attainment (late shipment rate) | shipped after deadline / shipped, bps. Amazon equivalent: Late Shipment Rate < 4% ([Feedvisor](https://feedvisor.com/university/seller-performance-measurements/)) | Line with threshold band | HAUL threshold is a product decision (see Gaps) | NO |
| D6 | Cancellation rate (seller-caused) | (REJECTED_BY_SELLER + auto-cancel at SLA) / orders; Amazon equivalent Pre-fulfillment Cancel Rate < 2.5% | Line + threshold | > 2.5% | NO |
| D7 | Time-in-state (accept, pack, handover) | p50/p90 durations between transitions | Box plot or p50/p90 band chart | p90 > SLA | NO (events carry timestamps in machine, INFERENCE) |
Privacy for all D: P1 for counts; order rows show buyer name/phone/address masked and only while the order is active (spec 19 "Data access", B1 relay number; 30 days after delivery or return closure access ends).

#### E. Fulfilment and courier
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| E1 | Delivery success rate | DELIVERED / (DELIVERED + RTO + DELIVERY_FAILED), bps, by courier | Line per courier; bar by governorate | < 90% | PART: `packages/domain/src/fulfillment/tracking.ts`, shipments events |
| E2 | RTO rate | RTO / dispatched | Choropleth by governorate + ranked bar | spec COD RTO baseline unverified (P2 row 12) | PART |
| E3 | COD refusal rate by governorate | refusals / COD deliveries attempted (REPO fulfillment `cod.ts`) | Choropleth with value labels; sparse cells show "n < 50" | > baseline | PART `packages/domain/src/fulfillment/cod.ts`; k-anon applies when derived from shoppers |
| E4 | On-time delivery vs ETA | delivered <= promised (p80 transit) | Line | < 90% (Amazon floor, [Feedvisor](https://feedvisor.com/university/seller-performance-measurements/)) | NO |
| E5 | AWB label pending/failed | count of queued AWB (REPO `awb-queue.ts`) | Tile with list | > 0 for 30 min | PART |
| E6 | COD remittance cycle | days from delivery to courier remittance; mismatch count | Bar + table | mismatch > 0 | PART (`cod_remittances`, reconciliation module) |
| E7 | gCO2e per shipment | courier-reported or distance estimated | Line | -- (P2 per spec) | NO |

#### F. Returns, refunds, disputes
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| F1 | Return rate | returned units / delivered units, bps, per SKU, category | Line + ranked bar | > category p75 | YES per SKU `apps/api/src/modules/seller-analytics` (`returns` route) |
| F2 | Return reasons | counts by taxonomy (too small, too large, not as described, defective, changed mind, late, wrong item) | Horizontal sorted bar (not pie) | defective > 3% | YES (reason counts) |
| F3 | Fit-related returns | too small + too large / returns; per SKU and size | Diverging bar (too small vs too large) per size | > 40% of returns | PART (fit feedback `packages/domain/src/sizing`) |
| F4 | Refund timeline | median/p95 hours return received -> refund initiated (SLO 24h) and -> paid (14 days assumed) | Funnel-like timeline + percentile bands | p95 > 24h initiate | PART: refunds module `apps/api/src/modules/refunds` |
| F5 | Inspection SLA | inspected within 48h of receipt; silence = auto-approve | Bar + counter | breach count | PART (returns policy `packages/domain/src/returns/policy.ts`) |
| F6 | Disputes | opened, won/lost, open > 5 business days | Stacked bar by outcome | open > 3 days | PART (disputes in returns state) |
| F7 | Refund amount | sum refunds, piastres | Line | -- | PART |
Buyer identity never shown; only return ids and masked contact while active.

#### G. Finance
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| G1 | Balance pending vs available | pending = lines not CLOSED (return window + 3 days); available = CLOSED, no dispute, not on hold (spec T4) | Two-segment stacked bar + tile | negative balance (refund after payout) | PART `packages/domain/src/payouts/eligibility.ts`, ledger |
| G2 | Payout schedule | next weekly cycle date (Cairo), amount, state SCHEDULED/ON_HOLD/APPROVED/SENT/SETTLED/FAILED | Timeline/stepper + table | ON_HOLD or FAILED | YES `packages/domain/src/payouts/cycle.ts`, `lifecycle.ts` |
| G3 | Statement | line facts per payout (sales, commission, fees, VAT, refunds, adjustments) | Table + waterfall header | -- | YES `payouts/statement.ts` |
| G4 | Commission and fee breakdown | commission, shipping fees, ads spend, FBH fees, VAT 14% on each | Stacked bar per month | commission surcharge active (enforcement) | PART |
| G5 | ETA e-invoices | HAUL -> seller B2B invoices: status submitted/accepted/rejected, UUID | Table + status counts | rejected > 0 | PART: `apps/api/src/modules/tax-eta`, spec `docs/specs/tax-eta.md` |
| G6 | VAT report | output VAT on commission/fees; seller's own goods VAT is seller's e-receipt (spec B4) | Table + export | -- | PART |
| G7 | Settlement/ reconciliation status | unmatched lines affecting this seller | Count tile | any > 3 days | PART (reconciliation module) |
Freshness: finance views should reflect ledger posts within 15 min; statements are immutable once cut (INFERENCE).

#### H. Inventory
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| H1 | Sell-through | sold / (sold + on hand), bps, per SKU and drop | Bullet chart vs target + bar by SKU | < 30% at day 14 (INFERENCE) | YES `stock.ts`, `sell-through` route |
| H2 | Size-curve | sold share vs stocked share per size | Paired bars per size (stocked vs sold) | gap > 15 pts | YES `size-curve` route |
| H3 | Aging inventory | units unsold at 30/60/90 days | Stacked bar by age bucket | any 90d | YES `aging` route, `markdown.ts` |
| H4 | Markdown recommendation | heuristic; `showsPercentOff: false` always; text says new price will not show "% off" unless verified against VRP | Table with current price, suggested price (piastres), expected effect note, plus mandatory notice | -- | YES (heuristic_v1; elasticity model with "clear 80% in 7 days" is out of scope in v1 per spec, so do not display clearance probability yet) |
| H5 | Stock-outs | SKU/size with on_hand = 0 and demand (views/saves) | Heat table (SKU x size) | stock-out on top-20 SKU | PART (inventory module) |
| H6 | Restock/ notify-me demand | count of back-in-size alerts (k>=50 if shopper-derived) | Ranked bar | -- | PART (alerts in catalog product alerts spec) |
| H7 | Oversell incidents | negative adjustments while reserved | Counter | any | PART (inventory spec) |

#### I. Catalog quality and listing score
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| I1 | Listing quality score 0-100 | weighted: AR title/description present, size chart valid, >= N images, attributes complete, condition/defect photos (INFERENCE weights) | Horizontal bar per listing + checklist of fixes | NO (spec lists "listing quality score" under Seller AI copilot P2) |
| I2 | Size chart coverage | listings with validated chart / listings (blocks size recommendation) | Tile + list | PART (`size_charts` in sizing module) |
| I3 | Image/Arabic completeness | % listings missing AR copy (legal CPL 181/2018) | Tile + list | PART (catalog validators) |
| I4 | Moderation rejections | count by reason | Bar | PART |

#### J. Price integrity
| ID | Metric | Definition | Chart | Alert | Exists? |
|---|---|---|---|---|---|
| J1 | Price Trust Score history | `100 - 10*min(violations90d,8) - 5*min(openCrossChannel,3) - floor(correctedPct/5)` (REPO `docs/specs/price-integrity.md` line 61) | Line 0-100 with colored bands and enforcement markers | < 70 | PART domain `packages/domain/src/price-integrity/enforcement.ts`; seller route spec'd `GET /v1/seller/price-trust` |
| J2 | VRP claims per SKU | VRP (piastres), price, discount_pct = floor((VRP-price)*100/VRP), allowed if >= 5 | Table with badge state (Verified / Lowest 30d / Launch price / plain) | claims auto-corrected | PART `vrp.ts` |
| J3 | Evidence freshness | channel snapshot age (stale after 72h degrades claim) | Status pills | > 48h | PART (crawler/channel modules) |
| J4 | Enforcement actions | action, reason, expiry | Timeline | any | PART (enforcement ladder in `enforcement.ts`); events `price_enforcement.applied` not wired (spec line ~91) |
| J5 | Appeals | open, upheld, rejected; re-score result | Table + stacked bar | -- | PART |
| J6 | Cross-channel parity breaches | SKUs where external current < HAUL price; 48h countdown | List with countdown | 24h left | PART |

#### K. Promotions, vouchers, ads
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| K1 | Voucher ROI | (incremental GMV attributed - seller-funded discount piastres) / seller-funded discount, bps; holdout needed for incremental (spec 17) | Bar per voucher | NO seller read model; funding split recorded per line (`packages/domain/src/promotions/funding.ts`) |
| K2 | Voucher redemptions and cost | uses, funded amount seller vs platform | Stacked bar | PART |
| K3 | Ad impressions, clicks, spend | counts, spend VAT-exclusive piastres | Line (spend vs attributed revenue dual axis, or two aligned panels to avoid dual axis misread) | YES `packages/domain/src/ads/reports.ts` |
| K4 | CTR | clicks / impressions bps, half-even | Line | YES (`ctrBp`) |
| K5 | CPC | spend / clicks, half-even piastres | Line | YES (`cpc`) |
| K6 | ROAS | attributed revenue / spend, bps (10,000 = 1.00x) | Bar by campaign with 1.00x reference line | YES (`roasBp`) |
| K7 | Budget pacing | spent / daily budget | Bullet chart | PART (`billing.ts`, `campaign.ts`) |
Sponsored placements are labeled and capped (spec 4); ad invalid clicks excluded (`traffic.ts`).

#### L. Reviews and ratings
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| L1 | Average rating and count | verified purchases only | Tile + stacked 1-5 star bars | PART: `docs/specs/reviews.md`, `packages/domain/src/reviews` |
| L2 | Sentiment and topics (AR/EN) | topic model share positive/neutral/negative | Diverging stacked bar by topic | NO (VoC spec'd in section 18) |
| L3 | Photo reviews share | reviews with photo / reviews | Tile | PART |
| L4 | Fit feedback | too small/ok/too large share per SKU | Diverging bar | PART (`fit_feedback`) |
| L5 | Seller reply rate and Q&A SLA | replied / reviews; Q&A answered <= 48h (REPO reviews spec: `sla_due_at`, `sla_overdue`) | Tile + overdue list | YES for Q&A SLA flags, PART for rate |
Privacy: seller sees review content, not user id (REPO `docs/specs/reviews.md`, data inventory). Reviewer first-name initial only.

#### M. Seller health score and visibility effect
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| M1 | Seller Health Score | composite of dispatch SLA, cancellations, return rate, rating, Price Trust (spec 19); weights are INFERENCE and must be admin-configurable/versioned | Radar is discouraged; use component bars with threshold lines and a score gauge/tile | NO: no health-score computation found in `packages/domain/src/sellers` (only health refs in ranking features: `packages/domain/src/ranking/features.ts`, ads auction) |
| M2 | Component contribution | points lost per component | Waterfall from 100 | NO |
| M3 | Visibility effect | rank percentile and impression share change vs health band; ranking uses seller health as a feature | Line of impressions with health band shading; table of category percentile | PART (ranking feature exists; no seller read model); causal attribution is INFERENCE, label as "correlated" |
| M4 | Badges/penalties | Verified badge, commission surcharge, drop block, suspension (spec 9.5) | Status list with dates | PART (`sellers/rules.ts`, enforcement) |
Amazon analogue: Account Health Rating with ODR/LSR/PFCR thresholds ([Feedvisor](https://feedvisor.com/university/seller-performance-measurements/)).

#### N. Stylist, search terms, demand gaps
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| N1 | Stylist inclusion rate | outfits including store items / outfits generated; withheld (null) below 50 distinct shoppers | Tile + line | YES `apps/api/src/modules/stylist/application/inclusion.ts` (`INCLUSION_K = 50`; returns outfits, distinctShoppers, addedToBagOutfits) |
| N2 | Stylist add-to-bag rate | addedToBagOutfits / outfits | Line | YES (same) |
| N3 | Cross-store basket partners | see C11 | bar | NO |
| N4 | Search terms leading to store | term, clicks; k>=50, PII-looking terms rejected at ingest | Ranked bar / word list (bar preferred) | YES `search-terms` route, `search_click` event |
| N5 | Demand gaps | search_no_result terms in seller's categories (aggregated) | Ranked bar of terms with volume | PART (search module logs `search_no_result`; not in seller route) |

#### O. Customer geography and demographics
| ID | Metric | Definition | Chart | Exists? |
|---|---|---|---|---|
| O1 | Orders/GMV by governorate | purchase events with governorate; cells < 50 distinct shoppers folded into smallest released cell, flagged `includes_suppressed` | Choropleth (27 governorates) plus sorted bar fallback | YES `geography` route |
| O2 | Delivery success by governorate | see E1 | choropleth | PART |
| O3 | Demographics (age band) | aggregated, k>=50 only | Bar | NO: DOB exists in users but seller analytics spec says no demographics collected; any new dimension must use `kAnonymize` (REPO spec) |

#### P. Restricted / never shown to sellers
| Item | Rule | Source |
|---|---|---|
| Budget data (budgets, cycles, installment commitments, affordability) | Never shown, never imported by analytics (boundary test) | REPO `apps/api/src/modules/seller-analytics/test/boundaries.test.ts`; spec 12 |
| Size measurements | Never shown; ingest schemas are strict and reject `measurements`, `budget_*`, `user_id` | REPO seller-analytics spec |
| Buyer PII | Masked, only for active orders, access ends 30 days after delivery/return closure; courier relay number | spec 19, B1 |
| Wishlist contents / gift recipient address | Never | spec 8 |
| shopper_key / user ids | Never on wire or CSV | REPO seller-analytics spec |
| Exports | Watermarked CSV, audit-first, owner/manager only | REPO seller-analytics spec |

### Inferences
- Thresholds that Amazon publishes (ODR < 1%, LSR < 4%, PFCR < 2.5%) are sensible starting points for HAUL, but HAUL's own SLAs (accept 24h, dispatch 48h) are stricter anchors; defaults must be admin-editable and versioned.
- Because the spec chooses query-time aggregation over append-only facts (REPO), distinct-shopper metrics (A3, C8, C9) are exact for any window; rollups would break them. Keep new distinct-count metrics on that path or move to ClickHouse with HyperLogLog only for non-privacy-critical numbers (HLL is approximate and unsafe for the k-gate).
- Choose small multiples and ranked bars over pies/radars for accessibility in RTL; mirror axes in Arabic; use Eastern/Western numeral preference (spec 25).
- Differencing risk: adjacent windows can isolate a delta (REPO spec acknowledges); keep day-snapped windows and rate limits.

### Gaps
- No seller-health-score computation or weights found in the repo; spec gives only inputs.
- Dispatch SLA, cancellation and late-delivery thresholds for HAUL are not specified; the Amazon figures are third-party summaries of Amazon policy and conflict on on-time delivery target (90% vs 95%).
- Several per-store events (impression, per-store checkout/purchase, stock snapshot) are listed as not yet published in the seller-analytics spec gaps, and the module is not registered in `app.module.ts` per the spec status line; confirm current state before building.
- Amazon Business Reports field definitions were not fetched (only search snippets); Shopify definitions come from its Help Center via search snippet, not full page read.
- Drop-level analytics dimension, follower history, review sentiment and demographic collection were not found.
- Cairo-time day boundaries vs UTC snapping unresolved for display of "today".
- ClickHouse serving is out of scope in v1 (REPO), so the 15-min SLO is currently met via Postgres ingest lag only.
