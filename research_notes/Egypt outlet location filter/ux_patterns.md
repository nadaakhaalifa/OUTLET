# Two-level (governorate -> area) location filter for an outlet-shops list: UX patterns, Egyptian benchmarks, a11y/RTL, privacy

Research depth note: web search returned mostly secondary summaries. Baymard's detailed guidelines are paywalled, NN/g's store-locator pages did not surface, and the Apple HIG pages returned no body text to the fetch tool. Items marked (training knowledge, unverified) are not sourced and need checking before use.

## 1. Best patterns for a two-level location filter on mobile

### Takeaway
Use a modal bottom sheet (expandable to near full height) with a filter button next to search, show applied filters as removable chips, and use a "Done/Apply" commit. The sourced evidence supports the sheet, the applied-filter overview and multi-select. Governorate-chips-then-area-list, counts, "nearest to me" and remembering the last choice are design inferences, not documented in the sources found.

### Cited Findings
- Baymard says mobile filters usually sit in a separate interface, and testing found three recurring issues: back-and-forth between list and filter screen, overly long option lists, and interfaces that skew how users perceive the filters. Its full set of 351 mobile findings is paywalled. — [Baymard mobile filtering benchmark](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options)
- Baymard has a guideline "Display 'Applied Filters' in an Overview" (title seen on its benchmark page); a search summary reports 28% of sites show no overview of applied filters (the benchmark page title says 32% don't, so the figures differ by edition). Without an overview users lack confirmation, a quick way to remove filters, and context for the list. — [Baymard benchmark](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options); [Baymard applied filters article](https://baymard.com/research-articles/how-to-design-applied-filters); [Baymard guideline 2572](https://baymard.com/guidelines/2572-applied-filters-on-mobile)
- Multi-select within one filter type should be allowed where users would logically compare several values (15% of sites don't allow it). This is a third-party summary of Baymard. — [WisePIM summary](https://wisepim.com/blog/ecommerce-product-filters-ux-best-practices)
- The two Baymard headline statistics in circulation conflict (78% poor-to-mediocre vs 34% poor). Do not quote either without the primary source. — [WisePIM](https://wisepim.com/blog/ecommerce-product-filters-ux-best-practices)
- Material describes standard, modal and expanding sheets. A modal bottom sheet blocks the content behind it, has a scrim, and suits menus or choices on mobile. The page returned is the older Material spec; the M3 page was not read. — [Material bottom sheets](https://material.io/components/sheets-bottom); [Android Compose bottom sheets](https://developer.android.com/develop/ui/compose/components/bottom-sheets)
- Secondary guides list filter and sort as a standard bottom-sheet use, with a visible drag handle, swipe-down dismiss and peek heights. Large multi-select option sets may warrant a full page instead. Contentsquare suggests one "Done" to apply all selections. — [AppStorys](https://appstorys.com/blog-Mobile-App-Bottom-Sheets-Design-Guide); [Bright UI docs](https://ui-docs.bright.hr/docs/design-patterns/Filtering); [Contentsquare](https://contentsquare.com/blog/5-major-mobile-filtering-pitfalls-and-how-to-fix-them/)
- NN/g publishes a paid report, "Ecommerce UX Vol. 11: Store Finders and Locators" (50 guidelines; four rounds of studies, 46 users, 56 sites per a secondary source). Its guideline text was not retrievable. — [NN/g report page](https://www.nngroup.com/reports/ecommerce-store-finders-and-locators/)
- Apple sheets with detents (`medium`/`large`), grabber and swipe-dismiss exist as APIs (from model knowledge; the HIG page body was not retrieved, so it is not cited).

### Inferences
- Recommended structure: filter button (with count badge) beside the search field -> modal sheet with detents (medium, large) -> top: governorate as a single-select horizontally scrollable chip row or a vertical list (27 governorates is too many for chips alone; show the top few plus "All governorates") -> below: searchable, multi-select area list for the chosen governorate -> sticky footer "Show N shops" + "Clear all".
- Because Baymard flags long lists and list/filter back-and-forth, the footer should update the live result count so users need not close the sheet to see results.
- After applying, show removable chips under the search bar ("Cairo - Nasr City x"), and badge the button with the number of applied areas, not including the governorate if the governorate alone is selected (decide and keep consistent).
- Counts per option should come from real data, hide zero-count areas or grey them with a count of 0 (consistent with the project rule against fake data), and never be hard-coded.
- Empty state: say that no outlets are in the selected area, offer "widen to {governorate}" and "clear filters" in one tap.
- Remember last choice on device (local storage) and show it as an applied chip so it is never hidden state. No source found; this follows from Baymard's applied-filter rationale.

### Gaps
- Baymard primary guideline text on filter counts, search-in-filter and sheet vs full screen was paywalled.
- NN/g store-locator and bottom-sheet guidance was not retrieved.
- Apple HIG sheets text and Material 3 (m3.material.io) bottom-sheet page were not retrieved.

## 2. How Egyptian and regional apps structure governorate/city/area pickers

### Takeaway
I could not verify any named app's actual picker from documentation. Only Talabat's city landing pages and Jumia/Bosta coverage were searched, and neither exposes the hierarchy. Treat everything about Egyptian apps below as unverified until someone inspects the apps directly.

### Cited Findings
- Talabat Egypt has per-city landing pages (Cairo, Alexandria, Minya, Assiut, Damietta, Ismailia, Banha, Zagazig, Ras El Bar, Port Said) where ordering begins with entering an address and a "locate me" option exists. Governorate/area dropdown details are not on those pages. — [Talabat Cairo page](https://www.talabat.com/egypt/city/cairo)
- Jumia: a vendor notice describes a 27,000 m2 fulfilment centre on the Cairo-Suez highway and nationwide coverage, with no area list. — [Jumia vendor notice](https://vendor.jumia.com/?p=2180)
- Geographic reference data with Arabic names exists: Wikipedia's list of cities by governorate and CityPopulation.de's markaz/kism breakdown. Useful as seed data, not as a product taxonomy. — [Wikipedia](https://en.wikipedia.org/wiki/List_of_cities_and_towns_in_Egypt); [CityPopulation.de](https://www.citypopulation.de/en/egypt/admin/)

### Inferences
- Noon, Instashop, Breadfast, Mrsool, Bosta, Aramex, Uber/inDrive and bank ATM locators: no sources found. Do not assert their hierarchies.
- Likely quirks to design for (domain reasoning, not sourced): many "areas" are informal or new-city names (Nasr City, 6th of October, Sheikh Zayed, New Cairo, Obour) that are cities or districts in the official hierarchy but behave as neighbourhoods to shoppers. Some new cities and compounds are commonly described under one governorate while shoppers perceive them as "Greater Cairo". Spelling varies in Latin transliteration, so Arabic should be the canonical key with synonyms (e.g. "6 October", "October", "اكتوبر").
- Recommendation: own a curated `area` table with an Arabic canonical name, an English name, aliases for search, parent governorate id, and optionally a "Greater Cairo" grouping, rather than relying on a courier's list.

### Gaps
- Screenshots or flows of Talabat, Noon, Jumia, Instashop, Breadfast, Mrsool, Bosta, Aramex, Uber, inDrive and bank locators were not obtained. Needs manual app inspection or app-store screenshots.

## 3. Accessibility and RTL specifics

### Takeaway
Use 44x44 pt targets, announce filter state in the button label, sort Arabic with a locale-aware collator tested on the target Hermes build, and mirror directional icons. Only the Hermes/Intl caveat is sourced here.

### Cited Findings
- Hermes supports a subset of ECMA-402 including `Intl.Collator`, but coverage varies by Hermes version and platform, with Android older builds the weak spot. No source confirmed `Intl.Collator('ar-EG')` behaviour. — [Amazon RN Vega i18n docs](https://www.developer.amazon.com/docs/react-native-vega/0.83/internationalization-and-localization.html)
- Apple's 44x44 pt minimum target and VoiceOver label guidance is common knowledge but the HIG fetch returned no text, so it is unverified here: https://developer.apple.com/design/human-interface-guidelines/accessibility

### Inferences
- Button label example: "Filter, 2 applied" (AR: "تصفية، ٢ مطبقة"), set as `accessibilityLabel`; chips get "Remove Cairo filter" as `accessibilityLabel` with role button; sheet announces result count changes via a polite live region.
- Sort areas with `Intl.Collator('ar')` (verify on device) and fall back to a bundled pre-sorted list if unsupported; sort the pre-sorted list at build time to avoid runtime dependence.
- Counts: format with `Intl.NumberFormat('ar-EG')` for Arabic-Indic digits, with a user preference toggle for Western digits (the master prompt requires a numeral preference). Verify Hermes support the same way.
- Mirror the filter icon only if it is directional (sliders icon is symmetric; no mirroring needed); chevrons that indicate navigation direction must flip in RTL, while expand/collapse chevrons (up/down) do not.

### Gaps
- No primary source for WCAG/HIG target size wording, Arabic collation behaviour on Hermes, or TalkBack announcements were retrieved.

## 4. Privacy: "nearest to me" under PDPL-style consent

### Takeaway
Ask for location only when the user taps "Nearest to me", prefer iOS one-time or approximate location, and never gate the filter on it. The platform facts are sourced; the PDPL interpretation is not definitive.

### Cited Findings
- iOS 14+ lets users grant "Precise: Off", exposed through `accuracyAuthorization`; reduced-accuracy fixes are coarse (Radar says roughly 1-20 km). — [Apple CLAccuracyAuthorization](https://developer.apple.com/documentation/corelocation/claccuracyauthorization.md); [Radar](https://radar.com/blog/understanding-approximate-location-in-ios-14)
- `CLLocationButton`/`LocationButton` (iOS 15+) grants one-time when-in-use authorization; the first tap shows a confirmation, later taps do not. — [Apple CLLocationButton](https://developer.apple.com/documentation/corelocationui/cllocationbutton.md)
- Google's web.dev advises not requesting location on page load and asking after a user action; its example is a store finder. — [web.dev user location](https://web.dev/articles/user-location)
- Egypt Law 151/2020 centres on consent; sources found do not name geolocation as a sensitive category and none addresses precise location. The executive-regulation status is conflicting across sources (the master prompt says Decision 816/2025, full compliance by 1 Nov 2026). — [Andersen law text](https://eg.andersen.com/wp-content/uploads/2025/06/Law-No.-151-OF-2020.pdf); [Clym summary](https://regulations.clym.io/law-no-151-of-2020-egypt)

### Inferences
- Flow: "Nearest to me" is an optional row in the sheet. Tap -> short Arabic-first explanation of purpose ("sort shops by distance; not stored") -> OS prompt. Denied or "Precise: Off" -> fall back to the coarse result or to the manual governorate/area picker with a non-blocking message.
- Use the location only on-device to sort or to infer the nearest area/governorate; do not send coordinates to the server, which sidesteps `location_precise` storage and cross-border questions. If coordinates must go server-side, record the `location_precise` consent purpose already defined in the master prompt (B1) and treat it as P2.
- Never request location at launch or on first sheet open; never make it required for browsing.

### Gaps
- Whether Law 151/2020 or its executive regulations classify precise location as sensitive: unresolved, needs Egyptian counsel (add to the verify register).
- Android coarse vs fine permission specifics were not researched (iOS first).
