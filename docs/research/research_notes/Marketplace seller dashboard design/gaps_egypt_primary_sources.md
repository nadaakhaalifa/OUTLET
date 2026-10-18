# Gaps closed: Egypt primary-source confirmation for seller onboarding and payouts (as of 2026-10-15; not legal advice)

Method note: WebFetch worked on HTML pages. Primary sources could NOT be read: eta.gov.eg and sdk.invoicing.eta.gov.eg were not reached (not returned by search), the CBE page (cbe.org.eg) was rejected by its WAF, and the Andersen and Sorbonne PDFs of Law 181/2018 were binary and unextractable here. Article text below therefore comes from a law-firm English translation (Consortio) and law-firm/vendor summaries. All items are VERIFY against Official Gazette Arabic text and ETA/CBE originals. Extends `egypt_seller_compliance.md` and does not repeat it.

## 1. ETA e-receipt (B2C) and e-invoice for marketplaces

### Takeaway
Legal basis for B2C e-receipts is MoF Decision 230/2022, rolled out by listed-taxpayer waves (Decision 281/2025 = 15 Sep 2025; a later wave is reported as Decision 361/2025). Nothing found confirms who issues receipts on a marketplace sale or any platform delegation mechanism.

### Cited Findings
- MoF Decision 230/2022 requires registered taxpayers to issue e-receipts for goods/services sold to final consumers; rollout is phased, "currently at phase 9 (Decision 361/2025)"; Decision 281/2025 covers phase 8, wave 2, effective 15 Sep 2025; real-time transmission; printed receipts carry UUID and QR — [Lookuptax](https://lookuptax.com/docs/country/egypt-vat-guidelines-indirect-tax)
- Earlier wave: 15 Jan 2025 under Resolution 405/2024; 15 Sep 2025 wave under Resolution 281/2025 (sources disagree on wave numbering: "Sixth" vs "eighth sub-phase") — [e-invoicing.org](https://e-invoicing.org/egypt/)
- Nationwide B2B/B2G e-invoicing since 15 Dec 2022 (Decision 323/2022 per Lookuptax; Decision 188/2020 per e-invoicing.org, different instruments); customs dealings limited to e-invoice issuers from 1 Apr 2023 — [Lookuptax](https://lookuptax.com/docs/country/egypt-vat-guidelines-indirect-tax); [e-invoicing.org](https://e-invoicing.org/egypt/)
- Registration steps (generic): register on ETA profile and invoicing portals, obtain API credentials and a digital signature, integrate ERP/POS, check wave listing by tax registration number, enrol POS serials — [e-invoicing.org](https://e-invoicing.org/egypt/)
- Annex scope conflict: Comarch says named taxpayers at Sixth District and Fifth Settlement offices; Flick says all branches/POS of listed businesses (already in earlier notes). Lookuptax and e-invoicing.org agree the annex is by listed taxpayer, not by sector.
- Buyer national-ID threshold: EGP 25,000 for e-invoices; a different figure (EGP 150,000) is cited for e-receipts — [Lookuptax](https://lookuptax.com/docs/country/egypt-vat-guidelines-indirect-tax)
- Third-party ERP/e-invoicing intermediaries exist (EDICOM, Mofawtar), but no source describes a marketplace issuing e-receipts as delegate for sellers — [search summary of EDICOM/Mofawtar pages](https://edicomgroup.com/electronic-invoicing/egypt)

### Inferences
- Treat "who issues" as seller-as-supplier by default (matches master prompt B4); HAUL-as-signer needs written ETA confirmation. Seller onboarding should store: tax registration number, wave-listing status, issuing system, signing-delegation evidence.

### Gaps
- VERIFY: Decision 281/2025 annex text; whether marketplace operators must issue or co-issue; delegation/power-of-attorney mechanics; the specific fields "branch" and "activity code" (not explained in any source read); exact SDK registration steps (sdk.invoicing.eta.gov.eg not read); Decision 361/2025 single-source.

## 2. CBE aggregators/facilitators and 2025 PSP licensing

### Takeaway
2019 CBE guidance puts bank guarantees (50% of collected payments) and a bank party above EGP 3m merchants on aggregators/facilitators; the June 2025 PSP rules create a licensing regime with a 12-month transition (to about June 2026). A payout deadline (3 working days) and the question whether a marketplace needs a licence were NOT confirmed.

### Cited Findings
- 2019 (article dated 15 May 2019): banks must hold guarantees covering 50% of payments aggregators/PayFacs collect; banks need "full control" over daily merchant collections; any agreement with a merchant above EGP 3m annual sales must include a commercial bank; PayFacs operate under own master accounts while aggregators do not own master accounts; prohibited categories (crypto, MLM, dating, crowdfunding, games of chance, securities, precious stones). The article states NO payout deadline and no licence requirement — [Enterprise](https://enterpriseam.com/egypt/2019/05/15/list-of-e-commerce-no-nos-issued-as-cbe-orders-aggregators-and-payment-facilitators-must-offer-guarantees-to-banks/). This contradicts the earlier-notes claim of a "3 working days" rule, which came via IBA; not reproduced by this source, so VERIFY.
- 19 Jun 2025: CBE issued licensing/registration rules for PSOs and PSPs under Law 194/2020, covering domestic and foreign providers; 12-month transition for existing providers — [CBE news](https://www.cbe.org.eg/en/news-publications/news/2025/06/19/08/20/psos-and-psps-licensing-rules) (URL seen in search; page not readable), [Matouk Bassiouny](https://matoukbassiouny.com/egypts-central-bank-issues-the-licensing-framework-for-psos-and-psps/)
- Capital: Category A EGP 30m (avg monthly value above EGP 750m), Category B EGP 10m, payment-initiation/account-information EGP 20m, PSO EGP 500m; letter of guarantee 2% of capital; two-step NOC then licence, 90 days extendable by 90, NOC valid 6 months — [Matouk Bassiouny](https://matoukbassiouny.com/egypts-central-bank-issues-the-licensing-framework-for-psos-and-psps/) (PSO figure from a search summary of secondary sites)
- Listed PSP services include "electronic acceptance services, such as payment technology, facilitation, and cash collection"; firm reads existing CBE approvals for bank-partnership aggregation/facilitation as remaining valid; new entrants may need the outsourcing route — [Matouk Bassiouny](https://matoukbassiouny.com/egypts-central-bank-issues-the-licensing-framework-for-psos-and-psps/)

### Inferences
- A marketplace collecting for third-party sellers likely performs "collection/facilitation", so a licence, a bank partner, or the PSP's sub-merchant product is needed. Keeps B2/VR-03 open; recommended path is the PSP's marketplace product.

### Gaps
- VERIFY: payout deadline (3 working days not confirmed); who may hold merchant funds under the 2025 rules; safeguarding rules (not addressed in sources); whether 2019 guidance was repealed; primary CBE text unread.

## 3. Consumer Protection Law 181/2018 and Decree 822/2019

### Takeaway
Article numbers now confirmed from an English translation: Art. 5 and 37 (identity), 9 (deceptive conduct), 17 (14 days), 21 (30 days defects), 40 (distance withdrawal 14 days), 27 and 74 (liability), 64-66 (fines). Note an important conflict: Art. 40 gives a 7-day refund deadline.

### Cited Findings
- Art. 5: supplier must include data identifying the supplier, "in particular address, means of communication" on dealings records — [Consortio translation](https://consortiolawfirm.com/egyptian-consumer-protection-law-181-2018-english-translation/)
- Art. 10: invoice must include the supplier's tax registration number and the price; Art. 11: absent a compliant invoice the consumer may prove terms by all means — same source
- Art. 37(1): before a distance contract, the supplier must disclose name, address, telephone and email if any; Art. 36 excludes banking/financial/capital-market services and periodical subscriptions — same source
- Art. 38: consumer may correct or modify the order within seven working days from acceptance — same source
- Art. 17: exchange/return within 14 days from receipt, no reasons, no expenses (exceptions such as perishables, books/software); Art. 40: distance withdrawal within 14 days from receipt, supplier refunds within 7 days, consumer generally bears return shipping; Art. 41: lapse cases — same source
- Art. 21: defective or non-conforming goods may be exchanged/returned within 30 days from receipt; Art. 19: supplier must notify the Authority of a defect within 7 days — same source
- Art. 9: supplier/advertiser must refrain from deceptive conduct about listed elements (price, origin, quantity, etc.); Art. 1(10) defines deceptive conduct; Art. 57: Authority can demand correction, then suspend an ad up to 7 days after 3 days — same source
- Liability: Art. 27 suppliers jointly and severally liable (product damage); Art. 74 juridical person jointly liable for penalties and compensation where an employee violates for its benefit — same source
- Fines: Art. 64 EGP 10,000-500,000 (or product value); Art. 65 (incl. Art. 10 invoices) EGP 30,000-1,000,000 or twice value; Art. 66 (incl. Art. 9) EGP 50,000-2,000,000 or twice value; Art. 69 doubles on repeat — same source
- Law No. 20 of 2024 amended certain provisions, issued 5 Apr 2024 — [Chambers/search summary](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt) (not read in full)

### Inferences
- Master prompt B5 "refund within 14 days from delivery" may conflict with Art. 40's 7-day refund after withdrawal; the 7-day Art. 38 right is an order-correction right, not a cancellation window — differs from the master prompt's reading.

### Gaps
- VERIFY: translation vs Arabic gazette; Law 20/2024 changes to Arts. 9, 17, 40; explicit intermediary/platform liability article (only Art. 27 and 74 found); Decree 822/2019 article text not retrieved (Shalakany summary exists, unread).

## 4. VAT

### Takeaway
Threshold basis is confirmed as combined taxable and exempt sales over any preceding 12 months (Art. 16, Law 67/2016). Deemed-supplier platform rules exist for remote services, but marketplace goods and commission-VAT treatment were not documented.

### Cited Findings
- Art. 16 Law 67/2016: registration once taxable plus exempt sales over any preceding 12 months reach EGP 500,000; apply within 30 days; procedure under Art. 25 of Law 206/2020; importers, exporters, distribution agents and scheduled-goods dealers have no threshold — [Lookuptax](https://lookuptax.com/docs/country/egypt-vat-guidelines-indirect-tax)
- Law 149 of 2026 effective 29 Jul 2026 changes machinery/refund rules; nothing found on the threshold or e-commerce — same source
- Platform deemed supplier of remote services to unregistered Egyptian customers (collect VAT) unless the vendor agreed in writing and the platform does not set terms; payment-only, advertising-only, referral-only platforms are outside — same source (ETA 2023 digital-services guideline)
- MoF Decree 24/2023 (11 Jan 2023) amended Executive Regulation 66/2017: defines "electronic distribution platforms" incl. marketplaces; platform not responsible for collecting if conditions met (conditions unspecified); imported goods VAT due at customs clearance unless a registered non-resident collected — [International Tax Review](https://internationaltaxreview.com/article/2bfig6idtrwgd7obwx4ao/sponsored/egypt-amends-its-rules-on-vat-for-non-resident-suppliers-in-e-commerce-transactions)
- Non-resident remote services: MoF Decision 160/2023, EGP 500,000 threshold (professional services from day one), no fiscal representative, Form 3-VAT within 10 days — [Lookuptax](https://lookuptax.com/docs/country/egypt-vat-guidelines-indirect-tax); another source says no threshold for non-residents, from first taxable sale — [Consortio](https://consortiolawfirm.com/vat-registration-egypt/) (conflict, search summary)

### Inferences
- VAT 14% on HAUL commissions/fees to sellers is standard B2B services VAT by default (not separately sourced; VERIFY).

### Gaps
- VERIFY: VAT on marketplace commissions (no source); B2C goods import VAT/de minimis (Lookuptax says not documented); foreign e-commerce goods registration beyond services; the EGP 250,000 figure is unsupported.

## 5. Customs ACI/ACID for B2C express

### Takeaway
ACID applies to shipments above 50 kg; no B2C parcel rule below that was found.

### Cited Findings
- Express courier ACI pilot from 31 Mar 2026, compulsory 1 May 2026 for airport-based couriers; ACID for parcels over 50 kg; single unnamed-government-source — [Enterprise, 31 Mar 2026](https://enterpriseam.com/egypt/2026/03/31/egypt-kicks-off-trial-for-new-advance-cargo-information-system/)
- From 1 Jan 2026 ACID per shipment over 50 kg actual weight — [DHL](https://www.dhl.com/discover/en-sg/news/customs-regulatory-updates), consistent with FedEx
- Zonos reports de minimis is 0 EGP (undated) and Nafeza scope B2B over 50 kg and USD 2,000, conflicting with DHL/FedEx — [Zonos](https://checkout.www.zonos.com/docs/guides/country-guides/egypt)

### Gaps
- VERIFY: any official B2C de minimis/duty; ACI for sub-50 kg parcels; customs authority original text.
