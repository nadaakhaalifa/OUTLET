# Product grid density and filters: competitor patterns

Research date: 2026-10-15. Method: web search plus page fetch (about 11 calls). The search tool returned mostly irrelevant Shopify/Shopware plugin pages. Almost no first-party or teardown evidence for the named apps was reachable. Everything below not cited is NOT FOUND, not assumed. Direct inspection of the live apps (or Mobbin/Page Flows with login) is required to fill the matrix.

## Which apps ship a column-count toggle, and which options?

### Takeaway
Only one weak signal was found: a "view" toggle on Zara's website (not confirmed for the app, column counts unstated). No verified column options (1/2/3/4) for any of the ten apps could be established from reachable sources.

### Cited Findings
- Zara (web, date unknown): a search summary of a Marie Claire UK article about a TikTok tip says a "view" toggle at top right of the Zara site rearranges photos into an aligned grid showing more items. The article page itself could not be fetched (truncated), so this is a search-snippet paraphrase; the column counts and the app behaviour are not stated — [Marie Claire UK](https://www.marieclaire.co.uk/news/fashion-news/this-tiktok-hack-will-change-the-way-you-shop-at-zara-762004)
- Amazon (iOS, circa iOS 7, 2014, OLD): AppleVis forum comments describe a search-results button toggling grid, image and list views in app version 4.0.x/4.1.1. Current app unverified — [AppleVis](https://applevis.com/comment/6064)
- Generic guidance, not app evidence: depict.ai (25 Mar 2026) recommends 2 columns under 768px, 3-4 on tablets, 4-6 on desktop; it does not discuss density toggles or pinch and does not mention Zara, ASOS or Zalando — [depict.ai](https://depict.ai/articles/10-best-practices-for-fashion-store-product-grid-design)
- Third-party Shopware plugins implement a mobile 1/2-column switcher whose choice persists in the browser through filter, sort and pagination; this shows a common pattern but is not any named retailer — [Shopware store](https://store.shopware.com/en/great98140330654m/mobile-grid-switcher-1-or-2-columns-for-product-listings.html)

### Inferences
- A mobile 1-vs-2 column switch is an established commodity pattern (plugin market), so 1/2 is a reasonable minimum option set for Z-OUTLET. This is inference only.
- Claims such as "ASOS 1 vs 2", "Zara 1/2/3", "SHEIN 2/3" in the brief are unverified here; do not present them as fact.

### Gaps
- ASOS, Zalando, H&M, SHEIN, Farfetch, Net-a-Porter, Noon, Namshi: no toggle evidence found (searches returned only unrelated plugin pages).
- Default, persistence and icon for every named app: not found.

## Does pinch-to-zoom change density anywhere?

### Takeaway
Not found for any of the ten retailers. Only generic developer components (Tizen GridView, Compose pinch grid library) support pinch-to-change columns.

### Cited Findings
- Search surfaced a Tizen GridView doc and a "compose-pinch-grid" library that adjust columns by pinch gesture; these are developer components, not retailer apps — [Tizen docs](https://docs.tizen.org/application/web/api/2.4/ui_fw_api/Mobile_UIComponents/mobile_GridView.htm), [klibs.io](https://klibs.io/project/aldefy/compose-pinch-grid)
- No result confirmed pinch-to-change-density in the Zara app or web — [Marie Claire UK](https://www.marieclaire.co.uk/news/fashion-news/this-tiktok-hack-will-change-the-way-you-shop-at-zara-762004) (absence only)

### Inferences
- Photo-app style pinch (Google Photos, Pinterest) is not shown to exist in fashion retail; treat as a differentiator needing its own usability test, with a visible button as the primary affordance (accessibility, RTL).

### Gaps
- Pinterest and Google Photos behaviour was not researched in this pass (out of the retailer list, no fetch made).

## Filter entry point and filter/sort/category consolidation

### Takeaway
One concrete datapoint: Farfetch app uses a "Refine" control with multi-select colour and brand, size and sale-discount filters. Button position, icon, count badge and consolidation with sort not verified for any app.

### Cited Findings
- Farfetch (app teardown, date not shown on page): "Refine" menu offers many filters including multi-select for colours and brands, plus size and sale discount — [ScreensDesign](https://screensdesign.com/showcase/farfetch-shop-luxury-fashion)
- depict.ai (Mar 2026): generic advice to use collapsible filter menus on mobile and keep filter placement consistent — [depict.ai](https://depict.ai/articles/10-best-practices-for-fashion-store-product-grid-design)

### Inferences
- None beyond generic advice; no basis for claiming how any competitor merges filter, sort and category.

### Gaps
- Baymard Institute product-list findings: the search returned no Baymard content; baymard.com is paywalled in part and was not fetched.
- Zara, ASOS, Zalando, H&M, SHEIN, Net-a-Porter, Amazon, Noon, Namshi filter button label/icon/badge: not found.

## Defaults, persistence, card content by density, native vs web

### Takeaway
Nothing verified for the named apps.

### Cited Findings
- Shopware plugin docs state the chosen mobile view persists in the browser across filter/sort/pagination (plugin behaviour, not a retailer) — [Shopware store](https://store.shopware.com/en/great98140330654m/mobile-grid-switcher-1-or-2-columns-for-product-listings.html)
- Older UX article (2016, OLD) says apparel retailers favour grid view with minimal product data, spec-heavy categories favour list — [Moovweb via Retail Dive](https://www.retaildive.com/news/what-retailers-selling-on-mobile-can-learn-from-tinder/415003/) (search-snippet paraphrase)

### Inferences
- Likely pattern (unverified): denser grids drop price/brand text to image plus heart; 1-column shows full metadata. Treat as a design hypothesis.

### Gaps
- Native vs web per app: not verified (Zara web toggle only suggested). Noon and Namshi RTL behaviour: not found.
- Recommended next step: manual walkthrough of each app on a device, or Mobbin/Page Flows/ScreensDesign access, recording date and app version.
