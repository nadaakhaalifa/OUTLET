# Commerce platform merchant admin and analytics dashboards: teardown

Evidence labels: DOCUMENTED = stated on the cited page. INFERRED = my reasoning. Not found = no evidence retrieved. Fetch notes: polaris.shopify.com/design/data-visualization 301-redirected to shopify.dev/docs/api/polaris (not retrieved; no Polaris data-viz guidance obtained). Several Shopify help pages returned only partial content (WebFetch summarises pages), so absence in my notes means "not found in what was returned", not "absent from Shopify". BigCommerce help centre was not reached; only third-party sources. About 25 tool calls used.

## Home screen and KPI tiles (what, order, decisions)

### Takeaway
Shopify Home is a short set of 4 metrics plus action cards; the deeper Analytics dashboard is a customisable card grid with comparison and drill-in. Wix and Lightspeed use a summary page plus per-domain tabs. Real-time vs daily vs weekly split is only partly documented.

### Cited Findings
- DOCUMENTED Shopify Home, after a first sale, shows by default sessions, total sales, total orders, conversion rate for the last 30 days across all channels; merchant can customise the four metrics and the date range/channels. Layout described: activity globe in the header, then metrics, order tasks, a feed of cards (Sidekick Pulse recommendations, Sidekick guides, insights), "Discover more" at bottom. In the mobile app, tapping a metric expands or collapses a chart preview linking to the full report. — [Shopify Home](https://help.shopify.com/en/manual/shopify-admin/shopify-home)
- DOCUMENTED Shopify Analytics dashboard is a collection of customisable data cards; each links to a report; cards can be added, removed, rearranged, grouped into labelled sections, resized; metric targets can be set; auto-generated insights; data updates within about one minute; all channels. — [Analytics overview](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports), [Overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard)
- DOCUMENTED Saving a custom report from a data exploration also creates a metric card. Staff need Analytics permission. — [Analytics overview](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports)
- DOCUMENTED Customise (editing cards) works only on desktop; changes show on desktop and mobile. — [Overview dashboard (search snippet)](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard?r_done=1)
- DOCUMENTED Shopify's compact metric card (size="small") is title + value + percent-change indicator, and its example image shows a small sparkline; `COMPARE TO previous_period` with `PERCENT_CHANGE` drives the delta; `VISUALIZE` sets chart type; optional polling interval; footer link drills into a report. — [metric-card docs](https://shopify.dev/docs/api/shopifyql/latest/web-components/metric-card.md)
- DOCUMENTED Wix: Sales Overview date picker defaults to 30 days and excludes the current day; each section has "View Report"; a Highlights page previews Sales Overview with top-selling items and top paying customers. — [Wix Sales Overview](https://support.wix.com/en/article/wix-analytics-understanding-the-sales-overview), [Highlights](https://support.wix.com/en/article/wix-analytics-about-the-highlights-page)
- DOCUMENTED Lightspeed Retail Analytics has tabs Overview, Sales, Inventory, Employees, Customers, with a Locations dropdown. — [Lightspeed](https://www.lightspeedhq.com/pos/retail/report-with-retail-pos-system/)
- Third-party only (not official) BigCommerce has a Store Overview dashboard (orders, customers, visits, revenue) in a set of 11 reports. — [Polymer](https://polymersearch.com/blog/a-guide-to-bigcommerce-analytics-what-to-consider), [Putler](https://www.putler.com/?p=152653)
- Square: Reports > Sales summary with date range, reporting hours, locations, grouping by day/week/month. — [Square help search result](https://squareup.com/help/us/en/article/7192-set-up-reporting-hours)

### Inferences
- INFERRED Shopify Home's 4 tiles serve a daily "is today normal" check; Analytics cards serve weekly review; targets and insights serve goal tracking.
- INFERRED Sparkline-in-tile plus delta is the small-tile standard (from the Shopify component example).

### Gaps
- Exact tile order on Analytics dashboard, Wix, Square, BigCommerce home: not found.
- Square/Lightspeed/Wix/BigCommerce sparkline use: not found.

## Date-range comparison

### Takeaway
Shopify documents the richest comparison model (previous period or same time last year, percent change).

### Cited Findings
- DOCUMENTED Shopify dashboard compares today vs yesterday by default; user picks preset or custom range, then Compare to previous period or same time last year; percent change available for metrics. Source is a search summary of the official page; a community thread describes a differing checkbox UI, so UI may have changed. — [Overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard?r_done=1)
- Shopify Home page article does not mention period-over-period comparison. — [Shopify Home](https://help.shopify.com/en/manual/shopify-admin/shopify-home)
- Wix table views: change time period, filters, columns. — [Customizing Wix reports](https://support.wix.com/en/article/customizing-wix-analytics-reports)

### Inferences
- INFERRED Line chart with dashed previous-period overlay is implied by compare feature, but chart styling was not documented in retrieved text.

### Gaps
- Preset list, Polaris guidance on comparison lines: not found.

## Funnels, cohorts, retention, customers

### Takeaway
Shopify ships cohort heatmap with retention-curve alternative and RFM; BigCommerce reportedly has a Purchase Funnel report (third-party).

### Cited Findings
- DOCUMENTED Customer reports: new customers over time; new vs returning (graph and table); one-time vs returning lists; customers by location; Customer cohort analysis (default heatmap of cohorts x periods, alternative retention curve, cohort table with customer count, retention rate, sales, AOV; projections need 24 months of data); predicted spend tier; RFM (1-5 scores, 11 groups, data table). No separate retention report; retention is a cohort metric. — [Customers reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/customers-reports)
- DOCUMENTED Default report categories: Acquisition, Behavior, Customers, Finance, Fraud, Inventory, Marketing, Order, Profit, Retail sales, Sales. — [Default reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports)
- Third-party BigCommerce reports include Purchase Funnel, Abandoned Cart, Abandoned Cart Recovery, Real-Time, Merchandising, Marketing, Orders, Customers, In-Store Search, Sales Tax. — [Putler](https://www.putler.com/?p=152653)
- Lightspeed customers tab exists (contents not retrieved). — [Lightspeed](https://www.lightspeedhq.com/pos/retail/report-with-retail-pos-system/)

### Gaps
- Shopify conversion funnel report (Behavior category) details: not found. Wix/Square funnels: not found.

## Sales by channel/product/location, live view

### Cited Findings
- DOCUMENTED Shopify Home/Analytics filter by sales channel; Live View shows online-store traffic. — [Analytics overview](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports)
- DOCUMENTED Home header has an "activity globe". — [Shopify Home](https://help.shopify.com/en/manual/shopify-admin/shopify-home)
- DOCUMENTED Wix Sales reports break down by coupon, order source, billing location, shipping method. — [Wix sales reports](https://support.wix.com/en/article/understanding-wix-analytics-sales-reports)
- DOCUMENTED Square sales summary can pick locations; Lightspeed has Locations dropdown and Sales by Employee / Team Performance / Sales by Hour of Day. — links above and [ShopKeep sales by employee](https://shopkeep-support.lightspeedhq.com/support/reporting/sales-by-employee)

### Gaps
- Live View metrics, map/globe specifics, refresh rate: not found (the help page fetches did not return Live View content). BigCommerce real-time report contents: not found officially.

## Inventory aging and ABC

### Cited Findings
- DOCUMENTED Shopify inventory reports: month-end snapshot and value; inventory sold daily; products by percentage sold; ABC product analysis (A about 80% revenue, B about next 15%, C last 5%, last 28 days); sell-through rate (30 days, about two-day delay); days of inventory remaining (28-day average daily sales); adjustment changes and counts by staff/location/app/reason. — [Inventory reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports)
- DOCUMENTED Lightspeed Retail reports include Sell Through, Dusty Inventory, Low Stock Alerts, Margin Alert, Turns, GMROI; advanced tier adds inventory performance and replenishment. ABC not found there. — [Lightspeed search results](https://retail-support.lightspeedhq.com/hc/articles/4410640218523)

## Orders, fulfilment, refunds/returns

### Cited Findings
- DOCUMENTED Shopify orders have two stages (payment, fulfilment); filter by fulfilment status, payment method, date; search by number, customer, product; full/partial refunds, cancel, returns, exchange items, self-serve returns. — [Manage orders](https://help.shopify.com/en/manual/orders/manage-orders)

### Gaps
- Saved views/tabs, bulk actions, order timeline, status values, return reporting, order pipeline visuals: not found (page did not cover). BigCommerce/Wix/Square/Lightspeed order UX: not searched.

## Report builders, saved views, exports, alerts

### Cited Findings
- DOCUMENTED Shopify reports show graph + table, max 1,000 rows displayed (totals cover all), export for full rows; customisable as new exploration; default reports filterable by Created by. — [Reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports)
- DOCUMENTED ShopifyQL Notebooks available to Plus at no extra cost; notebook export is PNG via presentation mode; no native scheduling found, third-party apps fill the gap (vendor marketing). — [ShopifyQL notebooks](https://www.shopify.com.au/enterprise/shopifyql-notebooks), [Creating notebooks](https://help.shopify.com/cs/manual/reports-and-analytics/shopifyql-notebooks/creating-notebooks), [ECOSIRE](https://ecosire.com/ja/apps/shopify/scheduled-reports-exporter)
- DOCUMENTED Shopify Flow: free app, trigger/condition/action, on Basic, Grow, Advanced, Plus. — [Flow](https://help.shopify.com/en/manual/shopify-flow)
- DOCUMENTED Wix: customised table saved as named view (table view only); developer docs list a custom-reports page. — [Wix customizing](https://support.wix.com/en/article/customizing-wix-analytics-reports)
- DOCUMENTED Square custom reports: owner/team with permission; blocks (key stats, sales summary, payment methods, item/category/team sales, discounts, modifiers, taxes); exportable; saved date filters not supported; not viewable in POS app; no scheduling found. — [Square 6104](https://squareup.com/help/article/6104)
- DOCUMENTED Lightspeed custom reports from a base report, favourites. — [Lightspeed](https://retail-support.lightspeedhq.com/hc/articles/4410657877659)

### Gaps
- Shopify alerts for metrics, scheduled Shopify exports: not found officially. Square scheduled reports: not found.

## Roles, mobile, AI

### Cited Findings
- DOCUMENTED Shopify staff need Analytics permission. Square custom reports need reports permission; only owners set email notifications. Shopify mobile (iOS/Android) manages orders, products, analytics; some advanced settings desktop-only. — [Analytics overview](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports), [Mobile](https://help.shopify.com/en/manual/shopify-admin/shopify-mobile)
- DOCUMENTED Sidekick: analyses data, manages orders, edits products, creates content, generates custom apps; Pulse shows recommendations on Home; changes presented for review before applying. Page does not mention ShopifyQL/Flow. — [Sidekick](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/sidekick)

### Gaps
- Wix/Square/Lightspeed/BigCommerce mobile apps and AI assistants: not researched. Payouts/finance UX: payouts page returned no statuses (not found).

## Chart types and why

### Cited Findings
- DOCUMENTED Cohort: heatmap default, retention curve alternative. RFM: table. Reports: graph + table. KPI: value + delta + sparkline. Globe on Home. (sources above)

### Inferences
- INFERRED Choice rationale (heatmap for cohort density, table for segmentation) is my reasoning; Polaris data-viz rationale not found.

### Gaps
- Polaris data-visualization guidelines and Shopify engineering blog: not retrieved (redirect, no time budget). Map/funnel chart usage: not found.
