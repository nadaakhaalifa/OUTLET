# Defect, seconds, open-box and B-grade selling: grading, disclosure, law, AI, UX (for the Outlet NK "defect card")

Research date: 2026-11-06. Every figure carries its year; "UNVERIFIED" means only secondary or snippet-level evidence was found. Some search results were summarized by the search tool and not fetched in full. eg.andersen.com (the English text of Law 181/2018) could not be reached from this session because the host is not on the allowed network list.

## 1. How platforms grade and disclose condition, and which defect taxonomies exist

### Takeaway
Platforms use short ordinal scales of 3 to 5 grades and add free-text or photo notes for specific flaws. eBay (2025) is the closest fashion analogue: it has a separate "New with imperfections" condition for unworn items that have flaws. AQL (critical/major/minor) is the only standardized defect-severity taxonomy in industry use. It is built for lot acceptance, not consumer disclosure, but it maps well to a defect-severity field.

### Cited Findings
- **Amazon Resale** (renamed from Amazon Warehouse in October 2024) inspects returned, open-box and refurbished items and assigns one of four grades: Like New, Very Good, Good or Acceptable. In Very Good, the item "may have seen limited use", is fully functional and may have minor cosmetic imperfections or damaged or replaced packaging. Sources: [ChannelX 2024](https://channelx.world/2024/10/amazon-renames-amazon-warehouse-to-amazon-resale/), [About Amazon UK](https://www.aboutamazon.co.uk/news/sustainability/how-to-shop-second-hand-amazon). The full official text for each tier was not retrieved, and the Acceptable definition is UNVERIFIED.
- **eBay:** "New with defects" covers a brand-new, unused and unworn item that may have cosmetic defects or mismarked tags (for example, wrong size tags). For clothing, examples include scuffs, hanging threads and missing buttons, and factory seconds and irregulars fall here. In a January 2025 update, eBay renamed this condition to "New with imperfections" for clothing and added Pre-owned Excellent, Good and Fair grades. Sources: [eBay condition IDs](https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html), [eBay Jan 2025 seller update](https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions), [ChannelX 2025](https://channelx.world/2025/01/new-ebay-conditions-for-pre-loved-clothing/).
- **Back Market:** phones, tablets, laptops and watches have four grades (Premium, Excellent, Good, Fair), while audio devices and consoles have two. The grade is cosmetic only, and every device is guaranteed 100% functional with at least 80% battery capacity. Premium means almost no signs of use and genuine manufacturer parts only. Back Market has a help flow for orders that do not match their grade. Sources: [Back Market grades](https://www.backmarket.com/en-us/c/smartphones/what-are-back-market-phone-grades), [Back Market help: grade mismatch](https://help.backmarket.com/hc/en-us/articles/360010146460-My-order-didn-t-match-the-appearance-grade). The exact scratch criteria for each tier came only from third parties ([RefurbMe](https://www.refurb.me/blog/what-are-refurbished-grades-a-b-c)) and are UNVERIFIED.
- **Vinted:** the scale runs New with tags, New without tags, Very good ("minor imperfections that don't affect overall appearance or use"), Good and Satisfactory ("well-used", wear is obvious). Vinted advises sellers who are unsure to pick the lower condition. Source: [Vinted help 50](https://www.vinted.com/help/50-choosing-item-condition).
- **Patagonia Worn Wear:** Excellent (barely worn), Great (minor signs of wear) and Good (visible wear or repairs). Each listing names the specific flaws, such as discoloration, fading or pilling. Source: [Worn Wear listings](https://wornwear.patagonia.com/products/ms-down-sweater_84673_dsc). Grade wording comes from a search summary and is UNVERIFIED in its exact form.
- **IKEA As-Is** covers discontinued items, buy-back items and display items. These "might have a few cosmetic imperfections" but are functional and safe, and online listings carry photos and comments that describe the defect. Sources: [IKEA India FAQ](https://www.ikea.com/in/en/customer-service/knowledge/articles/6579b255-2608-47a5-a643-c4a15b746181.html), [IKEA AU As-Is online T&Cs](https://www.ikea.com/au/en/files/pdf/29/c0/29c0a22a/as-is-online-t-and-cs.pdf).
- **The RealReal** publishes a written condition scale (Pristine, Excellent, Very Good, Good, Fair is the common reading; the snippet shows "Excellent: like new or gently worn") along with condition notes. Source: [TRR FAQ](https://therealreal.com/faq), [TRR vendor condition attributes](https://vendor-docs.therealreal.com/attributes/conditions). The full tier list is UNVERIFIED.
- **Nordstrom Rack:** I found no public "flawed" grade. The company says it "will not knowingly sell damaged or broken items". The source is consumer forums and search summaries, so this is UNVERIFIED. A November 2025 class action alleges fabricated "limited-time" sales; it is an allegation only. Source: [Top Class Actions 2025](https://topclassactions.com/lawsuit-settlements/lawsuit-news/class-action-alleges-nordstrom-racks-limited-time-sales-were-fabricated-and-perpetual).
- **AQL and ISO 2859-1:** the industry convention is Critical = AQL 0 (any one fails the lot; safety or regulatory issues, such as drawstrings on childrenswear or toxic dye), Major = AQL 2.5 (impairs use or clearly off-spec, such as an open seam) and Minor = AQL 4.0 (cosmetic, such as a loose thread end or a print offset under 2 mm). Brands tighten these levels; childrenswear, for example, uses Major 1.5 and Minor 2.5. Sources: [V-Trust defect classification](https://www.v-trust.com/en/our-services/inspection-standards/defect-classification), [WavePLM apparel AQL](https://blog.waveplm.com/aql-inspection-in-apparel-how-to-set-defect-thresholds-and-catch-quality-issues-before-they-ship/). These sources are vendors, not the purchased ISO text.
- **ThredUp** condition definitions ("minor flaw" and similar) were not retrieved, so they are a gap.
- **Imperfect Foods:** not researched in this pass. It is an analogy only.

### Inferences
- Outlet NK should use two separate axes, as eBay and Back Market do. The first is a **condition grade** (New with tags / New with imperfections / Sample / Open-box-returned / Pre-owned). The second is a list of **structured defects**, each with type, location, size, severity (minor/major from AQL) and a photo. Critical (safety) defects should be **unlistable**.
- A starting taxonomy built from the sources above: stain/discoloration, hole/tear, missing or damaged button/trim, broken zip or hardware, stitching flaw/open seam, pilling, fading, print misalignment, mismarked size tag, odor, packaging damage. This list is an inference, not a published standard.

### Gaps
- Official Amazon tier texts, ThredUp and TRR full scales, and the purchased ISO 2859-1 tables.

## 2. AI and computer-vision defect detection

### Takeaway
Factory fabric-defect detection is a mature research field with many deep-learning and YOLO models, but reported accuracies vary widely by dataset. Resale platforms publicly use AI mainly for **authentication and pricing**, not for verified condition grading. Outlet NK should treat CV as a **seller-assist and fraud check**, not as the grader of record.

### Cited Findings
- A 2024 IEEE Access review (Guo et al., vol. 12, pp. 63777–63808) compares deep-learning fabric-defect methods on detection rate and real-time capability, and lists public datasets. Source: [DOAJ / IEEE Access 2024](https://doaj.org/article/c833b02aba4444b4be12e806bdbc1a18). I did not extract its numeric results.
- A September 2024 MDPI Electronics review covers YOLOv1–v11 for real-time fabric inspection. Source: [MDPI 2024](https://www.mdpi.com/2079-9292/13/18/3728).
- A small 2024 study reported 73.91% accuracy for VGG-16 and 67.59% for ResNet. Source: [Wiserpub RRCS 2024](https://ojs.wiserpub.com/index.php/RRCS/article/download/4156/2021/40975). These figures are study-specific and show that accuracy is not uniformly high.
- Manual inspection is often cited at about 60–75% accuracy, according to a 2020 review. This figure came through a search summary and is UNVERIFIED.
- **The RealReal:** the Athena intake AI uses item photos and TRR's image database to route items to manual authentication or straight to listing. About 27% of items went through Athena in late September 2025, with a target of about 40% by December 2025. TRR Vision compares photos of bag parts against millions of images. Sources: [WSJ via itiger 2025](https://www-web.itiger.com/news/2605105461), [TRR FAQ](https://therealreal.com/faq). Whether Athena grades *condition* is not established.
- Vinted's and ThredUp's automated condition grading: no public evidence found.
- Third-party tools exist, such as GradeThread, which uses an LLM vision model to score fabric, structure, cosmetics, function and odor. It is a vendor claim with no published accuracy. Source: [Peerlist](https://peerlist.io/gradethread/project/gradethread--the-standard-for-grading).

### Inferences
- Lab results come from flat fabric rolls, while marketplace photos show finished garments under uncontrolled lighting. Expect much lower real-world accuracy and validate on a labeled Egyptian set, similar to the §9 τ approach in the master prompt.
- Uses that fit the evidence: suggest defect hotspots, flag listings where a model detects a visible defect the seller did not declare, and detect reused or stock photos (pHash). Never auto-assign a better grade.

### Gaps
- No published precision/recall for garment-level defect detection on consumer photos, and no resale-platform accuracy figures.

## 3. Law: selling disclosed-defect goods "as is" (Egypt vs EU and UK)

### Takeaway
In the UK, and under the EU 2019 Directive with conditions, a defect that was **specifically disclosed** before the contract cannot later found a non-conformity claim. Undisclosed defects keep full rights, and the distance-selling withdrawal right is unaffected. For Egypt, I could not verify the text of Law 181/2018 Art. 17 or whether a pre-disclosed defect is excluded from the defect-return right. Treat this as **VERIFY BEFORE LAUNCH** and default to the safe policy.

### Cited Findings
- **UK, Consumer Rights Act 2015 s.9(4)(a):** the satisfactory-quality term does not cover anything that makes quality unsatisfactory and that was "specifically drawn to the consumer's attention before the contract is made". The explanatory notes say a disclosed defect "will not be grounds for finding the goods to be unsatisfactory". Sources: [legislation.gov.uk s.9](https://legislation.gov.uk/ukpga/2015/15/section/9), [Explanatory notes](https://legislation.gov.uk/ukpga/2015/15/section/9/notes).
- **EU, Directive 2019/771 Art. 7(5):** there is no lack of conformity with the objective requirements if the consumer was **specifically informed** that a particular characteristic deviated and **expressly and separately accepted** it when concluding the contract. Italy transposed this verbatim in 2021. Sources: [Unife thesis](https://iris.unife.it/handle/11392/2497136), [EUR-Lex text via lexaris](https://lexaris.de/de/library/tableofcontents/2062147). The exact article wording was not fetched; check EUR-Lex. Implication: a pre-ticked box or a line buried in the T&Cs is not enough, and the shopper needs a separate, explicit acceptance.
- **Egypt, Law 181/2018:** Art. 17 is reported to give a 14-day right to return or exchange without a reason, provided the item is in its original condition. Sources: [Al-Ahram Weekly](https://english.ahram.org.eg/NewsContent/50/0/409645/AlAhram-Weekly/0/INTERVIEW-Safeguarding-consumer-rights-in-Egypt.aspx), [UNESCWA 2023](https://unescwa.org/sites/default/files/inline-files/ABLF-2023-consumer-CP-Egypt-english.pdf). The 30-day defect period appears in a **2014 draft** presentation and in retailer policies, and is UNVERIFIED against the enacted text. Source: [FTC 2014 presentation](https://www.ftc.gov/system/files/documents/public_events/316871/egyptamalehsan.pdf). The executive regulation is PM Decree 822/2019 ([Digital Policy Alert](https://digitalpolicyalert.org/event/28035-executive-regulation-for-consumer-protection-law-no181-of-2018-prime-ministers-decree-no-822-of-2019-including-usersubject-right-entered-into-force)). Authoritative texts: Arabic original; English at [WIPO Lex](https://wipolex-resources-eu-central-1-358922420655.s3.amazonaws.com/edocs/lexdocs/laws/en/eg/eg065en_1.pdf) and [Andersen PDF](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf) (not reachable from this session).
- **No source found** that confirms whether Egypt excludes disclosed defects from the defect-return right.

### Inferences
- Even where a disclosed defect is not a non-conformity, the **14-day no-reason return (Egypt) and the 14-day EU withdrawal right still apply** to distance sales, because those rights do not depend on a defect. "As is" therefore cannot mean "no returns" for online sales. This matches master prompt §22: a disclosed defect is not a return reason, other defects are, and the change-of-mind window still applies.
- Safe default (proposed ADR): (1) the disclosed defect, with photo and an explicit separate tick at add-to-bag, cannot ground a defect claim; (2) **any undisclosed or larger-than-shown defect is a seller-fault return** (30 days, seller pays); (3) the 14-day change-of-mind return still applies. Send to counsel (verify register row 7).

### Gaps
- Enacted Arabic text of Arts. 17–18 and Decree 822/2019 on disclosed defects, and any Egyptian Consumer Protection Agency guidance on "as is" or seconds.

## 4. Returns, satisfaction, discounts by grade, and fraud controls

### Takeaway
I found no rigorous public data comparing return rates or customer satisfaction for defect-disclosed fashion against new items. Discount bands come only from retailer guides. Fraud on both sides is an acknowledged problem: sellers under-grade and buyers claim new damage. Back Market's grade-mismatch flow and photo evidence are the documented controls.

### Cited Findings
- Open-box discounts run about 10–30% below new; refurbished runs about 20–50% or 30–60% depending on the source. Best Buy open-box "Excellent" is about 5–15% off, and its open-box return window is 15 days versus 30 for new. All figures are from 2024–2025 guides and UNVERIFIED. Sources: [Goodshop](https://www.goodshop.com/blog/refurbished-vs-open-box-electronics-which-option-actually-saves-you-more/), [ConsumerAffairs](https://www.consumeraffairs.com/news/open-box-vs-refurb-vs-renewed-the-real-differences-when-buying-electronics-102425.html), [RefurbMe](https://www.refurb.me/blog/what-does-open-box-mean-similarities-differences).
- The commonly cited "Grade B = 30–50% off" for fashion seconds: **no source found** (UNVERIFIED).
- Back Market lets buyers report that a device did not match its grade, which shows that grade mismatch is a common enough dispute to need a dedicated flow. Source: [Back Market help](https://help.backmarket.com/hc/en-us/articles/360010146460-My-order-didn-t-match-the-appearance-grade).
- Platforms tell sellers to grade down when unsure: Vinted ([help 50](https://www.vinted.com/help/50-choosing-item-condition)) and Amazon seller guides ([SureDone](https://support.suredone.com/support/solutions/articles/1000118239-what-guidelines-do-i-need-to-follow-when-specifying-condition-on-amazon-)).

### Inferences (controls for Outlet NK)
- Seller side: require a close-up photo for each declared defect plus one full-item photo, with EXIF/pHash checks against reuse. Run CV to flag undeclared visible defects. Track a seller "grade accuracy" metric from upheld grade-mismatch returns, and feed it into the Seller Health and Price Trust scores. Fulfilled-by-HAUL items get hub inspection.
- Buyer side: courier proof-of-delivery photo, optional unboxing video for high-value items, and a return inspection that compares the item against the listing's defect photos. Watch serial-claim patterns (master prompt §22 serial-returner policy).
- Pricing: do **not** auto-show "% off" for a defect item unless §9 verifies a reference. Show "Imperfect: X EGP vs Y EGP for the perfect version" only where a verified perfect-item reference exists. Otherwise show a plain price.

### Gaps
- Fashion seconds discount by grade, return rate of disclosed-defect items, and buyer false-claim rates. No public datasets were found.

## 5. UX patterns

### Takeaway
The documented patterns are a grade badge with a definition tooltip, per-flaw text and photos, and condition filters. Defect hotspots on images and side-by-side comparison with the perfect item are reasonable designs, but I found no public evidence of them at the named platforms.

### Cited Findings
- Condition filters and badges are standard on eBay (condition IDs used as facets) and Vinted. Sources: [eBay condition IDs](https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html), [Vinted help](https://www.vinted.com/help/50-choosing-item-condition).
- Patagonia Worn Wear lists named flaws on each product page, and IKEA As-Is shows photos plus comments describing the defect. Sources: [Worn Wear](https://wornwear.patagonia.com/products/ms-down-sweater_84673_dsc), [IKEA India](https://www.ikea.com/in/en/customer-service/knowledge/articles/6579b255-2608-47a5-a643-c4a15b746181.html).

### Inferences (proposed defect card)
- A card with: grade badge, defect count, then for each defect: type icon, Arabic label, location ("left cuff"), size in cm, severity, close-up photo, plus a hotspot pin on the main image (tap opens the close-up). Add a "compare with perfect item" toggle when the same SKU exists in new condition, an explicit "I have seen the N defects" acknowledgement before purchase (needed for EU-style express acceptance), and a filter by grade and by defect type ("no stains", "only minor"). Everything is Arabic-first, and photos must not be AI-retouched.

### Gaps
- No A/B or conversion evidence for hotspots or comparison views was found.
