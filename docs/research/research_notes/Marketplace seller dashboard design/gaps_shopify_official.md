# Shopify official docs: gaps closed

Note: WebFetch worked, but it returns model-summarised excerpts and several pages were thin or only index pages. Many items remain "not fetched".

## (1) Staff permissions

### Takeaway
Only the structure was confirmed. Individual permission names and role bundles were not fetched.

### Cited Findings
- Permission categories: Store-level, Organization-level, Shopify POS app-level, Partner organization. Subpages: Store permissions, Organization permissions, Point of Sale permissions, Sensitive permissions, Required store permissions for options on the Settings page. [Source](https://help.shopify.com/en/manual/your-account/staff-accounts/staff-permissions)

### Inferences
- None.

### Gaps
- Full permission list and role bundles: not fetched (the store-permissions URL guessed returned only the index; the real subpage URL is unknown).

## (2) Inventory

### Takeaway
State definitions, reason codes and adjustment log not obtained.

### Cited Findings
- "Store inventory represents the number of each product variant that you have available to sell." [Source](https://help.shopify.com/en/manual/products/inventory/getting-started-with-inventory/inventory-states)

### Inferences
- None.

### Gaps
- States (available, committed, unavailable, incoming, on hand), reason codes, locations, low-stock handling, history log: not fetched.

## (3) Reports and metrics

### Takeaway
Three inventory report definitions confirmed verbatim; the rest not fetched.

### Cited Findings
- Sell-through rate: "Total quantity of items sold divided by the (total quantity of items sold + total quantity of items still in inventory)"; uses the most recent 30-day period. [Source](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports)
- Days of inventory remaining: "Total quantity of items still in inventory (ending quantity) divided by the average quantity of items sold per day"; variants with no sales show N/A; chart "displays how many product variants are predicted to run out of stock soon". [Source](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports)
- ABC analysis by product (28 days of revenue): A = "top selling products that collectively account for 80% of your revenue"; B = "next 15%"; C = "last 5%". [Source](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports)
- Default report categories: Acquisition, Behavior, Customers, Finance, Fraud, Inventory, Marketing, Order, Profit, Retail sales, Sales. [Source](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports)

### Inferences
- None.

### Gaps
- Total/Net/Gross sales, AOV, Conversion rate, Returning customer rate, Sessions, Sales by product definitions, and chart types per report: not fetched.

## (4) Product import CSV and bulk editor limits

### Takeaway
CSV field limits found; no file-size or row limit stated on that page. Bulk editor not fetched.

### Cited Findings
- Max 250 tags per product; up to 3 options; up to 20 barcodes; up to 250 images; alt text max 512 chars (125 recommended); SEO title 70; SEO description 320; collection name 255; UTF-8 with LF linefeeds. [Source](https://help.shopify.com/en/manual/products/import-export/using-csv)

### Inferences
- None.

### Gaps
- File size/row limits and bulk editor limits: not fetched or not stated.

## (5) Polaris guidance

### Takeaway
Not fetched.

### Cited Findings
- None.

### Inferences
- None.

### Gaps
- Data visualization, index tables, empty states, setup guide: not fetched (ran out of call budget).
