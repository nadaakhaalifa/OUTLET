# Egypt seller compliance for online marketplace onboarding (as of 2026-10-15; not legal advice)

Method note: 9 web searches in one pass, almost all secondary sources (law firms, vendors, press). Search-result summaries only; primary texts (ETA, CBE, Customs, Official Gazette) were NOT fetched. Everything below is "VERIFY" unless stated otherwise; counsel confirmation is needed before any of it becomes seller-agreement text. Agree/differ notes against the master prompt (B1-B5) and `docs/compliance/verify-register.md` are in each section.

## 1. Commercial register, tax card, VAT, national ID, and how a marketplace verifies them

### Takeaway
Tax card plus commercial register are the standard VAT-registration inputs, and the VAT rate is 14%. The threshold basis and platform duties are inconsistently reported; nothing in this pass gives an authoritative, per-seller-type document list.

### Cited Findings
- Standard VAT rate is 14% — [Avalara](https://www.avalara.com/vatlive/en/country-guides/africa-and-middle-east/egypt-vat/egyptian-e-invoicing.html) (as summarised by search; several guides agree, e.g. [Fonoa](https://www.fonoa.com/resources/country-tax-guides/egypt)).
- VAT registration threshold is reported as EGP 500,000 over a rolling 12 months; guides differ on whether it is "taxable turnover" or "taxable plus exempt sales over the preceding 12 months" — [Stripe tax docs](https://docs.stripe.com/tax/supported-countries/europe-middle-east-and-africa/egypt), [Fonoa](https://www.fonoa.com/resources/country-tax-guides/egypt).
- A tax card and commercial register are listed among documents for VAT registration — [FZCO guide](https://www.fzcoltd.com/?p=59722).
- A 2021-era article cites EGP 20,000 for e-commerce providers; newer sources point to EGP 500,000, so treat the old figure as superseded — [VATcalc](https://www.vatcalc.com/?p=8162).
- One guide says online marketplaces act as intermediaries and collect and remit VAT for suppliers; another says a platform is not responsible if certain conditions are met. These conflict and neither was verified against ETA text — [Fonoa](https://fonoa.com/countries/egypt), [Mondaq](https://www.mondaq.com/tax-authorities/1683656/tax-compliance-for-digital-services-and-e-commerce-in-egypt).
- Foreign vendors supplying digital/remote services to Egyptian customers have had VAT accounting duties since 22 June 2023 — [Thomson Reuters](https://europe.thomsonreuters.com/news/e-invoicing-in-egypt/); a non-resident e-commerce VAT amendment is discussed in [International Tax Review](https://internationaltaxreview.com/article/2bfig6idtrwgd7obwx4ao/sponsored/egypt-amends-its-rules-on-vat-for-non-resident-suppliers-in-e-commerce-transactions) (not read in full).

### Inferences
- Suggested checklist by seller type (working draft, derived from the above and from master prompt section 19; unverified):
  - (A) Sole trader: national ID, tax card (individual), commercial register extract where trading commercially, VAT registration certificate if over threshold, IBAN in own name.
  - (B) Company: commercial register extract, tax card, articles/board resolution naming signatory, signatory national ID, VAT certificate, company IBAN, ETA registration status.
  - (C) Foreign brand via local distributor: distributor holds (B) documents; plus brand authorization/distribution agreement and trademark evidence (see section 7). The distributor, not the brand, is the Egyptian tax subject.
  - (D) Foreign brand shipping direct: foreign company registration documents, authorized representative or Egyptian importer-of-record details, tax identification, brand/trademark proof, customs/import structure. Legal model unresolved (see section 5).
- Agrees with master prompt B4/B5 (14% VAT, seller legal identity). Master prompt section 19 lists signatory ID at 21+, consistent with VR-08 (age of majority) staying open.
- Marketplace verification mechanics (automated lookup of tax registration number or commercial register against government registries) were not found; assume manual OCR plus document review until an API is confirmed.

### Gaps
- No primary-source document list per entity type; no confirmation whether sole traders need a commercial register at all (VERIFY).
- Whether ETA/Companies registry offers any verification API for third parties: not found.
- Exact VAT threshold basis and whether marketplace withholding exists: unresolved (already VR-06 / VR-B4-03).

## 2. ETA e-invoice and e-receipt: who issues, credentials, delegated signing, Decision 281/2025

### Takeaway
B2C e-receipts are being rolled out by named-taxpayer waves; Decision 281/2025 (26 July 2025) started a wave on 15 September 2025. How this applies to marketplace sales (platform vs seller issuer) and delegated signing was not found.

### Cited Findings
- ETA issued Decision 281/2025 on 26 July 2025; listed taxpayers must issue e-receipts for goods and services to end consumers from 15 September 2025, in a phase described variously as "eighth sub-phase of the second stage" or "second sub-phase of the eighth phase" — [Comarch](https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/egypt-expands-e-receipt-requirements-for-b2c-transactions-from-september-2025/), [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/07/tnf-egypt-new-taxpayers-required-to-comply-with-mandate-to-issue-electronic-receipts-for-b2c-transactions.html), [RTC Suite](https://rtcsuite.com/egypt-widens-b2c-e-receipt-mandate-new-taxpayers-required-as-of-september-2025/).
- Scope dispute: Comarch says the annex names taxpayers at the Sixth District and Fifth Settlement tax offices; Flick says it covers every branch and POS of each listed business — [Comarch](https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/egypt-expands-e-receipt-requirements-for-b2c-transactions-from-september-2025/) vs [Flick](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate).
- Listed taxpayers must register on the ETA portal and integrate POS or ERP; vendor guide says transmission within 24 hours (unverified) — [Flick](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate).
- Ministerial Decision 386/2021 reportedly required e-receipts at points of sale including digital platforms and apps — [Mondaq](https://www.mondaq.com/tax-authorities/1683656/tax-compliance-for-digital-services-and-e-commerce-in-egypt); B2C e-invoicing scope was reported expanded in Jan 2025 — same source (weakly supported).

### Inferences
- Agrees with master prompt B4 (8th sub-phase began 15 Sep 2025; seller as supplier issues receipt). Differs only in nuance: the wave is by listed taxpayer, so a given seller may or may not yet be in scope; onboarding should capture "ETA e-receipt status" as data rather than assume.
- A seller dashboard should collect: ETA registration number, e-invoice/e-receipt capability flag, which system issues receipts (self, HAUL service, ERP), and a signing delegation record if used.

### Gaps
- Delegated signing / power-of-attorney evidence for a platform signing on behalf of sellers: not found (VR-B4-02 stays open).
- Platform-versus-seller issuer for marketplace B2C sales: not found (VR-B4-01 / VR-06).
- Whether a given seller is on the Decision 281 annex or later wave lists: requires the ETA site/annex.

## 3. Bank/IBAN, CBE rules for aggregators and sub-merchants, PSP onboarding docs

### Takeaway
CBE regulates aggregators and facilitators (2019 rules) and issued new PSP licensing regulations in force 17 June 2025 under Law 194/2020. Paymob/Kashier/Fawry sub-merchant document lists are not public in what I found.

### Cited Findings
- 2019 CBE regulation: facilitators receive funds in their own account and must pay merchants within 3 working days; need an Egyptian office registered in the commercial register; banks must hold guarantees covering 50% of collected payments; merchants above EGP 3m annual sales need a commercial bank party; some sectors prohibited — [Enterprise (2019)](https://enterpriseam.com/egypt/2019/05/15/list-of-e-commerce-no-nos-issued-as-cbe-orders-aggregators-and-payment-facilitators-must-offer-guarantees-to-banks/), [IBA](https://www.ibanet.org/article/6FC3317B-4F9C-4DFC-BDF1-80CF98B68B21).
- 2025 PSP licensing regulations under Law 194/2020 in force 17 June 2025, apply to domestic and foreign payment institutions serving Egypt; existing operators got 12 months transition — [Amwal Al Ghad](https://en.amwalalghad.com/?p=206252), [Business Today Egypt](https://www.businesstodayegypt.com/amp/1/6465/Central-Bank-of-Egypt-issues-new-licensing-rules-for-payment). Whether the 2019 rules were repealed: unclear in sources.
- Paymob advertises digital merchant onboarding (within 48 hours) but no document list; method availability goes through the account manager — [Zawya](https://www.zawya.com/en/press-release/companies-news/paymob-fuels-menas-e-commerce-market-by-offering-embedded-shopify-payments-piwqgo9y), [Paymob docs](https://developers.paymob.com/paymob-docs/developers).

### Inferences
- Supports master prompt B2 caution: HAUL collecting and paying out likely falls under aggregator/facilitator rules; the safest path is the PSP's own marketplace/sub-merchant product. Agrees with VR-03 / VR-22; the 2025 regulations (17 Jun 2025) and 3-working-day payout cap are new inputs worth adding as evidence leads. The 3-day cap would conflict with the master prompt's payout design (release after CLOSED = return window plus 3 days, weekly cycle) if HAUL were itself a facilitator (VERIFY, flag to Finance/Legal).
- IBAN name-match: no Egyptian-specific rule found; keep as internal control (company IBAN for companies, own-name IBAN for sole traders).

### Gaps
- Paymob, Kashier, Fawry sub-merchant document checklists and split-payment capability: not found; ask account managers (VR-04).
- Full text of CBE 2019/2025 regulations not read.

## 4. Consumer Protection Law 181/2018 and Decree 822/2019

### Takeaway
Arabic is required for ads, product data, invoices and contracts including electronic ones, and a 14-day exchange/return right exists; exact online seller-identity article and interplay with the 7-day distance cancellation were not retrieved.

### Cited Findings
- Law 181/2018 published 13 Sep 2018, in force 14 Dec 2018; executive regulations (PM Decree 822/2019) in force 2 April 2019 — [UNESCWA ALP](https://alp.unescwa.org/legislations/law-181-2018-promulgating-consumer-protection-law), [Digital Policy Alert](https://digitalpolicyalert.org/event/28035-executive-regulation-for-consumer-protection-law-no181-of-2018-prime-ministers-decree-no-822-of-2019-including-usersubject-right-entered-into-force).
- Arabic required in adverts, product data, invoices, receipts and contracts including e-documents; invoices must carry supplier details — [Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law).
- 14 days to exchange or refund without reasons (conditions not retrieved) — [Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law); English translation of the law: [Andersen PDF](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf).

### Inferences
- Agrees with master prompt B5 on Arabic and 14-day windows. The 30-day defect window in B5 was not independently confirmed in this pass (it relies on the same Mondaq article B5 cites).

### Gaps
- Exact article text on online supplier identity display, 7-day cancel vs 14-day return, refund deadline, exclusions: not retrieved; read the Andersen PDF with counsel (VR-07).

## 5. Cross-border: customs, duties, import VAT, courier rules, ACI, representation

### Takeaway
ACI/ACID via the Nafeza portal is the advance cargo regime, with express-courier pilot reported for 2026; I found no reliable current de minimis or B2C parcel duty rule.

### Cited Findings
- ACI: importer files through Nafeza and obtains a 19-digit ACID; basis is Customs Law 207/2020 with MoF Decrees 38/2021 and 430/2021 (executive regulations published 31 Aug 2021) — [PwC](https://pwc.com/m1/en/services/tax/me-tax-legal-news/2021/egypt-new-customs-regulations-minister-of-finance-decree-430-2021.html), [Hapag-Lloyd](https://www.hapag-lloyd.com/en/services-information/news/2021/04/egypt--new-advance-cargo-information-customs-regulation-.html).
- Shippers need importer tax number and exporter registration; shipments lacking ACID reportedly not shipped — [ONE advisory](https://www.one-line.com/sites/oneglobal/files/2023-10/Customer%20Advisory%20-%20Egypt%20Advance%20Cargo%20Information%20%28ACI%29.pdf).
- Express couriers: ACI pilot reported March 2026, mandatory from 1 May for airport-based couriers, with ACID for parcels over 50 kg (single source, date not confirmed) — [Enterprise, 31 Mar 2026](https://enterpriseam.com/egypt/2026/03/31/egypt-kicks-off-trial-for-new-advance-cargo-information-system/).
- FedEx: from 1 Jan 2026 a 19-digit ACID on the air waybill for shipments above 50 kg — [FedEx](https://www.fedex.com/en-om/news.html).
- MoF Decree 262/2026 (24 May 2026) amended Art. 232 of the customs executive regulations (clearance documentation) — [EY](https://globaltaxnews.ey.com/news/2026-1247).

### Inferences
- Type (C) (via distributor) is clean: distributor is importer of record and ACID holder. Type (D) (direct B2C) needs an importer-of-record/customs model before it can ship; do not enable it until VR-19 closes.

### Gaps
- Current duty rates, de minimis, B2C parcel VAT, "ACI for individuals", restricted goods list, foreign-company representation rules: not found. Do not state any threshold (an unsourced EGP 10,000 traveller allowance from 2021 appears in [Enterprise](https://enterpriseam.com/egypt/hardhats/the-aci-explainer-what-you-need-to-know-and-how-you-can-prepare/) context and is not a parcel rule).

## 6. PDPL (Law 151/2020) for seller KYC data

### Takeaway
Not re-researched here; follow master prompt B1 (licensing, DPO, 72h breach notification, cross-border licence, consent). Seller KYC (national ID, IBAN) is P3 under master prompt classes.

### Cited Findings
- None new this pass. See master prompt B1 sources: [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins).

### Inferences
- KYC retention "contract + 5 years" in B1 is an assumption (VR-01); signatory ID images should be field-encrypted and excluded from any non-approved-region OCR/LLM processing (VR-02).

### Gaps
- Whether KYC document processing requires consent or relies on legal obligation/contract basis: not researched.

## 7. Anti-counterfeit and brand authorization

### Takeaway
Egypt's IP Law 82/2002 criminalises counterfeit trademark sales with confiscation; no platform notice-and-takedown statute was found, so authorization practice is contractual.

### Cited Findings
- IP Law 82/2002 (Book 2 trademarks), Decree 770/2005 procedures; Art. 13 counterfeiting offences with confiscation of goods and proceeds — [WTR](https://www.worldtrademarkreview.com/global-guide/anti-counterfeiting-and-online-brand-enforcement/2018/article/procedures-and-strategies-anti-counterfeiting-egypt), [Mondaq](https://www.mondaq.com/trademark/727576/combating-counterfeit-in-egypt).

### Inferences
- Require, for third-party brands: trademark registration certificate or brand authorization letter / distribution agreement / purchase invoices; keep the 48h takedown SLA from master prompt section 27 as a contractual commitment. Agrees with master prompt section 19 and B5 (joint-liability risk).

### Gaps
- Commercial agencies law (Law 120/1982) effect on foreign brands, Noon/Amazon.eg/Jumia seller document lists: not found in this pass.
