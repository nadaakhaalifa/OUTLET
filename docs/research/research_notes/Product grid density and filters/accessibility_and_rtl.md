# Accessibility and RTL for a pinch-to-zoom grid density control and consolidated filter button

## WCAG 2.2 criteria and what the pinch gesture needs as an alternative

### Takeaway
Pinch is a multipoint gesture, so SC 2.5.1 (Level A) requires a visible single-pointer control (tap/long-press) that changes density. Keep it tap-based, not drag-based, to also satisfy 2.5.7.

### Cited Findings
- 2.5.1 (A): functionality using multipoint or path-based gestures must also work with a single pointer and no path-based gesture, unless essential. Pinch-zoom example: visible zoom in/out buttons are the alternative. — [W3C Understanding 2.5.1](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)
- Single-point actions (tap, double tap, long press) qualify; keyboard operability alone does not; an alternative relying only on dragging conflicts with 2.5.7. — same source
- OS/AT gestures (e.g. screen reader gestures) are out of scope. — same source
- 2.5.7 (AA): anything done by dragging must work with a single click/tap without dragging; a swipe/flick alternative would fail 2.5.1. — [W3C Understanding 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- 2.5.8 (AA): targets at least 24x24 CSS px; exceptions: spacing (24px circle not intersecting others), inline, equivalent control elsewhere, essential. 2.5.5 (AAA) is the stricter enhanced goal. — [W3C Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- 2.3.3 (AAA, not AA): interaction-triggered motion animation should be disableable unless essential; elements that move or resize count as motion. — [W3C Understanding 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- 4.1.2 (A): name and role programmatically determinable; state/value changes must be communicated to assistive tech. — [W3C Understanding 4.1.2](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html)

### Inferences
- Provide a persistent density button (cycles 2/3/4 columns, or a segmented control) in the grid toolbar; pinch is then an enhancement only. Equivalent control also satisfies the 2.5.8 "equivalent" exception for any small element.
- 2.3.3 is AAA, so Reduce Motion handling is best practice, not an AA obligation; still do it (see below).
- Aim for 44pt (Apple) / 48dp (Android) targets even though WCAG AA minimum is 24 CSS px.

### Gaps
- 1.4.4 (Resize Text) and 1.4.10 (Reflow) Understanding pages not fetched; their applicability to native apps is by analogy, and exact text not verified here.

## VoiceOver/TalkBack exposure of the density control and filter badge

### Takeaway
Simplest robust option: a button with a label plus current value in accessibilityValue/state, announced after change. An adjustable role with increment/decrement is possible but has a reported stale-value bug on iOS.

### Cited Findings
- React Native pattern: container with `adjustable` role, `increment`/`decrement` in `accessibilityActions`, handled in `onAccessibilityAction`. — [Formidable AMA carousel guideline](https://formidable.com/open-source/react-native-ama/guidelines/carousel)
- RN typings: `increment` fires on swipe up, `decrement` on swipe down for adjustable elements; other action names include `longpress` (Android only), `magicTap`, `escape` (iOS only). — [RN ViewAccessibility typings](https://app.unpkg.com/react-native-tvos@0.86.0-2/files/Libraries/Components/View/ViewAccessibility.d.ts)
- Reported (RN 0.68.5) iOS VoiceOver sometimes reads the previous accessibilityValue after increment/decrement. — [facebook/react-native#35774](https://github.com/facebook/react-native/issues/35774)
- Android: label meaningful elements, mark decorative icons contentDescription null, use `onClickLabel` for action names, use `stateDescription`/role on custom controls via semantics, keep labels unique in collections. — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)

### Inferences
- Density control: role button, label "Grid density" (AR: localized), value "2 items per row" (localized, plural-aware); on change call `AccessibilityInfo.announceForAccessibility` with the new value to avoid the stale-value bug (verify on device).
- Filter button: label "Filters", value/state "3 filters applied"; hide the visual badge from accessibility tree and fold the count into the button label so it is not read twice. Announce result count after applying.
- Offer `increment`/`decrement` actions additionally so VoiceOver users can swipe to change density.

### Gaps
- Official RN accessibility docs page could not be fetched (tool error); accessibilityValue/announceForAccessibility semantics should be confirmed at reactnative.dev/docs/accessibility.
- No cited source for TalkBack handling of the adjustable role; test on device.

## Dynamic Type, font scaling and column count

### Takeaway
No authoritative source was retrieved; recommendations below are inference.

### Cited Findings
- Android guidance referenced sizing text in sp and 48dp targets, but the fetched page did not state this explicitly (the tool noted it as general guidance). — [Android accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles)

### Inferences
- Read `PixelRatio.getFontScale()` / `useWindowDimensions().fontScale`; cap the maximum columns (e.g. 4 allowed only at fontScale <= 1.0, 3 up to ~1.3, 2 above), and disable the denser options in the density control rather than hide silently.
- Allow card titles to wrap (2-3 lines) rather than truncate at large scale; keep price un-truncated.
- Test at largest accessibility sizes in both iOS and Android.

### Gaps
- Apple HIG Typography/Dynamic Type and Material text scaling pages not retrieved.
- 1.4.4 200% resize rule not verified here.

## Reduce Motion

### Takeaway
2.3.3 is AAA; honor the OS setting anyway.

### Cited Findings
- Interaction-triggered motion (movement or resizing) is what 2.3.3 targets; instant appearance is not animation. — [W3C Understanding 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

### Inferences
- Check `AccessibilityInfo.isReduceMotionEnabled()` and subscribe to `reduceMotionChanged`; when on, swap layout transition for an instant relayout or a short cross-fade (opacity) with no scale/position movement.
- Pinch-driven live scaling is user-driven direct manipulation; still snap without animation under Reduce Motion.

### Gaps
- RN Reanimated/LayoutAnimation Reduce Motion API details not verified from a source.

## RTL/Arabic

### Takeaway
Retrieval of RN and Apple RTL pages failed or returned only generic content, so nothing here is source-verified.

### Cited Findings
- None verified. The Apple HIG fetch returned only generic guidance from the summarizer, not page content; do not cite it.

### Inferences
- With `I18nManager.isRTL`, FlatList/FlashList numColumns rows lay out right-to-left (first item at right) via flexDirection flip; verify on device for both lists, and that RN needs restart/reload after `forceRTL`.
- Mirror directional glyphs only; the grid-density icon (2/3/4 squares) is symmetric and should not be mirrored; filter funnel icon is non-directional.
- Use Arabic-Indic or Western digits consistently per the app numeral preference (spec section 25); format via `Intl.NumberFormat('ar-EG')`; ensure badges set explicit numerals.
- Arabic needs taller line-height (about 1.4-1.6x) and tolerates fewer characters per line in narrow 3-4 column cards; allow 2 lines for titles.

### Gaps
- RN RTL blog and Apple HIG RTL page fetch failed; Material bidirectionality guidance not retrieved.
- Need to verify FlashList RTL behavior.

## Apple HIG pinch in collection views and Material grids

### Takeaway
Not researched successfully.

### Cited Findings
- None.

### Inferences
- Apple Photos changes density via pinch on its library grid; this is common knowledge but not sourced here.

### Gaps
- No HIG or Material page retrieved on pinch-density or grids; needs a follow-up fetch.
