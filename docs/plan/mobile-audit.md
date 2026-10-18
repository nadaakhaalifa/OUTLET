# Mobile audit (apps/mobile, packages/ui-native, packages/ui-tokens)

Read-only audit, static (grep + targeted reads; nothing was run). Line numbers are from the working tree at audit time and may drift while screens are being edited. Severity: blocker (ships wrong or unsafe), high, medium, low.

Overall: the screens are in good shape. RTL is handled through `start`/`end`, the `Icon directional` prop and `Text` alignment helpers; no raw `marginLeft/Right`, `left:`/`right:` or `row-reverse` remain. Pressables are almost all roled. Worklets use inline math with documented twins. The real gaps are list performance (zero FlashList usage), v1 naming/hex leftovers in the UI kit, fixture leakage when a real API URL is set, Latin tokens in AR strings, and dead dependencies.

---

## Top findings (ordered)

| # | Sev | Where | Finding |
|---|---|---|---|
| 1 | high | apps/mobile (all list screens) | `@shopify/flash-list` is a dependency and is imported nowhere. No FlatList/FlashList anywhere: every list is `ScrollView` + `.map` (Orders, Search results, Wallet transactions, Home, Stylist, Chat, Wishlists, Returns). Unbounded data will mount fully. |
| 2 | high | apps/mobile/src/features/brand-mode/fake.ts:62, features/me/model.ts:60-66, features/brand-apply/registry.ts:17 | Fixture identity ("Nada", Cairo address, owner) and `InMemoryBrandModePort` are the default when no brand port is registered; Me reads the default port in real-API mode until `brand-mode/state.ts:50` runs. Fixture can show in the Me switcher. |
| 3 | high | packages/ui-native/src/components/glass.tsx:119, 161; features/role-choice/RoleChoiceScreen.tsx:84, 93 | Raw colour literals in the UI kit (`tint: "rgba(10,8,7,0.5)"` is the v1 obsidian `#0A0807`; `rgba(7,26,28,0.5)` is the DEEP teal; `colors.champagne` is the v1 token). |
| 4 | high | packages/ui-tokens/src/index.ts:5-6, 48-49, 99, 133 | Header still documents "OBSIDIAN & IVORY ... BORDEAUX"; `champagne` kept as a v1 alias of `sand` (two values: `#D9BFA0` light, `#C9AE8A` dark, so not even the same as `sand` in dark?). Used only in glass.tsx:119 and logic/glass.ts:42 (comment). |
| 5 | high | packages/ui-native/src/logic/palette.ts:17-18 | Hex literals in the Plus/gold badge palette (`#FFF4D6`, `#4A3500`, `#E0B84A`, `#3A2D05`, `#FFE9A8`, `#8A6D12`) outside the token package. Move into `ui-tokens` as `plus*` roles (note `onPlus` is already an unused token). |
| 6 | medium | apps/mobile/src/art/palette.ts, art-geometry.ts, ProductArt.tsx, StoreArt.tsx, HeroArt.tsx | ~80 hex literals for generative art. Acceptable as art, but they duplicate `brand` tokens (`INK #0B2527`, `DEEP #071A1C`, `TEAL #12403F`, `SAND #D9BFA0`, `SAGE #7FA58F`, `PAPER #F4EFE6`). Import from `@outlet/ui-tokens` brand palette, else the two drift. |
| 7 | medium | packages/i18n/src/ar.ts (see section 7) | Latin tokens in Arabic strings: "Plus", "SKU", "GTIN", "IBAN", "YYYY-MM-DD", "DNS", "PDF/JPG/PNG". |
| 8 | medium | apps/mobile/package.json:12 | `@expo-google-fonts/ibm-plex-sans` (Latin) is unused. Also `expo-linking` and `@outlet/analytics`, `@outlet/auth-core` have zero source imports in apps/mobile/src. `@shopify/flash-list` is unused (see 1). |
| 9 | medium | apps/mobile/assets/fonts, theme/fonts.ts:11-19 | Bundled fonts that nothing selects: `PlayfairDisplay_400Regular_Italic` (token `displayLatinItalic`, check usage), `PlayfairDisplay_600SemiBold`/`400Regular` only via weight tokens `300/400/600`. Verify each weight is reachable, else drop to cut bundle size. |
| 10 | medium | packages/ui-native/src/components/controls.tsx:147 | `Chip` visual `minHeight: 38` (under 44pt); no hitSlop on the `PressScale` wrapper at line 155. Add `hitSlop` of 3 or raise to `minTouchTarget`. |
| 11 | medium | packages/ui-native/src/components/glass.tsx:190 | Hard-coded English fallback `backLabel ?? "Back"` inside the kit (visible to VoiceOver in AR). Make `backLabel` required or inject via theme/i18n. |
| 12 | medium | apps/mobile/src/app/onboarding/dob.tsx:161, 177-182 | Fixed `height: 264` picker plus a `ScrollView` with ~100 year `Chip`s mapped inline and `contentOffset` hand-computed from `40` px per row (row height is `38 + gap`, so the offset drifts). Use FlashList or `FlatList` with `getItemLayout`; Dynamic Type will also break the fixed height. |
| 13 | medium | packages/ui-native/src/components/glass.tsx:3,288,295,354 | `runOnJS` is the deprecated Reanimated 3 name; with `react-native-worklets 0.10` / Reanimated 4.5 use `scheduleOnRN` from `react-native-worklets` (runOnJS still works via compat, but verify no warning in Expo Go). |
| 14 | low | apps/mobile/src/features/brand-mode/DashboardScreen.tsx:148 | `accessibilityLabel="loading"` is a literal English string. |
| 15 | low | apps/mobile/src/app/__art.tsx, __styleguide.tsx, __purchase.tsx | Dev-only routes inside `app/`. `__art` and `__styleguide` are `__DEV__`-gated, `__purchase` has no visible gate (check lines after 20). They still ship in the bundle and carry literal hex/English. Gate all three, or move behind a dev-only entry. |

---

## 1. Hard-coded colours and v1 names

Outside `ui-tokens`:

| Sev | File:line | Literal / name | Fix |
|---|---|---|---|
| high | packages/ui-native/src/components/glass.tsx:161 | `tint: "rgba(10,8,7,0.5)"` (v1 obsidian) | token `glassTintOnImage` (or `colors.overlay`) |
| high | packages/ui-native/src/components/glass.tsx:119 | `colors.champagne` | `colors.sand` |
| high | packages/ui-native/src/components/glass.tsx:51-52 | `"rgba(255,255,255,0)"`, `"rgba(0,0,0,0)"` transparent stops | token `transparent` stop helper (see layout.tsx:192/202) |
| high | packages/ui-native/src/components/layout.tsx:192, 202 | `rgba(255,255,255,0.07/0.65/0)` sheen | `glassSheen` token already exists; reuse |
| medium | packages/ui-native/src/logic/glass.ts:40-43 | `rgba(0,0,0,...)` scrim | derive from a `scrim` token |
| medium | packages/ui-native/src/logic/glass.ts:42 | comment says "ivory/champagne" | reword to sand |
| high | packages/ui-native/src/logic/palette.ts:17-18 | six gold hex values | tokens `plusBg/plusFg/plusBorder` |
| high | apps/mobile/src/features/role-choice/RoleChoiceScreen.tsx:84 | `rgba(255,255,255,0.4)` hairline | `colors.glassBorder` / `glassHighlight` |
| high | apps/mobile/src/features/role-choice/RoleChoiceScreen.tsx:93 | `tint="rgba(7,26,28,0.5)"`; also `DEEP` import at :45 | `brand.deep` token |
| medium | apps/mobile/src/art/StoreArt.tsx:74 | `borderColor: "rgba(0,0,0,0.08)"` | `colors.hairline` |
| medium | apps/mobile/src/art/StoreArt.tsx:22,23,67 | inline `#071A1C`, `#041112` | `DEEP` constant / token |
| medium | apps/mobile/src/art/art-geometry.ts:81,110-158 | ~40 hex in art data | one palette module, built from tokens |
| low | apps/mobile/src/art/ProductArt.tsx:27-30, 63, 85-137 | `#000000`, `#FFFFFF`, `#1B1A1E`, `#EFE8DA`, `#F6F1E7`, `#0B2527` | same |
| low | apps/mobile/src/app/__art.tsx:16,31,32 | `#15110E`, `#F7F3EC` (near-v1 `#F7F3EB`) | dev only; use tokens |

v1 names found: `champagne` (tokens index.ts:49, 99, 133; glass.tsx:119; logic/glass.ts:42; asserted by admin-web styles.test.ts and seller-web tokens-css.test.ts, so removing needs those tests updated). `bordeaux`/`rosewood`/`#6B1D2A` appear only in the token test's negative assertion and the stale header comment (index.ts:5-6). No `Bodoni` anywhere. `#F7F3EB` and `#0A0807` literal: none, apart from the rgba(10,8,7) above.

Wardrobe `COLOURS` (features/wardrobe/model.ts:10) are colour names as data, not styling; fine. `burgundy` is a user-facing product colour, not a brand reference.

## 2. RTL

No violations of the `left/right` family found in styles. Details:

- Clean: no `marginLeft/Right`, `paddingLeft/Right`, `borderLeft/Right`, `left:`/`right:`, `row-reverse`, or arrow glyphs. Absolute positions use `start`/`end` (RoleChoice:84, controls.tsx:131 thumb).
- Intentional LTR: features/brand-apply/screens/FactorScreen.tsx:64 and brand-apply/components.tsx:121 force `textAlign: "left"` + `writingDirection: "ltr"` for codes. Correct (low, note only; confirm inside an RTL row the `alignSelf` is still `start`).
- primitives.tsx:54 `align` maps `start/end` to physical `left/right` using `isRTL` manually. Correct only while `I18nManager.isRTL` matches `isRTL`; with `textAlign: "auto"` default elsewhere it is fine. Low: prefer `"auto"` for `start` and let the platform decide (also avoids a one-launch flash after `forceRTL`).
- Directional icons: all five usages carry `directional` (RoleChoice:78, TypeScreen:38, ProductForm:269, Orders:217, Pdp:145, glass.tsx:190). Dev gap: `IconButton icon="arrow-back-outline"` in ProductFormScreen:269 is used for "move earlier" inside a horizontal list; verify semantics flip in RTL (earlier = right). Medium.
- primitives.tsx:140 uses `scaleX: -1` for directional icons: OK, but combined with `Icon` swapping names via `rtl.ts` could double-flip. Check that `directional` uses one mechanism only. Medium.
- LinearGradient `start/end` are physical x (layout.tsx:202, glass.tsx:51). Sheen direction does not mirror in RTL. Low (decorative).
- Progress fills use a `sign` for translateX (brand-apply/components.tsx:37, brand-mode/kit.tsx:159); good, but Scaffold.tsx:19 uses `width: "%"` which grows from the start edge in both locales (correct).
- Wallet/Orders ASCII separators: ` . ` in `wallet.txMeta` and `·` in strings are bidi-neutral; fine.

## 3. Accessibility

Counts: 14 `<Pressable` in app and kit; most flow through `PressScale` (primitives.tsx:100-130) which forwards `accessibilityRole/Label/State`.

| Sev | File:line | Issue |
|---|---|---|
| medium | packages/ui-native/src/components/primitives.tsx:110 | `PressScale` forwards role/label as optional props; nothing enforces them. Make `accessibilityRole` and `accessibilityLabel` required in the prop type (or default role `button`). |
| medium | apps/mobile/src/features/role-choice/RoleChoiceScreen.tsx:77 | 40x40 icon disc inside a large card pressable: fine. The 36pt `minHeight` GlassSurface at :93 is the language switcher; check it is a pressable with `minTouchTarget` hitSlop. |
| medium | packages/ui-native/src/components/controls.tsx:147 | `Chip` 38pt visual, no hitSlop (see top 10). |
| medium | apps/mobile/src/features/search/Chip.tsx:10 | duplicate of kit `Chip` with its own role logic (44pt, good). Consolidate to one component to avoid the 38pt variant leaking. |
| medium | packages/ui-native/src/components/glass.tsx:153, 161 | IconButton visual 40x40 inside a 44 box with `hitSlop={4}`: OK (48 effective). Sand variant 56: OK. |
| low | packages/ui-native/src/components/commerce.tsx:22-25 | Badge `minHeight: 22`, `fontSize: 11` fixed, `lineHeight: 14`. Not interactive; fixed lineHeight clips under large Dynamic Type. Use variant scale plus `maxFontSizeMultiplier`. |
| medium | packages/ui-native/src/components/glass.tsx:251 | Tab label `fontSize: 10, lineHeight: 13` fixed. 10pt is below the readable minimum under Dynamic Type; scale with `MAX_FONT_SCALE` cap or use `caption` token. |
| low | apps/mobile/src/features/home/HomeScreen.tsx:28 | `fontSize: 9` eyebrow on image. Below 11pt; raise. |
| low | apps/mobile/src/art/StoreArt.tsx:76 | `allowFontScaling={false}` on the avatar monogram: acceptable (decorative initial). |
| medium | apps/mobile/src/features/brand-mode/StoreScreen.tsx:58, 61 | `Image` without `accessible={false}` / `accessibilityLabel` for cover and logo. |
| medium | apps/mobile/src/features/brand-mode/ProductFormScreen.tsx:254 | Photo thumbnail `accessible={false}` and a 120x160 fixed box: confirm a labelled remove control exists beside it. |
| low | apps/mobile/src/features/brand-mode/DashboardScreen.tsx:148 | literal "loading" label (English only). |
| medium | apps/mobile/src/app/onboarding/dob.tsx:161 | `height: 264` fixed picker container; under Dynamic Type chips clip. Use `maxHeight` plus `flexShrink`. |
| low | apps/mobile/src/features/orders/OrdersScreen.tsx:47 | timeline row `minHeight: 40` (min, ok). |

Contrast (token pairs on images): `Text color="onImage"` is used over art in HomeScreen and RoleChoice. `logic/glass.ts` applies a scrim capped by `SCRIM_MAX_ALPHA` and `contrast.ts` exists with a tested ratio helper; I did not recompute. Risks to verify manually: light sand art (`#F7F2E8`..`#D9BFA0` stops in art-geometry.ts:152, "sand" hero) with white `onImage` text. The comment at glass.ts:42 admits the lower stop "must carry hairline serif titles in white". Add a contrast unit test for the sand and linen art stops against the max scrim: medium.

## 4. Performance

| Sev | File:line | Issue |
|---|---|---|
| high | FlashList unused (package.json:20) | Convert: features/orders/OrdersScreen.tsx (7 maps), features/search/SearchScreen.tsx (6), features/wallet/WalletScreen.tsx (transactions), features/home/HomeScreen.tsx + parts.tsx (rails: horizontal FlashList), features/stylist-chat/StylistChatScreen.tsx (7; inverted list), features/stylist/StylistScreen.tsx (8), features/wishlists, features/returns, features/outfit-calendar, features/wardrobe (grid, 4 maps), brand-mode/OrdersScreen.tsx, brand-mode/ProductsScreen.tsx. Each needs `keyExtractor` (keys from stable ids, not index), `estimatedItemSize`, and `React.memo` row components. |
| medium | features/home/parts.tsx:2 ScrollViews | Horizontal rails: use FlashList `horizontal`, with memoized cards and stable `renderItem`. |
| medium | features/bag/BagScreen.tsx:76 | `SuggestionRail` items with inline style objects; hoist to `StyleSheet`/memo. |
| medium | inline objects in map rows | `style={{...}}` inside `.map` bodies throughout (ProductForm, Orders, Stylist). Fine for small sets; once lists move to FlashList hoist styles and callbacks (`onPress={() => ...}` closures per row break memo). |
| medium | apps/mobile/src/features/home/useServerCountdown.ts:14, drops/DropScreen.tsx:59, auto-buy/AutoBuyScreen.tsx:53, onboarding/otp.tsx:26 | 1 s `setInterval` + `setState` re-renders whole screens. Contain the tick in a leaf `Countdown` component so only the digits re-render (DropScreen already hoists Reveal; still re-renders the full screen body). |
| medium | apps/mobile/src/features/pdp/PdpScreen.tsx:60-70 | Gallery `onIndex` is called from scroll end; confirm it is `onMomentumScrollEnd`, not a per-frame `setState` (the scroll handler itself only writes a shared value: good). |
| low | packages/ui-native/src/components/controls.tsx:131 | thumb animates `start` (a layout prop) in `useAnimatedStyle`; animate `translateX` (with RTL sign) instead. |
| low | packages/ui-native/src/components/controls.tsx:168, 224; Scaffold.tsx:19 | `width` animated via `useAnimatedStyle` (layout thrash). Use `scaleX` with `transformOrigin`, or accept for a thin bar. |
| low | features/pdp/PdpScreen.tsx:25 | Dot animates `width`; use `scaleX` on a fixed-width dot. |
| medium | Expo Go crash rule | Checked worklets in PdpScreen:23-55, layout.tsx:50, glass.tsx:102,185,186,236,298,299,357, controls.tsx:53,131,168,224, primitives.tsx:106,161, brand-apply/components.tsx:37, brand-mode/kit.tsx:159: all inline math or `interpolate`; no plain-JS helper calls found. `props.x.value` captured via props object is fine. `runOnJS` callbacks (glass.tsx:288, 295, 354) target closures; OK. Keep the "twin" tests. |
| low | Image sizing | `Image` uses (commerce.tsx:69, 117, glass.tsx:113, StoreScreen:58, 61, ProductForm:254, Returns:213, Wardrobe:51) pass no `recyclingKey`/pixel-size hints; for remote URIs request sized variants from the CDN and set `cachePolicy="memory-disk"`. Wardrobe:51 uses `width/height: "100%"` on a user-uploaded photo: pre-size. |
| low | useEffect | 107 effects; the sampled ones have dependency arrays; no omitted-deps effect found by a single-line grep. A lint pass (`react-hooks/exhaustive-deps`) is the safer check. |

## 5. Honesty

Largely compliant: strike-through appears only in `PriceBlock` (commerce.tsx:48, via the verified-claim logic in logic/price.ts) and in size-cell "unavailable" (controls.tsx:210, not a price). Countdowns are server-anchored (`serverClock.ts`, HomeScreen `heroCountdown` returns null without a future server start, AutoBuy refuses a ticking countdown without a server timestamp). No "N viewing/bought" strings found.

| Sev | File:line | Issue |
|---|---|---|
| high | features/rewards/model.ts:112-119 | `FIXTURE_REWARDS` has `tier: "silver"`, `remainingToNext: 1_500_000n`: the "Silver member" fixture. Reached via `InMemoryRewardsPort` default in `createInMemoryPorts()` only (ports.ts:100); safe when the API URL is set, but see below. |
| high | features/me/model.ts:60-66 and brand-mode/fake.ts:62 | Default `brandPort` is an in-memory fake with member "Nada". `brand-mode/state.ts:50` replaces it, but only after that module is imported; Me can read the default first. Default to a null/"no brand" port instead of a fixture. |
| medium | state/ports.ts:75-106 | `createInMemoryPorts()` is the fallback when `EXPO_PUBLIC_API_BASE_URL` is unset, including in release builds (`eas.json` profiles should set the URL). Add a `!__DEV__` guard that throws or shows a "not configured" screen so a store build can never show fixture stores, prices, wallet balances or "Silver". Blocker if any non-dev profile lacks the URL: check apps/mobile/eas.json and app.config.ts. |
| medium | features/checkout/model.ts:474 `orderGroupId: "og-1"`, features/gift-cards/model.ts:290 valid code `0123456789ABCDEFG`, family/model.ts:291 `verifier.example` | Fixture constants live in production model files, exported. Move to `__fixtures__`/`test-support` and tree-shake from release. |
| low | features/brand-apply/screens/StatusScreen.tsx:45-47 | `?demo=` status override guarded by `__DEV__` and `instanceof InMemory...`: good. |
| low | features/brand-apply/registry.ts:17 | `isFake: true` is returned; confirm the UI shows a visible "preview" banner whenever `isFake`. |

## 6. Dead code and dependencies

- apps/mobile/package.json: `@expo-google-fonts/ibm-plex-sans` (Latin, no import; the Latin face is bundled Inter), `expo-linking` (no import; expo-router brings it), `@shopify/flash-list` (no import yet; keep, it is wanted by item 1), `@outlet/analytics` and `@outlet/auth-core` (no source import in apps/mobile/src; verify they are not needed transitively before removing; `@outlet/privacy` and `@outlet/api-client` each have one import).
- Tokens never read by app or kit: `brandSoft`, `exit`, `glide`, `onPlus`, `onSavings` (packages/ui-tokens/src/index.ts; web apps may consume them via CSS vars, so check before deleting). `champagne` is read only once.
- Fonts: `Amiri_*`, `Inter_*`, `Playfair*`, `IBMPlexSansArabic_300Light` are all wired via `fonts` tokens (ui-tokens index.ts:234-239). Not reachable by any code path that sets `fontFamily` directly: `PlayfairDisplay_400Regular_Italic` unless a component reads `displayLatinItalic`; `PlayfairDisplay_600SemiBold`. Confirm usage; otherwise drop the `.ttf` and the `FONT_MAP` entries. The `__styleguide.tsx:101` text mentions "IBM Plex Sans Arabic وAmiri" and "Inter tabular": fine.
- ui-native index exports: every exported name is referenced somewhere in app or kit components; none unused by a name grep.
- Stale comments: ui-tokens index.ts:5-6 (Bordeaux), glass.ts:42 (champagne), tokens index.ts:48 ("kept under its v1 name for older callers").
- Dev routes in production tree: `app/__art.tsx`, `__styleguide.tsx`, `__purchase.tsx` (see item 15).
- `apps/mobile/coverage/` directory exists in the app folder; confirm it is gitignored.
- `apps/mobile/locales/{ar,en}.json` hold only the three iOS `NS*UsageDescription` strings (used by app.config). Not a catalogue; naming invites confusion with `packages/i18n`. Low.

## 7. i18n

Catalogue: packages/i18n/src/{ar,en}.ts, 1911 keys each, key sets match (0 missing, 0 extra, by my line-based flatten; the `brandApply.*` block from ar.ts:2222 onward packs many keys per line so it was not individually checked).

Identical AR == EN (none is an untranslated sentence; all are placeholder-only or numeric formats):
`home.heroEyebrow` (ar.ts:12), `role.eyebrow` (:56), `onboarding.phone.placeholder` (:79 `01X XXXX XXXX`), `sizeProfile.reviewRow` (:529), `sizeProfile.valueLabel` (:545), `checkout.methodHint` (:655), `checkout.feeLine` (:666), `rewards.oddsLine` (:1263), `wallet.subLine` (:1419), `wallet.txLine` (:1435), `wallet.txMeta` (:1436), `brandMode.dashboard.lowStockLine` (:1702), `brandMode.orders.buyerMasked` (:1825), `brandMode.store.payoutMasked` (:1884), `autoBuy.plusEyebrow` (:1972). Fine, but `wallet.txMeta` uses ASCII ` . ` as separator in both; use `·`.

English / Latin inside Arabic strings (ar.ts):
- :37 `common.languageToggle` "English", :62 `role.languageSwitch` "English": intentional endonym.
- :1484, :1499, :1563 `YYYY-MM-DD`: replace with a date picker; if kept, use Arabic digits hint ("سنة-شهر-يوم") or LTR isolate.
- :1778 `SKU`, :1779 `GTIN`, :1885 `IBAN` next to Arabic gloss: acceptable (field names), wrap in LRM.
- :1927 `JPEG/PNG/WebP`, :2251 `PDF/JPG/PNG`, :2260-2261 `DNS`: acceptable technical terms; low.
- :1965, :1972, :2006, :2065, :2074-2076, :2085, :2125, :2167-2176 `Plus`: product name. Decide: keep Latin "Plus" everywhere (then add the bidi isolate) or use "بلس". Medium (inconsistent with `{{product}}` handling).
- :2289 `brand.com` example: fine.

Hard-coded UI strings outside i18n:
- packages/ui-native/src/components/glass.tsx:190 `"Back"` fallback (medium).
- features/brand-mode/DashboardScreen.tsx:148 `"loading"` (low).
- app/__styleguide.tsx and app/__art.tsx: many English literals, dev-only (low).
- features/brand-mode/fake.ts:62 etc. fixture English, not user-facing in real mode.
- app/onboarding/dob.tsx month names: confirm they come from `Intl` with the active locale (`name` in loop at :170); not verified.

Money/number formatting: `localizeDigits` is used in Returns; confirm the same in Wallet and Orders rows (not exhaustively checked).

## 8. Spacing / radius / size literals vs tokens

Most screens use `spacing.*` and `radius.*`. Literal-heavy files (count of numeric padding/margin/gap literals): features/pdp/PdpScreen.tsx (20), features/plus/PlusScreen.tsx (17), brand-mode/StoreScreen.tsx (16), worlds/WorldsScreen.tsx (14), family/FamilyPlansSection.tsx (14), home/parts.tsx (12), brand-mode/ProductFormScreen.tsx (12), brand-mode/OrdersScreen.tsx (12), auto-buy/AutoBuyEntry.tsx (12), brand-mode/DashboardScreen.tsx (11), home/HomeScreen.tsx (11), ui-native controls.tsx (11), layout.tsx (10), commerce.tsx (10).

Specific items (all medium/low):
- brand-apply/components.tsx:61 `spacing.xs + 2`, `spacing.sm + 2`: arithmetic on tokens (add `xxs`/half-steps instead).
- brand-mode/StoreScreen.tsx:57,61 `borderRadius: 18`, `26`, `height: 120`: use `radius.lg`/token.
- brand-mode/ProductFormScreen.tsx:253 `borderRadius: 18`, `width: 120, height: 160`.
- brand-mode/DashboardScreen.tsx:148 `gap: 18` (not on the 4-pt grid).
- pdp/PdpScreen.tsx:78 `paddingHorizontal: 12`, `borderRadius: 12`, `gap: 5`; :145 header offsets.
- home/HomeScreen.tsx:24 `gap: 18`.
- ui-native controls.tsx:114,122,135,136 checkbox/radio/switch geometry: 22/46/26/20/12 literals; define `control` size tokens.
- ui-native commerce.tsx:22 `minHeight: 22, paddingHorizontal: 8, gap: 5`.
- Non-4pt values seen: 5, 18, 22, 26, 38, 46, 264.

---

## Fix order for the editing agent

1. ports.ts release guard + default brand port null (items 2, 5).
2. Replace colour literals in glass.tsx, layout.tsx, logic/palette.ts, RoleChoiceScreen; retire `champagne` (update admin-web and seller-web token tests in the same change).
3. Introduce FlashList on Orders, Search, Wallet, Home rails, Chat, Stylist.
4. Chip 38pt and `PressScale` required a11y props; `Back` fallback.
5. Remove `@expo-google-fonts/ibm-plex-sans`, `expo-linking`; confirm `@outlet/analytics`/`auth-core`; prune unused font files.
6. AR string clean-up for `YYYY-MM-DD` and `Plus` policy.
7. Spacing/radius literal sweep (low).
