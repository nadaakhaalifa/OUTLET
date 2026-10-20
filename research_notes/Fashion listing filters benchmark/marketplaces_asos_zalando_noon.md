# Fashion marketplace listing-filter UX teardown (ASOS, Zalando, SHEIN, Noon, Namshi, Amazon, Nike, Farfetch/NAP)

Scope note: ~10 tool calls used. WebSearch/WebFetch cannot see inside native apps, so app-level pattern claims (chips, sheets, section order, apply wording) are largely "not found" for the named marketplaces. Treat the Baymard material as the strongest evidence; the marketplace-specific evidence is thin.

## Baymard / NN/g benchmarks (filter UX best practice, mobile)

### Takeaway
Baymard recommends: counts on options, multi-select (OR within type, AND across types), a mobile full-screen overlay/bottom sheet with an explicit Apply button showing live result count, and an always-visible applied-filters overview. NN/g: not searched (gap).

### Cited Findings
- DOCUMENTED: show result counts beside each option ("Blue (34)"); called one of the highest-impact improvements — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: multi-select within a filter type; 14% of benchmarked sites lack it; AND between types, OR within; checkboxes not radios — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: mobile filters in full-screen overlay or bottom sheet, opened from a labeled button that stays visible on scroll; prominent Apply button showing updated count; removable active-filter chips above results; 44x44pt targets — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: desktop live filtering expected; on mobile require explicit apply to avoid disorienting refreshes — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: zero-result handling: Baymard's page does not say disable vs hide; it says prevent the selection or give a recovery path ("No results for these filters. Try removing X"); an empty page is a dead end — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: stats: 20% of sites fail to keep applied filters visible; 25% desktop / 40% mobile use unclear filter labels — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- DOCUMENTED: applied-filters overview: 28% of benchmark sites have none; on mobile combine a "N Filters Applied" label, a half-visible/faded last chip and horizontal scroll; or truncate to 1-2 rows with "See All Applied Filters"; do not show only a count; for apparel, filter type labels usually unnecessary — [Baymard](https://baymard.com/research-articles/how-to-design-applied-filters)
- DOCUMENTED: size filter: group options by size type with clear headers (waist vs inseam, juniors vs regular), alpha and numeric separate, dropdown to choose size type, translate between alpha and numeric (Nike and Macy's cited as doing this). In-stock handling not addressed — [Baymard](https://baymard.com/blog/apparel-how-to-format-size-options-in-the-size-filter)
- DOCUMENTED: 80% of mobile test users tried price filtering (Baymard mobile testing, via secondary summary) — [Baymard mobile filtering](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options) (snippet only; full text paywalled)
- Unverified: a blog cites "78% of mobile filters fail" from Baymard 2025; could not verify, do not use — [wisepim](https://wisepim.com/blog/ecommerce-product-filters-ux-best-practices)

### Inferences
- A Z-OUTLET sheet should be: bottom sheet, multi-select, per-option counts, sticky Apply "Show N items", chip row with fade, size-system tabs.
- Disable-vs-hide for zero-count options is unresolved by Baymard; pick one deliberately (disabled with 0 count keeps layout stable) and record an ADR.

### Gaps
- NN/g filter articles not retrieved. Baymard mobile filtering and 2023 product-list/filtering benchmark are paywalled; no per-marketplace scores found.

## Zalando

### Takeaway
Only personalization filters are documented well: "In your sizes" and "In your brands" (Oct 2021). Section order, chips, apply wording, Pre-owned condition filter: not found.

### Cited Findings
- DOCUMENTED: "In your sizes" applies personalized size recommendations to catalogue browsing (e.g. dresses show only likely-fit sizes); built on ~5 years of size-advice work — [Zalando corporate](https://corporate.zalando.com/en/node/9372)
- DOCUMENTED: "In your brands": followed brands are surfaced in search results; can be switched off to return to unfiltered browsing — [Zalando corporate](https://corporate.zalando.com/en/node/9372)
- DOCUMENTED: "From your closet" in account > Your Sizes lets users record fitting items/brands from any retailer; not a filter — [Zalando corporate](https://corporate.zalando.com/en/node/9372)
- DOCUMENTED (trade press): Zalando says customers tend to buy within 3-5 brands where they know their size; size filter intended to widen choice — [FashionNetwork](https://uk.fashionnetwork.com/news/Zalando-launches-new-sizing-personalisation-feature,1348819.html) (via search summary)
- INFERRED from search snippets only: Pre-owned category pages show a "Beliebteste Filter" panel with categories (clothing/shoes/accessories); no condition option seen — [zalando.de pre-owned](https://www.zalando.de/pre-owned-bekleidung-damen/zalando-essentials)

### Inferences
- Pattern worth copying: a saved-size "fits me" toggle that is explicitly reversible.

### Gaps
- No Zalando engineering-blog write-up on filters found. Sheet structure, sort placement, counts, Pre-owned condition grading as a filter: not found. Post-2021 changes: not found.

## ASOS

### Takeaway
Fit Assistant is documented as a size recommender on the product page; a "My Size" listing filter was not found.

### Cited Findings
- DOCUMENTED: Fit Assistant (powered by Fit Analytics, ML on purchases/returns) is available on site and app for some items; on web recommended size shows above the size dropdown, in app inside the size dropdown — [ASOS help](https://www.asos.com/au/customer-care/product-stock/what-is-fit-assistant)
- DOCUMENTED (2018): global rollout across app and web — [FashionUnited](https://fashionunited.uk/news/fashion/asos-rolls-out-fit-assistant-tool/2018112040054)

### Gaps
- ASOS "My Size" filter, filter sheet structure, chips, sort, ASOS tech blog: not found.

## SHEIN

### Cited Findings
- DOCUMENTED (March 2022, third-party eval, web vs app unspecified): size filter at top of panel, price at bottom (scroll down and back); fit/length/neckline facets with many duplicate attribute names attributed to inconsistent third-party tagging; horizontal options on top, advanced options open a full-screen vertical panel on mobile that must be closed to see results; no applied-filter display, only "clear all"; each selection reloads results slowly — [YesPlz](https://yesplz.ai/resource/product-filter-and-search-evaluation1)
- Low quality: a student redesign case study exists — [UX Collective bootcamp](https://bootcamp.uxdesign.cc/ux-ui-case-study-shein-redesign-134e37cd3935) (unaffiliated, not evidence)

### Inferences
- The SHEIN failure modes (no applied chips, live reload, messy tags) are a useful anti-pattern list; evidence is 2022, so may be outdated.

### Gaps
- Quick-filter tags behaviour, current app filters: not found.

## Noon, Namshi, Amazon Fashion, Nike, Farfetch/Net-a-Porter

### Takeaway
No usable evidence retrieved. Arabic/RTL searches returned only generic RTL advice.

### Cited Findings
- DOCUMENTED (generic, not Noon): RTL needs full mirroring of UI incl. forms, graphics, numerals; a Mozilla bug shows filter bars failing to mirror — [UX Planet](https://uxplanet.org/24-tips-for-designing-an-arabic-app-7f0a8cc9d9ab), [Mozilla bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1177692)
- DOCUMENTED: Nike translates between alpha and numeric sizes in its size filter (as cited by Baymard; date of observation not stated) — [Baymard](https://baymard.com/blog/apparel-how-to-format-size-options-in-the-size-filter)

### Gaps
- Noon, Namshi, Amazon Fashion mobile left-rail adaptation, Nike, Farfetch, Net-a-Porter: filter sheets, seller/"Sold by", delivery/Express, COD, rating, price-drop, condition, saved searches: all not found. Recommend live app inspection (Arabic and English) or Mobbin, plus Amazon/noon seller-help pages, in a follow-up pass.
- Marketplace-specific facets (seller/store, delivery speed, condition, rating, price-drop) are not evidenced for any of the eight.
