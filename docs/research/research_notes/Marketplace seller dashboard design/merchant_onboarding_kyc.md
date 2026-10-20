# Merchant onboarding and KYC/KYB at leading marketplaces

Scope note: one search round (about 9 searches). Mostly secondary snippets; first-party pages were often not retrievable (the Noon page fetch was blocked). Shopify, Etsy first-party articles, Mirakl's own docs, Salla's Egypt/Zid flows and all KYC vendor docs were not directly read. Treat as a starting point, not final.

## Common stages and the minimal data set at each stage

### Takeaway
Across platforms the order is: account/identity of the representative, then legal entity and tax data, then payout account with name match, then (for branded goods) brand authorization, then review and activation. Entity-level verification is often delegated to a payments/KYC provider, not done by the marketplace.

### Cited Findings
- Noon requires a valid commercial register/trade licence with at least 30 days validity and a qualifying activity (sales, trading, manufacturing, wholesale); a tax card for Egyptian sellers; an assigned Business Representative with national ID or passport (Egypt); and a business (not personal) bank account — [Noon documents](https://helpcenter.noon.partners/en/category/onboarding-and-registration/documents-required-to-sell-on-noon), [Noon registration](https://support.noon.partners/portal/en/kb/articles/seller-registration-process-12-3-2024)
- Etsy sole proprietors give name, date of birth, home address, sometimes a tax number, then bank details with account-holder name; a government ID may be requested — [Etsy Help](https://help.etsy.com/hc/en-us/articles/360001980067-How-to-Verify-Your-Seller-Information-for-Etsy-Payments)
- Zalando: no self-signup; Zalando contacts the brand, KYC reviews occur before onboarding and during the relationship, legal entity data is entered in the zDirect portal, a product safety/quality questionnaire is required, and a minimum 30-day return policy applies — [Zalando Partner Program requirements](https://partner.zalando.com/university/article/Partner-Program-Requirements-to-get-started), [pre-onboarding](https://partner.zalando.com/university/article/pre-onboarding-and-onboarding-requirements)
- Shopify Payments (secondary sources only): government ID, business registration, tax ID, bank statement, address proof; common rejections are blurry, cropped or expired ID and mismatch with account details — [Shopify community](https://community.shopify.com/t/why-is-shopify-payments-unable-to-verify-my-uploaded-id/310223), [Tevello guide](https://tevello.com/blogs/shopify-guides/how-to-verify-shopify-payments-a-comprehensive-guide-for-e-commerce-merchants)
- Salla (KSA): Ministry of Commerce moved e-commerce store verification from Maroof to the government Business Platform; flow is Nafath sign-in, apply, prove domain ownership via DNS TXT record, SMS approval. Companies cannot use a bank account not linked to the commercial registry — [Salla help](https://help.salla.sa/en/article/verify-store-on-business-platform-instead-of-maroof/gno9ilestioyspm61yu5buzp), [Salla store verification](https://help.salla.sa/en/article/store-verification-old-experience/yaqnhs5lfj3ltyiwzanj3ioa)
- Faire retailer-side verification is triggered by a first order and asks for storefront address, website, social profiles, store photos, sometimes a business licence — [Faire support](https://www.faire.com/support/articles/53979481093275)
- Mirakl: operator-side KYC is outsourced to payment connectors (Stripe, Adyen, Mollie, Mangopay, Lemonway) that sync a KYC status onto the shop — [Stripe Mirakl](https://docs.stripe.com/connectors/mirakl/onboarding-sellers), [Adyen](https://docs.adyen.com/plugins/mirakl/onboard-sellers), [Mollie](https://docs.mollie.com/docs/mirakl-seller-kyc)

### Inferences
- A minimal Z-OUTLET data set: representative identity, legal name, commercial register number, tax card, governorate/address, IBAN with account-holder name, brand authorization where applicable. This matches the Noon Egypt requirements most closely.

### Gaps
- Official Shopify, Amazon document lists per merchant type (individual/company/foreign), UBO collection rules, and Etsy/Faire brand-side checklists were not found in first-party text.

## Automated vs manual, and stated turnaround times

### Takeaway
Stated SLAs are short and vary; what is documented is mostly a fast automated or desk review with a manual fallback. Several figures come from third parties and conflict.

### Cited Findings
- Noon: legal-entity eligibility approval up to 24-48 working hours when the CR has trading activities (official); a third-party guide says about a week — [Noon documents](https://helpcenter.noon.partners/en/category/onboarding-and-registration/documents-required-to-sell-on-noon), [SPCFZ guide](https://spcfz.ae/?p=7698)
- Faire retailer verification reviewed within 24 hours, with portal/email notice when more information is needed — [Faire support](https://www.faire.com/support/articles/53979481093275)
- Amazon: video call verifies original documents; Amazon may follow up within two business days; missed appointments must be rescheduled; unfinished verification can leave the account deactivated — [Amazon.de guide](https://sell.amazon.de/weltweit-verkaufen/registrierungs-leitfaden), [Seller forum](https://sellercentral-europe.amazon.com/forums/t/video-call-verification-issue-link-uk/585125)
- Amazon video verification was piloted in 2020 in US, UK, China and Japan — [TechCrunch](https://techcrunch.com/2020/04/27/to-fight-fraud-amazon-now-screens-third-party-sellers-through-video-calls)
- Shopify Payments: 24-72 hours or 2-5 business days (blogs, unofficial) — [Tevello](https://tevello.com/blogs/shopify-guides/how-long-does-shopify-payments-verification-take-a-comprehensive-guide-for-merchants)
- Etsy US bank verification: self-verify, Plaid, or a manual option that carries a 5-day hold on funds — [The Paypers](https://thepaypers.com/ecommerce/etsy-imposes-that-us-sellers-must-verify-bank-accounts--1258151), [EcommerceBytes](https://www.ecommercebytes.com/2025/03/28/etsy-sellers-turn-to-have-account-verification-issues/)
- Brand-account review of 2-3 business days at Faire comes only from a third-party AI answer page; unreliable — [checkthat.ai](https://checkthat.ai/ai-answers/fda49574-4e0e-4648-8980-89898c73b9c9)

### Inferences
- Pattern: automated registry/ID checks first, human video or desk review only for exceptions, which is consistent with the PDF's `AUTO_CHECKS` then `NEEDS_INFO` design.

### Gaps
- Shopify and Etsy official SLAs; Zalando SLAs; sanctions/PEP screening practices (not found in any platform doc); liveness steps (only Amazon video call evidenced).

## Local vs international/cross-border handling

### Takeaway
Platforms demand local-country proof (address, VAT, bank) from foreign sellers, and country-specific document lists.

### Cited Findings
- Noon: international sellers need a VAT certificate from the selling country's authority; Egypt needs tax card; KSA freelance certificates no longer accepted for new sellers; a changed trade licence number is treated as a new legal entity — [Noon documents](https://helpcenter.noon.partners/en/category/onboarding-and-registration/documents-required-to-sell-on-noon), [Noon update docs](https://supportagent.noon.partners/portal/en/kb/articles/update-your-legal-documents-12-3-2024)
- Shopify staff reply: a legitimate in-country address needed, not a forwarding address (community post, single source) — [Shopify community](https://community.shopify.com/t/shopify-id-verification-for-shopify-payments/12049)
- Zalando publishes country-specific onboarding requirements — [Zalando](https://partner.zalando.com/university/article/country-specific-onboarding-requirements)
- Salla publishes separate verification flows for Qatar and Kuwait — [Salla Qatar](https://help.salla.sa/en/article/verify-your-salla-store-in-qatar-salla/v3eb7qii4es3nf1eg2tu6qpv)

### Inferences
- Z-OUTLET should model requirements as a per-country document matrix, with foreign brands needing local address or authorized distributor evidence.

### Gaps
- Shopify Markets seller-side verification (it is a selling-region feature; no merchant KYC differences found).

## Brand authorization, anti-counterfeit, suspension and appeals

### Takeaway
Letter of authorization and invoice rules are strict; invoices alone are not authorization. Suspension/appeal specifics were largely not found.

### Cited Findings
- Amazon LOA must be on trademark-owner letterhead with licensor/licensee details, scope, geography, term and signature; invoices and sales contracts do not count; Amazon may contact the trademark owner. Authorized users may need recent invoices (last 6 months) matching seller name/address — [Seller forum](https://sellercentral-europe.amazon.com/seller-forums/discussions/t/23645c2c-819d-40c6-8390-9be5f0fad7aa), [WisePPC](https://wiseppc.com/blog/sell-branded-products-on-amazon/)
- Amazon Brand Registry sends a verification code to the contact on the trademark record; rejections include forged documents and poor account health — [Bellavix](https://www.bellavix.com/how-to-enroll-in-amazon-brand-registry-step-by-step-guide-to-protect-and-grow-your-brand/)
- Faire terms require brand application and approval (via a third-party monitor, not primary) — [ConductAtlas](https://conductatlas.com/platform/faire/faire-terms-of-service/brand-application-and-approval-required/)
- Mirakl/Adyen statuses: Awaiting KYC data, Awaiting KYC verification, KYC failed; optional auto-unsuspend of new shops after KYC success — [Adyen](https://docs.adyen.com/plugins/mirakl/onboard-sellers)
- Etsy sellers in March 2025 reported suspended shops and frozen funds pending verification (anecdotal) — [EcommerceBytes](https://www.ecommercebytes.com/2025/03/28/etsy-sellers-turn-to-have-account-verification-issues/)
- Noon: updating documents via a document management platform does not affect selling privileges — [Noon update docs](https://supportagent.noon.partners/portal/en/kb/articles/update-your-legal-documents-12-3-2024)

### Inferences
- Shops start suspended and are unsuspended on KYC pass in Mirakl-style flows, which fits an `APPROVED`/`SUSPENDED` model.

### Gaps
- Not found: re-verification triggers, formal appeal flows, reason-code catalogs, dual approval, side-by-side admin review tooling, and admin queue/risk-tier patterns at any named platform. KYC vendor (Onfido, Sumsub, Persona, Veriff) docs were not searched; Zid and Mirakl first-party docs were not retrieved.
