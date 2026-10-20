# Design system foundation

> Superseded in identity by rebrand v2.1: see `brand.md` (ivory, deep teal ink, sand; Playfair Display / Amiri display, Inter / Plex Sans Arabic text, radii 14/18/24, flat tab bar) and `rebrand-guide.md`. Token roles and component APIs below still apply; the colour, radius and type VALUES quoted below are historical.

Direction (v1, historical; v2 is calm, professional and clean per `brand.md`): luxury minimalism with frosted glass. Stark white / near-black, one quiet neutral fill, 1px hairlines, edge-to-edge imagery, small light type with tracked uppercase labels, slow deliberate motion. Emerald (verified savings only), coral (genuine urgency and errors only) and gold (Plus only) are rare functional accents.

Code: tokens in `packages/ui-tokens`, components in `packages/ui-native`, app glue in `apps/mobile/src/theme`. Import UI from `../ui` (re-exports `@outlet/ui-native`). Review gallery: `/__styleguide` (dev only). Query params: `g=0..7` (section), `lang=en|ar`, `theme=light|dark|system`, `bar=0`. Screenshots: `docs/design-system/screenshots/foundation-*.png`.

## Tokens (semantic; never use raw hex)
| Role | Light | Dark | Use |
|---|---|---|---|
| background / surface | #FFFFFF | #0B0B0B / #141414 | page, sheets |
| fill | #F2F2F0 | #1C1C1B | the only neutral fill: chips, skeletons, image placeholders |
| textPrimary / textSecondary | #0B0B0B / #66665F | #F5F5F3 / #A3A39D | text |
| hairline (= border) | #E2E2DE | #2A2A28 | 1px dividers and outlines |
| accent / onAccent | #0B0B0B / #FFFFFF | #F5F5F3 / #0B0B0B | primary buttons (ink) |
| danger / onDanger | #C23E1A | #F27A57 | errors, genuine urgency only |
| savings / onSavings | #0E6B4D | #3DBE8B | verified savings only |
| plus / onPlus | #8A6A27 | #D4B26A | Plus / premium only |
| onImage, scrim | #FFF, #000 | same | text over imagery (always with a Scrim, max alpha 0.55) |
| glassTint, glassBorder, glassHighlight, glassSolid | translucent | translucent | GlassSurface; glassSolid is the Reduce Transparency fallback |

Contrast: `packages/ui-tokens/src/index.test.ts` asserts every text/background pair >= 4.5 in both modes (45 tests), plus the scrim worst case.

Spacing (4pt): xs4 sm8 md12 lg16 xl24 xxl32 xxxl48 huge64. Gutter 20. Radii: xs2 sm6 md10 lg16 xl24 pill. Buttons/chips are nearly square (xs) by design. Min target 44.

Type (IBM Plex Sans / Plex Sans Arabic): display 34/40 light, title1 26/32 light, title2 20/26, headline 17/24 medium, body 16/24, callout 15/22, caption 13/18, eyebrow 11/14 uppercase tracking 1.6 (Latin only). Arabic: +10% line height, no tracking, no uppercase. `numeric` prop gives tabular numerals. Dynamic Type capped at 2x. Fonts load via `useAppFonts` (splash held; 4 s timeout; system font fallback).

Motion: 200/300/360 ms, ease-out cubic, press scale 0.985, no bounce, all disabled by Reduce Motion. Glass intensity: bar 60, sheet 70, chip 45.

## Theme
`useTheme()` returns `colors, isDark, isRTL, direction, preference, setPreference, fontsLoaded, reduceMotion, reduceTransparency, spacing, radii, gutter, type(variant, {numeric, weight})`. Provider is mounted in the root layout (`AppThemeProvider`): follows system, manual override (`system|light|dark`) persisted under storage key `ui.theme`. `useColors()` still works.

## Components (all from `../ui`)
Existing names and props are kept: Screen, Card, Banner (tone info|warning|error|success; no text prefix), Badge (`tone` legacy or new `kind`), Button (variant primary|secondary|ghost|destructive), TextField, Checkbox, SwitchRow, Divider, EmptyState, ErrorState, LoadingState, Skeleton, ListRow, Text (variant display|title1|title2|headline|body|callout|caption|eyebrow, legacy title|heading; `secondary`, `color`, `weight`, `numeric`, `align=start|center|end`), useTheme, ThemeProvider.

New: 
- `Screen({title?, onBack?, trailing?, onRefresh?, refreshing?, footer?, padded?, scroll?})`: safe-area top (Dynamic Island) and bottom, pads past the floating tab bar (TabBarInsetContext), large light title collapsing into a glass AppBar, content scrolls under the glass.
- `AppBar`, `IconButton({icon,label,onPress,variant:'plain'|'glass'})`, `Icon`, `Eyebrow`, `PressScale`, `FadeIn`.
- `GlassSurface({intensity,radius,elevated,edges})`, `Scrim`, `FullBleedHero({image|imageNode,eyebrow,title,subtitle,action,aspectRatio|height,bleed})` (cancels the screen gutter), `StickyBar` (pass as Screen `footer`), `BottomSheet({visible,onClose,title})`, `ToastProvider`/`useToast().show(msg, kind)`, `TabBar`.
- `Chip`, `SegmentedControl`, `Radio`, `QuantityStepper`, `SizeSelector`, `ProgressBar`.
- `PriceBlock({priceText, priceMinor, claim?, launch?, launchLabel?, size})`: strike-through and percent render ONLY when `claim.verified` and the arithmetic is consistent (`percent === floor((ref-price)*100/ref)`, >= 5); otherwise plain or "Launch price". Pass preformatted `referenceText`/`percentText` (money formatting stays in features/money-display).
- `ProductCard({imageUri|imageNode, blurhash, title, sellerName, priceText, priceMinor, claim, launch, saved, onToggleSave, badge, onPress})`: 3:4 image, no box. `StoreCard`, `Avatar`, `ImageSlot`, `SectionHeader`, `Rating` (renders nothing without real value and count), `Badge kind=verified|lowest30|launch|sponsored|live|plus|neutral`.
- Pure logic (tested): `priceView`, `isValidClaim`, `chevronName`, `previewDirection`, `glassMode`, `textMetrics`, `resolveScheme`, `progressRatio`, `ratingView`, `sizeCellView`, `stepQuantity`, `tabBarInset`.

## RTL rules
Use `marginStart/End`, `paddingStart/End`, `start/end` positions, `borderStartWidth`; never left/right. Icons that point (chevrons, back arrows) use `Icon directional` or `chevronName(isRTL)`. Rows use `flexDirection: "row"` (the platform mirrors). Text aligns with `align="start"` or auto. Sliding indicators use `inlineSign(isRTL)`. Language switch needs an app reload in production; the styleguide previews direction with a `direction` style.

## Do / don't
Do: full-bleed imagery, hairlines instead of boxes, one primary button per screen, eyebrow labels, icons with accessible labels, glass only for floating chrome (tab bar, app bar, sheets, sticky bars, chips). Don't: grey filled cards, shadows on flat content, colour as the only signal, strike-through prices without a verified claim, fake stock/timers/ratings, hard-coded hex, English prefixes in banners, bounce animations.
