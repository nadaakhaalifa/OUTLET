# Pinch-to-change-density product grid and consolidated filter sheet: pitfalls and risks (RN 0.86 / FlashList 2 / Reanimated 4 / RNGH 2.32)

Research depth note: this pass was limited (about 12 tool calls). Many search snippets came from third-party mirrors (mintlify) and did not confirm issue resolutions. Items without a primary source are in Gaps/Inferences, not Cited Findings. Treat severity ranks as judgment calls.

## Gesture conflicts (pinch vs scroll, carousels, pull-to-refresh, back-swipe, sheet drag; Android two-finger)

### Takeaway
Pinch inside a scroll container needs explicit relations to the native scroll gesture; the documented tools are `simultaneousWithExternalGesture` / `blocksExternalGesture`, and relations only work if the other gesture is attached to a detector. Android pinch inside ScrollView/FlatList has a history of bugs; verify on device for 2.32.

### Cited Findings
- `simultaneousWithExternalGesture` only marks a relation and does not compose; the other gesture must be attached to another detector to be recognized — [RNGH pinch docs](https://docs.swmansion.com/react-native-gesture-handler/docs/gestures/pinch-gesture) (via search summary; page fetch returned empty)
- Docs describe Simultaneous composition where activation of one does not cancel the other — [Gesture composition](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/gesture-composition)
- Issue #2617 reports a Pan with `simultaneousWithExternalGesture(scrollRef)` working with ScrollView but not FlatList — [issue 2617](https://github.com/software-mansion/react-native-gesture-handler/issues/2617) (resolution not seen)
- PR #2370 "Fixed faulty pinch gesture handler on Android when in a ScrollView/FlatList" (opened Jan 2023; merge status not confirmed) — [RNGH pulls](https://redirect.github.com/software-mansion/react-native-gesture-handler/pulls)
- Docs warn against nesting detectors that use different APIs (undefined behavior); this wording is from the v3 docs and the InterceptingGestureDetector workaround is v3-only — [Gesture detectors](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/gesture-detectors)
- Gesture objects have `withTestId(testID)` for test queries — [RNGH pinch docs 2.x](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/pinch-gesture)

### Inferences
- Risk (High): one GestureDetector wrapping the FlashList plus horizontal chip rows inside it will contest horizontal pans; keep chip rows outside the pinch detector's hit area or use `blocksExternalGesture` only for the vertical list.
- Risk (Medium): do not nest an RNGH detector inside a legacy-API detector or v3-style component; use one API generation per subtree.
- Pull-to-refresh, iOS back-swipe and sheet-drag are native/other-handler gestures; pinch is two-pointer so conflicts are mostly on pointer-count transitions (second finger landing mid-scroll). Needs device testing.

### Gaps
- No confirmed source for Android two-finger scroll behavior, iOS back-swipe interplay, or refresh-control interplay with pinch.
- Whether PR #2370 shipped and applies to 2.32 is unverified.

## Jank sources on relayout (numColumns, size estimates, image decode, shadows, layout animation)

### Takeaway
FlashList 2 removed size estimates and enables `maintainVisibleContentPosition` by default; numColumns runtime change behavior is undocumented in sources found, so assume remount may be needed and test.

### Cited Findings
- v2 removes `estimatedItemSize`, `estimatedListSize`, `estimatedFirstItemOffset` — [FlashList v2 migration](https://www.mintlify.com/shopify/flash-list/migration/v2-migration)
- `maintainVisibleContentPosition` is on by default in v2 "to reduce visible glitches"; large top insertions may need larger `drawDistance` — [v2 changes](https://mintlify.wiki/shopify/flash-list/migration/v2-changes)
- `maxItemsInRecyclePool` defaults are usually fine; 0 disables the pool; `useRecyclingState` resets when deps change — [v2 changes](https://mintlify.wiki/shopify/flash-list/migration/v2-changes)
- Some props (e.g. `horizontal`) require a `key` change to remount — [FlashList usage docs](https://www.mintlify.com/shopify/flash-list/fundamentals/usage) (numColumns not confirmed)
- A user reported FlashList photo columns "jumping" out of view on orientation change (layout change analogue) — [freelancehunt post](https://freelancehunt.com/en/project/problema-pri-zmini-orientatsiyi-flashlist/1438591.html) (low authority)

### Inferences
- Risk (High): going 2 to 4 columns roughly doubles visible cells and image decodes at once; use small thumbnail variants per density, `expo-image` with memory caching, and avoid per-cell shadows and blurhash recompute (shadows and blurhash cost not sourced).
- Risk (Medium): animating relayout with LayoutAnimation on Android is unsourced here; prefer a cross-fade/opacity change over animating cell geometry.
- Test setting `key={numColumns}` versus plain prop change; the key remount loses scroll position unless you restore it by item index.

### Gaps
- No primary source on image decode cost at 4 columns, blurhash cost, shadows, or Android LayoutAnimation; no Shopify/Discord/Wix/Bluesky blog was retrieved.

## Correctness (scroll anchor, keys, state loss, wishlist state, a11y focus)

### Takeaway
Anchor loss is the likeliest bug; keep wishlist/heart state outside cells because recycling resets cell-local state.

### Cited Findings
- `useRecyclingState` exists because recycled cells reset state on deps change — [v2 changes](https://mintlify.wiki/shopify/flash-list/migration/v2-changes)
- Stable keys help recycling avoid glitches when scrolling upward — [reactnativerelay](https://reactnativerelay.com/article/react-native-flashlist-v2-expo-high-performance-lists-migration) (third-party blog)

### Inferences
- Persist the first visible item id (from `onViewableItemsChanged`) before changing columns and `scrollToIndex` to its row after layout; accept that this needs a frame delay.
- Heart state should come from a store keyed by product id, not component state.
- Announce the new density via accessibility announcement and keep focus on the density control, since cells remount.
- Duplicate-key risk arises only if the same product appears twice (sponsored plus organic); dedupe in the view-model.

### Gaps
- No sourced evidence on VoiceOver/TalkBack focus loss after FlashList relayout.

## Consolidated filter sheet (state, badge, keyboard, RTL)

### Takeaway
Keep draft and applied filter state in a store above the sheet, not inside sheet content; keyboard height vs snap points is a documented gotcha in gorhom bottom-sheet.

### Cited Findings
- Focusing a TextInput can trigger `onClose` when a snap point is at or near the keyboard height — [gorhom issue 1356](https://github.com/gorhom/react-native-bottom-sheet/issues/1356) (via search summary)
- Custom `backdropComponent` stayed visible after close in a reported case — [gorhom issues](https://github.com/gorhom/react-native-bottom-sheet/issues/1602) (summary only)
- Keyboard-handling complexity on complex screens — [GeekyAnts](https://geekyants.com/blog/the-keyboard-bounce-of-death-handling-inputs-on-complex-react-native-screens)

### Inferences
- Badge count must derive from the applied state (pure selector), not draft state; compute it in the same pure module as the filters for testability.
- Use `BottomSheetTextInput`-style keyboard-aware inputs and a snap point clearly above keyboard height.
- RTL sheet behavior: no source found; verify swipe direction, chip row scroll origin, and `I18nManager` flip on device.

### Gaps
- No RTL-specific source. Which sheet library this project uses was not checked.

## Testing strategy (vitest pure logic, Maestro)

### Takeaway
Extract density logic to a pure module and test it in vitest; for Maestro, provide an accessible button.

### Cited Findings
- `withTestId` on gestures supports test queries — [RNGH docs](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/pinch-gesture)
- RN accessibility: accessible views should have `accessibilityLabel` — [RN accessibility docs](https://reactnative.dev/docs/0.83/accessibility)

### Inferences
- Pure module: `stepFromScale(currentStep, scale)`, thresholds with hysteresis (for example scale > 1.15 steps one down, < 0.87 one up), clamp to [min, max], one step per gesture, and a storage adapter interface for persistence. Test thresholds at boundaries, clamping at both ends, repeated gestures, invalid persisted values (fall back to default), and a property test that output is always within range.
- Maestro: I found no source confirming a pinch command; do not rely on it. Add a visible "grid density" button (or `-`/`+` pair) with testID and Arabic/English accessibility labels, tap it in the flow and assert column count via a testID on the list (for example `grid-columns-3`). This also serves as the accessible alternative for users who cannot pinch.

### Gaps
- Maestro docs on pinch/gesture support not retrieved.

## Ranked risk register (judgment)
1. High: pinch recognizer vs FlashList/ScrollView scroll and horizontal rows (Android especially). Mitigate: explicit external-gesture relations, on-device tests, button fallback.
2. High: scroll anchor loss on column change. Mitigate: restore by item id.
3. High: decode/memory spike at 4 columns. Mitigate: density-specific image sizes, cache policy, measure.
4. Medium: state loss in recycled cells. Mitigate: store-backed state.
5. Medium: filter sheet keyboard/snap interplay and RTL. Mitigate: store-backed draft/applied state, snap above keyboard.
6. Medium: untestable pinch in e2e. Mitigate: button alternative.
7. Low: duplicate keys, a11y announcement. Mitigate: dedupe, announce.
