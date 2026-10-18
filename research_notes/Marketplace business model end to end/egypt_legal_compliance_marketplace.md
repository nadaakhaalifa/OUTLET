# Egypt legal and compliance framework for a marketplace charging seller subscriptions and commissions and collecting consumer payments

Not legal advice. Egyptian counsel must review everything here. Research date 2026-10-18. Method: 12 web searches plus one page fetch; most law-firm pages could not be fetched in full (search snippets only), so almost all findings are secondary sources and confidence is LOW to MEDIUM unless stated. No primary Arabic statute text was read. Cross-references are to /Users/nadakhalifa/OUTLET/docs/compliance/verify-register.md (page 1 of 2 read: lines 1-192 of 227; rows after that were not checked).

## Is the operator jointly liable with sellers for consumer claims, and what do platforms do about it?

### Takeaway
Egyptian law does not define an online marketplace or an intermediary role; the platform's status is described by one Egyptian firm as a "grey area". The CPL "supplier" and "advertiser" definitions are broad enough to be argued to reach a platform, so exposure is real but not settled. Confidence: LOW-MEDIUM (one secondary Egyptian-firm article plus statute summaries; no cases found).

### Cited Findings
- Neither Law 181/2018 nor Executive Regulation 822/2019 recognises an intermediary concept; Egyptian law does not define an online marketplace. — [Adsero via Mondaq, 7 Nov 2025](https://www.mondaq.com/advertising-marketing-branding/1702228/marketplace-liability-in-egypt-evolving-roles-in-the-digital-economy)
- "Supplier" = any person engaged in commercial or professional activity who provides a service or product to a consumer, including by electronic means; "advertiser" = any person promoting a product or service through any medium including digital. The article says these are broad enough to cover platforms but do not settle whether platforms carry supplier-level duties. — same Mondaq article
- Platforms are typically treated as service providers facilitating transactions and so "theoretically" not expressly subject to supplier liability; in practice exposure is described as fault-based: insufficient information about breaching sellers, not verifying vendor legitimacy or product identity, ignoring evident violations, misleading advertising or consumer complaints. The article does not use the term "joint" liability, cites no cases or enforcement actions, and gives no specific recommendations. — same Mondaq article
- Producers and distributors may be liable for defective-product harm under Commercial Code 17/1999 if causation is proven. — same Mondaq article
- Distance contracting is defined to include sale over the internet; Art. 37 requires clear pre-contract information in remote sales; Art. 4 requires disclosure of essential product data such as origin and price. — [search summary of Law 181/2018 text (Andersen translation)](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf) (PDF not read directly)
- Regulators that may extend their mandates to online activity: Consumer Protection Agency, Competition Authority, NTRA; "remains to be seen" whether e-commerce-specific rules follow. — same Mondaq article
- Platform practices (seller KYC, seller identity shown to consumers, takedown/complaint handling, price-parity controls) are NOT documented in any source I found; the practices below are inference.

### Inferences
- Options to manage exposure (for counsel to weigh): (a) position as facilitator, with seller legal identity displayed on every listing and ToS stating the seller is the supplier; (b) seller KYC and counterfeit controls, which the master prompt already treats as mandatory; (c) prompt complaint/takedown handling with logs, since the exposure theory is fault-based; (d) back-to-back seller indemnity, payout set-off and holdbacks; (e) if Z-OUTLET is merchant of record or Fulfilled-by-HAUL, assume it is the supplier and liable as such.
- Handling consumer refunds and charging the consumer directly increases the chance a regulator treats the platform as a party to the sale. Judgement, not a sourced fact.
- Shared fault-based theory is consistent with the repo's design (seller identity on PDP, automatic price-integrity enforcement), but it is not confirmed to satisfy the law.

### Gaps
- Arabic statute text of Law 181/2018 articles on advertiser/supplier joint liability (the commonly cited "solidary liability" between supplier and advertiser) was not retrieved; no case law or CPA enforcement against a marketplace found.
- Art. 9 misleading discounts, 14-day/30-day return rules, 7-day cancellation, Arabic requirement: the Mondaq/other pieces cited in the repo spec were not re-verified here. Affects VR-07, VR-RF-05, VR-P2-01.

## Can the operator hold seller funds, or must settlement go through a licensed PSP/bank? (CBE, Law 194/2020, e-money, merchant of record)

### Takeaway
Collecting buyer money and forwarding it to sellers resembles the "payment facilitator" activity that CBE regulation treats as a regulated settlement role, so the safe option is the PSP/bank sub-merchant or split product or a licensed facilitator, not a Z-OUTLET-owned bank account. Not verified against CBE text. Confidence: LOW-MEDIUM.

### Cited Findings
- CBE issued new licensing and registration rules for payment system operators and PSPs under Law 194/2020 (June 2025, effective 17 June 2025); they cover domestic and foreign firms serving Egyptian clients; existing operators get 12 months to apply. — [Business Today Egypt](https://www.businesstodayegypt.com/amp/1/6465/Central-Bank-of-Egypt-issues-new-licensing-rules-for-payment); [Amwal Al Ghad](https://en.amwalalghad.com/?p=206252)
- Reported capital thresholds: EGP 30m Category A PSP, EGP 10m Category B PSP, EGP 20m account information / payment initiation, EGP 500m payment system operator; a partnership with a CBE-licensed bank for settlement was mentioned by one secondary source. — search summary of [Mondaq fintech licensing guide](https://www.mondaq.com/financial-services/1833344/fintech-license-in-egypt-cbe-fra-licensing-guide) (not fetched, single secondary source)
- Earlier CBE regulation distinguished technical payment aggregators from payment facilitators; the facilitator takes part in settlement (receives funds into an account in its own name and forwards to the merchant), must keep a separate account for customer funds and, per that older framework, transfer within three working days. Whether the 2025 rules changed this is unconfirmed. — [IBA article](https://www.ibanet.org/article/6FC3317B-4F9C-4DFC-BDF1-80CF98B68B21)
- Full EMI licence needs EGP 30m paid-up capital; decision within 90 (+90) days. — [Andersen via Mondaq](https://www.mondaq.com/fintech/1755348/electronic-money-institution-licensing-in-egypt) (as already cited in the master prompt)
- Law 80/2002 (AML) defines financial institutions to include banks, FX companies and entities engaged in money transfer; whether a marketplace falls within it is not shown by the sources. — [Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/10/Law-No.-80-of-2002.pdf)

### Inferences
- Options: (1) PSP marketplace/sub-merchant/split product with PSP-side settlement to sellers (lowest licensing risk, depends on Paymob/Kashier offering it); (2) Z-OUTLET as licensed facilitator/PSP (EGP-millions capital, CBE approval; unlikely early); (3) collect into a Z-OUTLET bank account and pay out (the repo's current ledger chart, VR-F1-07, flags this as not meeting ADR-0021 decision 1) which carries the highest regulatory risk of being seen as unlicensed facilitation/money transmission.
- Closed-loop, non-withdrawable store credit usable only on the issuer's platform may sit outside e-money, but I found no CBE text or counsel opinion; unverified.
- Merchant-of-record question: if the PSP contracts Z-OUTLET as the merchant and Z-OUTLET then pays sellers, Z-OUTLET is the aggregator. If sellers are sub-merchants, sellers are MoR for goods and Z-OUTLET is MoR only for its own fees.

### Gaps
- CBE 2025 rule text (categories, exact activity definitions, settlement/escrow/segregation rules, whether a marketplace needs a licence) not retrieved.
- Paymob/Kashier marketplace or split product availability: not found.
- Affects VR-03, VR-04, VR-22, VR-F1-03, VR-F1-07, VR-PO-01, VR-P3-03, VR-P3-08, VR-PAY-12.

## VAT and e-invoice mechanics (commission, subscriptions, seller sales), withholding, stamp duty, corporate and digital-services taxes

### Takeaway
Commission and subscription income earned by the operator from sellers is a B2B supply subject to 14% VAT and e-invoicing; seller goods sales are the seller's supply, and one secondary guide says marketplaces may be responsible for collecting and remitting VAT on suppliers' behalf (unconfirmed). Confidence: LOW-MEDIUM; tax rows must be settled by a tax adviser.

### Cited Findings
- Standard VAT rate 14%. Fonoa also states online marketplaces/platform operators are considered intermediaries responsible for collecting VAT on behalf of the supplier and remitting it, and may need to register and file returns. — [Fonoa Egypt guide](https://fonoa.com/countries/egypt) (secondary vendor guide; the legal basis is not cited; conflicts in scope with the repo's VR-B4-03 assumption, so treat as unverified)
- E-invoicing was extended to e-commerce goods and services from 15 Sep 2021 (then-threshold EGP 20,000); over 49,000 e-commerce firms registered by mid-2021 per the Ministry of Finance. — [VATCalc](https://www.vatcalc.com/egypt/egypt-extends-e-invoicing-to-e-commerce-sept-2021/); [Cairoscene](https://cairoscene.com/Buzz/Egyptian-Authorities-Collect-EGP-8-8-Billion-From-Tax-Evasion-Cases)
- Ministerial Decision 386 of 2021 obliged points of sale and entities dealing directly with the public (including digital platforms and apps) to use electronic receipts. — [Mondaq: tax compliance for digital services and e-commerce](https://www.mondaq.com/tax-authorities/1683656/tax-compliance-for-digital-services-and-e-commerce-in-egypt)
- Since 1 Jan 2023 electronic invoices must be reported the same day issued. — [Fonoa](https://fonoa.com/countries/egypt)
- A 2026 guide gives VAT registration threshold EGP 500,000 of sales in the preceding 12 months; unconfirmed against ETA. — [Afrotools](https://afrotools.com/blog/egypt-vat-guide-2026/)
- Withholding at source (advance on corporate income tax, payments over EGP 300): 1% contracting/supply, 3% services, 5% commissions, per Andersen. Applicability to marketplace payouts to sellers, and to who must withhold, is not addressed. — [Andersen: withholding taxes in Egypt](https://eg.andersen.com/withholding-taxes-in-egypt/); see also [PwC](https://taxsummaries.pwc.com/egypt/corporate/withholding-taxes)
- Foreign digital/online services bought from abroad: Egyptian payer is the withholding agent; B2B VAT on foreign digital services is reverse-charged by the recipient; digital services consumed in Egypt are Egyptian-source. Relevant to Z-OUTLET's own cloud/SaaS/ad vendors, not to its sellers. — [Andersen](https://eg.andersen.com/tax-digital-services-in-egypt/); [BDO](https://www.bdo.global/en-gb/insights/tax/indirect-tax/egypt-guidance-issued-on-vat-treatment-of-a-supply-of-digital-services); [Mondaq](https://webiis08.mondaq.com/tax-authorities/1709518/tax-rules-for-digital-services-provided-in-egypt)

### Inferences
- Mechanics to model (for tax adviser sign-off): Z-OUTLET issues a B2B ETA e-invoice to each seller for commission and subscription at 14% VAT; consumer-facing goods e-receipt is the seller's (or Z-OUTLET's if it is the supplier or acts under delegation); whether the platform must also withhold or report on seller payouts is the open point behind VR-B4-03 and VR-06.
- Withholding on commission (5%) may apply to payments Z-OUTLET receives from sellers only if the payer is a withholding agent (government/large taxpayers); direction is unclear. Do not assume.

### Gaps
- Stamp duty on contracts/subscriptions: nothing found.
- Corporate income tax rate (understood as 22.5%, not sourced here), any Egyptian digital services tax on domestic platforms: not found.
- Marketplace-facilitator legal basis, ETA delegated signing, VAT base on platform-funded discounts: not found (VR-06, VR-B4-01 to -04, VR-F1-06).

## Recurring B2B subscription billing (card-on-file, invoicing, termination, refunds)

### Takeaway
I found no authoritative source on merchant-initiated card-on-file rules in Egypt. Only CBE's 2023 device-tokenisation regulation was found, which targets wallets like Apple Pay, not gateway recurring. Confidence: LOW.

### Cited Findings
- CBE board approved regulations for payment-card tokenisation on electronic devices on 8 March 2023, applying to banks, licensed Token Service Providers, issuers and networks; the Apple Pay/mobile tokenisation service launched 12 Dec 2024. — [Baker McKenzie](https://insightplus.bakermckenzie.com/bm/financial-institutions_1/egypt-new-regulations-on-payment-cards-tokenization-on-electronic-devices-applications_1); [Digital Policy Alert](https://digitalpolicyalert.org/change/12258-cbe-payment-cards-tokenization-on-mobile-applications-and-apple-pay-service)
- E-signature Law 15/2004 defines electronic documents and signatures and gives a framework for authorised certification entities; the 2026 Mondaq piece says e-signatures are the legal equivalent of handwritten ones. Click-wrap acceptance of a seller subscription is likely supportable but the evidentiary rule for non-certified signatures was not confirmed. — [Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/10/Law-No.-15-of-2004.pdf); [Mondaq](https://www.mondaq.com/contracts-and-commercial-law/1737494/electronic-signatures-in-egypt-%7c-legal-validity-under-law-15-of-2004)

### Inferences
- Seller (B2B) subscriptions can alternatively be paid by bank transfer or invoice/direct debit, or deducted from seller payouts (set-off) which avoids card-on-file entirely; set-off needs a clear contractual clause and sits within the ledger design.
- Each charge should have an ETA e-invoice and a stored mandate (consent record, price, renewal terms, cancellation terms).

### Gaps
- Paymob/Kashier recurring/MIT support and 3-DS handling on renewals, wallet recurring: not found (VR-04, VR-P2-02, VR-P3-01).
- Termination/refund rules for B2B subscriptions in Egypt: general Civil Code principles only; no source retrieved. CPL refund rules likely do not apply to B2B but this was not verified.

## Seller agreement essentials under Egyptian law

### Takeaway
Core enforceability points found: exclusions of liability are void for fraud or gross negligence and for the contract's core obligation, and tort liability cannot be waived in advance; foreign-ownership rules matter if the operator imports goods. Confidence: LOW-MEDIUM (secondary sources, article numbers unverified).

### Cited Findings
- Civil Code Art. 219: parties may exempt the debtor from contractual liability except for fraud or gross negligence; Cassation Challenge 415 J.Y. 2005 reportedly voids an exemption covering the contract's core obligation; Art. 181: pre-agreed exclusion for tortious acts is void; Art. 225 liquidated damages subject to judicial review; clauses contrary to public order are void. — [Mondaq: Liability under Egyptian law](https://www.mondaq.com/contracts-and-commercial-law/980060/liability-under-egyptian-law)
- Law 80/2002 AML framework exists with the Money Laundering Combating Unit at the CBE; vendor sources say KYC duties apply across fintech/payments but cite no provision. — [Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/10/Law-No.-80-of-2002.pdf); [UNESCWA](https://alp.unescwa.org/legislations/law-80-2002-promulgating-anti-money-laundering-law)
- Seller identity points (commercial register, tax card) are in the repo spec (B5, section 19); I found no external source on who must hold them for online selling.

### Inferences
- Essential clauses to propose to counsel: seller identity and legal-status warranties (commercial register, tax card, ETA registration); brand authorization/proof of purchase and counterfeit warranties; seller is supplier and indemnifies for consumer claims; price-accuracy and discount-claim warranties and consent to monitoring; fees, VAT and e-invoice delivery; payout schedule, holdbacks and set-off; returns/refund funding; takedown and IP notice process; suspension and appeal (a human review point, VR-15); data processing addendum (VR-01); AML/sanctions cooperation and information sharing; liability cap that carves out fraud/gross negligence and does not gut the core obligation (to stay enforceable under Art. 219 as reported); governing law Egyptian; dispute resolution by arbitration (cause: Arbitration Law 27/1994 not researched, see Gaps) with Arabic as authoritative text; electronic acceptance records.
- Foreign operator: contract and ToS must be in Arabic for consumers (CPL); seller B2B contract language not researched.

### Gaps
- Arbitration (Law 27/1994, Cairo Regional Centre/CRCICA), enforceability of arbitration clauses with sole proprietor sellers: no source found.
- IP infringement notice-and-takedown framework in Egypt (Law 82/2002 IP law; safe-harbour for hosting platforms): not researched; Law 175/2018 (anti-cybercrime) provisions on platforms and its interaction with PDPL: no results. Decision 816/2025 not re-researched here (already in master prompt B1).
- Who in Egypt can be a seller (individuals vs registered traders): not found.

## Foreign ownership and entity setup (context only)

### Takeaway
LLC and JSC can generally be 100% foreign-owned; importing for trading triggers 51% Egyptian ownership and an Egyptian import manager. Confidence: MEDIUM-LOW.

### Cited Findings
- LLC may be 100% foreign-owned but an LLC importing goods for trade must be at least 51% Egyptian-owned with an Egyptian manager responsible for imports. — [Alzayat](https://alzayatfirm.com/egyptian-corporate-law-for-foreigners/)
- Capital: LLC no statutory minimum, one-person company EGP 50,000, closed JSC EGP 250,000 issued capital (Tahoun memo, July 2026); PwC guide gives JSC minimum EGP 250,000 with 10% deposit; older UNESCWA guide mentions EGP 2m for importing LLCs. — [Lexafrica 2026](https://lexafrica.com/2026/03/egypt-foreign-investment-regulations/); [PwC guide](https://www.pwc.com/m1/en/tax/documents/doing-business-guides/dbie.pdf)
- Investment Law 72/2017 (amended by Law 160/2023): up to 50% of investment cost deductible, stamp and notary fee exemptions for five years on investment documents, "Golden Licence"; the Article 11 incentive window reportedly runs to October 2026 (check extension). — [Lexafrica](https://lexafrica.com/2026/03/egypt-foreign-investment-regulations/); [Andersen](https://eg.andersen.com/companies-law-159-investment-law-72/)

### Inferences
- Because the operator is a facilitator with sellers importing their own goods, the 51% rule may not bite; Fulfilled-by-HAUL import or the Global world (VR-19) could trigger it.

### Gaps
- Whether an e-commerce operator needs a specific activity licence/registration (e.g., GAFI, commercial register activity code, ITIDA): not found. A payments subsidiary would need CBE capital (see above).

## Cross-reference to verify-register rows (page 1 read)

| Row | Finding effect |
|---|---|
| VR-03, VR-04, VR-22, VR-F1-03, VR-F1-07, VR-PO-01, VR-PAY-12 | Collection/payout model: no authoritative text found; facilitator-style settlement likely regulated; prefer PSP sub-merchant/split. Stay Open. |
| VR-06, VR-B4-01..04, VR-F1-06, VR-P2-11, VR-PO-04 | One vendor guide says marketplaces may collect/remit VAT for suppliers; unconfirmed. Withholding 1/3/5% rates exist; applicability unknown. Stay Open. |
| VR-07, VR-RF-05, VR-P2-01 | CPL text and platform liability: fault-based exposure theory only. Stay Open. |
| VR-04, VR-P2-02, VR-P3-01 | Recurring/MIT: no source. Stay Open. |
| VR-15 | Not researched. VR-19 (import structure) not researched; 51% Egyptian ownership rule noted for importers. |
| VR-08, VR-01, VR-02 | Not re-researched. |

New suggested rows (not in the register as far as page 1 shows): seller-subscription set-off and B2B subscription billing basis; Art. 219 liability-cap carve-outs in the Seller Agreement; arbitration clause (Law 27/1994) and IP takedown safe-harbour; withholding-agent status of the operator on commission/payouts; stamp duty on subscription contracts; whether a registered commercial-activity licence is needed for the operator.

## Source reliability note
Primary sources (CBE rules, ETA decisions, Arabic statutes) were not read. Adsero/Mondaq, Andersen, Baker McKenzie are law-firm secondary sources; Fonoa, Afrotools, VATCalc are vendor guides and weaker. Search tools returned snippets only for most pages; several results were truncated.
