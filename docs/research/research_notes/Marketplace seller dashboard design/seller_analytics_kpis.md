# Seller analytics KPI and chart catalogue (Shopify, Amazon, Noon, Zalando, Etsy, Mirakl)

Research depth note: ~11 tool calls. Many official help pages (help.shopify.com, Amazon Seller Central, Mirakl docs) were unreachable or not indexed; most definitions below come from search summaries and third-party vendors and are flagged. KPI formulas in "Inferences" are design proposals, not platform quotes. Money in integer piastres.

## 1. KPI definitions, formulas, grain, comparisons (platform evidence)

### Takeaway
Platforms converge on a small core: sessions/visits, orders, units, revenue, conversion = orders (or units) / sessions, AOV = revenue / orders, with period-over-period comparison. Amazon's "Unit Session Percentage" is units-based and session = 24h unique visit; Etsy conversion is orders / visits. Account-health KPIs (cancel, late shipment, defect) are measured on short rolling windows with hard thresholds.

### Cited Findings
- Shopify-style conversion rate = purchases / sessions x 100; AOV = total revenue / orders; returning customer rate = returning customers / total customers (single period; ShopBase example, not Shopify's own wording) — [Shopify blog](https://www.shopify.com/blog/basic-ecommerce-metrics), [ShopBase help](https://help.shopbase.com/en/article/zsjsjf)
- ShopifyQL query pattern: `FROM sales SHOW total_sales TIMESERIES day SINCE -30d COMPARE TO previous_period`; supports GROUP BY dimension, TIMESERIES, WHERE, SINCE/UNTIL/DURING, previous_period comparison (search-summarized, not run) — [ShopifyQL syntax](https://shopify.dev/docs/api/shopifyql/syntax)
- Amazon Unit Session Percentage = units ordered / sessions; session = unique visitor in 24h; Buy Box % = share of sessions holding the Buy Box; both in Detail Page Sales and Traffic report (third-party sources, no official wording found) — [Seller Sonar](https://sellersonar.com/blog/glossary/unit-session-percentage/), [Repricer](https://www.repricer.com/blog/buy-box-win-rate-amazon-tracking-guide/)
- Amazon account health: ODR < 1%, Late Shipment Rate < 4%, Pre-fulfillment cancel rate < 2.5%; ODR = negative feedback + A-to-Z claims + chargebacks; applies to seller-fulfilled orders; windows reported as ODR 60d, LSR 10/30d, cancel 7d (third-party; may be outdated) — [Feedvisor](https://feedvisor.com/university//customer_metrics_faqs), [Seller forum](https://sellercentral.amazon.com/seller-forums/discussions/t/8a41416f-e1ad-4221-9675-7145d5cc5e28)
- Amazon cancellation rate counts only seller-initiated pre-shipment cancels — [Impakter](https://impakter.com/amazon-seller-performance-metrics/)
- Noon DirectShip: cancellation rate < 2.5% and late shipment rate (handover after ESD) < 3%, both on 7-day windows; shown under Account Health & Performance — [Noon support](https://support.noon.partners/portal/en/kb/articles/directship-seller-performance-management)
- Noon FBP dashboard: total orders, cancellation rate, cancelled order value, weekly breakdown, cancellations by reason (seller rejection, delay rejection, shipment lost), default 90 days, per-SKU "Fair" if < 2.5% — [Noon FBP](https://support.noon.partners/portal/en/kb/articles/what-is-fbp-performance-dashboard)
- Noon reputation dashboard: Red status gives 7 days for a Corrective Action Plan or dispute; offer visibility and ads suspended meanwhile — [Noon reputation](https://support.noon.partners/portal/en/kb/articles/seller-reputation-dashboard)
- Walmart late shipment measured vs expected ship date, target <= 5% — [Walmart](https://marketplacelearn.walmart.com/guides/performance-dashboard-late-shipment-rate)
- Marketplacer seller rating: weekly, trailing 3 months, late dispatch/cancellations/returns 30% each, missing tracking 10% — [Marketplacer](https://support.marketplacer.com/hc/en-us/articles/25571003783309)
- Etsy Stats: select visits, orders, conversion rate or revenue graph; pick date range back to Nov 2017; shops > 1 year can compare to previous year; visits count shoppers entering shop, not page views — [Etsy Help](https://help.etsy.com/hc/articles/115015774268)
- Etsy "How shoppers found you": Etsy search, app, other Etsy pages, direct, social, Offsite Ads; plus search terms and listing sections (third-party) — [Ecommerce Fastlane](https://ecommercefastlane.com/etsy-statistics-explained-how-to-read-and-use-your-shop-stats/)
- Zalando zDirect Analytics: commercial metrics, stock, sales module (revenue, visibility, stock, margins), article performance, assortment/backfill widget, peer benchmarks incl. return rates, return insights page — [Zalando corporate](https://corporate.zalando.com/en/node/10314), [Partner University](https://partner.zalando.com/university/pp/optimise-assortment)
- Amazon Search Query Performance (Brand Analytics): per query impressions, clicks, add-to-carts, purchases funnel; brand-registered only; top ~1000 queries; ~2 week lag (vendor claims) — [DataHawk](https://docs.datahawk.co/help-center/data-metrics-guides/search/brand-analytics-sqp)

### Inferences (proposed catalogue for Z-OUTLET; piastres integer, rates as basis points or ratios)
- Gross sales = sum(unit_price x qty) before discounts; Net sales = gross - discounts - refunds(returns) ; show "returns-adjusted" by attributing refunds to the ORIGINAL order date (cohort view) and, separately, to refund date (cash view). Label which one.
- Orders = count distinct SellerOrders (not OrderGroups); Units = sum qty; AOV = net_sales / orders; Items per order = units / orders.
- Conversion funnel: impression -> view -> add-to-bag -> checkout start -> purchase; step rate = n_k / n_{k-1}; overall = purchases / views. Use sessions as denominator, same as Amazon/Etsy, and state it.
- Sell-through (period) = units_sold / (units_sold + ending_on_hand) (a common retail definition; not platform-sourced). Days of cover = on_hand / avg_daily_units_30d. Stockout lost-sales estimate = days_oos x avg_daily_units_in_stock x price (estimate, label so).
- Return rate = units_returned / units_delivered, cohort by delivery month, with lag note; by SKU and reason code. Cancellation rate = seller-cancelled pre-ship / orders (7d). Late shipment = handed over after promised ship-by / orders shipped. Order defect rate = (late + seller-cancel + defect-return + A-to-Z-like disputes) / orders over 60d.
- Repeat purchase rate = customers with >= 2 orders in window / customers with >= 1 order. New vs returning by first-ever order on the marketplace (not only that seller) is a privacy question; prefer seller-scoped.
- Ad ROAS = attributed_net_sales / ad_spend; CPC = spend / clicks; CTR = clicks / impressions. State attribution window.
- Comparison default: vs previous period, plus same period last year (Etsy: only when > 1 year of data).

### Gaps
- Official Shopify, Amazon and Mirakl help-page wording could not be fetched; Shopify returns/net-sales attribution rules unverified.
- No source found on Mirakl seller/operator dashboard KPIs (search returned none).
- Zalando sell-through formula not published in accessible pages.

## 2. Dashboard layouts, default ranges, filters

### Takeaway
Platforms use a KPI-card row with period-over-period deltas, a switchable trend chart (Etsy: pick one metric), then ranked tables and source breakdowns; health metrics are separate tabs with RAG status and thresholds. Detail is thin in sources.

### Cited Findings
- Etsy: metric overview with selectable graph per metric, date picker, YoY compare — [Etsy Help](https://help.etsy.com/hc/articles/115015774268)
- Noon FBP default window 90 days; weekly breakdown; Performance and Pending tabs — [Noon FBP](https://support.noon.partners/portal/en/kb/articles/what-is-fbp-performance-dashboard)
- Noon reputation uses Red status band — [Noon reputation](https://support.noon.partners/portal/en/kb/articles/seller-reputation-dashboard)
- Amazon Account Health described as a 0 to 1000 score with red "Unhealthy" band (vendor claim) — [Vortex IQ](https://docs.vortexiq.ai/nerve-centre/kpi-cards/amazon-seller/account-health-status.md)

### Inferences
- Proposed layout: (1) KPI cards (net sales, orders, units, AOV, conversion, return rate) with sparkline and delta; (2) trend chart with metric toggle and day/week/month grain; (3) funnel; (4) ranked tables (best sellers by units / revenue / margin, with return rate column); (5) heatmap size x colour or weekday x hour; (6) health panel with RAG vs threshold.
- Defaults: last 30 days vs previous 30; health metrics on 7d/60d rolling windows per platform norms; timezone Africa/Cairo, currency EGP, shown in the header.
- Dataviz guidance (Few, NN/g, Polaris) not fetched in this pass.

### Gaps
- Stephen Few, NN/g and Shopify Polaris dataviz guidance not retrieved; no cited layout research.

## 3. Export, scheduling, freshness

### Takeaway
Little verified evidence; only lag figures for Amazon query data and noon's weekly/rolling windows.

### Cited Findings
- Amazon SQP data lag about 2 weeks (vendor claim) — [Ad Badger](https://www.adbadger.com/blog/amazon-search-query-performance-dashboard/)
- Marketplacer rating recalculated weekly — [Marketplacer](https://support.marketplacer.com/hc/en-us/articles/25571003783309)

### Inferences
- Project spec already sets <= 15 min freshness, watermarked audited CSV export and scheduled reports; adopt: operational tiles near-real-time, returns/refund metrics labelled "settling" for the return window (14/30 days), health scores daily.

### Gaps
- Official export formats/scheduling for Shopify, Amazon, noon, Zalando, Etsy not verified.

## 4. Privacy limits and Egyptian PDPL

### Takeaway
No source found documenting platform aggregation thresholds; Amazon limits query data to top ranked queries and brand-registered sellers. PDPL (Law 151/2020, Regs. Decision 816/2025) stresses minimisation, purpose limitation and prior authorisation; its treatment of anonymised/aggregated data was not found.

### Cited Findings
- No k-anonymity threshold found in Amazon Brand Analytics docs — [search results](https://influencermarketinghub.com/amazon-search-query-performance-dashboard/)
- Regulations reinforce lawfulness, fairness, transparency, purpose limitation, data minimisation, storage limitation; Egypt favours prior authorisation esp. cross-border and e-marketing — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- PDPL applies to personal data of natural persons processed electronically — [Law 151/2020 text](https://eg.andersen.com/wp-content/uploads/2025/06/Law-No.-151-OF-2020.pdf)

### Inferences
- Keep k >= 50 for demographic/geography cells; suppress or merge small governorate cells and apply complementary suppression so differences between exports cannot reveal individuals; never show buyer-level rows beyond active-order fulfilment data; mask phone.
- Aggregates under k >= 50 are likely outside "personal data" but this needs counsel (add to verify register).

### Gaps
- PDPL anonymisation/aggregation and profiling provisions not found; needs counsel review.
- No platform publishes its threshold values in sources found.
