# Operator capabilities and seller performance standards (gap closure)

Fetch status: WebFetch worked for docs.stripe.com and ebay.com. NOT fetched / JS-shell only: Amazon Seller Central help (returned landing page only), Mirakl help (empty), Mirakl developer shop-state enums (index page only), Zalando partner portal (index only, no KPI values), Noon (timeout). All sources below are OFFICIAL unless noted.

## 1. Stripe Connect: onboarding, KYC statuses, risk, payouts, balances

### Takeaway
Stripe exposes a requirements hash (currently_due/eventually_due/past_due/pending_verification, current_deadline, disabled_reason) as the KYC state model; there is no single status enum. Loss liability, payout delay and negative-balance handling are platform-configurable.

### Cited Findings
- requirements hash properties: `current_deadline`, `currently_due`, `disabled_reason`, `errors`, `eventually_due`, `past_due` (subset of currently_due; capabilities disabled because unresolved before deadline), `pending_verification` — [Stripe handling-api-verification](https://docs.stripe.com/connect/handling-api-verification)
- Flags `charges_enabled` and `payouts_enabled` indicate whether account can charge / receive payouts; Stripe typically disables payouts if info not received by current_deadline — same URL
- disabled_reason values: `action_required.requested_capabilities`, `listed`, `rejected.fraud`, `rejected.incomplete_verification`, `rejected.listed`, `rejected.other`, `rejected.terms_of_service`, `requirements.past_due`, `requirements.pending_verification`, `under_review` — same URL
- Risk requirement format `interv_<id>.<requirement_description>.<resolution_path>`; resolution paths: `challenge`, `form`, `notice`, `support`, `underwriting_case`; descriptions include `business_model_verification`, `restricted_or_prohibited_industry_diligence`, `intellectual_property_usage`, `supportability_rejection_appeal`, `credit_review`, `reserve_appeal`, `identity_verification`, `url_inquiry`, `address_verification`, `bank_account_verification`, `sanctions_review`, `pep_review`, `legal_hold`, `rejection_appeal` — same URL
- Balances: `pending` and `available`; platform may also have `connect_reserved` balance to offset negative connected-account balances — [Stripe account-balances](https://docs.stripe.com/connect/account-balances)
- Negative balance liability: Accounts v2 `defaults.responsibilities.losses_collector`, v1 `controller.losses.payments`; value `stripe` or `application` — same URL
- Negative balance: Stripe debits external account up to max attempts, then pauses payouts; balance negative 180 days triggers `connect_collection_transfer` from platform; recommends rejecting account afterwards; reserve held 3 additional business days — same URL
- Compliance fund holds: Thailand 10 days, United States 2 years, all others 90 days — same URL
- Payout schedule `interval`: `manual`, `daily`, `weekly`, `monthly`; `delay_days_override` up to 31; platform owning fraud/dispute liability can edit — [Stripe manage-payout-schedule](https://docs.stripe.com/connect/manage-payout-schedule)
- Risk tooling: Radar on by default at user level; Connected accounts page flags restricted/expected-restricted accounts; pause payouts, pause payments, reject (permanent), close/delete; "dispute activity above 0.75% is generally considered excessive"; filter for accounts with negative balances; "View financial reports" per account — [Stripe risk best practices](https://docs.stripe.com/connect/risk-management/best-practices)
- Stripe recommends new platforms have Stripe take negative-balance responsibility — same URL

### Inferences
- Z-OUTLET's seller KYC state machine can mirror: currently_due / pending_verification / past_due plus a deadline and a disabled_reason enum; payout hold and reserve are operator levers.
- Our ledger is system of record (spec T4), so Stripe's liability model is a reference, not an adoption.

### Gaps
- Radar-with-Connect page, reporting pages, and loss-liability matrix by account type not fetched.

## 2. Mirakl operator back office, shop KYC, quality indicators

### Takeaway
Not verified from official pages.

### Cited Findings
- Operator API exposes shop documents endpoints: GET/POST /api/shops/documents, GET /api/shops/documents/download, DELETE /api/shops/documents/{document_id} — [Mirakl developer index](https://developer.mirakl.com/content/product/mmp/rest/operator/openapi3/shops)

### Gaps
- Shop states, KYC statuses, quality indicators, reports: help.mirakl.com returned empty; full OpenAPI at https://developer.mirakl.com/_bundle/content/product/mmp/rest/operator/openapi3.yaml not fetched.

## 3. Zalando partner programme

### Cited Findings
- Partner portal has "Analyse performance" and "Assortment and return rates" pages for Partner Program and Connected Retail; webinars on reducing return rate; onboarding covers legal details and per-market contact, carrier and VAT info — [Zalando partner portal](https://partner.zalando.com/)

### Gaps
- No KPI definitions, thresholds or return-rate benchmarks retrieved; deep pages not fetched.

## 4. eBay seller standards and Amazon Account Health

### Takeaway
eBay fully verified; Amazon not retrievable (JS-rendered).

### Cited Findings (eBay)
- Levels: Top Rated, Above Standard, Below Standard — [eBay seller standards](https://www.ebay.com/help/policies/selling-policies/seller-performance-policy/seller-performance-standards?id=4347)
- Evaluated on the 20th of each month; if >400 transactions in past 3 months those are counted, else last 12 months — same URL
- Minimums: cases closed without seller resolution: higher of 2 cases or 0.3% of transactions; transaction defect rate 2% max, Below Standard only if defects involve more than 4 different buyers — same URL
- Top Rated: defect rate 0.5% or less from 3 or fewer buyers; late shipments 5 or fewer (or 3%); tracking uploaded on at least 95% within handling time; account 90+ days; 100+ transactions and $1,000 US sales in 12 months; upgrade on 1st of following month — same URL
- Below Standard consequences: lower Best Match placement, reduced selling limits, blocked from Promoted Listings, possible funds hold until tracking shows in transit, no deduction from refunds for used/damaged returns; from the 1st of next month possibly higher final value fees; extended period: possible Store downgrade and selling restrictions — same URL
- Appeals: cases appeal within 30 days of eBay decision; late shipments appealable with valid tracking; defects removable in certain circumstances — same URL
- From October 15, 2026 eBay Live transactions no longer count toward standards — same URL

### Gaps
- Amazon Account Health (G200205250): only landing page returned; no metrics (ODR, LSR, cancel rate, thresholds) verified.

## 5. Noon seller policies

### Gaps
- sell.noon.com fetch timed out; nothing verified.
