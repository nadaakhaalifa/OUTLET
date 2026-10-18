# Region prompt ("change region to a different country?") on the outlet-shops screen

## What does the repo spec allow today, and what is built?

### Takeaway
Egypt only, EGP only. A `market` seam exists in the domain, but only `EG` is defined and any other market is gated by a flag that defaults to false. ADR-0040 and ADR-0002 are both Proposed, so a live country switcher is not allowed today.

### Cited Findings
- Master prompt: iOS first; GCC expansion is Phase 3; currency is EGP at launch ("Currency is always EGP at launch", §6; "Multi-currency is out of scope", §12). Local means seller registered and stock held in Egypt; Global means an international brand via a distributor or cross-border (cross-border is Phase 3, shown with duties and ETA) (§3). Source: /Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md
- ADR-0040 (Proposed, blocked on VR-P3-07 and ADR-0002): Option 1 default, "Egypt only until the foundation is multi-market ready"; no market is enabled without its own verify rows; safe default "Egypt only; `market` abstraction built behind the single `EG` value". Owner must decide which country first, entity/bank, shared vs split deployment. Source: /Users/nadakhalifa/OUTLET/docs/adr/0040-gcc-expansion-data-and-currency.md
- ADR-0002 (Proposed): personal data may leave Egypt only with PDPC licence or authorization, adequacy and TIA; no real personal data anywhere (including TestFlight) until Accepted; external LLM/ML get no P2/P3 without `cross_border_ml` consent and a licence. Source: /Users/nadakhalifa/OUTLET/docs/adr/0002-data-residency.md
- Market seam: pure `Market` value (currency + exponent, locales, time zone, vatConfigRef, agePolicyRef, payment/courier sets, legalTextSetKey, dataResidencyRegionKey); `MARKETS` registry has one market; non-default market needs static enablement AND flag `release.market.additional_markets` (default false, fails closed); `market` text column default 'EG' on carts, order_groups, price_events, promotions, budgets (migration 0072). `Currency` type is still the single literal EGP. Source: /Users/nadakhalifa/OUTLET/docs/specs/phase-3/gcc-market-abstraction.md
- Same doc: "`market` is not yet in indexes, RLS, API payloads or OpenAPI. Nothing reads the column in production code; it is a seam." So no API can return another country's stores or prices.
- Status doc lists "GCC markets" as spec/partial only (market-abstraction seams, EG only), blocked by ADR-0040/VR-P3-07. Source: /Users/nadakhalifa/OUTLET/docs/plan/status-2026-10.md
- Verify register open rows: VR-P3-07 and VR-P3-MKT-01..06 (tax, e-invoicing, consumer/e-money/BNPL/age law, data protection and residency, currency exponent, payment/courier/legal bundles per market); VR-02 (residency, cross-border licence); VR-19 (foreign-seller import structure for the Global world); VR-20/21 (PDPC review lead time, beta tolerance). Source: /Users/nadakhalifa/OUTLET/docs/compliance/verify-register.md
- Mobile: no region/market UI found. `apps/mobile` hits for "country" are seller-application country (brand-apply/countries.ts, CountryScreen), store address display (stores-directory/model.ts) and phone parsing. The existing "world" segmented control is Local / Global / Shop everything / My Stores (not a country switch).

### Inferences
- "Region" in the user's request is easy to confuse with "world" (Local/Global). Local/Global is already the in-scope concept; "country" is out of scope until ADR-0040 is Accepted.
- Because nothing reads `market` in production, a live switcher would have no backend to switch to; it would be a fake affordance, conflicting with the "never show fake availability" rule.

### Gaps
- Did not read ADR-0019 in depth (it is the mutation-policy ADR, not region related; the assignment's reference looks like a mislabel).
- Did not inspect mobile i18n keys for an existing region string.

## How do comparable apps and Apple handle country/region switching?

### Takeaway
Established guidance: do not auto-redirect by location; if you detect, offer a dismissible suggestion and always let the user choose manually; label by native name; put country and language selectors together in a settings/utility spot. Apple exposes the App Store storefront as a signal, but Apple says not to store it and to fetch it right before use.

### Cited Findings
- Smashing Magazine advises avoiding forced auto-redirects (they frustrate more than help, e.g. users stuck without a VPN) and cites BMW skipping auto-redirect in favour of a header option opening a modal; also suggests a region-first modal. [Smashing](https://smashingmagazine.com/2022/05/designing-better-language-selector)
- Oracle guidance: pair any auto-redirect with a manual override. Source as summarized in search results: [monsekaneko case study](https://monsekaneko.format.com/oracle-active-country-selector) (a designer portfolio, weak source).
- Use native-script names, avoid flags as language/country identifiers; remember preference; searchable long lists. [Linguise](https://www.linguise.com/blog/guide/best-practices-designing-language-selector/), [SimpleLocalize](https://simplelocalize.io/blog/posts/ui-design-language-selector-examples/)
- Shopify: country and language selectors should always be placed together; placement options are footer, near account links, near the cart, or navigation drawer. [Shopify](https://shopify.dev/docs/storefronts/themes/markets/country-language-ux) (the fetched page did not cover geolocation or banners)
- Apple: `Storefront.countryCode` returns the App Store storefront country as ISO 3166-1 alpha-3, iOS 15+; `Storefront.updates` emits changes; Apple notes storefront can change at any time, advises not storing it with customer records and fetching it right before showing product info. [Apple](https://developer.apple.com/documentation/storekit/storefront/countrycode.md), [Storefront](https://developer.apple.com/documentation/storekit/storefront.md)
- Master prompt B7: the app reads StoreKit `Storefront.current` and enables US link-out only, behind a flag; Egypt and other storefronts get no anti-steering relief. This is the only storefront-based behaviour planned, and it is about payments, not catalogue region. Source: master prompt.
- IKEA Turkey runs a "delivery regions" page where choosing a location tailors content. [IKEA TR](https://www.ikea.com.tr/en/online-store-delivery-regions)

### Inferences
- Storefront country is a poor proxy for shopper location or delivery eligibility (an expat on a UAE Apple ID); use it at most as a non-binding hint, never a redirect. Not stored per Apple's advice.
- A settings-based region sheet plus no auto-switch fits both the UX guidance and the fail-closed seam.

### Gaps
- No verified, citable description of Noon, Amazon, Zara, Talabat, Namshi or Shein region switching (search returned nothing usable; I did not fetch their live pages). Report writer should not assert specifics about them.
- No NN/g or Baymard source retrieved.
- I did not find an Apple App Review Guideline that mandates or forbids in-app region pickers; none confirmed. Related risk to check: guideline 5.1.1 (data/consent) and 2.3 (accurate metadata, no features that are not available).

## Legal and privacy implications (PDPL, CPL 181/2018, other markets)

### Takeaway
Switching to a non-Egypt market is a feature that would likely trigger cross-border transfer and a new legal regime, none of which is decided or licensed. Capturing interest via waitlist is possible only with granular consent and must be treated as personal data processed under the Egyptian regime.

### Cited Findings
- PDPL executive regulations (Decision 816/2025) issued 1 Nov 2025, full compliance by 1 Nov 2026; transfers need licence or authorization, adequacy and TIA; consent must be explicit, informed, specific, freely given and easy to withdraw. [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins)
- Secondary advisory summaries: transfer abroad needs a specific licence (fee reported at 50% of standard controller/processor fee); PDPC judges adequacy; the third-country adequacy framework is described as forthcoming by one firm; fallback via explicit consent or SCC/BCR still subject to approval; applications cover destination, storage, security, data categories, retention. [Tech Hive](https://www.techhiveadvisory.africa/insights/review-of-egypts-executive-regulation-for-the-personal-data-protection-law), [Legal 500](https://www.legal500.com/guides/hot-topic/strategic-challenges-and-opportunities-in-cross-border-data-transfers-under-egypts-personal-data-protection-regime). Sources conflict on the enforcement date (one says 31 Oct 2026; spec says 1 Nov 2026): treat as unconfirmed.
- Spec B5: CPL 181/2018 requires Arabic for ads, product data, invoices, contracts, with supplier identity; spec B1 consent purposes include `location_precise`. Source: master prompt.
- Repo: ADR-0040 and VR-P3-MKT-01..06 state that none of the UAE/KSA/other-GCC tax, e-invoicing, consumer, e-money, BNPL, age or data-protection facts have been researched. The Egyptian rows (VR-03/05/07/08/09) do not transfer.

### Inferences
- Do not use precise location (`location_precise`) to suggest a region; coarse device locale or the user's own choice avoids a new consent purpose. Any geo-IP use should be coarse, server-side, and documented in the RoPA (counsel to confirm whether IP-derived country is personal data to be consented).
- A country-interest waitlist would collect a country plus a contact; needs a new consent purpose (e.g. `market_waitlist`) and a `data_inventory.yaml` entry, and must not be pre-ticked.
- A non-EG market implies its own data-protection regime and possibly localisation; UAE and KSA each have their own laws, flagged as needing counsel (no sources gathered here).

### Gaps
- No primary text of Decision 816/2025 or any UAE/KSA statute read; PDPC adequacy list not found.
- Whether showing a disabled country entry or collecting an interest email is itself regulated marketing: counsel.

## Recommendation: safe default, flow, copy, placement, filter behaviour

### Takeaway
Ship no live switcher. Show a read-only region row in Settings (and a small link from the outlet screen) stating Egypt, with an optional, consent-gated "tell me when more countries open" capture that is off by default and can be deferred entirely.

### Cited Findings
- (Design basis only; see sections above.) No additional external sources.

### Inferences (recommendation)
1. Flow: on the outlet-shops screen, no blocking prompt and no auto-detection prompt. Optional low-emphasis row "Region: Egypt" opens a sheet with one selected entry (Egypt, EGP, Arabic/English) and a disabled "More countries" note. No flags, no fake country list.
2. Interest capture (optional, phase it behind a flag): unticked consent checkbox, country picker limited to a free-text/short list, withdraw in Settings -> Privacy. Requires new consent purpose and inventory row before build. Recommended to defer until counsel confirms handling.
3. Placement: Settings region sheet (next to language, per Shopify "keep together"), not the filter sheet. The filter sheet keeps Local / Global / My Stores, which is a different concept and must not be mislabeled "country".
4. Filter behaviour: since region cannot change, outlet filter is always market EG; keep `market` scoping server-side by default (`EG`), never from client input; if the value is ever non-EG, fail closed to EG with no data shown from elsewhere.
5. Copy (sentence case, honest, draft for Arabic review by a native speaker/legal):
   - EN row: "Region: Egypt"
   - EN sheet body: "Z-OUTLET currently serves Egypt only. Prices are in EGP."
   - EN disabled note: "Other countries are not available yet."
   - EN waitlist (if enabled): "Tell me if Z-OUTLET opens in another country" / checkbox "I agree to be contacted about this. I can withdraw any time in Settings."
   - AR row: "المنطقة: مصر"
   - AR body: "Z-OUTLET متاح حاليا في مصر فقط. الأسعار بالجنيه المصري."
   - AR note: "الدول الأخرى غير متاحة بعد."
   - AR waitlist: "أخبروني إذا أصبح Z-OUTLET متاحا في دولة أخرى" / "أوافق على التواصل معي بخصوص ذلك. يمكنني سحب موافقتي في أي وقت من الإعدادات."
   - Avoid "coming soon" wording that implies a date or commitment; avoid country flags.
6. Not to be assumed (ADR or VERIFY): which country first and entity/deployment (ADR-0040, owner decision); cross-border transfer for any non-EG user data (ADR-0002, VR-02, VR-P3-MKT-04); consent purpose and RoPA for waitlist and any IP-derived country (new VERIFY row suggested, owner Legal/DPO); whether storefront country may be used as a hint (low risk, but confirm Apple guideline text at submission); Arabic legal text per market (VR-P3-MKT-06).

### Gaps
- Arabic copy not reviewed by a native legal reviewer.
- Whether the product owner wants "Global world" (cross-border imports into Egypt, VR-19) to be shown under the region row: not decided.
