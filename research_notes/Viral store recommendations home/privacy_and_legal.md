# Privacy and legal rules for a location- and gender-personalised "popular stores" module (Egypt)

Scope note: Egypt first. Nothing here is legal advice; items needing counsel are marked COUNSEL. Primary Egyptian text could not be read directly: the Andersen PDFs of Law 151/2020 and Law 181/2018 fetched as image-only/binary files with no text layer, and no OCR tool was available. All Egyptian statements therefore rest on secondary summaries (DLA Piper, CMS, Chambers, Mondaq) and are flagged. Research budget was about 15 tool calls.

## 1. Egypt PDPL 151/2020 and Executive Regulations (Decision 816/2025): profiling, gender, sensitive data, consent, DPIA

### Takeaway
Gender is not in the PDPL sensitive list as reported by secondary sources, so a self-declared "shop for" preference is ordinary personal data processed on explicit consent. I found no primary or reliable secondary text on profiling/automated-decision rights or mandatory DPIA in Egypt; treat both as unconfirmed and design to the stricter GDPR-style standard anyway.

### Cited Findings
- Sensitive data per one English translation: data revealing mental, psychological, physical or genetic health, biometric data, financial data, religious beliefs, political opinions, and security status; children's data is always sensitive. Another source (DLA Piper) lists criminal records instead of "security status". Gender/sex is not listed in either; the two lists differ, so the Arabic text must be checked — [search result summarising Andersen translation](https://eg.andersen.com/wp-content/uploads/2025/06/Law-No.-151-OF-2020.pdf); [DLA Piper Egypt](https://www.dlapiperdataprotection.com/index.html?t=law&c=EG)
- Personal data is any data relating to an identified or identifiable person (directly or indirectly) — [DLA Piper Egypt](https://www.dlapiperdataprotection.com/index.html?t=law&c=EG)
- Art. 2: processing requires the data subject's explicit consent unless the law permits otherwise; consent can be withdrawn. Art. 6: electronic processing is lawful if consent for specific purposes, contract/legal claims, legal obligation, or controller's legitimate interests not overriding fundamental rights — [DLA Piper Egypt](https://www.dlapiperdataprotection.com/index.html?t=law&c=EG)
- Executive Regulations were issued 1 November 2025 (Decision 816/2025) with a one-year grace period; they cover consent, licensing, records, breach notification, cross-border transfers, special categories, children and direct electronic marketing; Egypt leans on prior authorisation rather than GDPR-style self-assessment — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins); [Al Tamimi via search summary](https://www.tamimi.com/news/from-policy-to-practice-egypt-issues-executive-regulations-of-the-personal-data-protection-law). One source says compliance is due "end of 2026" rather than 1 Nov 2026 (conflict; confirm).
- Consent standard under the PDPC guidance: explicit, informed, specific, freely given, granular, easy to withdraw, documented; PDPC states consent is unsuitable where there is no real choice (power imbalance or conditional service). Sensitive data needs written consent; Arabic-language consent and enhanced records — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- Legitimate interests must be documented in a Legitimate Interest Assessment; ROPA should reference DPIAs; further PDPC DPIA guidance was "expected" (so no confirmed DPIA mandate in this source) — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- Electronic direct marketing (Arts. 17-18): needs consent, sender identification, valid contact, marketing label, easy opt-out; consent records kept 3 years after the last message — [DLA Piper Egypt](https://www.dlapiperdataprotection.com/index.html?t=law&c=EG). A "popular stores" in-app module is arguably not direct marketing, but a push/WhatsApp variant would be.
- One compliance summary claims impact assessments are mandatory for high-risk processing including profiling; unverified secondary claim — [Clym summary found via search](https://regulations.clym.io/law-no-151-of-2020-egypt)

### Inferences
- A cohort statement shown to everyone (not to a person because of a trait) involves no per-user decision; the risk sits in how the user's own gender/district is obtained and stored.
- Inferred gender (from name, browsing, photos) is not on the Egyptian list but is advisable to avoid: it fails "explicit, informed, specific" consent, is likely inaccurate, and would be treated as special-category-like under GDPR practice (section 2). Inference.
- Self-declared gender plus the existing `personalization` consent purpose is the lowest-risk basis; keep it separate from marketing consent. Inference.

### Gaps
- Exact Arabic wording of sensitive-data definition (is "sex/gender" or "sexual life" absent?) not verified.
- No confirmed text on profiling, automated decisions, objection to profiling, DPIA triggers, anonymisation standard, or inference treatment in Egypt.
- Whether the Regulations' "special categories" section widens the Law's list is unknown. COUNSEL.

## 2. Collect gender explicitly vs infer it (GDPR, ICO, EDPB, Apple, Google)

### Takeaway
Explicit, optional, self-declared "shop for" preference is the defensible route. Under UK/EU practice, inferring a protected trait is itself regulated regardless of accuracy; gender alone is not Art. 9 but gender inference can reveal sexual orientation/health in edge cases, and it is a bias risk. Apple and Google require consent, minimisation and honest disclosure.

### Cited Findings
- ICO: special category data includes data "revealing or concerning" those categories; inferences count if you intend to infer, or to treat people differently based on inferred special-category information, "regardless of how confident you are"; profiling that infers ethnicity, beliefs, politics etc. needs an Art. 9 condition. The ICO page does not discuss gender as a proxy — [ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-is-special-category-data)
- ICO updated this guidance 9 April 2024 and dropped certainty of inference as a factor; Easylife fine (GBP 1.35m) for inferring health conditions from purchases for marketing — [Lewis Silkin](https://www.lewissilkin.com/insights/2022/10/18/1-35m-ico-fine-spells-no-easylife-for-marketing-related-profiling-and-invisibl-102hzc7); [Inside Privacy](https://www.insideprivacy.com/eu-data-protection/uk-ico-publishes-new-guidance-on-special-category-data/)
- EDPB Guidelines 8/2020: derived/inferred data can be special-category data; both platform and advertiser need an Art. 9 exception — [EDPB](https://www.edpb.europa.eu:443/sites/default/files/consultation/edpb_guidelines_202008_onthetargetingofsocialmediausers_en.pdf); [Hunton summary](https://hunton.com/privacy-and-information-security-law/edpb-published-guidelines-on-the-targeting-of-social-media-users)
- Apple 5.1.1(ii): consent required even for data considered anonymous, with easy withdrawal; 5.1.1(iii): collect only data needed for the task; 5.1.2(iii): "should not attempt to surreptitiously build a user profile" and must not re-identify "anonymized, aggregated" data; 2.5.18: no targeted/behavioural ads based on sensitive user data (health, school, kids examples) — [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- Apple reviewers have rejected a required gender field as not relevant to core functionality, suggesting optional with justification — [Apple forum, 5.1.1 gender](https://developer.apple.com/forums/thread/128670)
- Google Play: limit collection of personal and sensitive data to app functionality; prominent in-app disclosure before consent; Data safety label must be accurate and match the privacy policy — [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)

### Inferences
- Nothing found says Apple or Google classify inferred gender as "sensitive"; the real exposure is 5.1.2(iii) "surreptitious profile" (hidden inference) and the Data safety / privacy label accuracy. Inference.
- Offer a non-binary-safe design: options "Women / Men / Prefer not to say / Show me everything", never binary-forced, and never required (Apple 5.1.1(iii)).

### Gaps
- No Apple/Google text specifically on inferred gender; Google precise vs approximate location rule text not retrieved.
- Last 12k characters of the Apple page unread.

## 3. Aggregated cohort statements and minimum cohort size

### Takeaway
Aggregate statements are acceptable practice when the cohort floor is enforced server-side; no single legal number exists. Recommend k >= 50 distinct users AND >= 20 distinct purchasers per store claim (matches spec section 19.1), fall back to a wider area then to all-Egypt.

### Cited Findings
- Statistical-office practice has no settled threshold: 10 is the common default for outputs, 5 or 20 also used; counts of 1-2 must be avoided; complementary suppression is needed because suppressed cells can be recovered by differencing — [Ritchie, "10 is the safest number"](https://uwe-repository.worktribe.com/OutputFile/7457513); [ABS](https://www.abs.gov.au/websitedbs/D3310114.nsf/home/Basic+Survey+Design+-+Confidentiality); [UK LLC SDC guide](https://guidebook.ukllc.ac.uk/_sources/docs/user_guide/sdc.md)
- Google Analytics withholds demographic data below undisclosed system thresholds to prevent inferring individuals — [Google](https://support.google.com/analytics/answer/9383630?hl=en). Google Ads customer-list/audience minimum reported as 100 users (down from 1,000) — [Search Engine Land](https://searchengineland.com/google-lowers-audience-size-limits-across-ads-466816). Meta's "Below 1000" is a display cutoff per a third-party help page, not confirmed as a minimum — [Audiense](https://help.audiense.com/en/soprism/not-enough-information-at-the-beginning)
- Apple 5.1.2(iii) forbids reconstructing profiles from data described as aggregated — [Apple](https://developer.apple.com/app-store/review/guidelines/)

### Inferences
- Floor reasoning: stores are a long-tail; a store bought by 3 of 50 women is identifiable-ish. So also require a per-store minimum (>= 20 purchasers) and show rank only (no counts) to limit differencing. Inference.
- Fall back chain: (district x gender) -> (governorate x gender) -> (district, all) -> (Egypt-wide). Never show an empty or fabricated module; if nothing qualifies, show a plainly labelled generic list ("Popular across Egypt").
- Add small noise or rank-bucketing; formal differential privacy is optional at this scale (cohort floor plus rank-only output is proportionate). Inference. Differential privacy basics were not sourced in this pass.

### Gaps
- No Egyptian statistics-agency (CAPMAS) threshold found; no DP source retrieved; Meta true minimum unconfirmed.

## 4. Location

### Takeaway
Use a user-chosen governorate/district (coarse) and avoid precise location for this module entirely.

### Cited Findings
- Personal data includes indirectly identifying data (Egypt) — [DLA Piper](https://www.dlapiperdataprotection.com/index.html?t=law&c=EG). Google Play lists device location as sensitive and requires prominent disclosure — [Google Play](https://support.google.com/googleplay/android-developer/answer/10144311)
- The spec lists `location_precise` as a separate consent purpose (master prompt B1) — [/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md]

### Inferences
- A chosen district tied to an account is personal data (linked to an identifiable user) but low risk; the address book already holds finer data, so reuse the default delivery district only with a clear disclosure or let the user pick separately. Inference.
- Sheikh Zayed is small; district-level cohorts raise the k problem, hence the fallback chain.

### Gaps
- No Egyptian text on whether coarse location is exempt from consent. COUNSEL.

## 5. Consumer protection, fairness, dark patterns

### Takeaway
A cohort claim must be literally true and reproducible; stereotyping risk is handled by wording and by letting users change the filter.

### Cited Findings
- CPL 181/2018 applies to advertisers across all media incl. digital; practitioner guide says claims are misleading if they create a false impression about characteristics, origin, quality or price, including by omission or implication; advertisers primarily liable, platforms possibly — [Chambers 2025 Egypt](https://practiceguides.chambers.com/practice-guides/advertising-marketing-2025/egypt); [Andersen Law 181 PDF](https://eg.andersen.com/wp-content/uploads/2025/07/Law-No.-181-of-2018.pdf) (article text not extractable). Law 206/2017 on advertising is a separate statute — Chambers (same link).
- DSA Art. 26 bans profiling-based ads using special categories; EDPB says it complements GDPR Arts. 9 and 22(4); recommender personalisation is allowed — [EDPB DSA-GDPR guidelines 3/2025](https://www.edpb.europa.eu/system/files/2026-09/edpb_guidelines_202503_interplay-dsa-gdpr_v2_en.pdf); [DSA Observatory](https://dsa-observatory.eu/?p=2231)

### Inferences
- Master prompt rule 13 already forbids fake social proof; "women in Sheikh Zayed buy from X most" must be computed from real delivered (or paid) orders within a stated window and be reproducible from the audit data. Inference.
- Label sponsored placements "Sponsored" and keep them out of cohort ranking.
- Gender-stereotype copy is a reputational and fairness risk, not an identified Egyptian legal breach; avoid category implications ("women's stores"). Give a one-tap "Show for everyone" switch.
- Non-sourced: DSA Art. 25, Art. 38 and FTC dark-pattern guidance were not retrieved; cite from primary text before use.

### Gaps
- Exact CPL 181/2018 articles on misleading info not extracted. COUNSEL.
- DSA Art. 25/38 and FTC material not obtained.

## 6. Recommended design

- Data: gender stored only as optional `shop_for` (women/men/everyone/undisclosed) in profile, field P2, never inferred, never derived from names, photos or browsing. District = user-chosen governorate + district.
- Consent: reuse `personalization` purpose for using `shop_for`+district for the module; consent text in Arabic, not pre-ticked, one-tap withdrawal. Purpose name suggestion: `personalization_cohort` as a sub-purpose. Precise location stays under `location_precise` and is not used here.
- Computation: server-side batch (daily). Join orders to cohort attributes; output only (cohort key, store_id, rank) when distinct users >= 50 and per-store distinct purchasers >= 20; exclude cancelled/returned; exclude users who withdrew consent or have `personalization=false`. Raw per-user attributes never leave the server; client receives rank lists only, no counts.
- Fallback chain as in section 3; final fallback is a non-personalised popularity list.
- Personalisation off: module shows national popularity (no gender or district input), request carries `personalized=false` (spec section 13 acceptance).
- Excluded inputs: budget data (spec section 12 lint), seller-visible features, measurements.
- Retention: derived cohort tables rebuilt daily and not kept beyond 25 months aggregated; `shop_for` deleted with the account or on user clearing.
- Wording: "Popular with shoppers in {district}" plus "{gender group}" only when the user chose it; add "How this works" sheet; no counts, no "buying now".
- Items needing action: (a) DPIA (inference design, fairness, small cohorts), light-weight, as the spec already requires DPIAs for personalisation models; (b) ADR: "Cohort popular-stores: self-declared gender, k floor, fallback"; (c) ADR-level decision on k = 50/20; (d) verify-register rows for counsel.

Proposed verify-register rows (new; I read VR-01 to VR-17 of /Users/nadakhalifa/OUTLET/docs/compliance/verify-register.md, not all 137 rows, so check for duplicates before adding):
1. Is gender/sex in the PDPL sensitive list (Arabic text, Art. 1 and Regulations)? Owner Legal/DPO.
2. Egyptian rules on profiling, objection to profiling and automated decisions, and DPIA triggers under Decision 816/2025. Legal/DPO.
3. Whether aggregated cohort statistics derived from personal data need consent or count as anonymised data; minimum cohort size expectation of the PDPC. Legal/DPO.
4. Whether a user-chosen district is personal data needing separate consent and whether a PDPC licence/permit is involved. Legal/DPO.
5. CPL 181/2018 / Law 206/2017 treatment of cohort social-proof claims and the "Sponsored" labelling duty. Legal.
6. App Store / Play Data safety disclosure of gender and district. Product/Legal.

## Open conflicts to flag
- Sensitive list differs between sources (security status vs criminal records).
- Compliance deadline 1 Nov 2026 vs "end of 2026" in one source.
- Meta threshold (100 vs 1,000) unresolved.
