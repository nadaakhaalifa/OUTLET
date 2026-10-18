# Admin / Operator Console: KPIs, queues, seller health, governance, UX

Scope note: only 8 searches were run (search snippets, no full-page fetches). Coverage is partial; many items are listed as Gaps.

## Which metrics and thresholds do major platforms publish for seller performance, and what automatic actions follow?

### Takeaway
Platforms converge on three pillars (customer satisfaction, shipping performance, policy compliance) with small-percentage thresholds (cancel ~2.5%, late ~3-4%, defect 1-2%), and consequences that escalate from visibility loss to funds hold to deactivation.

### Cited Findings
- Amazon minimums commonly cited: order defect rate under 1%, late shipment rate under 4%, pre-fulfillment cancel rate under 2.5%. These come from third-party seller-tool sites, not Amazon docs (unverified against Seller Central). — [Repricer](https://www.repricer.com/blog/amazon-account-health/), [Feedvisor](https://feedvisor.com/university/improve-seller-rating/)
- Amazon account health draws on customer service (ODR, response), shipping (late shipment, tracking), and policy compliance (IP, authenticity, restricted products); policy violations can hit status despite clean metrics. — [Emplicit](https://emplicit.co/amazon-account-health-top-risk-factors-to-monitor/)
- eBay US: transaction defect rate max 2%, cases closed without seller resolution max 2 (or 0.3%); monthly level Top Rated / Above Standard / Below Standard; thresholds differ by site. — [eBay help](https://www.ebay.com/help/selling/selling-seller-performance/seller-performance-standards?id=4347)
- eBay minimum-volume rule: a 2.5% defect rate did not trigger Below Standard when fewer than 4 buyers were involved. — [eBay.ie](https://www.ebay.ie/help/selling/selling/seller-performance-overview?id=4080)
- eBay UK/IE Top Rated: defect rate 0.5% and max 3 unique buyers; late delivery max 3% and 5 transactions. — [eBay.co.uk](https://www.ebay.co.uk/help/policies/selling-policies/seller-performance-policy?id=4347)
- eBay consequences of Below Standard: lower search placement, account limits, held funds, higher final value fees, blocked from Promoted Listings. — [eBay help](https://www.ebay.com/help/selling/selling-seller-performance/seller-performance-standards?id=4347)
- Noon Account Health: lowest of three areas (customer satisfaction, shipping performance, policy compliance); tiers Excellent to Average to Critical; Critical gives 7 days to submit a corrective action plan or dispute, with lost offer visibility and ad privileges; then warehouse deactivation. — [Noon reputation dashboard](https://support.noon.partners/portal/en/kb/articles/seller-reputation-dashboard)
- Noon DirectShip: cancellation rate target under 2.5% per 7 days, late shipment rate under 3%; penalties include stock pulldown, offer deactivation, suspension or termination. — [Noon DirectShip](https://support.noon.partners/portal/en/kb/articles/directship-seller-performance-management)
- Noon FBP: SKU cancellation rate above 5% rated Very Poor; SKUs with under 10 orders unassessed; default window 90 days. — [Noon FBP dashboard](https://supportagent.noon.partners/portal/en/kb/articles/what-is-fbp-performance-dashboard)

### Inferences
- Design patterns to copy: minimum-sample guard (eBay 4 buyers, Noon 10 orders), "worst-of-pillars" aggregation (Noon), explicit dispute/corrective-action window before deactivation (Noon 7 days), rolling windows (7/30/90 days). Fits Z-OUTLET's automatic-ladder plus human review for suspension requirement (spec 9.5).

### Gaps
- Zalando partner quality metrics: not found in searches.
- Amazon first-party thresholds and exact scoring scale: only third-party sources found; one claims a 0-1000 scale (unverified).

## What does a best-in-class KYC review workbench contain?

### Takeaway
Only adjacent evidence found: queues routed by rules, fixed reject reason taxonomies, and immutable history. No single authoritative workbench spec located.

### Cited Findings
- Reason codes grouped as approve / decline / review-escalate; used for later analysis of agent decisions. — [Kount](https://support.kount.com/hc/en-us/articles/360045746411)
- KYB rejection reasons as a fixed set (missing, invalid, expired document, data mismatch, unrelated document); approval also checks representatives' KYC. — [Ondato](https://ondato.atlassian.net/wiki/spaces/PUB/pages/2317680676)
- Rules route cases into queues. — [Microsoft Dynamics 365 Fraud Protection](https://learn.microsoft.com/ro-ro/dynamics365/fraud-protection/case-management-administrator)
- One queue per use case. — [Socure RiskOS](https://help.socure.com/riskos/docs/queues)
- KYB statuses under review / approved / rejected with reason in dashboard or API. — [Bridge](https://support.bridge.xyz/articles/6523574169-what-kyc-and-kyb-statuses-should-i-expect)

### Inferences
- Workbench components consistent with this evidence: queue list with SLA timer and risk tier, document viewer beside a checklist, extracted-vs-declared field diff, reason-code picker on decision, append-only decision log. These are design inferences, not sourced.

### Gaps
- Risk tiers, SLA timers, document viewer features: no sources found.

## Information architecture: top-level sections of Shopify / Seller Central / Mirakl

### Takeaway
Not established. Mirakl public pages give only fragments; Shopify Polaris gives the list-page pattern (index table + filters + saved views), not the full nav.

### Cited Findings
- Mirakl operator back office lets operators invite sellers, run onboarding workflows and monitor progress; has Settings > Advanced Parameters > Shops (custom fields). — [Mirakl sellers](https://mirakl.com/sellers), [Stripe Mirakl guide](https://docs.stripe.com/use-stripe-apps/mirakl/onboarding-sellers)
- Polaris index filters: search, filter, sort and save results as named views (rename, duplicate, delete). — [Polaris](https://polaris-react.shopify.com/components/selection-and-input/index-filters)
- Polaris index table: bulk actions for many rows; add sorting/filtering for long lists; paginate past 50. — [Polaris index table](https://polaris-react.shopify.com/components/tables/index-table)
- Shopify advises one shared state for filters, sort, cursor and selected IDs; hover-revealed row actions. — [Shopify migration guide](https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/index-table.md)

### Inferences
- The index-table pattern (saved views as tabs, bulk bar on selection, cursor pagination) maps directly to admin queues.

### Gaps
- Full Mirakl operator menu, Seller Central nav, Shopify Admin nav: not found. Stripe Connect operator docs, NN/g, Baymard, Carbon/Atlassian not searched.
- Operator KPI catalogue (GMV, take rate, concentration etc.), fraud dashboards, RBAC/JIT/audit best practice: not researched in this pass.

## RTL dashboard pitfalls and accessibility

### Takeaway
Mirror layout and directional icons; keep numbers and untranslated text unchanged; sources conflict on charts, so decide by locale testing.

### Cited Findings
- RTL layout is the mirror image of LTR; numbers and untranslated text are not mirrored. — [Material bidirectionality](https://m2.material.io/go/design-bidirectionality)
- Mirror icons with directional meaning; do not mirror decorative icons, logos; undo/redo needs deliberate choice. — [Material](https://m2.material.io/go/design-bidirectionality), [SimpleLocalize](https://simplelocalize.io/blog/posts/rtl-design-guide-developers/)
- One source lists "graphs and charts" as not mirrored; another says progress bars fill right to left and sliders start on the right (conflicting treatment of charts). — [Saudisoft checklist](https://localization.saudisoft.com/?p=38918), [SimpleLocalize](https://simplelocalize.io/blog/posts/rtl-design-guide-developers/)
- Set dir="rtl" on html rather than hand-mirroring styles; Tabler ships an RTL dashboard with charts and tables. — [Tabler](https://docs.tabler.io/ui/getting-started/rtl.md)
- WCAG 2.2 AA additions: target size minimum 24x24 CSS px; dragging needs single-pointer alternative; accessible authentication (no cognitive tests). Source numbering inconsistent, verify against W3C. — [Deque](https://dequeuniversity.com/resources/wcag-2.2)

### Inferences
- Table column order flips with dir=rtl (first column on right); time-series x-axis direction is a product decision to test with Arabic users. Digits (Arabic-Indic vs Western) are a formatting choice, not covered by sources.

### Gaps
- Chart axis direction and numeral formatting guidance for Arabic dashboards: no authoritative source found.
- Keyboard shortcuts, global search, empty states, onboarding checklists: not researched.
