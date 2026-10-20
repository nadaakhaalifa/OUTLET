# UX and honest copy for a "Popular near you" / "Trending stores" home module

Scope note: about 13 tool calls. Web search was US-only and returned few primary sources. Competitor layout facts and NN/g or Baymard findings were largely NOT retrievable; they are listed under Gaps rather than guessed.

## 1. How marketplaces present popular / trending / recommended store modules

### Takeaway
Primary evidence on competitor layouts could not be retrieved (Baymard pages are paywalled, NN/g articles did not surface). The only sourced pattern is that food-delivery homepages group stores into themed horizontal card carousels. Treat layout specifics as inference for the team to verify with screenshots.

### Cited Findings
- Uber Eats' homepage groups restaurants into themed categories, each a swipeable card carousel; each card shows image, name, cuisine and estimated delivery time (design review, not first-party) — [DesignRush](https://www.designrush.com/best-designs/apps/ubereats)
- Baymard keeps screenshot benchmarks of Uber Eats and DoorDash mobile homepages, but the page text I fetched contained no findings (paywalled or image-only) — [Baymard Uber Eats](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/homepage/17954-uber-eats), [Baymard DoorDash](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/homepage/18119-doordash)
- EU DSA Art. 26 requires each ad to be identifiable as an ad, say on whose behalf and who paid, with main targeting parameters accessible from the ad itself; this is the closest legal template for "Sponsored" marking — [arXiv 2503.05764](https://arxiv.org/pdf/2503.05764), [Presencis Art. 27](https://presencis.com/regulations/dsa/article-27/)

### Inferences
- Proposed (not sourced): one horizontal rail, 6 to 10 store cards, plus a "see all" row; card = cover, logo, name, one honest fact line (distance or delivery estimate, verified discount only when price-integrity allows). A flat list with hairlines on "see all" fits ux-principles rule 5 (no card-in-card).
- Any sponsored store must carry a visible "Sponsored" label and be excluded from the "popular" ranking, never blended silently (spec section 4 caps sponsored at 2 in top 10).
- One primary action per screen (rule 1): the rail is secondary content; each card has a single tap target (open store), follow is a small secondary control.

### Gaps
- No verified details for Talabat, Noon, Amazon, Etsy, Zalando, Instacart, Shopee or Instagram Shop (card contents, counts, labels, sponsored marking). Needs manual screenshot capture; anything from screenshots must be marked "inferred from screenshot".
- NN/g and Baymard guidance on rail length, carousels and recommendation labels was not retrieved.

## 2. Honest social proof, legal and regulator guidance

### Takeaway
Regulators treat popularity counts as "urgency claims" and judge them on truth and freshness window. Egypt's law broadly bans misleading statements incl. by omission or implication. Design rule: only show a claim computed from real events, with a stated window and a minimum threshold.

### Cited Findings
- UK CMA treats any scarcity, popularity, "act fast" or time-limited claim as an urgency claim, e.g. "Only 7 left", "14 sold in the last 24 hours" — [GOV.UK CMA press release](https://www.gov.uk/government/news/shoppers-urged-to-call-out-online-rip-offs-as-cma-unveils-red-lines)
- Per law-firm summaries of the CMA letter: "now" figures based on the past hour, or "24 hours" figures drawn from an earlier window, are likely misleading; popularity claims urging quick action are likely misleading if stock is plentiful — [Hogan Lovells](https://hlc.com/en/publications/online-claims-that-put-unfair-pressure-on-consumers-new-uk-guidance-on-what-to-avoid), [Shoosmiths](https://www.shoosmiths.com/insights/comment/consumer-watchdog-ramps-up-action-against-online-rip-offs) (secondary; I did not read the CMA letter itself)
- FTC Consumer Reviews and Testimonials rule (16 CFR Part 465, effective 21 Oct 2024) bans fake reviews and buying or selling fake social media influence indicators such as bot followers, where the buyer knew or should have known — [Federal Register](https://www.govinfo.gov/content/pkg/FR-2024-08-22/html/2024-18519.htm), [Consumer Finance Monitor](https://www.consumerfinancemonitor.com/2024/08/20/ftc-issues-final-rule-to-fight-fake-product-reviews/)
- Egypt CPL 181/2018 defines a deceptive practice as any act or omission by a producer or advertiser creating a false or misleading impression; "advertiser" includes digital media; Art. 2 gives the consumer the right to correct information — [Law text (Andersen PDF)](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf)
- Per Chambers commentary, Egyptian law bars statements that mislead by exaggeration, omission, ambiguity or implication; remedies include penalties, corrections and takedown, and liability can reach platforms that ignore regulator warnings — [Chambers Egypt](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt)
- A reported CPA fine ceiling of EGP 2m (single news report, unverified) — [Egypt Independent](https://www.egyptindependent.com/?p=2636603)
- Cornell music study: social explanations changed likelihood of trying items but correlated little with later ratings, so social proof persuades without improving fit — [Sharma and Cosley](https://bebop.berkeley.edu/papers/MusicCHI_RSFinal.pdf)

### Inferences
- Proposed rules: (a) claim computed server-side from real orders/follows in a named window ("this week", rolling 7 days, recomputed at least daily, never "now" unless data is under ~1 min old); (b) threshold before any count, e.g. at least 20 distinct buyers and at least 5 distinct districts-or-devices to resist one-buyer gaming (values are proposals, to be tuned and recorded in an ADR); (c) round down to a floor ("50+", "١٠٠+"); (d) no "selling fast" copy unless stock is genuinely low; (e) no countdowns. Consistent with spec sections 16 and 18 and ux-principles rule 12.
- Rank by engagement but exclude self-purchases, bot/duplicate devices, refunded orders and cancelled orders from the count, so the ranking is not a "fake indicator".
- Need counsel confirmation of the exact CPL article numbers (register as VERIFY row).

### Gaps
- Exact CPL article number for misleading advertising not confirmed. Egypt Consumer Protection Agency guidance on social-proof claims specifically: not found.
- NN/g social-proof article summary only seen as a snippet ("designers can represent the crowd's actions"), full text not read — [NN/g topic](https://www.nngroup.com/topic/persuasive-design/?page=3). Baymard social-proof guidance not found.
- EU/UK CMA guidance on reviews specifically (beyond the urgency red lines) not read.

## 3. Cohort statement design, explanations and user control

### Takeaway
Use neutral location wording ("Popular in Sheikh Zayed") by default. Demographic cohort claims ("with women in ...") add stereotyping and small-cohort exposure risk with little benefit; avoid them. Offer a short "why am I seeing this" and a reset control.

### Cited Findings
- Surveys of explainable recommenders list transparency, trust, scrutability, persuasiveness and satisfaction as separate explanation goals; scrutability (letting users correct the system) is distinct from persuasion — [Jannach et al. chapter](https://web-ainf.aau.at/pub/jannach/files/BOOK_CHAPTER_PERSONALIZED_HCI_2019.pdf)
- A 2025 qualitative study of Facebook users found explanations affect perceived transparency, trust and understandability; participants want concise, non-technical explanations and control over information flow — [arXiv 2508.16610](https://arxiv.org/abs/2508.16610v1)
- A 2017 group-recommendation study reports explanations raised intent to follow recommendations and perceived trust, but notes explanations must be tactful about personal relationships (single study) — [UWL repository](https://repository.uwl.ac.uk/3095/1/1-s2%200-S095741741730060X-main.pdf)
- Ngo, Kunkel and Ziegler (UMAP 2020) studied users' mental models of transparent, controllable recommenders (abstract only; findings not read) — [UMAP 2020 PDF](https://interactivesystems.info/system/pdfs/958/original/UMAP-20-Exploring.pdf?1597843041)
- DSA Art. 27: platforms must disclose main recommender parameters and, where options exist, give a functionality to modify them that is easy to reach from where content is ranked — [Presencis Art. 27](https://presencis.com/regulations/dsa/article-27/) (summary flagged as possibly overstating a non-profiling-option duty that likely applies only to very large platforms)

### Inferences
- Wording ladder, safest to riskiest: "Popular in {district}" (location chosen by user) > "Popular with shoppers like you" (vague; needs a "why" sheet explaining it means similar browsing/orders, not identity) > demographic phrasing (avoid). If the optional "shop for" preference (e.g. women, men, kids) is used, word it as the shopper's own choice: "Because you chose Women's" rather than inferring gender.
- Small-cohort rule: do not show a cohort-based claim if the cohort is under k (propose k at least 50, matching the spec's seller-analytics k-anonymity) ; fall back one geographic level.
- Controls: "Why this?" bottom sheet (one line: location + window + preference), "Not interested" per store (hides it, feeds a negative signal), "Reset personalisation" in Privacy Center, and a personalisation-off mode that uses non-personalised ranking (spec section 13).
- Do not use budget data for this module (spec section 12 bans it from ranking/targeting).

### Gaps
- No Egypt-specific research on stereotyping risk. Full text of the Ngo et al. and Jannach papers not read, so no quantitative effect sizes. NN/g and Baymard "explanations for recommendations" guidance not retrieved.

## 4. Thin-data fallback ladder and states

### Takeaway
Pick the narrowest geography that meets the threshold, label it truthfully, and fall back automatically. No manual curation as the primary driver.

### Cited Findings
- None directly sourced; the ladder follows the project spec (section 13: personalisation off gives popularity plus freshness ranking; section 16: truthful social proof only above a threshold) — [master prompt](/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md)

### Inferences
- Ladder: district (enough stores and orders in window) > governorate ("Popular in Giza") > country ("Popular in Egypt") > non-personalised default (popularity plus freshness plus store health, labelled "New and active stores", with no popularity claim). The label always names the level actually used; never say "near you" when showing country-wide data.
- Below the claim threshold show stores without any count, only factual card fields (delivery area, verified discount if any).
- Loading: skeleton cards with fixed height, no spinner-only. Empty (no eligible stores): honest EmptyState ("No stores deliver to this area yet") with change-location action. Error: ErrorState with retry; hide the module rather than show stale ranking older than the freshness window. Offline: show cached module with "last updated" time. (Maps to ux-principles rule 7.)

### Gaps
- Threshold values and minimum store counts per level need data from the pilot; none exist yet.

## 5. Arabic-first copy and RTL

### Takeaway
Arabic needs all six CLDR plural categories; store keys by category and let the runtime pick. Rails mirror in RTL (first card at the right, scroll starts from the right).

### Cited Findings
- CLDR Arabic cardinals: zero (n=0), one (1), two (2), few (n%100 in 3..10), many (n%100 in 11..99), other (e.g. 100 to 102); `Intl.PluralRules("ar")` returns these categories — [CLDR plural chart](https://www.unicode.org/cldr/charts/46/supplemental/language_plural_rules.html), [Plural rules spec page](https://www.specification.website/spec/i18n/plural-rules/)

### Inferences
Proposed strings (need native-speaker review; sentence case, plain words, no flags/emoji):
- Section title: AR "الأكثر طلبًا في {district}" / EN "Popular in {district}". Fallbacks: "الأكثر طلبًا في {governorate}", "الأكثر طلبًا في مصر" / "Popular in Egypt".
- Window label: AR "هذا الأسبوع" / EN "this week".
- Count line (plural): EN "{n}+ orders this week"; AR zero "لا طلبات هذا الأسبوع" (do not display below threshold), one "طلب واحد", two "طلبان", few "{n} طلبات", many/other "{n} طلبًا" (a count line should only render at or above threshold, so few/one/two forms are mostly defensive).
- Rounded floor: "+١٠٠ طلب هذا الأسبوع".
- Why sheet: AR "تظهر هذه المتاجر لأنها الأكثر طلبًا في منطقتك خلال آخر ٧ أيام. يمكنك تغيير المنطقة أو إيقاف التخصيص." / EN "These stores are the most ordered in your area over the last 7 days. You can change your area or turn off personalisation."
- Preference: AR "لأنك اخترت ملابس نسائية" / EN "Because you chose Women's".
- Sponsored: AR "إعلان" / EN "Sponsored".
- Digits: format with locale (`ar-EG` gives Arabic-Indic digits); respect the user's numeral preference setting (spec section 25). Mirror rails with logical start/end and flip chevrons; keep Latin store names isolated with bidi isolation.

### Gaps
- No source found for Egyptian-dialect vs MSA preference in marketplace UI; Arabic strings are drafts, not validated.

## 6. Metrics and honest experimentation

### Takeaway
Measure engagement and downstream value, with guardrails, and test against a non-personalised control rather than against fake variants.

### Cited Findings
- Spec guardrails: return rate, complaints, COD refusal, plus unsubscribe as notification guardrail; A/B with guardrails for ranking — [master prompt sections 20.5, 24](/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md)
- Cornell study suggests persuasion metrics (clicks) can diverge from satisfaction, so CTR alone is a weak success measure — [Sharma and Cosley](https://bebop.berkeley.edu/papers/MusicCHI_RSFinal.pdf)

### Inferences
- Primary: store-to-purchase conversion (7-day) per exposure, not CTR. Secondary: CTR, store-follow rate, add-to-bag from store. Health: store diversity (share of impressions to top 10% of stores, new-store exposure; spec allows 5% exploration), geographic coverage of eligible districts.
- Guardrails: return rate and complaint rate of attributed orders, "not interested" and reset rate, unsubscribe rate, p95 load time of home.
- Experiment design: arms = current home vs home with module; and, within module, label wording and location level, never different claim values for the same data. Both arms must display true data only; do not test unverifiable claims. Include a personalisation-off holdout. Exclude sponsored from the organic metrics.

### Gaps
- No benchmark CTR or follow-rate figures found from any source; targets must come from our own baseline.
