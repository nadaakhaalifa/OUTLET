# Turn Outlet NK into honest outlet infrastructure

**Short answer.** Outlet NK becomes an advanced, end-to-end product when it stops being "a cheap shop" and becomes **the trusted place where brands clear stock and shoppers know exactly what they get**. Three new ideas make this possible, and each one changes the current spec (the master prompt v3). First, **sell software to brands, but charge mainly on sales**. The market trend is "no upfront fees, pay when you sell" (ThredUp removed its upfront and monthly fees in 2025), and Egyptian store builders such as Wuilt went free in 2025, so a heavy monthly fee would scare Egyptian brands away. A free tier with higher commission, plus paid tiers with lower commission and better tools, is the safest structure. Second, **make defective items a first-class category with a structured "defect card"**: a condition grade plus a list of each defect with its type, place, size, severity and a real close-up photo. This is how eBay, Back Market and Vinted handle condition. But "as is" cannot mean "no returns" for online sales in Egypt, because the 14-day no-reason return right still applies, and the Egyptian rule on disclosed defects is **not yet verified**. Third, **"Black Friday every day" must be built on freshness, not on bigger and bigger "% off"**. Research shows frequent generic discounts damage brands and teach shoppers to wait, and on 27 October 2026 Egypt's Consumer Protection Agency (CPA) warned of fines of up to **EGP 2m or twice the product value** for fake discounts. The right engine is a fixed daily drop time, real stock bars and rewards instead of deeper cuts. Finally, **launch on the web first** (a fast, indexable PWA plus WhatsApp), then Android and iOS, because Android is about 88–91% of Egyptian phones. Most commercial figures in this report come from vendors or secondary blogs and are marked **UNVERIFIED** where that is the case. Pricing, commission and legal policy are the owner's decisions.

## What changes from the current plan

The master prompt v3 is a strong engineering plan, and most of it still holds: price integrity (§9), the ledger, the multi-store checkout, risk-gated COD, and returns that count from delivery. But the new idea changes six things. The table below lists them so the team can update the spec and write ADRs.

| Area | Current spec (v3) | New idea | What to change |
|---|---|---|---|
| Platform order | iOS first, Android +6–8 weeks, shopper web only in Phase 3 (§0, §P3) | Website first, then iOS and Android | Move the shopper web (Next.js, PWA) to Phase 1. Mobile apps follow. Rewrite §0 platform order, §P3 phases and ADR-0004 timing. |
| Brand model | Brands are sellers who pay commission; Seller Center is a tool (§19) | Brands are **SaaS customers** with tiers | Add a `subscriptions` model for sellers (plans, billing, entitlements), separate from shopper Plus. New ADR on seller pricing. |
| Defective items | "Minor defect" is one filter value; defect photos required (§4, §22) | Defects are a **core category** with a detailed card | New module `condition-grading` with a defect taxonomy, defect card, buyer acknowledgement and grade-mismatch returns. |
| Deal rhythm | Time-boxed drops and events (§16) | Cheap every day, all year | Add a daily drop calendar, evergreen category pages, and anti-fatigue rules. Keep §9 unchanged. |
| B2B channel | Not in spec | Bulk and badly defective lots | Optional B2B stocklot channel for lots that should not reach consumers (Phase 3). |
| Display control | Verified "% off" shown on every eligible item | Brands fear public discount depth | Brand-controlled display mode: hide % off or show it only to logged-in members. Never show an unverified claim. |

The Apple subscription risk in §B7 matters less at first, because the web launches first and the website has no App Store rules. It returns when the iOS app ships.

## Brands pay when they sell, so tiers must be light

The global pattern is clear: **liquidation and off-price platforms earn mainly from a share of sales, not from software fees**. Otrium splits revenue with brands and gives them control over price, visibility and sales data ([Glossy](https://www.glossy.co/fashion/luxury/luxury-briefing-why-off-price-fashion-e-tailer-otrium-closed-its-u-s-operations)). ThredUp's resale-as-a-service **dropped its upfront and monthly fees in 2025** ([Retail Dive](https://www.retaildive.com/news/thredup-overhauls-resale-service-slashes-fees-brand-recommerce/747934/)). Where a fixed fee exists, it is small: Zalando's partner programme is reported at about **EUR 40/month plus 5–25% commission** on non-returned sales ([ecommercenews.eu](https://ecommercenews.eu/?p=30766), UNVERIFIED), and B-Stock Supply at about **USD 99/month** plus a minimum auction fee ([entreresource](https://entreresource.com/best-liquidation-sites/), UNVERIFIED). In Egypt the software price anchor is near zero: **Wuilt dropped its monthly merchant fees in 2025** ([TechAfrica News](https://techafricanews.com/2025/08/04/cairos-wuilt-raises-2-million-to-fuel-e-commerce-expansion-after-bold-pivot/)), and Salla offers a free plan. The commission ceiling is also clear: **Noon charges 15% on apparel in Egypt from February 2026** ([noon partners](https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-fbp-fees-in-egypt)).

So the "SaaS" in Outlet NK should mean **real tools that brands value**, sold mainly through a lower commission, not a big monthly bill. The tools most likely to justify a paid tier in Egypt are Shopify/WooCommerce stock and price sync, AI Arabic listing generation, the defect-grading listing flow, analytics, a markdown advisor and a private B2B lot portal. Markdown tools have real but modest value: vendor case studies report **2–6% profit gains** and sell-through gains of about 6–10% ([Invent Analytics](https://www.casestudies.com/company/invent-analytics/case-study/a-major-european-apparel-retailer-improves-its-revenue-by-24-and-lowers-markdown-loss-by-2); [Antuit](https://www.antuit.ai/resources/case-study-0/global-footwear-sports-apparel-retailer-improves-sell-through-and-recaptures-lost-margins)), all vendor-reported. Brands also accept outlet channels more when they keep control of their image, which is why Lounge by Zalando is a closed members' club ([Zalando](https://corporate.zalando.com/en/node/10813)).

The table below shows **options only**. Every number is a placeholder for the owner to decide and test. None is a benchmark.

| Option | Monthly fee (placeholder) | Commission (placeholder) | What the brand gets |
|---|---|---|---|
| **Start (free)** | EGP 0 | Higher, e.g. 15% | Store page, manual and CSV listing, defect card builder, basic sales report, standard payouts |
| **Growth** | Low, e.g. EGP 500–1,500 | Middle, e.g. 11–12% | Shopify/Woo sync, AI Arabic/English listings, background clean-up, full analytics, store vouchers, faster payouts |
| **Pro / Outlet-as-a-Service** | Higher, e.g. EGP 3,000–8,000 | Lower, e.g. 8–10% | Brand-controlled display mode, private members-only outlet, markdown advisor, B2B lot portal, team roles, API, priority support |
| **Enterprise / franchise** | Custom contract | Custom | Fulfilled-by-Outlet NK, dedicated events, data exports, custom reports |

Three alternatives are worth testing against this. A **pure commission** model (no fees at all) is the easiest way to win the first 30 brands. A **pay-per-feature** model sells add-ons (sync, AI listing credits, sponsored placement) one by one. A **success fee on sell-through** charges more when a brand clears a higher share of a lot, which aligns Outlet NK with the brand's real goal. A sensible path is pure commission for launch brands for 3–6 months, then introduce tiers once the tools prove their value. The key brand metric should be **recovery rate** (net money received ÷ cost or RRP) compared with jobbers, stocklot buyers and destruction. No Egyptian recovery benchmark exists, so seller interviews must supply it.

## The defect card is the product, and "as is" still allows returns

Platforms that sell imperfect goods use **two separate things**: a short condition grade, and a specific list of flaws. eBay's "New with defects", renamed **"New with imperfections" for clothing in January 2025**, covers unworn items with scuffs, loose threads, missing buttons or wrong size tags, including factory seconds ([eBay condition IDs](https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html); [eBay Jan 2025](https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions)). Back Market uses four cosmetic grades and has a dedicated help flow when an order "didn't match the appearance grade" ([Back Market](https://help.backmarket.com/hc/en-us/articles/360010146460-My-order-didn-t-match-the-appearance-grade)), which shows that grade disputes are common enough to need their own process. Vinted tells sellers to **choose the lower condition when unsure** ([Vinted](https://www.vinted.com/help/50-choosing-item-condition)). For severity, factory quality control uses AQL: Critical (safety, AQL 0), Major (AQL 2.5) and Minor (AQL 4.0) ([V-Trust](https://www.v-trust.com/en/our-services/inspection-standards/defect-classification)).

**Proposed Outlet NK grading.** The condition grade has five values: New with tags, New with imperfections, Sample, Open-box/returned, and Pre-owned (later). Each defect is a structured row with type (stain or discoloration, hole or tear, missing or damaged button or trim, broken zip or hardware, open seam or stitching flaw, pilling, fading, print misalignment, wrong size tag, odour, packaging damage), location ("left cuff"), size in cm, severity (Minor or Major) and a **required close-up photo**. **Critical defects (safety issues, such as drawstrings on children's clothes) cannot be listed at all.** This taxonomy is our own design built from the sources above, not a published standard.

**The defect card on the product page** shows the grade badge with a one-line definition, the defect count, and each defect with an icon, an Arabic label, location, size and photo. Pins on the main image open each close-up. A "compare with the perfect item" toggle appears when the same SKU exists in new condition. Before adding to bag, the shopper ticks a separate box: "I have seen the 2 defects". Filters let shoppers choose "only minor defects" or "no stains". Photos of defects must never be AI-edited. No A/B evidence exists yet for pins or comparison views, so test them.

**The legal position.** In the UK, a defect that was "specifically drawn to the consumer's attention" before purchase cannot later be the basis of a quality claim ([Consumer Rights Act s.9](https://legislation.gov.uk/ukpga/2015/15/section/9)). The EU rule (Directive 2019/771 Art. 7(5)) is stricter: the buyer must be specifically informed **and expressly and separately accept** the deviation, so a line hidden in the terms or a pre-ticked box is not enough ([Unife](https://iris.unife.it/handle/11392/2497136)). For Egypt, Law 181/2018 is reported to give a **14-day right to return without a reason** if the item is in its original condition ([Al-Ahram Weekly](https://english.ahram.org.eg/NewsContent/50/0/409645/AlAhram-Weekly/0/INTERVIEW-Safeguarding-consumer-rights-in-Egypt.aspx); [UNESCWA](https://unescwa.org/sites/default/files/inline-files/ABLF-2023-consumer-CP-Egypt-english.pdf)). The 30-day defect period appears in a 2014 draft and in retailer policies but was **not verified against the final law** ([FTC 2014](https://www.ftc.gov/system/files/documents/public_events/316871/egyptamalehsan.pdf)). **No source confirmed whether Egypt removes the defect-return right for a disclosed defect.** This is a VERIFY BEFORE LAUNCH item for Egyptian counsel.

The safe default policy, which also matches spec §22, has three rules. A disclosed defect, shown with a photo and accepted with a separate tick, is not a reason for a defect return. **Any defect that was not disclosed, or is bigger than shown, is the seller's fault**: 30-day window, seller pays return shipping, and the seller's grade-accuracy score drops. And the **14-day change-of-mind return still applies to defective items**, so "as is" never means "no returns" online.

Trust needs controls on both sides. Sellers must upload one full photo plus one close-up per defect, and photos are checked for reuse with pHash. A computer-vision model flags visible defects the seller did not declare. Fabric-defect detection is a mature research field ([MDPI 2024](https://www.mdpi.com/2079-9292/13/18/3728)), but accuracy varies widely (one 2024 study reported only **74% for VGG-16** ([Wiserpub](https://ojs.wiserpub.com/index.php/RRCS/article/download/4156/2021/40975))), and lab tests use flat fabric, not garment photos. So AI should **assist and flag, never give a better grade**. Buyers' return claims are checked against the listing's defect photos, the courier's delivery photo and, for expensive items, an optional unboxing video. On price, open-box discounts in electronics run about 10–30% ([ConsumerAffairs](https://www.consumeraffairs.com/news/open-box-vs-refurb-vs-renewed-the-real-differences-when-buying-electronics-102425.html), UNVERIFIED), and the common "Grade B = 30–50% off" for fashion has **no source**. A defect item shows "X EGP vs Y EGP for the perfect version" only when §9 has verified the perfect item's price; otherwise it shows a plain price.

## "Black Friday every day" works only with freshness and real scarcity

The danger of a permanent sale is **deal fatigue**. Research consistently finds that frequent generic price cuts hurt brand equity and lower the price shoppers think is fair ([INFORMS via phys.org](https://phys.org/news/2008-12-frequent-price-threaten-quality-brands.amp); [CEPR](https://repec.cepr.org/repec/cpr/ceprdp/DP16947.pdf)), and that equal-value rewards protect the reference price better than price cuts ([ISCTE](https://repositorio-iul.iscte.pt/bitstream/10071/32986/1/Master_catia_vicente_sebastiao.pdf)). The legal risk is direct: the CPA chairman said in October 2026 that discounting an item whose price was raised before is deceptive, and that unapproved competitions will face immediate action ([Ahram Online](https://english.ahram.org.eg/News/581028.aspx)).

The winners build excitement from **new stock on a fixed rhythm**. Lounge by Zalando launches new campaigns daily at 7am ([Zalando](https://corporate.zalando.com/en/node/10813)). TJX "flows fresh merchandise into its stores regularly" to create urgency, and its comparable sales growth came from more customer visits ([TJX 10-K](https://www.sec.gov/Archives/edgar/data/109198/000010919825000010/tjx-20250201.htm)). Honest scarcity has working models: Amazon Lightning Deals show a real "% claimed" bar and one per customer ([ppc.land](https://ppc.land/lightning-deal/)), and Woot shows nothing new until midnight even if the deal sells out ([Wikipedia](https://en.wikipedia.com/wiki/Woot)). Loyalty for real actions beats ad-driven growth: Temu had more users, but SHEIN had a "significantly lower churn rate", possibly because of its loyalty game ([Sensor Tower](https://sensortower.com/blog/e-commerce-app-battle-temus-rising-star-challenged-by-sheins-loyalty-game)).

The Outlet NK deal engine therefore has five parts. A **daily drop at a fixed time** (for example 8pm Cairo) with genuinely new stock. A **published price ladder** for slow lots, where the schedule is public in advance and the reference comes from §9. **Real stock bars** and per-customer limits, never timers that reset. **Rewards instead of deeper cuts**: coins for photo reviews and fit feedback, free delivery, member early access. And a **theme calendar** across Ramadan, Eid al-Fitr, Eid al-Adha, back to school, summer, 11.11 and White Friday. The "Defect Deals" corner is itself a strong hook, because "honest imperfect" is a story no Egyptian competitor tells. Mystery boxes, spin games and group buys need CPA approval and a lottery-law check before launch.

## Web first, then apps: growth through search, WhatsApp and creators

Web first fits Egypt. Android is about **88–91% of Egyptian phones and iOS only 9–12%** ([StatCounter](https://gs.statcounter.com/os-market-share/mobile/egypt)), and a link opens on any phone without a download. Old but often-cited PWA results support the approach: AliExpress reported **+104% conversion for new users** and Flipkart Lite about **+70%** ([Prisync](https://prisync.com/blog/top-ecommerce-pwas-analyzed); [Medium](https://medium.com/progresshive/benefits-of-progressive-web-apps-forbes-flipkart-and-others-taking-the-high-road-7f7f6b22535c)). These figures are from 2016–17, secondary, and partly conflicting.

The web plan has four channels. **Search (SEO):** server-rendered, Arabic-first product, brand and category pages with permanent URLs; when a drop ends, keep the page and show similar items rather than a dead link. Brand events in "hidden discount" mode are login-only and not indexed. **WhatsApp:** a WhatsApp Channel for the daily drop (broadcast, no personal data), which launched in Egypt and MENA ([Amwal Al Ghad](https://en.amwalalghad.com/whatsapp-launches-channels-in-egypt/)), plus opt-in WhatsApp Business messages for price-drop and back-in-size alerts under the §24 consent rules. **Creators and TikTok:** a TikTok-commissioned study says **77% of MENA consumers discover products on TikTok** ([Arab News](https://www.arabnews.pk/node/2620094), commissioned, so treat with care); route deal-hunter creators through the referral and affiliate programme (§15.4). TikTok Shop availability in Egypt is unverified. **Brands as distribution:** each brand shares its own Outlet NK store link with its followers, which costs Outlet NK nothing. The apps come next, built with Expo for both platforms, adding push alerts, saved sizes and faster checkout for repeat buyers.

## AI across the chain: copilot for brands, assistant for shoppers, guard for trust

AI is most proven where it saves brand time. Amazon reports that **over 900,000 sellers** used its AI listing tools and accepted the text with little or no editing about **90% of the time** ([TechCrunch](https://techcrunch.com/2025/05/08/amazons-newest-ai-tool-is-designed-to-enhance-product-listings)), and Zalando cut image production from 6–8 weeks to 3–4 days ([The Star/Reuters](https://www.thestar.com.my/tech/tech-news/2025/05/07/zalando-uses-ai-to-speed-up-marketing-campaigns-cut-costs)). Both are company-reported. Arabic needs care: Egyptian dialect and Franco-Arabic remain harder than standard Arabic, and the open model Nile-Chat beats general open models on Egyptian benchmarks ([ACL Anthology](https://aclanthology.org/2025.arabicnlp-main.25)). A self-hosted model in the approved region would also reduce PDPL cross-border transfer problems.

| Stage | AI feature | Rule |
|---|---|---|
| Brand onboarding | Document reading (commercial register, tax card), counterfeit checks with pHash across stores | Human review for rejections |
| Listing | Photo → attributes, Arabic and English titles, background clean-up, **defect hotspot suggestions** | Brand approves; defect photos never edited; AI model images labelled |
| Pricing | Markdown advisor and price-ladder suggestions | Advice only; % off still needs §9 |
| Buyer | Arabic/Franco search, visual "similar items", size advice, stylist within budget | Product IDs only from catalog; prices never written by AI |
| Delivery | COD risk score (rules plus a model) using courier outcomes | Start with rules; Egyptian RTO data is unverified |
| Returns | Compare returned item with listing defect photos; grade-accuracy score per seller | AI flags; people decide disputes |
| Support and VoC | Suggested replies, weekly summaries without personal data | Human sends |

Virtual try-on is mainstream elsewhere (Google, US 2025; UK and India December 2025) but **not available in Egypt**, and its return-reduction claims are vendor marketing ([FashionUnited](https://fashionunited.uk/news/fashion/google-launches-virtual-apparel-try-on-tool-in-the-uk-and-india/2025120385179)). Keep it for Phase 3 and test it with an A/B test on returns.

## The end-to-end journey from brand to payout

The full chain has six steps, and each step needs a clear owner, state and evidence trail.

| Step | What happens | Key controls |
|---|---|---|
| 1. Brand onboarding | Sign up, choose tier, KYC (commercial register, tax card, signatory ID 21+, IBAN name match, brand authorization), connect Shopify/Woo or upload CSV | KYC states (§19); authorization blocks "export surplus" counterfeits |
| 2. Listing | AI drafts the listing; brand picks condition grade and adds defects with photos; size chart; choose display mode (public % off, members only, or hidden) | Critical defects blocked; CV flags undeclared defects; §9 decides any % off |
| 3. Buyer | Browse web, filter by grade and defect type, read the defect card, tick "I have seen the defects", pay once for many stores | Separate acknowledgement stored with the order line |
| 4. Delivery | Brand packs, courier label (Bosta first), tracking, proof of delivery with photo | COD caps and risk checks; delivery date starts the return clock |
| 5. Returns | 14-day change of mind for all items; 30-day seller-fault return for undisclosed defects; exchange-first for size; inspection within 48h; dispute to a human | Grade-mismatch return lowers seller score; disputes reviewed in 5 business days |
| 6. Payout | Ledger records seller payable minus commission and fees; payout after the return window closes; refunds after payout are netted later | Double-entry ledger, weekly payouts, reconciliation |

A seventh, optional lane takes the worst defects and leftover lots to a **B2B stocklot portal** for resellers. B-Stock claims auction lots recover more than fixed-price sales, for example **40% more for half-truckload lots** ([B-Stock](https://bstock.com/blog/doing-overstock-auctions-the-b-stock-way)), but this is vendor marketing.

## A web-first roadmap in four phases

| Phase | Time (estimate) | Main deliverables |
|---|---|---|
| **0. Foundations** | 4–6 weeks | Monorepo, auth, ledger, outbox, consent, ADRs (add: web-first, seller tiers, defect grading), defect taxonomy, Egyptian counsel opinion on "as is" |
| **1. Web MVP** | 12–16 weeks | Shopper PWA (Arabic-first, SEO), Seller Center with Start tier, defect card, §9 price integrity v1, multi-store checkout (cards, Vodafone Cash, InstaPay, capped COD), Bosta, returns with grade mismatch, payouts, Admin, WhatsApp Channel, daily drop |
| **2. Apps and SaaS tiers** | 10–12 weeks | Android and iOS apps (Expo, same release), Growth and Pro tiers, AI listing, sync, analytics, brand display modes, rewards, BNPL partner, Plus price test |
| **3. Scale** | ongoing | Markdown advisor, B2B lot portal, Fulfilled-by-Outlet NK hub with inspection, returns-resale lane, stylist, visual search, try-on test |

Launch with about 30 brands connected at least 30 days early, so the price history exists for §9.

## Business model and the numbers to watch

Revenue comes from **commission** (the main source), **SaaS tier fees**, **sponsored listings**, **fulfilment and inspection fees**, **B2B lot fees** and, later, **shopper Plus**. Costs per order are payment fees, shipping subsidy, COD refusals and returns. The earlier report's planning placeholders still apply and are all unverified: card fees about 2.5–3%, returns 25% (base) to 35% (stress), COD refusals 15% to 30%. Defective items may have different return rates, but **no public data exists**, so measure it from day one.

The metrics to track are: brand recovery rate and the share of brands running a second event within 90 days; free-to-paid tier conversion; share of listings with a verified or launch-price label; **grade-mismatch return rate per seller** (target below 2%, our proposal); return rate for defect items versus new items; daily-drop return visits and 90-day repeat rate; COD refusal rate; contribution margin per order; and CPA complaints (target zero). These targets are proposals, not benchmarks.

## Risks, ranked

The biggest risk is **supply**: brands may refuse because of channel conflict or fear of showing deep discounts. Otrium closed its US operations, a warning about off-price economics ([Glossy](https://www.glossy.co/fashion/luxury/luxury-briefing-why-off-price-fashion-e-tailer-otrium-closed-its-u-s-operations)). The second is **legal uncertainty on "as is"** sales and the exact Law 181/2018 text. The third is **trust failure on defects**: one viral "they hid the stain" story can damage the brand, so grade accuracy must be enforced strictly. The fourth is **deal fatigue and fake-discount enforcement** under the CPA's new stance. The fifth is **COD and returns cost**, since defect items and cheap items leave small margins. The sixth is **counterfeit and grey goods** entering as "export surplus". The seventh is **SaaS pricing that is too high** for a market where Wuilt is free. The eighth is a **strong entrant** (BFL backed by TJX, or Noon/Amazon adding an outlet tab). Data protection also applies now: the PDPL grace period ended around 1 November 2026.

## Decisions only the owner can make

| # | Decision | Options |
|---|---|---|
| 1 | Seller pricing model | Pure commission at launch; free + paid tiers; per-feature add-ons; success fee |
| 2 | Commission levels per tier | Must stay at or below Noon's 15% to win supply |
| 3 | "As is" policy | Safe default above (disclosed defects not a defect reason, 14-day change of mind kept), after Egyptian counsel review |
| 4 | Which conditions to allow at launch | New with tags, imperfections, samples, open-box; pre-owned later or never |
| 5 | Brand display mode | Allow brands to hide % off or show it to members only |
| 6 | Platform order | Web first confirmed; Android and iOS together in Phase 2 |
| 7 | Daily drop time and theme calendar | Fixed time and the yearly themes |
| 8 | B2B stocklot channel | Build in Phase 3 or partner |
| 9 | Games, mystery boxes, group buy | Only after CPA approval and lottery-law advice |
| 10 | Plus price and timing | Test lower prices (EGP 59–99/month) before Phase 2 launch |

New verify-register rows: Law 181/2018 Arts. 17–18 and Decree 822/2019 on disclosed defects; CPA rules on games and the EGP 2m fine; seller-tier billing VAT; Wuilt, Salla and Shopify Egypt prices; and Egyptian stocklot recovery rates.

## Conclusion

The new idea is better than the old plan in one important way: it gives Outlet NK something no competitor in Egypt offers, **honest selling of imperfect goods**. Verified prices answer "is the discount real?". The defect card answers "what exactly is wrong with it?". Together they turn a cheap-goods site into a trust brand, and they make the CPA's crackdown an advantage instead of a threat. The SaaS layer should follow the same logic: brands pay most when they sell most, and the tools exist to help them clear stock faster with less risk to their image.

The biggest unknowns are not technical. They are whether Egyptian brands will list defects publicly, how much they recover compared with stocklot buyers, and what Egyptian law says about disclosed defects. About 30 brand interviews and one written opinion from Egyptian counsel will answer these faster than more desk research, and both should happen before Phase 1 begins.
