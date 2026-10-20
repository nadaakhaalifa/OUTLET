# UI standards and React Native implementation guidance: mobile fashion filters (Arabic-first RTL)

Research coverage note: about 18 tool calls. Baymard full mobile guidelines (351 findings) are Premium and were not read. Several fetches (Apple HIG, Material 3, RN a11y/I18nManager docs) returned no page content, so those areas have no cited findings and are listed under Gaps. WebFetch summaries come from a small model and may paraphrase; verify exact quotes before external use.

## Baymard public findings on filtering UX

### Takeaway
Baymard's public pages support: an applied-filters overview (horizontal scroll with truncation, fade and a text count), dual-handle price slider plus text input, multi-select within a filter type, swatches with labels, size high in the panel, and sticky filter trigger with a "Show X results" button. Statistics differ between Baymard pages and the mobile "apply vs live" advice comes from a single page whose summary is unverified.

### Cited Findings
- Baymard's mobile Filtering Options benchmark page: 509 mobile examples across 93 sites; the 351 mobile research findings and many example thumbnails are Premium-only (paywalled). — [Baymard mobile filtering options](https://baymard.com/mcommerce-usability/benchmark/mobile-page-types/filtering-options)
- Applied filters overview: 28% of benchmark sites show none (the 2025 state-of-the-art article says 20%; same-topic figures conflict between Baymard pages, likely benchmark versions). — [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters); [Current state PL and filtering](https://baymard.com/blog/current-state-product-list-and-filtering)
- Mobile applied-filter patterns: horizontally scrolling list above the product list, truncating filters that do not fit, only when at least half of the cut-off chip is visible; a faded edge; a text header such as "4 Filters Applied". Combining the three signals is called the ideal mobile approach. Stacked rows avoid scrolling but push products down; a "See All Applied Filters" variant shows one or two rows. — [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters)
- Do not show only a count of applied filters; users must see the options without reopening the interface. Users frequently skip text. — [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters)
- Example: with 5 applied filters only about a dozen products remained; removing 2 auto-applied filters on a mobile site that closes the interface after each deselection takes 2 trips to the filter UI. — [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters)
- 97% of benchmark sites leave the chosen option in its original position (not moved to top). — [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters)
- Five essential filter types (Price, User rating, Color, Size, Brand): 51% of sites miss some (57% on related-article link; conflict). — [Current state](https://baymard.com/blog/current-state-product-list-and-filtering); [Five essential filters](https://baymard.com/blog/5-essential-filters)
- 14% of sites do not allow combining values of the same filter type (multi-select). — [Current state](https://baymard.com/blog/current-state-product-list-and-filtering)
- Four essential sort types (price, user rating, best selling, newest): 69% of sites lack all four (mobile 69%, desktop 68% per article; related link says 64%). — [Current state](https://baymard.com/blog/current-state-product-list-and-filtering); [Product list collection](https://baymard.com/blog/collections/product-list)
- 78% of mobile sites have mediocre or worse product list UX vs 58% desktop. — [Current state](https://baymard.com/blog/current-state-product-list-and-filtering)
- Mobile filter UI guidance: full-screen overlay or bottom sheet from a labelled button, sticky trigger, "Show X Results" button updating live, 44x44 pt targets, collapsible groups; mobile filters perform worse than desktop. — [Baymard ecommerce filter UI](https://baymard.com/blog/ecommerce-filter-ui) (fetch summary; verify)
- Same page: AND between filter types, OR within; checkboxes not radios; swatches for fashion with a label/tooltip; keep Size open near top; dual-handle price slider paired with text input; avoid empty results by preventing or giving a recovery path. — [Baymard ecommerce filter UI](https://baymard.com/blog/ecommerce-filter-ui) (fetch summary; verify)
- Same page says mobile should require an explicit apply action because live updates can disorient. Note this conflicts with the "Show N items" live-count footer only if results re-render live; a live count on the button with deferred list refresh is consistent. — [Baymard ecommerce filter UI](https://baymard.com/blog/ecommerce-filter-ui) (single unverified summary)
- Filters set inclusion, sorting sets order (keep separate sheets). Price: users should define own ranges; range sliders work with care; pair with text input. — [Baymard search snippet of Product list collection](https://baymard.com/blog/collections/product-list)

### Inferences
- A sticky quick-filter bar plus an applied chips row plus a "N filters" text label satisfies Baymard's three-signal mobile pattern.
- Facet-sorted-by-relevance and number-of-filters guidance: Baymard figures not retrieved; the "5 to 10 attributes" number came from the fetch summary without a clear Baymard origin and should not be quoted.

### Gaps
- Baymard filter-sorting-by-relevance, dead-end prevention, colour/size, price slider and mobile apply-vs-live exact figures: Premium-only or not in fetched text.
- Exact article pages for dead-ends and slider were not found by search.

## NN/g, Material 3, Apple HIG, WCAG

### Takeaway
Only WCAG was successfully sourced. NN/g, Material and HIG pages returned no usable content; nothing from them is cited.

### Cited Findings
- WCAG 2.2 SC 2.5.8 (AA): pointer targets at least 24x24 CSS px unless spacing (24px circle centred on target does not intersect another), equivalent control, inline, user-agent, or essential exceptions. — [W3C 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- SC 1.4.11 (AA): UI component identification and state indicators (selected, focused) need 3:1 against adjacent colours; ratios not rounded; disabled exempt. Applies to swatch selection ring and slider track/thumb. — [W3C 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- SC 1.4.1 (A): colour must not be the only visual means of conveying information, so swatches need a text label or check mark. — [W3C 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- Baymard recommends labels/tooltips on swatches and 44x44 pt targets. — [Baymard ecommerce filter UI](https://baymard.com/blog/ecommerce-filter-ui)

### Inferences
- Use 44 pt for all chips, swatches, size cells and slider thumbs (exceeds 2.5.8; SC 2.5.5 AAA was not fetched).
- Selected swatch: ring plus check glyph plus accessible name, never colour alone.

### Gaps
- NN/g articles, Material 3 chips/sliders/bottom sheets, Apple HIG sheets/detents/segmented controls, WCAG 2.5.5: not retrieved. A model-memory summary of Apple sheet APIs (detents medium/large, grabber, visible close button for VoiceOver) exists but is UNSOURCED and must be verified at developer.apple.com.

## React Native implementation (sheet, slider, list, scroll)

### Takeaway
Gorhom bottom sheet supports FlashList, FlatList, modal presentation, keyboard handling and needs Reanimated and Gesture Handler; Reanimated's useAnimatedScrollHandler requires Animated-wrapped scrollables. Slider, histogram, RTL and a11y library details were not verified.

### Cited Findings
- @gorhom/bottom-sheet v5 docs list: RN Web, dynamic sizing, FlashList support, a Bottom Sheet Modal, snapping, keyboard handling, FlatList/SectionList/ScrollView/View scrolling, React Navigation integration, TypeScript; requires react-native-reanimated and react-native-gesture-handler with GestureHandlerRootView. The page gives no RTL or accessibility details. — [Gorhom docs](https://gorhom.dev/react-native-bottom-sheet/)
- Reanimated useAnimatedScrollHandler: returns a handler for onScroll (also onBeginDrag, onEndDrag, onMomentumBegin/End); must be attached to an Animated component (e.g., Animated.ScrollView); context persists across events. — [Reanimated docs](https://docs.swmansion.com/react-native-reanimated/docs/scroll/useAnimatedScrollHandler/)
- FlashList: stickyHeaderIndices with stickyHeaderConfig (offset, zIndex default 2, hideRelatedCell, backdropComponent, useNativeDriver default true), ListHeaderComponent, numColumns with horizontal={false} (zig-zag, equal-height items; docs inconsistent on masonry), v2 no longer reads size estimates, valid keyExtractor recommended; onScroll falls through to the underlying ScrollView; RTL not covered. — [FlashList usage](https://shopify.github.io/flash-list/docs/usage/)
- react-native-multi-slider: enabledOne/enabledTwo props; page shows no RTL or accessibility docs and no visible release info (184 commits, 77 open issues). — [react-native-multi-slider](https://github.com/ptomasroos/react-native-multi-slider)

### Inferences
- Custom Gesture Handler + Reanimated slider with a histogram in react-native-svg is the safest route for RTL and `accessibilityActions` increment/decrement, because the evaluated library documents neither. Needs a prototype.
- Collapse-on-scroll: derive direction from scroll delta in a shared value; keep the sticky quick-filter bar pinned and translate only the top header; verify against FlashList sticky header behaviour on device.
- Live counts: debounce (about 250 ms), send a monotonically increasing request id and ignore stale responses (or AbortController); the footer shows the last confirmed count with a subtle loading state, never a blocking spinner.
- Reducers pure; serialize filter state to route params for deep links; persist last filters per category in MMKV (no PII).
- Anti-patterns to avoid: layout-jumping from hiding zero-count options (disable and keep in place instead), resetting scroll on apply, blocking spinners. Baymard-sourced support: keep chosen option in place (97% do) per [Applied filters article](https://baymard.com/blog/how-to-design-applied-filters).

### Gaps
- @react-native-community/slider, rn-range-slider, Skia histogram, Reduce Motion API (AccessibilityInfo.isReduceMotionEnabled), accessibilityValue/adjustable actions and accessibilityState docs: fetch failed or not attempted; unsourced.
- Native Expo/RN modal with detents (e.g., react-native-screens formSheet): not researched.

## RTL specifics

### Takeaway
No RTL claims could be sourced. Neither Gorhom, FlashList nor multi-slider docs address RTL.

### Cited Findings
- Gorhom, FlashList usage and multi-slider pages do not mention RTL. — [Gorhom](https://gorhom.dev/react-native-bottom-sheet/); [FlashList](https://shopify.github.io/flash-list/docs/usage/); [multi-slider](https://github.com/ptomasroos/react-native-multi-slider)

### Inferences (unsourced)
- In RTL the min thumb sits on the right: map value to `isRTL ? width - x : x` in a custom slider and test on device.
- Format counts/prices with `Intl.NumberFormat('ar-EG')` (Hermes Intl support must be verified); mirror chevrons; truncate long Arabic labels with tail ellipsis and allow two lines; test text expansion.

### Gaps
- React Native I18nManager docs fetch failed; Intl.NumberFormat support on Hermes not checked.

## Testing approaches

### Takeaway
Nothing sourced; recommendations are inference.

### Inferences (unsourced)
- fast-check properties: reducer idempotence, apply-then-clear equals initial, serialize/parse round-trip, never selecting a value outside the facet list.
- Facet-count consistency: for each option, count equals result length when applied alone (server contract test).
- Maestro iOS flow: open sheet, expand section, pick swatch and size, assert footer "Show N" in ar-EG numerals, apply, assert chips row and scroll offset retained.
- A11y: assert labels such as "Size, 2 selected", Dynamic Type, Reduce Motion, 44 pt target checks.

### Gaps
- No sources fetched for Maestro, fast-check or RN a11y testing.
