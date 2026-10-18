# Egypt e-commerce unit economics for an off-price fashion marketplace

Status: PARTIAL. Only 7 searches were run; no fetch of primary pages (provider fee pages, Bosta rate cards, FRA/CBE) was made, and search returned almost no hard fee numbers. Most cost inputs below are UNSOURCED PLACEHOLDER ASSUMPTIONS and are labelled as such. Do not present them as facts. FX used: about EGP 50.7 per USD (late July 2026).

## What is a realistic contribution margin per order for a COD-heavy fashion marketplace in Egypt (low/base/high)?

### Takeaway
No sourced benchmark for Egyptian fashion contribution margin was found. An illustrative model (assumptions only) gives a thin positive margin of roughly 5-7% of AOV before CAC in the base case, negative in the low case. COD refusal, return rate and shipping subsidy dominate.

### Cited Findings
- Typical Egyptian AOV is quoted at USD 30-50 (about EGP 1,500-2,500 at 50.7); no category split or date, low quality — [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026)
- ECDB has a 2025 fashion AOV figure but it is paywalled; ECDB puts Egypt fashion e-commerce revenue at USD 401m (2025), Ken Research puts fashion/apparel at USD 820m; sources differ widely — [ECDB](https://ecdb.com/resources/sample-data/market/eg/fashion), [Ken Research](https://www.kenresearch.com/industry-reports/egypt-e-commerce-fashion-apparel-market)
- After the March 2024 devaluation, locally sourced goods rose from about one-third of online fashion (2023) to about one-half (2025); only 8.3% of Egyptians were regular online buyers in 2025 (vendor report, unverified) — [Ken Research](https://www.kenresearch.com/industry-reports/egypt-e-commerce-fashion-apparel-market)

### Inferences
- See parametrised model at the end. Base case about EGP 100 per placed order (about USD 2) before CAC, on AOV EGP 1,500. Entirely assumption-driven.

### Gaps
- No fashion contribution margin, return-rate or support-cost-per-order benchmark for Egypt/MENA found (Jumia/Noon investor material not searched).

## Payment fees and settlement (Paymob, Kashier, Fawry, Meeza, InstaPay, wallets, BNPL)

### Takeaway
No published percentage fees were found for any provider. Fees are contract-negotiated; treat all rates as unverified.

### Cited Findings
- Paymob earns via percentage-of-payment transaction fees; supports cards, wallets, QR, installments, BNPL; no rate found — [Dealroom](https://dealroom.co/companies/paymob)
- valU: merchants register with valU and receive full payment upfront once the transaction is processed (via Geidea integration); no merchant discount rate found — [Geidea docs](https://docs.geidea.net/docs/valu)
- valU H1 2025: BNPL was 60% of GMV, gross revenue up 94% to EGP 2.6bn; does not reveal merchant fees — [Techpoint](https://techpoint.africa/news/egyptian-fintech-valu-h1-results/)

### Inferences
- Placeholder assumptions (not sourced): cards/wallets about 2-3% plus fixed fee; InstaPay lower; BNPL merchant discount about 4-10%+ (needs provider quotes); settlement T+1 to T+3 for cards, longer for Fawry/BNPL.

### Gaps
- Fee and T+n for Paymob, Kashier, Fawry, Meeza, InstaPay, wallets; MDR for valU, Sympl, Aman, Contact, Souhoola. Needs provider sales quotes (matches VERIFY register row 4/5).

## COD share, RTO and refusal; courier rates

### Takeaway
COD share is cited anywhere from 51% to 85%; no Egypt-specific refusal/RTO rate or courier rate card was verified.

### Cited Findings
- COD preference 62% (academic paper, Apr 2024) — [IJPPE](https://ijppe.journals.ekb.eg/article_351297_a729280a6428d63eedab519b038a5745.pdf); 51% — [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026); 70-85% (unnamed studies, vendor blog) — [eGrow](https://www.egrow.com/en/blog/egypt-ecommerce-statistics-trends-2026). Sources conflict; use 50-80% range.
- MENA return/failed-delivery rate said to be about five times the global average (2019 report, regional, not Egypt-specific) — [IJPPE](https://ijppe.journals.ekb.eg/article_351297_a729280a6428d63eedab519b038a5745.pdf)
- Bosta pricing is quoted per merchant, not published; supports next-day COD transfers — [Shopify app listing](https://apps.shopify.com/bosta-shipping-app?locale=fr). A page listing 65 EGP Cairo / 80 EGP Alexandria does not name Bosta and must not be attributed to it.
- Prior brief figure of MENA COD RTO 25-35% remains unverified (eGrow, unsourced upstream).

### Inferences
- Placeholder: outbound parcel EGP 50-100 by zone, COD fee 1-2% of collected, return leg about 50-100% of outbound. Unsourced.

### Gaps
- Rate cards for Bosta, Aramex, Mylerz, J&T, R2S; COD remittance cycle; Egypt RTO/refusal; fulfilment/warehouse costs; fraud/chargeback loss; CAC (only claim: Egypt CAC "60-70% lower than Saudi", promotional, [EasySell](https://easysellapp.com/blogs/wiki/egypt-ecommerce-cod-market-entry-shopify-2026)); support cost per order.

## Break-even take rate, working capital, VAT, macro

### Takeaway
Break-even take rate not sourceable; the model gives about 8-12% of kept GMV in base, with COD refusal, return rate and shipping subsidy the largest drivers. Working capital is model-only. VAT 14% is from the spec (B4); not re-researched.

### Cited Findings
- USD/EGP rose from 47.3 (Jan 2026) to 50.8 (Jun 2026), +7.4%; headline inflation peaked 15.2% in March, 14.3% end-H1; net reserves USD 55.1bn — [Arab Finance](https://arabfinance.com/en/news/newdetails/reviewing-egypt-economic-scene-in-h1-2026)
- Late July 2026: USD/EGP about 50.73, core inflation 14.3% (June), CBE deposit rate 19%, lending 20% — [Capital.com](https://capital.com/en-gb/analysis/usd-to-egp-forecast-dollar-egyptian-pound)
- Trading Economics showed a record 52.90 in March 2026 (short spike) — [Trading Economics](https://tradingeconomics.com/egypt/currency)

### Inferences
- With CBE lending at about 20%, each EGP of float costs about 0.055 piastres/day. Working capital ≈ daily GMV x (COD remittance lag + return window + payout cycle days) x share of cash paid out before collection; with COD collected by courier T+2..7, 14-day return window + 3 days, weekly payout, seller payables are released about 17-24 days after delivery, which is later than COD cash arrives, so the float may be positive for the platform on COD (platform holds cash) but must be segregated/ledgered; refunds and RTO create the exposure. Direction only; no figures verified.
- Import restrictions and devaluation not researched beyond FX; no sourced effect on off-price supply.

### Gaps
- Import restriction status, off-price supply effects; ETA e-receipt treatment of commission and shipping income (see spec B4 VERIFY); actual payout/remittance cycles.

## Parametrised per-order model (ALL inputs are assumptions except FX and AOV range)

Per placed order, EGP. delivered d = 1 - cod*ref; kept k = d*(1-ret).

| Input | Low | Base | High |
|---|---|---|---|
| AOV | 900 | 1,500 | 2,200 |
| COD share (cod) | 80% | 65% | 40% |
| COD refusal (ref) | 30% | 20% | 10% |
| Return rate on delivered (ret) | 30% | 20% | 12% |
| Commission on kept GMV (c) | 15% | 20% | 25% |
| Outbound ship cost | 90 | 75 | 60 |
| Shipping fee paid by shopper (avg) | 20 | 40 | 60 |
| Return/RTO leg cost | 90 | 60 | 45 |
| Prepaid fee % (p) | 3% | 2.5% | 2% |
| COD handling % of collected | 2% | 1.5% | 1% |
| Support + fraud per order | 35 | 25 | 15 |

Formulas:
- Revenue = AOV*k*c + fee*d
- Costs = ship_out + (1-d)*ret_leg + d*ret*ret_leg + (1-cod)*p*AOV + cod*d*codpct*AOV + support_fraud
- CM = Revenue - Costs (before CAC and VAT on platform income; shopper prices are VAT-inclusive, commission/fees bear 14% output VAT if not grossed up)
- Break-even commission c* = (Costs - fee*d) / (AOV*k)

Base worked example: d=0.87, k=0.696; revenue = 1500*0.696*0.20 + 40*0.87 = 209 + 35 = 244; costs = 75 + 0.13*60 + 0.87*0.2*60 + 0.35*0.025*1500 + 0.65*0.87*0.015*1500 + 25 = 75+7.8+10.4+13.1+12.7+25 = 144; CM about EGP 100 (about USD 2, 6.7% of AOV) pre-CAC. c* about 13.5% of kept GMV. Low and high cases computed by the same formulas will be near zero/negative and about 2-3x base respectively (not worked out here). Any CAC above about EGP 100 per order makes first-order economics negative; repeat rate then decides.
