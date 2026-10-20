# Seller dashboards: orders, fulfilment, returns, payouts, finance, messaging

Scope note: this pass used 8 web searches (no page fetches). Findings come from search-result summaries; many official pages (Amazon Seller Central, Mirakl, Bosta, Zalando) were not reachable, so those areas are thin and flagged as gaps. Third-party blogs are labelled as such.

## 1. Order list/detail, statuses, actions, SLAs, labels, COD

### Takeaway
Marketplaces use a short seller-facing state chain (awaiting acceptance, shipping, shipped, received, closed) with accept/refuse as the first gate and tracking number as the ship trigger. Late-shipment and cancellation rates are the standard SLA metrics. COD remittance specifics for Egypt were not sourced.

### Cited Findings
- Mirakl order statuses seen via integrators: WAITING_ACCEPTANCE (seller can accept or refuse), PAYMENT_COLLECTED, SHIPPING (seller must ship; the ship action requires a tracking number), SHIPPED, RECEIVED, CLOSED. Refund from the integrator's "closed" state is only allowed when the Mirakl status is RECEIVED. — [Lengow Decathlon Mirakl orders](https://help.lengow.com/hc/en-us/articles/12957370606876-Decathlon-Mirakl-Orders-Management); [Sellercloud Mirakl](https://help.sellercloud.com/omnichannel-ecommerce/channel-integration-through-mirakl/)
- Amazon seller-fulfilled performance thresholds (third-party reports, not official): order defect rate 1%, late shipment rate 4% (10 and 30 day windows), cancellation rate 2.5%, on-time delivery 90%. Enforcement reportedly moving to per-offer blocking. — [Impakter](https://impakter.com/amazon-seller-performance-metrics/); [Ecomengine](https://www.ecomengine.com/blog/amazon-seller-performance-metrics); [ppc.land](https://ppc.land/amazon-blocks-the-failing-fbm-offer-not-the-account-from-august-31/)
- Faire: a canceled order was never charged to the retailer; retailers without net terms are charged when the order ships; if an order takes more than 14 days to ship, the net-60 due date moves to 60 days after ship date. — [Faire support](https://www.faire.com/support/articles/360006920172) (via search summary; confirm article)
- Noon FBP returns: customers request returns within 14 days; Noon makes up to three delivery attempts to return item to seller. — [Noon FBP returns policy](https://supportagent.noon.partners/portal/en/kb/articles/handling-customer-returns-policy-for-fbp)
- Generic (non-Noon) claim that COD sellers are paid only after delivery, cash collection and courier remittance, 7-15 days later. — [Inc42 / third-party blogs via search](https://inc42.com/?p=461748) (unverified for MENA)
- Delhivery (India, not Egypt) remits COD to seller bank within 48 hours, shown only as a pattern example. — [Delhivery](https://help.delhivery.com/docs/cod-remittance.md)

### Inferences
- Recommended Z-OUTLET seller states map cleanly to Mirakl: PAID/CONFIRMED_COD (awaiting acceptance) -> ACCEPTED -> PACKED -> SHIPPED -> DELIVERED -> CLOSED, with REJECTED_BY_SELLER, CANCELLED, and RTO branches. Ship action should require AWB/tracking.
- Dashboard should expose acceptance and dispatch countdowns plus late-dispatch and cancellation rates modelled on the Amazon metric set, with thresholds set by Z-OUTLET (not copied from Amazon).
- COD needs a separate "collected by courier / remitted / reconciled" sub-status per shipment, plus RTO and refusal-reason columns.

### Gaps
- Official Mirakl state machine docs (including operator-side states) not retrieved.
- Amazon official order/Account Health pages, Shopify fulfilment statuses, Etsy, Zalando order flows not retrieved.
- Bosta API states, webhooks, COD remittance cycle: official docs not found; only third-party tracking pages. Aramex/DHL not researched.
- Pick list and label print workflows not sourced.
- Split shipment / partial fulfilment behaviour not sourced.

## 2. Returns, exchanges, refunds, disputes

### Takeaway
Noon's published seller-protection model (grade-based compensation, time-bound windows, returnless refunds) is the most relevant regional reference found. Seller-balance effects of refunds were only sourced via reserve mechanics.

### Cited Findings
- Noon covers return requests within 15 days of delivery under its Seller Protection Fund, and proactively compensates sellers in certain cases; grading-based compensation tiers exist (one version shows 5% for dead-on-arrival/manufacturing defect and 15% for missing accessory plus dented box; versions differ, verify). Direct-ship grading support payouts stopped for returns processed via AFS warehouse from 1 Dec 2024; sellers can dispute via Seller Lab. — [Noon returns and seller protection](https://helpcenter.noon.partners/en/category/program-policies/returns-and-seller-protection-policy); [alt version](https://support.noon.partners/portal/en/kb/articles/returns-and-seller-protection-policy)
- Noon FBP: sellers have 48 hours to message customers before pickup; returnless refunds exist for incorrect or damaged orders with a 48-hour window to issue the refund. — [Noon FBP](https://supportagent.noon.partners/portal/en/kb/articles/handling-customer-returns-policy-for-fbp); [Noon returnless refund](https://helpcenter.noon.partners/en/category/fulfilled-by-partner-fbp/returnless-refund-for-directship-sellers)
- Amazon reserves hold funds against future refunds, chargebacks and claims (third-party description). — [Feedvisor](https://feedvisor.com/university/payments/)

### Inferences
- Recommend: reason taxonomy on intake, photo evidence, seller inspection SLA with auto-approve on silence (already in spec section 22), dispute escalation with evidence thread, and a returnless-refund option for low-value items.
- Refund hits seller balance as a reversing ledger entry; if already paid out, negative balance is netted from next payout (matches spec).

### Gaps
- Amazon A-to-Z / returns official docs, Zalando, Mirakl incident/refund API, Etsy case system not retrieved.
- Who-pays-shipping matrices on these platforms not sourced.

## 3. Payouts, balances, holds, statements, reports

### Takeaway
All sourced platforms separate funds-in-hand from reserved/held funds, expose scheduled payout dates and statuses, and provide downloadable statements. Reserves are risk-based with expiry and review.

### Cited Findings
- Shopify: reserve amount depends on risk level, has an expiry; before expiry Shopify reviews and may keep, reduce or raise it; otherwise it moves into upcoming payouts. Balance shown under Settings > Payments > View payouts is reserved funds plus next payout. — [Shopify reserves](https://help.shopify.com/en/manual/payments/shopify-payments/reserves)
- Shopify payout statuses include In Transit, Paid, Failed; payout details are viewable and exportable; changing schedule defers pending payouts to the next date on the new schedule; monthly schedule on a missing day pays on last day of month. — [Shopify payout details](https://help.Shopify.com/en/manual/payments/shopify-payments/getting-paid-with-shopify-payments/view-payouts/view-details); [Shopify scheduling](https://help.shopify.com/cs/manual/payments/shopify-payments/getting-paid-with-shopify-payments/view-payouts/schedule-payouts)
- Amazon: settlement reports downloadable from Reports > Payments, with Statement View (open settlement) and All Statements tabs; account reserve is funds not disbursed in the selected settlement period. — [Amazon Pay help (settlement reports)](https://payments.Amazon.com/help/201212310); [Amazon help](https://pay.amazon.com/help/202070210)
- Amazon disbursement roughly every 14 days per third-party guides; a single vendor claims a DD+7 hold from 12 March 2026 (unverified). — [InventoryHero](https://www.inventoryhero.ai/blog/amazon-payout-schedule); [Hector AI](https://hectorai.live/blog/amazon-seller-payment-schedule)
- Etsy: temporary reserve withholds a percentage of new physical-item sales; Etsy says reserved money is on average available within two weeks of order date; adding tracking is the usual release route; schedules daily/weekly/biweekly/monthly (per third party). — [Etsy community announcement](https://community.etsy.com/t5/Announcements/Renewing-our-commitment-to-protecting-the-Etsy-marketplace/td-p/134308237); [Etsy Seller Handbook](https://www.etsy.com/seller-handbook/article/1177649220109); [Alura](https://alura.io/docs/article/understanding-etsy-payment-account-reserves)
- Faire: payout speed is brand-selected (next-day 3.5% + $0.30, 30-day 2.4% + $0.30, 60-day 1.9% + $0.30, timed from ship); retailer payment terms do not affect payout timing. — [Faire support](https://www.faire.com/support/articles/30874207730331) (via search summary; verify)

### Inferences
- Recommended balance types: pending (not delivered / in return window), available (CLOSED, no dispute), reserved (risk or refund reserve, with expiry and reason), COD-in-transit, negative/netting.
- Statement columns: order/line, event type, gross, commission, VAT on commission, shipping, promo funding, refunds, adjustments, net, payout ref. Filters: date, store, type, payout status. Exports: CSV, PDF statement, e-invoice list.
- Standard reports: settlement/statement, fee breakdown, VAT/e-invoice, returns/refunds, COD remittance reconciliation.
- Release-on-tracking (Etsy) is a useful pattern for dispatch-linked release.

### Gaps
- Noon payout schedule and statement format, Zalando Partner Program finance, Mirakl invoicing/accounting docs, Stripe Connect balance docs not retrieved.
- Chargeback handling specifics and negative-balance rules from official sources not found.
- Tax documents (1099-K etc.) not researched; Egyptian ETA specifics are in the master prompt.

## 4. Customer messaging, Q&A, notifications

### Takeaway
Little sourced. Noon requires seller contact with the customer within 48 hours for return pickups, indicating a messaging SLA.

### Cited Findings
- Noon FBP sellers using the messaging service have 48 hours to contact customers about a return request. — [Noon FBP](https://supportagent.noon.partners/portal/en/kb/articles/handling-customer-returns-policy-for-fbp)

### Inferences
- Recommend in-platform message threads per order/return, templates, response-time metric in seller health, and event notifications (new order, accept deadline approaching, dispatch late, return requested, dispute opened, payout sent).

### Gaps
- Amazon Buyer-Seller Messaging rules, Shopify Inbox, Etsy conversations, Mirakl messaging, notification catalogues not retrieved.
