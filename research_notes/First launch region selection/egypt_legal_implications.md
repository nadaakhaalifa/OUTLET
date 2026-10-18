# Egypt legal implications of a first-launch country/region selection

Not legal advice; Egyptian counsel must review. Research as of 2026-10-17. WebFetch was blocked for law-firm and law-text domains, so everything below rests on search-result summaries of secondary sources, not the Arabic official text. No source addressed region pickers, IP defaulting or geo-scoping directly; those answers are inferences.

## Q1. Is a device-stored region preference personal data under PDPL? Consent or "strictly necessary"?

### Takeaway
A region/country value stored only on the device, with no account and not sent to a server linked to an identifier, is probably not personal data. Egyptian sources found do not give an explicit "strictly necessary" or device-storage exemption, so treat any server-side linkage as personal data and keep the choice local. Confirm with counsel.

### Cited Findings
- Law 151/2020 Art. 1 defines personal data as data about an identified or identifiable natural person, directly or indirectly, including by linking with other data. Examples include name, voice, image, ID number and "online identifier". — [Andersen translation of Law 151/2020](https://eg.andersen.com/wp-content/uploads/2025/06/Law-No.-151-OF-2020.pdf); similar wording in [DLA Piper guide](https://www.dlapiperdataprotection.com/guide.pdf?c=EG)
- The search found no source stating whether IP addresses, device IDs or location count as personal data, and none defining "online identifier". Translations vary slightly (one summary omits the "linking" wording); the Arabic text governs. — [ELA/Ibrachy summary](https://www.ela.law/firms/ibrachy-dermarkar/articles/personal-data-protection-law-no-151-for-year-2020-arab-republic-of-egypt)
- The law applies to personal data processed electronically in whole or in part. — [ACC-hosted copy of the law](https://acc.com/sites/default/files/program-materials/upload/Data%20Protection%20Law%20-%20Egypt%20-%20EN%20-%20MBH.PDF)
- The Executive Regulations (Decision 816/2025, issued 1 Nov 2025) call for purpose specification and prior informed consent; full compliance due 1 Nov 2026. — [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law); [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- Exceptions to consent for contract performance and legal obligation appear to sit in the Regulations (per Kennedys, discussed for transfers). — [Kennedys](https://www.kennedyslaw.com/en/thought-leadership/article/2026/egypt-s-personal-data-protection-law-the-compliance-countdown-has-begun)

### Inferences
- A region flag with no linkage to a person is not about an "identifiable" person, and a bare country/region value is low-identifiability. Still, if it is synced to a server alongside device ID, push token or IP, the combination likely becomes personal data (P1/P2 in the repo's classes).
- Safest design: store locally (e.g. MMKV/AsyncStorage), do not transmit it or log it with identifiers, send it only as a request parameter needed to serve the right catalogue. Record the ADR default as "functional preference, no consent prompt, no SDK init". The repo rule that SDKs (PostHog, Sentry) init only after consent still applies; region screen must not trigger them.
- Nothing found requires consent for a user-initiated, functional preference, but that conclusion is by analogy to other regimes, not an Egyptian source.

### Gaps
- No PDPC guidance, decision or case on local-device storage, cookies/local storage, or "strictly necessary" processing.
- Arabic text of Art. 2 (conditions for collection/consent) and the Regulations' list of lawful bases not obtained.

## Q2. Restrictions on coarse location/IP for defaulting; storefront/locale detection

### Takeaway
No Egyptian source found prohibits coarse IP/locale defaulting, but IP addresses plausibly fall under "online identifier", so server-side IP processing for defaulting is arguably personal-data processing needing a lawful basis. Prefer on-device signals (OS locale, App Store storefront) and a user-confirmed choice.

### Cited Findings
- "Online identifier" is an enumerated example of personal data; no source clarifies IP or location. — [Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/06/Law-No.-151-OF-2020.pdf)
- Consent under the Regulations must be prior and informed; purposes must be specified. — [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law)
- Repo spec lists `location_precise` as a consent purpose and says SDKs init only after consent (internal, not a law source). — docs/haul-master-prompt-v3.md B1

### Inferences
- Device locale and the StoreKit storefront are read on-device and need no transmission; low risk. The master prompt already limits the storefront to the US link-out case; reading it for defaulting a suggestion only is a separate use, so keep it local.
- Do not request OS location permission for the region screen. If server-side GeoIP is used, use it transiently at the edge (no storage, no logging of full IP), pre-select only, and always let the user confirm. Truncated or country-only derivation reduces risk but is not shown to remove it.
- A defaulted (not confirmed) region should not be treated as the user's declaration for any legal purpose (e.g., delivery coverage disclosure).

### Gaps
- No PDPC position on IP addresses or coarse geolocation; no Egyptian sources on geo-IP defaulting.

## Q3. Cross-border implications if non-Egypt users browse

### Takeaway
The transfer licence regime concerns moving, storing or processing personal data outside Egypt. Non-Egypt visitors raise two issues: their data is still covered if processed in a way the law reaches, and hosting them abroad triggers the licence rules (ADR-0002). Minimising collected data from them is the main mitigation.

### Cited Findings
- Art. 14: transfer of personal data out of Egypt requires a licence from the regulator and an equivalent level of protection in the destination. — [Legal500 / Chambers commentary via search](https://www.legal500.com/guides/legal-landscapes/egypt-data-protection-cybersecurity/); [Access Partnership](https://accesspartnership.com/?p=13939)
- Tamimi: moving, storing, sharing or processing outside Egypt needs a licence or permit, adequacy, consent and proportionate safeguards. — [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law)
- Kennedys: Regulations allow transfers necessary for a contract with the data subject, a legal obligation, vital interests or legal claims; Tsaaro frames consent as the route. The two secondary sources conflict on structure. — [Kennedys](https://www.kennedyslaw.com/en/thought-leadership/article/2026/egypt-s-personal-data-protection-law-the-compliance-countdown-has-begun); [Tsaaro](https://tsaaro.com/blogs/egypts-pdpl-is-finally-live-why-november-2026-is-a-hard-stop-for-compliance)
- CMS: Egypt uses prior authorisation rather than GDPR-style accountability. — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- Repo: VR-02 (residency/transfer licence) and VR-P3-MKT-04 (non-EG market data protection, localisation) are open; no real data until ADR-0002 accepted. — docs/compliance/verify-register.md

### Inferences
- If the backend is hosted outside Egypt, even a non-Egypt visitor's IP in server logs is data processed abroad, but the licence question is about data leaving Egypt; for a foreign visitor whose data never was in Egypt, applicability of the Egyptian law is unclear (territorial scope not confirmed).
- Design: for users who pick "outside Egypt", collect nothing beyond what the request inherently carries; no account, no analytics, no waitlist form, no email.

### Gaps
- Territorial scope of PDPL (extraterritorial application to foreign visitors of an Egyptian service) not confirmed.
- Whether a licence is required for transient infrastructure logs; PDPC review lead time and any grace after 1 Nov 2026 (repo VR-20, open).

## Q4. Consumer-protection duties: Arabic, supplier identity, delivery area before purchase; advertising outside served territory

### Takeaway
CPL 181/2018 requires clear pre-contract disclosure for remote sales, including supplier identity, delivery date/place, total price with fees, taxes and shipping, and Arabic for transaction documents including electronic ones. Delivery coverage by governorate must be clear before the contract; a region screen helps only as a first filter, not as the disclosure itself. No rule found on advertising to consumers outside the served territory.

### Cited Findings
- Art. 37 (as quoted by Mondaq): before concluding a remote contract the supplier must give the consumer clear information enabling a decision, including name, address, contact, commercial register and tax card, and importer/factory details where relevant; delivery date and place; costs due on delivery; full price including fees, taxes and shipping. — [Mondaq, legal framework of e-commerce in Egypt](https://www.mondaq.com/telecoms-mobile-cable-communications/1225322/legal-framework-of-e-commerce-business-in-egypt)
- Arabic must be used in documents of transactions with consumers (adverts, product data, invoices, receipts, contracts, including e-documents). — [Riad & Riad via search](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law)
- Executive Regulation is PM Decree 822/2019 and extends protection to online contracts. — [Mondaq overview](https://www.mondaq.com/dodd-frank-consumer-protection-act/769376/new-consumer-law-1812018)
- Law text hosted at [Andersen: Law 181/2018](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf) (not opened).
- Repo B5: all windows count from courier-confirmed delivered_at; supplier legal identity shown on every listing; Arabic title/description mandatory. — docs/haul-master-prompt-v3.md B5

### Inferences
- Region screen copy itself (an advert/product data surface) should be Arabic-first. Show coverage ("we deliver to N governorates in Egypt") as an early notice, then repeat the specific delivery place/ETA/fees on PDP and checkout, where Art. 37 bites. Governorate eligibility should be validated against the courier coverage table at address entry (as B2/checkout already specify), with a clear message when an address is unserved.
- Not found: any law forbidding browsing or advertising to users outside the served territory. General misleading-advertising rules may apply if copy implies availability that does not exist; so say clearly "not available yet" and avoid promotional offers to out-of-scope users. Treat as unverified.

### Gaps
- Exact Art. 37 wording and other articles (misleading ads) not verified against Arabic text or Decree 822/2019.
- No Consumer Protection Agency guidance found on geographic scoping, delivery-area disclosure or ads to non-served regions.

## Q5. Message for users outside Egypt without collecting personal data; waitlist

### Takeaway
Show a static, Arabic/English "not available in your country yet" screen with no input fields. A waitlist (email/phone) is personal-data collection needing specific, informed, opt-in consent and a stated purpose and retention; defer it or make it a separate, optional, consented step.

### Cited Findings
- Consent must be prior, informed, purpose-specific; withdrawal easy. — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins); [Al Tamimi](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law)
- Repo: consent never pre-ticked; marketing consent per channel; purposes listed in `consent_records`. — docs/haul-master-prompt-v3.md B1, A4
- Repo VR-P3-MKT-04: non-EG market legal review open. — docs/compliance/verify-register.md

### Inferences
- Waitlist would add a new processing purpose, potentially a new data store abroad, and a retention job; and it adds a `consent_records` purpose (e.g. `marketing_email`) before any account exists, which the current model ties to `user_id`. Recommend: no waitlist at launch; offer "notify me" via the user's own OS/store mechanisms or a link to a web page with its own privacy notice, after counsel review.
- Do not persist a "non-Egypt" choice server-side; keep it on device so the user can change it.
- The app should still allow browsing the public catalogue? Not recommended: it would imply availability and add cross-border exposure; keep it gated pending VR-P3-MKT items.

### Gaps
- No source on Egyptian rules for pre-account marketing waitlists or on minimum consent evidence without an account.

## Q6. Regulator guidance: PDPC, Consumer Protection Agency, ETA; VAT/e-receipt by delivery region

### Takeaway
No regulator guidance found on geographic scoping for any of the three. VAT 14% applies by default; exports of goods are zero-rated under the Executive Regulations conditions, but delivery within Egypt to any governorate is not differentiated in anything found.

### Cited Findings
- Standard VAT 14%; exports of goods and services 0% subject to Executive Regulations conditions; B2B e-invoicing mandatory, B2C e-receipt rollout continuing. — [Avalara](https://www.avalara.com/vatlive/en/country-guides/africa-and-middle-east/egypt-vat/egyptian-vat-rates.html); [Kintsugi guide](https://trykintsugi.com/sales-tax-guides/middle-east/egypt)
- Service exports zero-rated if performed from Egypt and remote, with evidence (agreement, e-invoice, bank transfer). — [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2024/11/tnf-egypt-new-vat-rules-on-exported-services.html); [Enterprise](https://enterpriseam.com/egypt/2025/12/01/exported-services-to-be-treated-as-vat-zero-rated-under-new-rules-clarification/)
- Repo B4: VAT-inclusive prices, ETA e-receipt for HAUL's own B2C supplies, VR rows for platform withholding/marketplace obligations; VR-19 for cross-border parcels (Global world). — docs/haul-master-prompt-v3.md B4; docs/compliance/verify-register.md

### Inferences
- Because the app serves only Egyptian delivery addresses at first launch, VAT/e-receipt treatment does not vary by governorate; export (non-Egypt delivery) treatment is not in scope and should stay blocked until VR-19 and tax counsel close.

### Gaps
- No ETA primary text on e-receipts for goods delivered abroad; no PDPC or Consumer Protection Agency publication on region scoping.
