# Outlet NK: operating risks and economics in Egypt (as of 2026-11-06)

Method note: research was done with web search snippets only, in about 13 calls. Most hard cost figures (courier rate cards, PSP MDRs, BNPL merchant fees) are **not published**. Every figure below gives its year and source quality. Treat anything from a vendor blog as **unverified**.

## 1. COD refusal / RTO, delivery cost, COD remittance

### Takeaway
No courier (Bosta, Aramex, Mylerz, J&T) publishes Egypt RTO rates or a rate card. The only figure in circulation, 25–35% COD RTO, comes from vendor blogs and has no methodology. For planning, use it only as a pessimistic band and replace it with courier contract data.

### Cited Findings
- Egypt COD return-to-origin is 25–35%, against KSA 15–25% and UAE 10–18% (vendor blog, 2026, no methodology, **unverified**) — [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026)
- COD delivery cost per shipment in Egypt is about USD 1.00–1.80 (same blog, 2026, **unverified**; not Bosta-specific) — [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026)
- COD settlement is "typically 3–5 business days after delivery confirmation" (same blog, **unverified**). A template/SWOT site says 7–10 days for Bosta, but its other figures contradict each other, so it is unreliable — [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026); [canvasbusinessmodel](https://canvasbusinessmodel.com/products/bosta-swot-analysis)
- Bosta prices are usage-based with no public rate card, and its Shopify listing notes "additional charges may apply" — [Bosta Shopify app](https://apps.shopify.com/bosta-shipping-app)
- Bosta claims a ~95% delivery success rate (company claim) — [canvasbusinessmodel](https://canvasbusinessmodel.com/products/bosta-swot-analysis) (low-quality source)

### Inferences
- At USD 1.0–1.8 (~EGP 47–85 at ~47 EGP/USD), outbound delivery is a small share of a 2,000 EGP basket. The real cost is the RTO loop: a refused parcel costs two legs with no revenue. At 30% RTO, effective COD logistics cost per *delivered* order is roughly 1.6–1.9× the nominal fee. This supports the spec's risk-gated COD, delivery-fee prepayment and caps.
- Free delivery at ≥2,000 EGP per store is affordable per parcel, but multi-store bags multiply parcels. Hub consolidation (P2) matters for unit economics.

### Gaps
- Cairo vs governorate price differentials (EGP, 2025–26): no source found.
- Aramex, Mylerz and J&T rates, COD fees (% of collected cash) and remittance cycles: not found. Request quotes and sandbox access (verify-register rows 11–12).
- No courier-sourced Egypt RTO baseline.

## 2. Fashion return rates and reverse logistics

### Takeaway
No Egypt-specific online fashion return rate was found. MENA estimates are 15–40% depending on category, and vendor sources put fashion at 25–40%.

### Cited Findings
- Dubai Chamber studies put e-commerce return rates at 15–40% depending on category (cited in a 2022 op-ed) — [Al Arabiya](https://english.alarabiya.net/views/2022/07/28/Total-refund-requires-managing-the-growing-issue-of-e-commerce-returns-in-MENA-)
- Fashion and apparel returns are 25–40% (vendor blog, **unverified**) — [Omniful](https://omniful.ai/blog/returns-management-benchmarking-across-industries)
- US online apparel return rate was 24.4% in the 12 months to March 2023 (Coresight, US data) — [Coresight](https://coresight.com/research/the-true-cost-of-apparel-returns-alarming-return-rates-require-loss-minimization-solutions)
- Namshi offers 14-day returns with an instant wallet refund on approval (policy, current) — [Namshi](https://www.namshi.com/uae-en/return-policy/)

### Inferences
- Model 20–30% returns on top of COD RTO for the base case. Size tooling (Zalando: ~10% fewer size returns) is a direct margin lever.

### Gaps
- Reverse-logistics cost per return pickup in Egypt: not found.

## 3. CAC, CPI, CPM, retention

### Takeaway
No Egypt shopping-app CPI, Meta/TikTok CPM or retention benchmark was found in public sources. Egypt is below the threshold for AppsFlyer's public benchmarks.

### Cited Findings
- AppsFlyer's Egypt page (Android live-video-chat, 2023) shows CPI of about USD 0.34, but notes "thresholds for Egypt not met", so it displays Middle East data — [AppsFlyer](https://www.appsflyer.com/benchmarks/social-media/live-video-chat/live-video-chat---overall/android/egypt/2023-05-01/overall)
- Global shopping-app CPI (2021): Android USD 2.13 vs iOS USD 3.85 — [Liftoff 2021](https://content.liftoff.io/hubfs/aaa_Reports/2021/2021%20Shopping/2021%20Mobile%20Shopping%20Apps%20Report%20-%20EN.pdf)
- Generic guidance: iOS CPI about USD 2–5+, Android about USD 1–3 (vendor, not Egypt) — [Superads](https://www.superads.ai/facebook-ads-costs/cost-per-app-install/e-commerce/united-arab-emirates)

### Inferences
- Egypt CPI is likely well below global averages on Android. iOS is scarcer and pricier per install, but probably has higher spend per user. This is not evidenced: run a paid test campaign.

### Gaps
- Meta and TikTok CPMs for Egypt in 2025–26; D1/D30 retention for MENA shopping apps; Egypt iOS vs Android AOV.

## 4. Payment costs

### Takeaway
None of the PSPs publishes an official Egypt MDR in the sources found. The only public InstaPay fee is the consumer transfer fee.

### Cited Findings
- Kashier's listed rate is "from 2.75%" (aggregator, excludes fixed and chargeback fees, **unverified**) — [paymentproviders.io](https://paymentproviders.io/compare/kaspi-kz-vs-kashier?focus=fees)
- Paymob: 60+ payment methods, 395k+ active merchants across EG/UAE/KSA/Oman, no public rate found — [Forbes ME 2025](https://www.forbesmiddleeast.com/lists/the-middle-easts-fintech-50-2025/paymob/)
- InstaPay transfer fees since 1 April 2025: 0.1% of value, minimum EGP 0.50, maximum EGP 20. InstaPay reportedly turned profitable about a year later (April 2026) — [Business Today Egypt](https://www.businesstodayegypt.com/amp/1/6185/InstaPay-to-Introduce-New-Fee-Structure-Starting-April-2025); [Arab Finance](https://arabfinance.com/en/news/newdetails/instapay-turns-profitable-a-year-after-transfer-fee-rollout)
- InstaPay limits: EGP 70k per transaction and EGP 120k per day (secondary source) — [PhotonPay](https://www.photonpay.com/hk/blog/article/instapay-egypt?lang=en)
- valU: merchants receive full payment upfront, and admin fees/down payment can be collected at delivery or online. No MDR is published. A generic (US) BNPL merchant fee range is 2–8% — [Geidea valU docs](https://docs.geidea.net/docs/valu); [Resolve](https://resolvepay.com/blog/23-statistics-comparing-factoring-discount-rates-to-bnpl-fees)

### Inferences
- Planning placeholders: cards ~2.5–3%, BNPL ~3–8% (higher MDRs on longer tenors are typical). These are **assumptions to confirm in contracts** (verify-register rows 4–5).

### Gaps
- Fawry, Geidea and Paymob MDRs; InstaPay merchant/QR acquiring fees; Sympl merchant fees.

## 5. Commercially relevant regulation: what actually happened by late 2026

### Takeaway
The CPA is actively policing fake discounts on platforms for White Friday 2026, with fines up to EGP 2m. The PDPL grace period ended around 31 Oct/1 Nov 2026, and reporting points to gradual enforcement. Platform VAT is 14%, with registration push. No Egypt-specific small-parcel duty change was confirmed.

### Cited Findings
- 27 Oct 2026: CPA chairman Ibrahim El-Segini warned of fake White Friday discounts. Fines reach up to EGP 2m or twice the product value, and oversight covers e-commerce platforms and social media — [Ahram Online](https://english.ahram.org.eg/News/581028.aspx)
- Nov 2025: a CPA monitoring unit tracks discounts across marketplaces. Raising a price before discounting it is deceptive — [Ahram Online](https://english.ahram.org.eg/NewsContent/3/12/556313/Business/Economy/CPA-warns-of-stiff-fines-for-fraudulent-;White-Fri.aspx)
- PDPL: an operational PDPC licence is required from the end of the grace period (sources say 31 Oct or 1 Nov 2026). The DPO must be registered. Fines run up to EGP 5m. The PDPC planned "gradual enforcement" prioritising compliance — [Digital Policy Alert](https://digitalpolicyalert.org/event/45206-grace-period-for-compliance-with-personal-data-protection-law-no-151-of-2020-including-operational-license-requirement-ends); [Kennedys](https://www.kennedyslaw.com/en/thought-leadership/article/2026/egypt-s-personal-data-protection-law-the-compliance-countdown-has-begun); [Amwal Al Ghad](https://en.amwalalghad.com/?p=226843)
- VAT: standard rate 14% (Law 157/2025 amended the VAT law but kept 14%). Platforms are treated as intermediaries that collect and remit. The ETA urges platforms to register — [Kintsugi](https://trykintsugi.com/sales-tax-guides/africa/egypt); [Fonoa](https://www.fonoa.com/resources/country-tax-guides/egypt); [ETA](https://eta.gov.eg/en/node/771)
- Customs: ACI pre-registration for air cargo was scheduled as mandatory from 1 Jan 2026. Decree 430/2021 set e-commerce shipment procedures. Commercial guides say there is no universal duty-free threshold and that ~14% VAT applies on imports — [S-GE](https://www.s-ge.com/export/en/article/news/2025-e-egypt-ct10-advanced-cargo-information); [Amwal Al Ghad](https://en.amwalalghad.com/?p=222602); [PwC](https://pwc.com/m1/en/services/tax/me-tax-legal-news/2021/egypt-new-customs-regulations-minister-of-finance-decree-430-2021.html)

### Inferences
- The Price Integrity Engine is a real compliance moat, not just a feature: enforcement is live and the fines are material.
- ACI on air cargo raises friction for cross-border sellers (SHEIN/Temu-type supply), which modestly favours local off-price stock.

### Gaps
- No confirmed 2025–26 Egypt small-parcel de minimis change. EU changes (Reg. 2026/382) dominate search results and should not be confused with Egypt.
- No post-deadline PDPC enforcement actions found. No CPA fine totals against online stores in 2026.

## 6. Counterfeit and brand authorization

### Gaps
- No source found in this pass on Egyptian marketplace brand-authorization rules or counterfeit enforcement statistics. The spec's KYC plus brand-authorization requirement remains the safe default.

## 7. Macro: FX, rates, purchasing power, imports

### Takeaway
Macro conditions eased in 2025–26: rate cuts, a stronger pound and lower inflation. Data for late 2026 is incomplete.

### Cited Findings
- Deposit rates peaked at 27% in early 2025. A later CBE cut took the deposit rate to 19% (article undated, likely 2026). The pound strengthened to ~EGP 46.8/USD — [Ahram Online](https://english.ahram.org.eg/News/562609.aspx)
- Headline inflation was 12.5% in Oct 2025. The CBE target is 7% (±2) for Q4 2026, with upside risks from regional conflict (Apr 2026) — [Trading Economics](https://tradingeconomics.com/egypt/interest-rate/news/490056)

### Gaps
- The latest CBE decision, current CPI and the current EGP rate in Nov 2026. No 2025–26 source on import/LC restrictions was found (the 2022–23 LC regime was lifted in early 2023 per general knowledge, **unverified here**).

## 8. iOS share in Egypt and iOS-first

### Takeaway
iOS is only about 9–12% of Egyptian mobile traffic in 2026. iOS-first reaches a small, likely higher-spending slice, and caps volume.

### Cited Findings
- StatCounter Egypt mobile, Aug 2026: Android 88.0%, iOS 12.0%. June 2026: Android 91.1%, iOS 8.9% — [StatCounter](https://gs.statcounter.com/os-market-share/mobile/egypt)
- Global 2021: iOS shopping CPI is ~1.8× Android — [Liftoff](https://content.liftoff.io/hubfs/aaa_Reports/2021/2021%20Shopping/2021%20Mobile%20Shopping%20Apps%20Report%20-%20EN.pdf)

### Inferences
- iOS-first is defensible for a premium off-price launch with a curated 30-brand supply (affluent Cairo/Giza users, higher AOV that clears 2,000 EGP, lower COD dependency). It limits scale and COD-heavy demand, though. The plan's Android launch 6–8 weeks after iOS is critical. Consider pulling Android forward, or launching a web PWA for acquisition.
- Plus pricing (200 EGP/month ≈ USD 4.3; 800 EGP/year) is plausible for iOS users. Its value depends on order frequency: free delivery at ~50–85 EGP per order breaks even at about 3 orders/month for monthly Plus.

### Gaps
- No Egypt data on iOS vs Android spend or AOV.
