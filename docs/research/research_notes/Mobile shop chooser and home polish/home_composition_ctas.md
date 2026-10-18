# Home composition and primary CTAs for fashion marketplace apps

## (a) Live-now carousel and filter entry integration

### Takeaway
No authoritative source found on where a Filter button belongs on a fashion Home. Baymard's free material only confirms mobile filters live in a separate interface and search is often collapsed behind an icon. Practical default (inference): search-adjacent filter icon at most; filters belong on listing pages.

### Cited Findings
- Mobile filters are usually in a separate interface, not permanently visible; users go back and forth between lists and filter screens, a common problem — [Baymard filtering options](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options)
- On mobile, search is often collapsed behind an icon or in the hamburger menu — [Baymard search field](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/search-field)
- 2016 blog advice (secondary, dated): search at top of home, repeated at bottom if long — [Babich](https://babich.biz/blog/mobile-ecommerce-how-to-design-ux-search)

### Inferences
- Home has no product list to filter, so a standalone Filter button is low value; a filter icon inside/next to the search field that opens the same sheet as listing pages avoids a stacked-widget look.
- Make the Live-now module a single full-width horizontal rail with the same card radius, gutter and type scale as other rails, a small "Live" dot plus countdown inside the card (not a separate banner) so it reads as part of the feed. Unverified against any teardown.

### Gaps
- No teardown evidence found for Zara, COS, Massimo Dutti, Net-a-Porter, Mytheresa, SSENSE, ASOS, Zalando, Noon, Namshi live/drop modules; Mobbin/Page Flows pages not retrievable via search.
- Baymard premium guidance on filter placement not visible.

## (b) Hero height as share of screen

### Takeaway
No verified measurement of fashion-app hero heights found. Only web-theme practitioner values (75-100% viewport) which are web, not native app, and not evidence for 40-43%.

### Cited Findings
- Shopify forum replies set mobile hero to ~75-80% viewport; default 100svh; 40vh fixed caused cut-off content in one store — [Shopify community](https://community.shopify.com/t/how-can-i-increase-image-banner-height-to-extra-large-dawn-theme/359816/3), [Shopify community](https://community.shopify.com/t/dawn-theme-mobile-home-page-banner-sizing-issue/413271)
- Vendor blog suggests mobile hero 800x1200 px (2:3), as a starting point only — [TrueProfit](https://trueprofit.io/blog/shopify-banner-size)

### Inferences
- On 390x844, 40-43% is about 338-363pt of height. Arithmetic only; no source validates it. Keep above the fold: header/search, hero headline plus both CTAs, and a peek (about 40-60pt) of the next rail to signal scroll.

### Gaps
- Per-app hero heights (px/pt, %) for all ten apps: not found.

## (c) Bold primary CTA pair

### Takeaway
Size floor is verified; the visual pattern for fashion homes is not sourced.

### Cited Findings
- Apple recommends 44x44pt minimum tappable area; Material recommends 48x48dp (~9 mm); WCAG 2.2 AA 2.5.8 is 24x24 CSS px — [Front-End Checklist](https://frontendchecklist.io/rules/accessibility/touch-targets), [specification.website](https://specification.website/spec/accessibility/touch-target-size/). Secondary sources; primary Apple HIG/Material pages not retrieved.

### Inferences
- 56-72pt tall is above the floor, so size is not the risk; the "ad banner" look comes from busy gradients and multiple colours. Use one filled brand-colour button, a circled icon, weight 600, text contrast at least 4.5:1 (WCAG AA), placed on a solid scrim rather than the photo. Two equal filled buttons vs filled + outline: no evidence found; filled + outline is the common hierarchy choice (inference).

### Gaps
- Measured CTA sizes and pair patterns for the ten apps: not found.

## (d) Section order and pacing for the ten apps

### Takeaway
Not found. Searches returned no per-app teardown data.

### Cited Findings
- None.

### Inferences
- Suggested order for this app (not sourced): header/search, hero with two CTAs, Live now rail, stores/brands rail, trending/deals rails, editorial. Alternate rail and full-bleed rhythm every 2-3 sections.

### Gaps
- Verified section order for Zara, COS, Massimo Dutti, Net-a-Porter, Mytheresa, SSENSE, ASOS, Zalando, Noon, Namshi: requires Mobbin/Page Flows or hands-on app capture. Note only 3 searches were run, so coverage is thin.
