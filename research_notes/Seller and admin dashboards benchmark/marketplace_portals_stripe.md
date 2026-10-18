# Marketplace seller portals and Stripe Dashboard teardown

Method note: most portals are behind login. Findings come from public help pages and search-result summaries (full page text was fetched only for Stripe's dispute docs and payout docs; one Noon fetch timed out). Anything not directly cited is marked INFERRED. Roughly 12 tool calls used.

## 1. Information architecture, home overview, health scores, penalties

### Takeaway
Amazon uses a 0-1000 color-coded Account Health Rating (AHR) plus named metrics with thresholds; Jumia uses a weekly 4-week store rating that drives traffic and fees; Noon exposes a Governance and Performance area plus dashboards. Penalty transparency is partial everywhere; formulas are often unpublished.

### Cited Findings
- DOCUMENTED: Amazon AHR indicates risk of deactivation from policy non-compliance; it is a color-coded 0-1,000 score in near real time; points are lost on new violations and regained when fixed; violations weighted critical/high/medium/low. Amazon may deactivate regardless of score for suspected fraud. — [Amazon AHR policy](https://sellercentral.amazon.com/gp/help/external/G521)
- Score bands (200+ healthy, 100-199 at risk, 99 or lower unhealthy; new sellers start at 200) and Account Health Assurance eligibility (AHR 250+ in last 6 months) come from secondary sources only; one blog gives conflicting danger thresholds — [JumpFly](https://www.jumpfly.com/blog/the-ins-and-outs-of-amazon-account-health-ratings/), [SPS Commerce](https://www.spscommerce.com/community/articles/how-does-amazons-account-health-assurance-work), [Sellersonar](https://sellersonar.com/blog/glossary/account-health/)
- Amazon metric targets (third-party, not Amazon text): ODR under 1% over 60 days (negative feedback, A-to-z claims, chargebacks); late shipment rate under 4% (FBM only, 10/30-day windows); pre-fulfillment cancel rate under 2.5%; valid tracking rate 95%+. Located at Performance > Account Health. — [AdNabu](https://blog.adnabu.com/amazon/amazon-seller-metrics/), [Sellersonar](https://sellersonar.com/blog/glossary/account-health/)
- Noon: help center has a "Governance and Performance Management" overview tying together seller reviews, product quality control policy, Inventory Health Dashboard, Sales Overview, FBP Performance. Seller rating is a weighted average of star ratings with recent ratings weighted more, and affects Buy Box. Seller Lab home shows yesterday's sales vs 30-day average and ad sales. — [Noon governance](https://support.noon.partners/portal/en/kb/articles/governance-performance-management), [Noon homepage](https://supportagent.noon.partners/portal/en/kb/articles/navigating-your-homepage), [Noon ratings](https://support.noon.partners/portal/en/kb/articles/seller-reviews-ratings)
- Jumia: store rating covers prior four weeks, four indicators incl. vendor cancellation rate, refreshes weekly, higher rating gets more traffic. Seller score below 3 triggers extra fees (20% to 75% of prior week's commission, per one table); Official Store requires cancellation rate at or below 2% (Senegal site), with a quality report instead of immediate penalty. — [Jumia store rating](https://vendor.jumia.com/?p=523), [Jumia penalties table](https://vendor.jumia.com/?p=433), [Jumia Official Store](https://vendorhub.jumia.sn/official-store-standards-framework-eligibility-performance-compliance-requirements/), [Jumia penalties](https://vendorhub.jumia.sn/penalties/)
- Zalando: partner help pages list base fee, Marketplace Service fee, Payment Service fee, Convenience Incentive (new structure 1 Jan 2026); most detail login-gated. — [Zalando fees](https://partner.zalando.com/university/pp/accounting-and-fees)
- Stripe Dashboard home charts are estimates; exact figures live in Reports. — [Stripe support](https://support.stripe.com/questions/dashboard-home-page-charts-for-business-insights)

### Inferences
- INFERRED: Pattern across Amazon/Jumia/Noon: few named rates with explicit thresholds, a rolling window, a single traffic-light summary, and consequences tied to the band (visibility, fees, suspension). A Z-OUTLET Seller Health Score should publish its metrics, windows and thresholds, which matches the spec's transparency intent.
- INFERRED: Stripe's "home is estimate, Reports is exact" separation is a good rule for seller home vs finance reports.

### Gaps
- Noon thresholds and penalty amounts: not found (page fetch timed out; only summary seen).
- Namshi seller portal: not found.
- Amazon's own AHR band numbers: not found on Amazon's page in results.
- Etsy and Zalando health/penalty scoring: not found.

## 2. Order tracking, SLA timers, label printing

### Takeaway
Public documentation found is thin; only metric-level evidence (Amazon late shipment and valid tracking rates, Etsy tracking-driven reserves).

### Cited Findings
- Amazon late shipment rate and valid tracking rate are tracked as health metrics (see section 1 sources).
- Etsy: tracking can be added from Orders and Shipping; missing tracking/late shipping are listed risk factors for payment reserves; once Etsy verifies in-transit, reserved funds are accessible. — [Etsy payment account help](https://help.etsy.com/hc/articles/115015747228), [Alura summary](https://www.alura.io/docs/article/understanding-etsy-payment-account-reserves)

### Inferences
- INFERRED: Tying shipping behavior directly to money availability (Etsy) is a strong, explainable enforcement lever.

### Gaps
- Ship-by date timers, pipeline status views, label printing UX for Amazon Manage Orders, Noon, Zalando, Etsy: not found in public sources I reached.

## 3. Returns, refunds, disputes

### Takeaway
Stripe's dispute design is the clearest documented model: deadline-driven queue, category-specific evidence checklist, one-shot submission.

### Cited Findings
- Response window usually 7-21 days by card network; missing it loses the dispute automatically. Notified via email, Dashboard, webhook, push. — [Stripe respond to disputes](https://docs.stripe.com/disputes/responding)
- Disputes tab lists disputes; detail page shows category/reason, bank's claim documents, option to email the customer; actions are Accept or Counter. — same source
- Evidence form: first page asks why the dispute is wrong and product type, which tailors evidence checklist; one file per evidence type; 4.5 MB combined; Mastercard 19 pages; no links/audio/video; submission is final (one opportunity); bank decision can take up to 3 months; status under_review then won/lost. — same source
- Stripe pre-populates evidence from transaction data and flags Visa CE 3.0 eligibility with "Required for CE 3.0" badges; inquiries are a pre-dispute stage; countering incurs a fee returned on win. — same source
- Automation via Stripe Workflows and Apps. — same source
- Amazon A-to-z claims count toward ODR (see section 1). Third-party only.

### Inferences
- INFERRED: Reusable patterns: deadline countdown in the queue, evidence checklist keyed to reason, auto-prefilled evidence, explicit finality warning, separate pre-dispute stage (maps to Z-OUTLET return inspect then dispute).

### Gaps
- Amazon Returns dashboard and A-to-z claim response UX, Etsy case system, Noon/Zalando returns analytics: not found.

## 4. Payments, payouts, reconciliation, fees

### Takeaway
Stripe separates pending vs available balance and offers manual/daily/weekly/monthly schedules; Etsy shows reserves in the payment account; Zalando provides a monthly sales/returns report and settlement file.

### Cited Findings
- Stripe payout schedules: manual, daily, weekly or monthly; monthly dates that do not exist roll to month end; weekend dates move to next business day; payout reflects available balance when created; pending becomes available after settlement timing; minimum payout amounts apply. — [Stripe payouts](https://docs.stripe.com/payouts) (reconciliation section was in truncated text, not read)
- Etsy reserve: percentage of sales held on a rolling basis up to 45 days; payment account shows reserved amount, charge activity and amount available to deposit; triggers include order spikes, missing tracking, late shipping, refund increases. — [Etsy payment account help](https://help.etsy.com/hc/articles/115015747228), [Alura](https://www.alura.io/docs/article/understanding-etsy-payment-account-reserves)
- Zalando: monthly sales and returns report (all sales, returns, manual refunds); settlement file with type/subtype fields giving accounting context per transaction; both partially login-gated. — [Zalando accounting and payments](https://partner.zalando.com/university/pp/accounting-and-payments)
- Stripe Apps chart guidance: fixed-height containers, 180px compact vs 320px featured, line for trends, bar for comparison, sparklines for compact trends. — [Stripe chart layout](https://docs.stripe.com/stripe-apps/patterns/chart-layout)
- Third-party critique (not Stripe): dense sortable tables, right-aligned money, monospace numerals. — [AdminLTE roundup](https://adminlte.io/blog/25-best-dashboard-design-examples-for-2026-real-products-principles/), [925 Studios](https://www.925studios.co/blog/stripe-dashboard-design-breakdown)

### Inferences
- INFERRED: Settlement file with per-row type/subtype is the model for a seller ledger statement; Etsy-style visible reserve with a stated reason fits Z-OUTLET payout ON_HOLD.

### Gaps
- Amazon Payments/Statement view, VAT reports, Stripe balance chart and money-table design posts (no official Stripe design post found), Sigma, Billing analytics, Radar: not researched in depth / not found.

## 5. Inventory health, advertising, insights

### Cited Findings
- Noon Inventory Health Dashboard: covers FBN and FBP; daily update; tabs Pricing Improvement, FBP Replenishment, FBN Replenishment; urgency levels; actioned SKUs drop off list. — [Noon inventory health](https://support.noon.partners/portal/en/kb/articles/inventory-health-dashboard), [helpcenter](https://helpcenter.noon.partners/en/category/price-and-inventory/inventory-health-dashboard)
- Noon FBN Inventory Dashboard: saleable vs non-saleable by warehouse, search by PSKU/ZSKU/Pbarcode; non-saleable "Stranded Issue" items over 30 days incur storage fees. — [Noon FBN dashboard](https://support.noon.partners/portal/en/kb/articles/what-is-fbn-inventory-dashboard)

### Inferences
- INFERRED: Action-list-that-empties-as-you-act (Noon) is a good "what to fix" pattern.

### Gaps
- Amazon FBA aging/stranded/restock, Brand Analytics, ad reports, Seller app, Etsy Stats, Egypt-specific Arabic UI/COD reports, roles/permissions, notifications, weekly/daily seller needs: not found in sources reached.
