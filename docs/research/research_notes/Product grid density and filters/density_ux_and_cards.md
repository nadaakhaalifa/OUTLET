# Product grid density and filters on mobile fashion e-commerce

Scope note: web search returned thin primary evidence. Baymard's grid guideline (#2272) and mobile benchmarks are paywalled or unloaded; NN/g's own pages were not retrieved. No published A/B test on 1 vs 2 vs 3+ columns was found. Most numeric card guidance below is therefore inference, labelled as such.

## What do Baymard, NN/g and published A/B tests say about 1 vs 2 vs 3+ columns?

### Takeaway
No retrievable primary evidence quantifies 1 vs 2 vs 3+ columns. Baymard frames it as a tradeoff between information per item and ability to compare/overview; the specific column recommendation sits behind Premium.

### Cited Findings
- Baymard frames mobile product lists as a balance: users need substantial product info in the list to avoid needless product-page visits, but small screens make comparison hard; large thumbnails with info versus condensed items for overview — [Baymard mobile product list benchmark](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/product-list)
- Baymard's 2025 Product List UX article reports 78% of mobile ecommerce sites perform "poor" to "mediocre" in product list UX — [Baymard](https://baymard.com/research-articles/current-state-product-list-and-filtering)
- A vendor plugin page claims single column means lots of scrolling and a fixed two-column grid can feel cramped; this is marketing, not evidence — [Shopware plugin](https://store.shopware.com/en/great98140330654m/mobile-grid-switcher-1-or-2-columns-for-product-listings.html)

### Inferences
- Because Baymard calls out both info loss and overview as competing goals, a user-switchable density (default 2 columns) is the defensible design; this is opinion, not tested.

### Gaps
- Baymard guideline 2272 "Grid Layout for Visually Driven Products" text did not load ([page](https://baymard.com/guidelines/2272-grid-layout-for-visually-driven-products)); needs Premium.
- No NN/g article or A/B test on 1/2/3/4 columns and conversion found.

## What must be hidden at 3 and 4 columns; minimum type size and touch target

### Takeaway
Platform minimums for tap targets are well sourced (44pt Apple, 48dp Material, WCAG 24 CSS px AA). Per-density card content rules are not sourced anywhere found; derive from geometry.

### Cited Findings
- Apple HIG minimum tap target 44x44 pt; Material 48x48 dp; Material lists 8dp spacing separately — [OpenReplay](https://blog.openreplay.com/improving-tap-targets-mobile-ux/), [UXPin](https://www.uxpin.com/studio/blog/responsive-design-touch-devices-key-considerations/) (secondary sources)
- WCAG 2.2 AA SC 2.5.8 requires at least 24x24 CSS px; AAA SC 2.5.5 calls for 44x44 — [Disability World glossary](https://www.disabilityworld.org/toolkit/glossary/touch-target-size/), [W3C mobile a11y wiki](https://www.w3.org/WAI/GL/mobile-a11y-tf/wiki/Proposed_SC_Target_Size)
- A UXPin table attributes about 1 cm (2 mm spacing) to NN/g; unverified against NN/g directly — [UXPin](https://www.uxpin.com/studio/blog/responsive-design-touch-devices-key-considerations/)

### Inferences
- Geometry at 390pt with 16pt side margins and 8pt gutters (my arithmetic): 1 col ~358pt, 2 cols ~175pt, 3 cols ~117pt (16pt margins, 8pt gutters => (390-32-16)/3 = 114pt), 4 cols ~84pt ((390-32-24)/4).
- At 4 columns (~84pt) a 44pt heart overlay covers over half the card width; use a non-overlapping approach (no heart, tap-to-open only, long-press for save) or a 44pt hit area with smaller glyph at 3 columns.
- Suggested hide order as width shrinks (opinion): 4 cols image + price only; 3 cols image + price + (optional one-line brand), no rating, no heart overlay or small glyph; 2 cols full card (image, brand, 2-line name, price, discount, heart, 1 badge); 1 col add rating, size availability, store chip.
- Text floor: do not go below about 11pt for price/brand (opinion; Apple HIG lists 11pt as its smallest text style, not retrieved here, so verify).

### Gaps
- No source on minimum legible font size for dense cards; no primary Apple/Google pages fetched.

## Aspect ratios, gutters, and tiny-size price/discount display

### Takeaway
No sourced guidance found. 3:4 or 4:5 portrait ratios are common in fashion but unverified here.

### Cited Findings
- None retrievable.

### Inferences
- Keep one ratio (4:5 or 3:4) across all densities so toggling does not reflow content unpredictably (opinion). Gutters 8pt at 2 columns, 4-6pt at 3-4 columns (opinion).
- Product rule from project spec: show strike-through or "% off" only when verified (VRP, master prompt section 9); at 3-4 columns show only the current price and a single "Verified" mark or "-X%" chip, never an unverified reference price.

### Gaps
- No A/B or heuristic source on price legibility at small sizes.

## Overview mode and density toggle: default, discoverability, icon design

### Takeaway
Grid/list toggles are a common plugin pattern, but no evidence on default density, discoverability, or glyph comprehension was found.

### Cited Findings
- Commerce platforms ship grid/list toggles operated by single-click icons — [Shopware](https://store.shopware.com/en/ictec84115991924/switch-grid-list-view-in-product-listing-page.html), [WooCommerce plugin](https://wordpress.org/plugins/grid-list-toggle-for-woocommerce/)

### Inferences
- A single cycling button showing the glyph of the next/current density (single square, 2x2, 3x3) is a convention-based choice; persist the choice per user. Treat 4 columns as opt-in overview, never default.

### Gaps
- No study of toggle discoverability, icon comprehension, or overview-only mode with tap-to-open found.

## Single filter icon button beside search (~44pt) with count badge

### Takeaway
Badge-count on a Filter button and a sticky filter bar are recommended by practitioner sources; Baymard's mobile filter findings are paywalled.

### Cited Findings
- Baymard notes mobile filters usually live in a separate interface, causing repeated trips between list and filter screen — [Baymard filtering options](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options)
- Showing matching counts per filter option builds confidence before tapping (desktop article) — [Baymard](https://baymard.com/learn/ecommerce-filter-ui)
- Sticky "Filter & Sort" bar with "Filter (2)" badge to show active filters — [GrowthSuite](https://www.growthsuite.net/questions/should-i-show-filters-on-mobile-or-hide-them) (low-authority)
- Badge count on Filters button indicates active filters — [GoHighLevel changelog](https://ideas.gohighlevel.com/changelog/mobile-ui-improvements-sorting-filtering)

### Inferences
- An icon-only button loses the text label that makes "Filter" discoverable; add an accessible name and consider a labelled variant if testing shows misses (opinion). Show live result count inside the sheet's apply button.
- Keep the badge from overlapping the 44pt target edge; mirror position in RTL.

### Gaps
- No Baymard or NN/g evidence on icon-only vs labelled filter buttons or badge pitfalls.
