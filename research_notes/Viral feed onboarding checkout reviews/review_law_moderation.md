# Review rewards (10 points per approved review): law, platform rules, safe design, photo moderation

Scope note: 14 tool calls. Several primary texts were NOT retrievable (eCFR/Federal Register blocked by redirect, Egyptian law PDF is image-only, CMA208 URL 404, Perspective docs failed). Where only secondary sources were read, that is flagged. Nothing here is legal advice.

## 1. Egypt: Consumer Protection Law 181/2018, Advertising Law 206/2017, review/endorsement rules

### Takeaway
No source found that bans rewarding reviews in Egypt, and none that specifically regulates reviews or incentivised endorsements. The relevant hooks are the general misleading-statement prohibition and the Arabic requirement, plus the spec's own rules. Article numbers could not be confirmed.

### Cited Findings
- A Chambers guide says Law 181/2018 prohibits any statement that may mislead consumers by exaggeration, omission, ambiguity or implication (secondary summary, not statutory text) — [Chambers Advertising & Marketing 2025, Egypt](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt)
- Law 181/2018 defines "advertiser" to include anyone advertising directly or through others via any media including digital, and extends to the requester, intermediary, agency and media outlet; obligations of supplier and advertiser sit in a dedicated part — [Andersen English translation (PDF)](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf) (as reported by search summary; PDF text layer unreadable)
- Consumers have a private right of action under the Consumer Protection Law and Civil Code — [Chambers](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt)
- Law 206/2017 on regulating advertising is described as setting licensing and general advertising standards, with the Supreme Council for Media Regulation overseeing print, broadcast and digital advertising, able to fine, suspend or revoke licences (single secondary source) — [Chambers trends](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt/trends-and-developments)
- Arabic is mandatory for ads, product data, invoices and contracts incl. electronic, per the spec's cited summary — [Mondaq](https://www.mondaq.com/Article/820956/New-Egyptian-Consumer-Protection-Law)
- Law 175/2018 (anti-cyber and IT crimes) in force 15 Aug 2018; NTRA may block content/sites found to commit a cybercrime; criticised for vague offences — [Digital Policy Alert](https://digitalpolicyalert.org/event/27852-law-no-175-of-2018-on-anti-cyber-and-information-technology-crimes-including-content-moderation-regulation-entered-into-force); [Amnesty (2018, drafts)](https://www.amnesty.org/en/latest/news/2018/07/egypt-proposed-laws-an-assault-on-online-freedoms/)
- Repo spec: coins are given for any honest review, not positive ones (section 27); coins for photo reviews with size info (15.5); verified-purchase-only reviews; seller cannot review itself — /Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md

### Inferences
- Because EG has no found review-specific rule, the safe approach is to meet the strictest of FTC/UK/EU (sections 2) and treat that as the CPL "misleading" defence. (Inference.)
- A review displayed as a consumer opinion while hidden-incentivised could be argued misleading by omission under the general prohibition; disclosure of the programme mitigates. (Inference.)
- Reviews and seller replies are Arabic-authoritative content: UI, review guidelines, authenticity page must exist in Arabic; user reviews may be in any language but need Arabic display/translation policy (counsel). (Inference from Arabic rule.)
- Coin VAT/expiry already tracked (VR-06, VR-B4-04, VR-P2-04, VR-RF-07); points redeemable for vouchers inherit those.

### Gaps
- Article numbers (misleading ads, advertiser duties, Arabic) NOT confirmed: Andersen PDF has no extractable text; Arabic gazette/official database not reached. Often cited as Arts. 6-7 and 9 in secondary commentary but unverified here; do not cite numbers until counsel confirms.
- No Consumer Protection Agency (CPA) guidance on reviews/influencers found; Law 206/2017 text and scope for in-app reviews not found.
- Whether Law 206/2017 licensing reaches a marketplace's user reviews: unknown, counsel.

## 2. FTC Part 465, Endorsement Guides, UK DMCC Act, EU Omnibus/UCPD

### Takeaway
All three regimes allow incentives only if they are not tied to sentiment, and UK/EU/FTC staff expect disclosure of the incentive. Review suppression and fake reviews are banned; platforms in UK/EU must take reasonable steps and explain verification.

### Cited Findings
- FTC (staff Q&A on 16 CFR Part 465): businesses may offer incentives for reviews unless they expressly or implicitly require positive or negative sentiment; an example violating implication: "Tell us how much you loved your visit... and get a $5 coupon"; expecting positivity alone is not a violation — [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- Same: a generalized email asking all purchasers for reviews does not violate; answer unchanged if every recipient who posts is offered an incentive; undisclosed incentives may still raise FTC Act issues — [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- FTC: pure review hosts not liable for fake reviews they did not write or buy and have no duty to screen; featuring reviews in marketing turns them into testimonials and loses the exemption — [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- FTC review suppression (465.7): no intimidation or unfounded legal threats; sorting by helpfulness/rating is not suppression; may exclude reviews on grounds (wrong business, customer-service-only) if applied regardless of sentiment; paying to remove negatives may be unfair under FTC Act — [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers)
- FTC insider reviews (465.5) need clear, conspicuous, unavoidable disclosure; disclosure in first line counts — same Q&A. Rule section headings 465.1-465.8 and source 89 FR 68077 (22 Aug 2024) — [Cornell LII TOC](https://www.law.cornell.edu/cfr/text/16/part-465)
- UK: DMCC Act Sched. 20 para 13 bans fake reviews and undisclosed incentivised reviews as a blacklisted practice (no need to prove effect on decisions); facilitating services also banned; penalties up to 10% global turnover; CMA guidance April 2025 (secondary summaries) — [CMS](https://cms.law/en/gbr/legal-updates/no-more-faux-five-stars-the-dmcc-act-bans-fake-reviews); [Business Companion](https://www.businesscompanion.info/en/quick-guides/digital/reviews-and-endorsements)
- UK: disclosure of incentive required even if review is genuine; platforms expected to take reasonable and proportionate steps, publish a policy, and give no cherry-picking of positives or suppression of negatives (law firm summaries, CMA208 not read directly) — [Reed Smith](https://www.reedsmith.com/articles/the-truth-about-fake-reviews-what-businesses-need-to-know/); [Slaughter and May](https://thelens.slaughterandmay.com/post/102l6s8/cma-clarifies-expectations-on-consumer-reviews-but-uncertainties-remain)
- UK: CMA reviewed 100+ businesses, 54 possibly non-compliant; 14 investigations by March 2026 (secondary) — [Reed Smith](https://www.reedsmith.com/articles/the-truth-about-fake-reviews-what-businesses-need-to-know/)
- EU: UCPD Annex I point 23b bans claiming reviews come from real users without reasonable and proportionate checks; Art. 7(6) makes information on whether/how reviews are verified material; 23c bans submitting/commissioning false reviews (secondary; no official guidance on verification methods found) — [TRIS notification](https://technical-regulation-information-system.ec.europa.eu/cs/notification/26584/message/110913/EN); [Make Influence](https://www.makeinfluence.com/en/academy/fake-and-manipulated-reviews-what-the-eu-omnibus-directive-bans)

### Inferences
- A flat 10 points for any approved review, offered to all verified purchasers regardless of rating, fits the FTC "not conditioned on sentiment" line; the approval step must be sentiment-neutral (criteria on authenticity/safety only), otherwise approval becomes a gate that implicitly conditions reward. (Inference.)
- Because UK says disclose even honest incentivised reviews, show a per-review marker ("Reviewer received points") or at minimum a page-level notice; the lowest-risk option is both. (Inference; UK is the stricter read.)
- Egypt launch makes FTC/UK/EU non-binding; they are benchmarks and matter if GCC/EU/UK shoppers or later expansion.

### Gaps
- Full 465.x text and 16 CFR Part 255 text not retrieved (federalregister/eCFR blocked); Endorsement Guides claims not sourced here.
- CMA208 primary text (404); no official EU Commission guidance on verification methods; DMCC subsection wording unverified.

## 3. Platform policies

### Takeaway
Apple's 1.2 UGC requirements apply to in-app reviews; Apple's incentive/review-manipulation rules concern App Store ratings of the app, not product reviews. Amazon and Google ban most review incentives, but those govern their own platforms, not a first-party marketplace's own reviews.

### Cited Findings
- Apple 1.2: apps with UGC must include filtering of objectionable material, a report mechanism with timely responses, ability to block abusive users, and published contact information — [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- Apple 3.2.2(x): apps may not force users to rate/review the app to access functionality, but "may otherwise incentivize users to take specific actions within apps" — same
- Apple 5.6.1: custom prompts for App Store reviews disallowed (use the provided API); 5.6.3: manipulating reviews/charts/referrals of your app not permitted; Section 3 intro warns of expulsion for paid/incentivised/fake feedback for ranking — same
- Apple 3.1.1: unlocking features/in-game currencies requires IAP; points here unlock commerce discounts (physical goods), consistent with 3.1.5(a) per spec B7 — same; repo spec B7
- Google Play UGC: users accept terms defining objectionable content, ongoing moderation, in-app reporting and blocking of content and users — [Google Play UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937)
- Google Maps/merchant: incentives such as payment, discounts, free goods for posting a review are not allowed; also bans incentives to remove/modify negatives; content from multiple accounts by one person is fake engagement — [Google contribution policy](https://support.google.com/contributionpolicy/answer/7400114?hl=en); [Search Engine Land](https://searchengineland.com/google-prohibits-incentivizing-customers-to-remove-or-modify-negative-reviews-387874)
- Amazon: since Oct 2016 incentivised reviews barred except via Vine, where Amazon picks reviewers, does not incentivise positive ratings, and does not require a review (secondary; current text not read) — [TechCrunch](https://techcrunch.com/2016/10/03/amazon-bans-incentivized-reviews-tied-to-free-or-discounted-products/)

### Inferences
- Do not prompt shoppers to leave App Store reviews with points (Apple 5.6.1/3.x). Keep points strictly for product/store reviews. Do not send Google Maps/Play-style review requests with rewards. (Inference.)
- Google Maps and Amazon rules apply on their platforms; if Z-OUTLET ever syndicates reviews or asks for Google reviews, rewards would breach them.
- Disclosure wording (proposed, AR primary): AR "يحصل المراجعون على نقاط مقابل أي مراجعة صادقة، سواء كان تقييمها إيجابيا أو سلبيا" / EN "Reviewers receive 10 points for any honest, approved review, whatever the rating." Show on review form, on each review ("Verified purchase · Reviewer received points"), and on authenticity page. (Proposal.)

### Gaps
- Apple 3.1.1 vs points redeemable for "other benefits": benefits must stay physical-commerce perks; any digital/app-feature benefit triggers IAP, counsel/App Review (links VR-23).
- Amazon current guideline text and Google Play policy on incentivised app reviews not read.

## 4. Safe design rules (each with basis)

### Takeaway
Reward all honest, verified, approved reviews equally; keep moderation sentiment-blind; disclose; never suppress; claw back on return.

### Cited Findings (rule: basis)
- Reward for any honest review regardless of rating: FTC Q&A (not conditioned on sentiment) and CMA/EU summaries above; repo spec section 27.
- Verified purchasers only, and label "Verified purchase": EU 23b requires reasonable checks before claiming reviews are from real purchasers — [TRIS](https://technical-regulation-information-system.ec.europa.eu/cs/notification/26584/message/110913/EN); spec section 27.
- Seller cannot review itself; insiders disclose: FTC 465.5 — [FTC Q&A](https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers); spec section 27.
- Never suppress negatives, allow seller reply only, no legal threats: FTC 465.7; UK cherry-picking/suppression — FTC Q&A, [Reed Smith](https://www.reedsmith.com/articles/the-truth-about-fake-reviews-what-businesses-need-to-know/).
- Sellers may not offer extra incentives off-platform (esp. for positive/removal): Google bars incentives to remove/modify negatives — [Search Engine Land](https://searchengineland.com/google-prohibits-incentivizing-customers-to-remove-or-modify-negative-reviews-387874); FTC says paying to remove may be unfair.
- Publish a review policy / how reviews verified: EU Art. 7(6) (secondary), UK expectation of a published policy — [Reed Smith](https://www.reedsmith.com/articles/the-truth-about-fake-reviews-what-businesses-need-to-know/).

### Inferences (design proposals, not legal requirements)
- Grant points after approval; for fashion, grant at return-window close (14/30 days from delivered_at) with clawback on return, per spec 15.5 clawback; show "pending" state. Risk: clawback on return must not look like punishment for negative content, so tie it only to the order, never to rating.
- No edit after approval; edit triggers re-moderation and no extra points; one rewarded review per order line.
- Caps: per-account/day cap (suggest 3/day, 30 days minimum account age or one delivered order) and monthly cap; configurable, audited.
- Duplicate/template-text detection (normalised text hash, shingling similarity), cross-account image reuse (pHash), device/graph checks; rejection reason categories exclude sentiment; log decision reasons for audit and sampling to prove sentiment-neutrality (rating distribution of approved vs submitted should match; alert on drift).
- Approval criteria published; rejection appeal path.
- Points redeemable only on commerce perks (vouchers, free delivery); not cash; align with closed-loop credit rules (spec B2) and open rows VR-P2-04, VR-RF-07.
- Review-authenticity statement page (AR/EN): who can review, how verified, rewards exist, moderation criteria, no suppression, seller reply, how to report.

### Gaps
- No authoritative source for the numeric caps; tune with fraud data.

## 5. Photo and text moderation pipeline

### Takeaway
Spec and Apple/Google rules require filtering, reporting, blocking and contact info; specific vendor capabilities (Rekognition, Vision SafeSearch, Perspective Arabic) could NOT be verified in this pass.

### Cited Findings
- Apple 1.2 and Google Play UGC requirements as in section 3 (filter, report with timely response, block, contact info, ongoing moderation, terms defining objectionable content) — [Apple](https://developer.apple.com/app-store/review/guidelines/); [Google Play](https://support.google.com/googleplay/android-developer/answer/9876937)
- Spec: upload pipeline with type sniff, size cap, AV scan, EXIF/GPS strip, re-encode, private buckets, signed URLs <= 15 min (T5); pHash across stores for counterfeit (27); image classifier + AR/EN toxicity for photo reviews (16); photo reviews verified-purchase and moderated; Egyptian and cross-border limits: no P2/P3 to external LLM/ML without consent and licence (B1, T12); LLM rules LLM01-LLM10 (T12, 11) — /Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md
- Egypt: NTRA content blocking under Law 175/2018 and vague offences criticism (section 1 sources).
- Perspective API attribute/language page failed to load; Arabic support unverified.

### Inferences (proposed pipeline, vendor claims unverified)
1. Upload: signed URL to quarantine bucket, size and type caps, AV scan, EXIF/GPS strip and re-encode before any model sees it.
2. Automated: nudity/violence classifier (cloud moderation API or open model; choose after residency ADR-0002 since images may include faces/addresses = P2), Arabic+English toxicity (cloud API or open Arabic model; evaluate on Egyptian-dialect golden set), OCR on images for phone numbers, addresses, courier labels with redaction or reject; face detection with blur or reject when bystanders; license plates.
3. Duplicates: pHash/dHash within and across accounts; web/stock reuse via reverse image search is costly, so run only on photo reviews that would earn points and score risk (cost unverified).
4. Human queue for borderline/reports; proposed SLA 24h for reports of illegal/abusive content, 48h general; appeals with second reviewer, 5 business days (matches spec dispute SLA, section 22).
5. Reporting button on every review, block/mute for abusive users, contact email published (Apple 1.2).
6. Hold content as pending until moderated; points only after approval.
7. LLM review summaries: reviews are untrusted data in delimited fields, no tools, schema-constrained output, no PII or raw photos sent, cite counts from verified data, label "AI summary", per-feature cost cap, eval set, aggregate must not exclude negatives (LLM01/02/05/09/10; spec T12). Summaries must reflect the actual rating distribution (UK/FTC cherry-picking risk).

### Gaps
- Not verified: AWS Rekognition Moderation, Google Vision SafeSearch, Perspective Arabic support/deprecation, open Arabic toxicity models, reverse-image-search pricing, OCR redaction tooling. Needs a follow-up search before choosing vendors.
- Egyptian content-law limits on user speech (defamation, public morals) need counsel; sources found are only advocacy/overview.

## Counsel-needed items and proposed VERIFY rows
- VR-REV-01 (Legal): Confirm Law 181/2018 article numbers for misleading statements, advertiser duties and Arabic requirement; whether a points-for-review programme with disclosure complies.
- VR-REV-02 (Legal): Law 206/2017 applicability to marketplace reviews/seller replies; CPA guidance on endorsements.
- VR-REV-03 (Legal/Product): Whether per-review incentive disclosure is required or page-level suffices (UK vs FTC vs Egypt); final AR/EN wording.
- VR-REV-04 (Tax/Legal): Points for reviews as coins: VAT and expiry (extends VR-B4-04, VR-P2-04, VR-RF-07).
- VR-REV-05 (Product): Apple review that review points redeemable for commerce perks only avoid 3.1.1; no prompts for App Store reviews (links VR-23).
- VR-REV-06 (Legal/DPO): PDPL treatment of review photos (faces, labels), retention, whether moderation vendors count as cross-border transfer (links ADR-0002, VR row 2).
- VR-REV-07 (Legal): Egyptian user-content liability, takedown duties and defamation exposure for the platform.
- VR-REV-08 (Security/ML): Vendor capability and Arabic accuracy for moderation, measured on a labelled Egyptian set.
