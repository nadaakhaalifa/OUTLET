# Accessibility and RTL audit, mobile screens changed 2026-10-16

Static, read-only review. Paths are under apps/mobile/src unless noted. Line numbers are from the working tree at audit time.
Standards: WCAG 2.2 AA, the project 44pt rule, Apple HIG, RN accessibility APIs, RTL.

## Method and facts established
- RTL is native: `I18nManager.forceRTL` is called in i18n/index.ts:75-85, so `start`/`end` styles and row direction mirror. `Icon directional` additionally applies `scaleX:-1` from `theme.isRTL` (primitives.tsx:145-151). `Text` sets writingDirection per string and maps `align` logically (primitives.tsx:58).
- `MAX_FONT_SCALE = 2` (ui-native/src/logic/touch.ts), so the kit meets 1.4.4. Individual overrides are listed below.
- Kit `Chip`: visual height 34 plus `hitSlop` 5 (controls.tsx:245-263), `minWidth` 44. `IconButton`: 44x44 (glass.tsx:140+). `PressScale` drops the scale under Reduce Motion (primitives.tsx:91+). `BottomSheet` and `GlassSurface` honour reduceMotion and reduceTransparency.
- Resting state, English, light: /stores route screenshot at /Users/nadakhalifa/.claude/jobs/843a52fb/tmp/stores.png. The first page renders as designed: segments outlined, hairline dividers visible, back chevron points left. A floating blue gear (dev tool overlay) is visible and is not app UI.

## Texture contrast (script: /Users/nadakhalifa/.claude/jobs/843a52fb/tmp/tex.mjs, sharp pixel stats of the 128px tiles)
| Backdrop | mean RGB | darkest RGB | L min / mean | textPrimary and accent #0B2527 (mean / darkest) | textSecondary #3F4F49 (mean / darkest) |
|---|---|---|---|---|---|
| fabric-taupe.png, full strength (stores first page) | 203,192,177 | 174,165,152 | 0.382 / 0.538 | 8.95 / 6.60 | 4.83 / **3.56** |
| fabric-taupe-light.png at 45% over #EBE4D4 (soft) | 234,227,213 | 219,212,199 | 0.664 composited darkest | 12.53 / 10.91 | 6.76 / 5.88 |

- The first page uses only textPrimary and accent (StepScreens.tsx:25,50,51,74), so it passes (min 6.60). Secondary text on the full backdrop would fail (3.56 on the darkest thread, under 4.5). Do not use `secondary` text on `<FabricBackdrop />` without `soft`.
- Soft backdrop: secondary text passes everywhere (min 5.88). In practice most lists sit on `colors.surface` cards, which is safer still.
- Other pairs: onSand #3A2312 on storesTile #B8A48C = 6.11. The caption at opacity .85 is about 4.65 (marginal). Pressed tile onSand on #F5EEE3 = 12.75. Dark: onSand on tile 10.15. savings on surface 7.02. textSecondary on surface 7.28.
- Non-text (1.4.11): the field border #6A6856 on bg = 4.45 (ok). The segment-group outline uses accent (ok). The segment divider (accent at 35%) = 2.07 and the Entry hairline are decorative only. The store card border (teal at 45%, 2px) = 2.23; the card is also bounded by its surface fill and photo, so this is acceptable. The hairline alone is 1.43, so never use it as the only boundary of a control.

## Defects

Severity scale: High = blocks or misleads AT or RTL users on a main path; Medium = degrades; Low = polish.

### Shared kit (packages/ui-native)
1. **Medium** glass.tsx:325. `BottomSheet` dismiss backdrop defaults to the English label "Close". FiltersSheet.tsx:27 and LocationSheet.tsx:40 never pass `closeLabel`, so Arabic VoiceOver users hear "Close". Fix: pass a translated `closeLabel` (a `common.close` key exists or should be added), or make it required.
2. **Medium** controls.tsx:362. `SearchField` clear button defaults to English "Clear" (StoresScreen.tsx:202, FiltersSheet and LocationSheet SearchField at LocationSheet.tsx:54 do not pass `clearLabel`). The target is also an 18pt icon plus `hitSlop` 10 = 38pt (under the 44pt project rule, fine for 2.5.8). Fix: pass `clearLabel`, raise `hitSlop` to 13.
3. **Medium** collapse.tsx:48-51. Collapsed header has only height 0 and opacity 0. The children stay in the accessibility tree and the focus order: TalkBack can focus invisible controls (density toggle, sort and department row). The collapse also ignores Reduce Motion (the 220 ms timing at line 25 does not read `reduceMotion`), and a layout that moves under VoiceOver or Switch Control while scrolling is disorienting. Fix: when `reduceMotion` or a screen reader is enabled (AccessibilityInfo.isScreenReaderEnabled), do not collapse (progress stays 1); set `importantForAccessibility="no-hide-descendants"` and `accessibilityElementsHidden` while progress is 0.
4. **Low** primitives.tsx:148. `Icon` hides itself from AT (correct), but there is no `accessibilityIgnoresInvertColors` on photos in StepScreens.tsx:44 and StoresScreen.tsx:100,162. Smart Invert will invert photographs.
5. **Low** controls.tsx:260. `Chip` role "radio" and "checkbox" depend on `accessibilityRole`. RN maps these on iOS to a trait string; verify announcements on device. The "radio" Row (controls.tsx:195) sets `checked`, while radios usually expose `selected`; verify.
6. **Low** glass.tsx:329-333. The sheet grab handle is a gesture-only dismissal (it is not an accessible control). It is covered by the backdrop button and by `onRequestClose`, but `accessibilityEscape` (two-finger Z on iOS) is not implemented. Fix: wrap with a view that has `onAccessibilityEscape`.

### ShopAllScreen / FiltersSheet / collapse
7. **High (RTL, unverified visually)** ShopAllScreen.tsx:462-463 with model.ts:592-597. Grid cell padding uses physical `paddingLeft`/`paddingRight` and the comment asserts that FlashList lays columns out left to right in RTL. If true, the first product sits at the left and reading order is reversed for Arabic (first result should be at the right), and the 2 and 3 column grids read backwards. If false (columns mirror), the gap is still symmetric, so no visual harm but the comment is wrong. Fix: verify on a device in Arabic; if columns are not mirrored, either reverse each row's items, or render with an explicit `direction: "rtl"` wrapper. Keep the padding physical only if the column order is physical.
8. **Medium** ShopAllScreen.tsx:317,330,340 (and StoresScreen.tsx:216). `accessibilityLabel` on a horizontal `ScrollView` has no effect on iOS because it is not an accessibility element. The quick-filter, applied and category groups therefore have no group name. Fix: wrap in a `View accessible={false}` with `accessibilityRole="toolbar"` or give the first child the context; for the applied row, the leading count Text (already a header) is enough, but then drop the dead label.
9. **Medium** ShopAllScreen.tsx:340 and 316-327. Chips in horizontal ScrollViews have `paddingVertical` 4 and 2. `hitSlop` 5 beyond the scroll frame is clipped, so the effective vertical target is 42pt (quick bar) and 38pt (applied chips, 34+4). This is above the 24pt AA minimum but below the project 44pt rule. Fix: `paddingVertical: 5` (quick bar) and 5 (applied row).
10. **Medium** ShopAllScreen.tsx:321. Applied chips use role button with `selected` state true plus a label "Remove X". VoiceOver reads "Remove X, selected, button", which is contradictory. Fix: omit `selected` from the accessibility state (keep it visual), or use the `accessibilityHint`.
11. **Medium** no result-count announcement. Count changes (shop-all-count at line 284, debounced stores list) have no live announcement; iOS ignores `accessibilityLiveRegion`. Fix: call `AccessibilityInfo.announceForAccessibility` with the localized count after filters settle (debounce about 500 ms), or move focus to the count. Related: the loading skeleton `View accessibilityLabel` (StoresScreen.tsx:114) is not an accessible element, so it is silent. Fix: `accessible` + `accessibilityRole="progressbar"` or announce on load.
12. **Low** ShopAllScreen.tsx:247. Departments row has `accessibilityLabel` on a plain View (ignored, same as item 8) and fixed width 76 cells with `space-between`. At 6 departments on a 375pt device cells would overflow; verify with AVATAR_DEPARTMENTS length. Also each cell's visible name has `numberOfLines={1}` (truncates at large type; the a11y label still carries the full name, ok).
13. **Low** ShopAllScreen.tsx:502-503. Title is centered between a back button and a 44pt spacer: symmetric, correct in RTL.
14. **Low** ShopAllScreen.tsx:491. Hero title and tagline are white text on a photo plus Scrim. Contrast depends on the photo and cannot be computed statically (see Not verifiable).
15. **Low** FiltersSheet.tsx:28,54,82. Nested scrollable pickers (maxHeight 240) inside a ScrollView (maxHeight 520): `nestedScrollEnabled` helps Android; with VoiceOver the inner lists are reachable but a 520pt cap plus Dynamic Type 200% pushes the footer "Show items" button below the fold only if the sheet is not scrollable: it is outside the ScrollView, so it stays visible. Verify the heading order (Sort, Discount, Price, Category, Department, Condition, Delivery, Stores) is the visual order: it is.
16. **Low** FiltersSheet.tsx:58-63,67-72. The Department and Condition chips use role "checkbox", while Department is single-select (selected toggles off). Use `radio` semantics in a radiogroup, or keep checkbox and say so in a hint.

### Stores directory first page (StepScreens.tsx)
17. **Medium** StepScreens.tsx:64-78 (Segment). The `accessibilityLabel` is "{mode}, {scope}" ("Online stores, Local"), but the visible text is just "Local". WCAG 2.5.3 passes (visible text is contained) and the context is helpful, but the three segments are not grouped: `SegmentGroup` (line 82) has no role or label. Fix: give the group `accessible={false}` and `accessibilityRole="radiogroup"`/`"toolbar"`, or leave as is (they navigate, so buttons are right).
18. **Low** StepScreens.tsx:44. `accessibilityElementsHidden` on `Image` is iOS only; add `importantForAccessibility="no"` for Android. The two Entry titles are headers and the subtitle is `accessibilityRole="none"`; fine.
19. **Low** StepScreens.tsx:26. The hairline uses `colors.accent` at opacity .25: decorative. OK.
20. **Pass** Segment `minHeight` 48, pressed state inverts fg/bg (onAccent on accent), `PressScale` respects Reduce Motion, divider uses `borderStartWidth` (RTL-safe), arrow icon `directional`. Back button `marginStart:-12` (logical).

### StoresScreen (outlets variant)
21. **High** StoresScreen.tsx:92-108, hero. The accessible Pressable label is "Shop everything" (`storesDir.shopEverything`) but the visible text is "Find the nearest store to you" plus a body line. The label does not contain the visible text (2.5.3 Label in Name fails, so Voice Control users saying the visible words cannot activate it) and the body copy is dropped from the AT output. The destination (/shop-all) also does not match the visible message. Fix: label = `${heroNearestTitle}. ${heroNearestBody}`, or change the visible copy to match the action.
22. **Medium** StoresScreen.tsx:153-180. Each store row has `accessibilityLabel` = "Open {name}" only. The location, open or closed state, hours, distance, discount, delivery and rating (all visible) are not announced. The open or closed state is conveyed by colour and text, so 1.4.1 is fine visually; but 1.3.1 info is lost to screen readers. Fix: compose the label from `v.name`, location line, open state, distance and discount, or add `accessibilityValue`.
23. **Medium** StoresScreen.tsx:174. Hard-coded "km" suffix is not localized (Arabic UI shows Latin "km" next to Arabic digits). Use a translation key ("كم").
24. **Low** StoresScreen.tsx:206-211. Filter badge is `pointerEvents="none"` and its count is in the button label (`buttonLabelCount`): good. It is not `selected`/state-exposed, which is fine. Badge text colour `colors.background` on `colors.accent`: 12+ contrast. The badge at `top:2,end:2` overlaps the 36pt disc and mirrors correctly.
25. **Low** StoresScreen.tsx:170-171. Text mixes a nested `Text` with a bullet string `"  •  "`; the nested Text sets its own role "none" (fine), but in RTL the bullet and time order is bidi-dependent. Verify on device.
26. **Low** StoresScreen.tsx:100,101. Hero photo is positioned with `end:0` and the text with `paddingEnd:150`: mirrors correctly. Photo width is 34% while text reserve is a fixed 150pt; at small widths the text can overlap the photo (not an a11y failure unless it overlaps text; text is on solid accent, fine).
27. **Pass** Back button is `directional`; applied chips Row uses logical gaps; location sheet radiogroup and checkboxes expose role and state; the apply button is disabled with count 0 and reads the real count.

### LocationSheet
28. **Medium** LocationSheet.tsx:44-50. Governorate chips include the count in the label ("Cairo · 12") which VoiceOver reads as "Cairo dot 12". Fix: label "Cairo, 12 outlets" (separate the visible and accessible strings).
29. **Low** LocationSheet.tsx:60-61. Checkbox rows with the governorate suffix "(…)" are long; OK with wrapping.
30. **Low** LocationSheet.tsx:66. `accessibilityRole="summary"` is Android-only (iOS maps to none), harmless.

### QuickActions (home-banners)
31. **Medium** QuickActions.tsx:21-22. `maxScale={1.15}`/`1.1` and `fontSize: 14` on a fixed 66pt tile defeat Dynamic Type for these tiles (1.4.4 requires up to 200% without loss). Fix: let the tile grow (`minHeight` 66, allow 2 lines, `maxScale` 2), or stack the tiles vertically at large text sizes.
32. **Low** QuickActions.tsx:22. The hint caption uses `opacity .85`, giving about 4.65:1 (sand tile) — passes but only just; it fails if the tile colour darkens. Prefer an explicit colour at .85 equivalent or full opacity.
33. **Low** QuickActions.tsx:16. The `brand.ivory + "1F"` top highlight is decorative. Pressed state (storesTilePressed) flips tile to near-white and keeps the onSand text: contrast 12.75, fine; the pressed state is colour plus scale so it is not colour alone (it is also not the only focus indicator; there is no visible keyboard focus style for external keyboards — Low, platform default applies).
34. **Pass** `PressScale` role/label "title, hint", the icon is hidden, the pressed state resets on press out, logic uses `start`/`end` throughout (mirrors).

### FabricBackdrop
35. **Low** FabricBackdrop.tsx:21. Hidden from AT and touch-transparent (good), light theme only. Missing `accessibilityIgnoresInvertColors`. It is purely decorative so Reduce Transparency does not need to remove it; Increase Contrast is not honoured (the weave remains). A switch for it would be a nicety: when `reduceTransparency` is on, consider rendering flat `colors.background` as the texture reduces text-to-background uniformity (worst-case contrast above still passes).
36. **Low** Texture: tile is 128px with `resizeMode="repeat"` at window size; at @2x/@3x the pixel stats were not computed (only the 1x tile), assumed the same.

## What is fine (summary)
Targets 44pt via kit hitSlop or `minHeight` on every control except the cases above. All icon-only buttons have labels (back, search, bag, filter, close). Headers are marked (`accessibilityRole="header"`) on titles, sheet titles and section headings. Directional icons use the `directional` prop (back chevron, forward arrow, row chevrons). Logical `start`/`end` and `marginStart`/`borderStartWidth` are used in all audited layouts; the only physical styles are the intentional ones in the grid cell padding (item 7) and `Text` align mapping. Reduce Motion is honoured by PressScale, BottomSheet and SegmentedControl (not by the collapse header). Reduce Transparency is honoured by `GlassSurface` (solid fallback). Money and counts use localized digits through `num`/`localizeDigits`.

## Counts by severity
High: 2 (items 7, 21). Medium: 11 (1, 2, 3, 8, 9, 10, 11, 22, 23, 28, 31). Low: 22. Passes noted per screen above.

## Not verifiable statically
- Real VoiceOver and TalkBack output: role words for `radio`/`checkbox` chips, focus order, the "selected" announcement on remove chips, whether alpha 0 collapsed header items are skipped on iOS.
- Actual RTL rendering: FlashList column order and gap (item 7), horizontal ScrollView start position in RTL (RN mirrors the content origin natively with forceRTL, but this needs a device check), bidi order of the bullet line and "km", icon flips.
- No language switch was exercised: the app has no query-param language switch for these routes (only `__styleguide` and `__purchase` accept `?lang=`), and the simulator language setting may not be changed. Only the resting English state of /stores was captured.
- Photo-over-text contrast (hero title, glass buttons on photographs), actual rendering of the 45% weave on devices with different gamma, Dynamic Type 200% layouts, Increase Contrast, Smart Invert, Switch Control and Voice Control behaviour, and haptics (the kit calls `selectionTick` on rows; no haptic is attached to chips or segments, a design choice).
