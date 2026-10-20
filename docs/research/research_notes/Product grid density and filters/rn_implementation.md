# Changeable-column product grid with pinch-to-zoom density (RN / Expo)

Scope: FlashList 2.0.x, Reanimated 4 + worklets, Gesture Handler 2.32, expo-image, MMKV. Only official docs and search results were available; nothing was run on a device. Code sketches are mine, built from the cited API names, and are untested.

## FlashList 2 and numColumns at runtime

### Takeaway
No official doc says numColumns can change at runtime without a remount, and none says it cannot. Treat a `key` that includes the column count as the safe default (a remount), and verify without it on device first.

### Cited Findings
- The v2 migration guide lists numColumns as unchanged; v2 requires the New Architecture, maintainVisibleContentPosition is on by default ("better scroll position handling"), estimatedItemSize and related estimate props are no longer needed, and `masonry` is now a prop (MasonryFlashList deprecated) — [FlashList v2 migration](https://shopify.github.io/flash-list/docs/v2-migration)
- The usage docs: multiple columns need `horizontal={false}`, items zig-zag like flexWrap, same-height items are assumed; the usage page does not state whether numColumns can change at runtime — [FlashList usage](https://shopify.github.io/flash-list/docs/usage)
- maintainVisibleContentPosition options: `disabled`, `autoscrollToTopThreshold`, `autoscrollToBottomThreshold`, `animateAutoScrollToBottom`, `startRenderingFromBottom` — [FlashList usage](https://shopify.github.io/flash-list/docs/usage)
- Strongly recommended: a valid `keyExtractor` in v2 to prevent glitches when layouts change while scrolling upward; `extraData` is needed when renderItem depends on outside state (PureComponent) — [FlashList usage](https://shopify.github.io/flash-list/docs/usage)
- `getItemType` controls recycling pools (default type 0); called very frequently, keep it fast — [FlashList usage](https://shopify.github.io/flash-list/docs/usage)
- Known-issues page (via search summary): the `horizontal` prop cannot be toggled dynamically and a `key` on FlashList forces recreation; numColumns is not named there — [known issues](https://www.mintlify.com/shopify/flash-list/known-issues) (third-party mirror of the docs)
- Issue #874 (v1.4.3): changing columns on rotation/resize left the first row broken; a maintainer suggested `clearLayoutCacheOnUpdate()` on the ref — [flash-list #874](https://github.com/Shopify/flash-list/issues/874); not confirmed for v2

### Inferences
- Because the layout cache is per-column-width, a column change on a mounted v2 list is the same class of problem as rotation. Safest: `key={`grid-${columns}`}` (remount, recycling pool resets), or no key plus a ref call to clear layout cache only if tests show glitches. Remount loses scroll offset, so restore it by index.
- Anchor: capture first visible index from `onViewableItemsChanged` (or `viewabilityConfig`), keep it in a ref, and after the column change call `scrollToIndex({ index: anchorIndex, animated: false })` on the new ref (via `initialScrollIndex` when remounting). Row index changes with columns, so use item index, not offset. maintainVisibleContentPosition targets content insertion, not column reflow, so do not rely on it for this.

### Gaps
- No doc statement or issue found for numColumns change on v2.0.x specifically. Needs a device spike (iOS and a mid-range Android).
- `initialScrollIndex` and `scrollToIndex` behaviour with changed numColumns not documented in sources read.

## Pinch gesture, discretisation, coexistence with scroll

### Takeaway
Use a Gesture Handler pinch with `scale` (starts at 1.0), decide the step in `onEnd`/`onUpdate` on the UI thread with a threshold plus hysteresis, and hop to JS to update state and fire haptics. Compose it with the list's scroll via `simultaneousWithExternalGesture` or a native-gesture wrapper.

### Cited Findings
- GH 2.x Pinch: `onUpdate`, `onEnd` (fires only if active), `scale` starts at 1.0, `runOnJS(boolean)` (default false, so callbacks run on UI thread when worklets are available), `simultaneousWithExternalGesture(...)`, `requireExternalGestureToFail(...)`; page notes 2.x is no longer actively maintained — [GH 2.x pinch](https://docs.swmansion.com/react-native-gesture-handler/docs/2.x/gestures/pinch-gesture)
- GH 3.x docs use a `usePinchGesture` hook with `onBegin/onActivate/onUpdate/onDeactivate/onFinalize` (no `onEnd`), `scaleChange`, `focalX/Y`, and `simultaneousWith` config — [GH 3 pinch](https://docs.swmansion.com/react-native-gesture-handler/docs/gestures/use-pinch-gesture). The request says 2.32; I could not confirm whether 2.32 ships the hook API, so the sketch uses the 2.x `Gesture.Pinch()` names.
- Reanimated 4 moved worklets to `react-native-worklets`; recommended replacement for `runOnJS` is `scheduleOnRN(fn, ...args)` from `react-native-worklets`; one source says runOnJS is removed, another lists it as deprecated — [React Doctor rule](https://www.react.doctor/docs/rules/react-doctor/rn-reanimated-4-use-worklets-scheduler) (secondary); conflict with [Amazon Vega worklets reference](https://developer.amazon.com/docs/vega-api/0.24/react-native-worklets.html)
- Haptics: `Haptics.selectionAsync()` and `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light|Medium|Heavy|Rigid|Soft)`; on Android impactAsync uses Vibrator, `performAndroidHapticsAsync` with `AndroidHaptics` is recommended — [Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/)

### Inferences
- Pinch-out (scale > 1.25) means fewer columns (bigger cells); pinch-in (scale < 0.8) means more columns. Using 1.25 and its reciprocal 0.8 is symmetric on a log scale. Fire once per gesture (a `fired` shared value reset in `onBegin`) so one pinch moves one step; hysteresis comes from that single-fire rule plus resetting only on a new gesture.
- Pull-to-refresh: native RefreshControl is a scroll-view gesture; a two-finger pinch rarely conflicts, but use `Gesture.Simultaneous` / `simultaneousWithExternalGesture` with the list's native gesture and test on both platforms. Not verified in sources.

### Gaps
- No official doc found on pinch + FlashList scroll composition; no verified pattern for passing the list's native gesture handle (FlashList exposes no gesture object in docs read).
- Exact `scheduleOnRN` signature not confirmed from official docs (fetch failed); confirm against the installed react-native-worklets version.

## Animating the transition

### Takeaway
Of the options, FlashList documents only `LayoutAnimation` (with `prepareForLayoutAnimationRender()` and a `keyExtractor`). Reanimated layout transitions with FlashList are undocumented; the safest cheap option is a short opacity cross-fade around a remount.

### Cited Findings
- FlashList layout animation: keep a ref, call `prepareForLayoutAnimationRender()` before `LayoutAnimation.configureNext(...)`, provide `keyExtractor`; LayoutAnimation is experimental on Android — [FlashList layout animation](https://shopify.github.io/flash-list/docs/guides/layout-animation)
- Reanimated `LinearTransition` animates position and dimension; default 300 ms, `.springify()` available; platform support Android, iOS, Web; page does not mention FlashList, `itemLayoutAnimation` or numColumns — [Reanimated layout transitions](https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/layout-transitions/)

### Inferences
- Reanimated layout transitions on recycled cells are likely unreliable (cells reused, not mounted/unmounted); no source confirms either way. Recommended: fade the list to ~0 for ~120 ms using a shared value, change columns (remount, restore anchor), fade in. LayoutAnimation is a second option for iOS only if Android tests glitch.

### Gaps
- No benchmark found for mid-range Android. Needs on-device profiling.

## expo-image in a dense grid

### Takeaway
Always set `recyclingKey`, a blurhash or thumbhash placeholder with matching `placeholderContentFit`, `contentFit="cover"`, and request a CDN image width sized for the cell (cell width x pixel ratio), not full size.

### Cited Findings
- `recyclingKey` clears the view to blank/placeholder when changed; intended for recycling lists such as FlashList — [Expo Image](https://docs.expo.dev/versions/latest/sdk/image/)
- `placeholder={{ blurhash }}` needs `width`/`height` (default 16; higher costs performance); placeholderContentFit defaults to `scale-down` (can flicker) so match `contentFit`; ignored if `uri` also set in same source object — [Expo Image](https://docs.expo.dev/versions/latest/sdk/image/)
- `cachePolicy` default `disk`; `memory-disk` available; `allowDownscaling` default true (downscales to view size); `transition` accepts ms number; `clearMemoryCache()`; iOS `configureCache` with `maxMemoryCost/maxMemoryCount` — [Expo Image](https://docs.expo.dev/versions/latest/sdk/image/)

### Inferences
- Density buckets: compute `uri` width from `PixelRatio.getPixelSizeForLayoutSize(cellWidth)` rounded up to the CDN's allowed widths (e.g. 160/240/360/480/720). Changing density changes the URL, so images refetch; to avoid re-download churn when going denser, keep the larger cached version (cachePolicy `memory-disk`) or pin to widths shared across density 2 and 3. Whether the CDN supports width params is an app decision (not covered by sources).

### Gaps
- No source on expo-image decode memory at 4 to 5 columns; needs measurement.

## Persistence and sharing across screens

### Takeaway
Store the density in MMKV (v4: `createMMKV`, `useMMKVNumber`), read it through one hook so every grid screen shares it reactively.

### Cited Findings
- MMKV v4 is a Nitro module, requires RN 0.76+ and `react-native-nitro-modules`; API `createMMKV({ id })` and `useMMKVNumber(key)` (also `useMMKVString`, `useMMKVBoolean`) — [react-native-mmkv README](https://github.com/mrousavy/react-native-mmkv)

### Inferences
- `useMMKVNumber` subscribes to key changes, so all screens (Shop everything, store, search, category) update together without a context. Not sensitive, so no SecureStore. Give the key a version (`grid.columns.v1`) and clamp on read.

### Gaps
- Not checked: whether the repo already pins MMKV v3 vs v4 (v3 uses `new MMKV()`); check `apps/mobile/package.json`.

## Code sketches (untested; names per sources above)

```ts
// useGridDensity.ts
import { createMMKV } from 'react-native-mmkv'; // v4
import { useMMKVNumber } from 'react-native-mmkv';
const storage = createMMKV({ id: 'ui-prefs' });
export const COLUMN_STEPS = [1, 2, 3, 4] as const;
const clamp = (n: number) => Math.min(4, Math.max(1, Math.round(n)));
export function useGridDensity() {
  const [raw, set] = useMMKVNumber('grid.columns.v1', storage);
  const columns = clamp(raw ?? 2);
  return { columns, setColumns: (n: number) => set(clamp(n)) };
}
```

```tsx
// PinchToDensity.tsx  (GH 2.x names)
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets'; // confirm signature for installed version
import * as Haptics from 'expo-haptics';

export function PinchToDensity({ columns, setColumns, children }: Props) {
  const fired = useSharedValue(false);
  const step = (dir: 1 | -1) => { // dir 1 = denser
    const next = columns + dir;
    if (next < 1 || next > 4) return;
    void Haptics.selectionAsync();
    setColumns(next);
  };
  const pinch = Gesture.Pinch()
    .onBegin(() => { fired.value = false; })
    .onUpdate((e) => {
      if (fired.value) return;
      if (e.scale < 0.8) { fired.value = true; scheduleOnRN(step, 1); }
      else if (e.scale > 1.25) { fired.value = true; scheduleOnRN(step, -1); }
    });
  return <GestureDetector gesture={pinch}>{children}</GestureDetector>;
}
```
Note: wrap in a plain `View` child; check scroll coexistence on device.

```tsx
// Grid usage
<FlashList
  key={`grid-${columns}`}
  numColumns={columns}
  data={items}
  keyExtractor={(i) => i.id}
  getItemType={() => 'product'}
  renderItem={({ item }) => <ProductCard item={item} columns={columns} />}
  extraData={columns}
/>
// ProductCard: <Image recyclingKey={item.id} placeholder={{ blurhash: item.blurhash, width: 16, height: 16 }}
//   placeholderContentFit="cover" contentFit="cover" source={{ uri: sizedUri(item, cellWidth) }} />
// columns >= 3: hide title/brand rows, keep price and badge.
```
