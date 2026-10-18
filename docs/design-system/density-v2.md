# Density v2: native "zoom out" (2026-10-15)

**Why.** The owner found the Expo app "zoomed in": type, spacing, buttons and cards were larger than the calm, dense reference (body 13-14, product name 12-13, price 13, section title 17-18, tab labels 11, buttons about 44pt). Density v2 shrinks the native scale about 12-17% at the display end and 1pt at body and callout. It also tightens kit paddings by 10-15%. Colours, faces, weights, radii and motion stay the same.

**Options compared.**

- **(A) Shrink the shared `typography`.** One scale, so nothing can drift. But it also shrinks the web apps, and shopper-web body text would drop below 16px. Mobile Safari zooms the page when an input under 16px gets focus.
- **(B) Add a separate `nativeTypography` with the same keys.** Native and web can each keep the right scale. The cost is a second table, which a test keeps tied to the web scale: same keys, face, weight and case, and 80-100% of the web size.

**Chosen: B.** It is the lowest-risk option. The web apps and their derived CSS do not change, and the drift test keeps the two scales consistent.

## Type (native; `packages/ui-tokens` `nativeTypography`, read by ui-native `textMetrics`)

| Variant | Face | Old (size/leading) | New | Change |
|---|---|---|---|---|
| hero | serif | 48/54 | 40/46 | -17% |
| display | serif | 38/46 | 32/38 | -16% |
| title1 (= title) | serif | 28/34 | 24/30 | -14% |
| quote | serif | 22/30 | 19/26 | -14% |
| title2 (= heading) | sans | 20/26 | 18/24 | -10% |
| headline | sans 500 | 17/24 | 16/22 | -1pt |
| lede | sans | 17/26 | 16/24 | -1pt |
| body | sans | 16/24 | 15/22 | -1pt |
| callout | sans | 15/22 | 14/20 | -1pt |
| caption | sans | 13/18 | 12/16 | -1pt |
| eyebrow | sans 500, tracked caps | 11/14, track 2.2 | 10.5/14, track 2.0 | -0.5pt |

These rules have not changed:

- **Arabic leading.** Arabic gets +10% leading, rounded to an even number, with no tracking and no uppercase. For example, body Arabic is 15/24 and caption Arabic is 12/18. A test checks that Arabic leading is always greater than Latin leading and at least 1.25x the font size.
- **Dynamic Type.** It still scales every size, up to `MAX_FONT_SCALE` 2.
- **Tabular prices.** Prices still use tabular numerals (the `numeric` prop).

**Web scale.** The `typography` export (web) is unchanged: body 16, display 38/46.

## Controls and layout (native; `controlSize` token + kit)

| Item | Old | New | Touch target |
|---|---|---|---|
| Page gutter (`gutter`) | 20 | 16 | n/a |
| Screen block gap | 16 | 14 | n/a |
| Button height (comfortable / compact) | 52 / 48 | 44 / 40 | 44 (compact gets 2pt hitSlop) |
| Button label | callout 15/600 | callout 14/600, icon 16, padding 20 | n/a |
| Button radius | 14 | 14 (unchanged) | n/a |
| Text field (comfortable / compact) | 52 / 44 | 46 / 44 | >= 44 |
| Field label | 14 / 13 | 13 / 12 | n/a |
| Field input text | body 16 / 15 | body 15 / callout 14 | n/a |
| Chip (regular / compact / large) | 38 / 32 / 48 | 34 / 30 / 40 | 44 via `slopFor` hitSlop |
| Chip label | caption 13 | caption 12 | n/a |
| Size selector cell | 48 | 40 | 44 via hitSlop |
| Search pill | 48 | 44 | 44 |
| Icon button disc (glass / solid) | 40 | 36 inside a 44 box | 44 |
| Icon button default glyph | 22 | 20 | n/a |
| Category (sand) disc | 56 | 48 | >= 44 |
| App bar row | 52 | 48 | 44 buttons |
| List row min / vertical padding | 56 / 12 | 48 / 10 | >= 44 |
| Card (boxed) padding | 16 | 14 | n/a |
| Product card | gap 10, title callout 15 | gap 8, title caption 12/500, price callout 14/600 tabular | n/a |
| Store card avatar | 40 | 36 | n/a |
| Section header | headline 17/600 | title2 18/500 (the reference's section title) | "See all" 44 |
| Banner padding | 12/14 | 10/12 | n/a |
| Empty/error/loading vertical padding | 48 | 40 | n/a |
| Bottom sheet / sticky bar side padding | 20 | 16 | n/a |
| Badge | 22 tall, 11pt | 20 tall, 10.5pt | not interactive |
| Checkbox / radio glyph | 22 | 20 | row 44 |
| Tab bar | unchanged (labels already 11) | n/a | 44 |

Radii stay the same (`md` 14 buttons and inputs, `lg` 18 cards, `xl` 24 sheets). Spacing stays on the shared 4pt scale. Density comes from how the kit uses that scale, not from changing its values, because the web CSS variables read the same scale.

## Guards

- `packages/ui-tokens/src/index.test.ts`, "native density v2":
  - The exact native scale.
  - The same variants, faces, weights and case as the web scale.
  - Every native size is 80-100% of the web size, and the hierarchy order holds.
  - Latin leading is at least 1.3x for text and 1.15x for display. No text variant is below 12pt (the eyebrow is the only exception).
  - Every `controlSize` entry plus 2 * `slopFor` is at least 44.
- `packages/ui-native/src/logic/ui.test.ts`:
  - Arabic leading versus Latin leading for every variant.
  - Tabular numerals.
  - The updated body and eyebrow metrics. These expectations encoded the old 16/24 size and the 2.2 tracking.
- WCAG AA colour tests have not changed. Colours were not touched.

## Follow-ups for screen owners

Screens that hard-code paddings of 20 (the old gutter) or fixed heights should move to `useTheme().gutter` and `spacing` so they pick up density v2. Raw sizes in screens are already lint debt (`DS-FONT`).

## iPad: token-level zoom (ADR-0054, T0)

Windows >= 600 pt use a true zoom in the tokens. `IPAD_ZOOM` (owner decision: **1.725**, history 1.25 -> 1.75 -> 1.25 -> 1.5 -> 1.725) is the only zoom literal, in `packages/ui-tokens/src/index.ts`; `CONTROL_ZOOM = 1 + (IPAD_ZOOM - 1) * CONTROL_ZOOM_SHARE` (share 0.62, so ~1.45) is derived. Compact (every iPhone) is unchanged: a regression test pins the pre-change tokens.

- **Zoom in force:** `z(w) = 1` below 600 pt; from 600 pt `z = min(IPAD_ZOOM, 1 + (w - 600) / 375)`, so it is 1 at 600 (continuous, no jump), reaches 1.725 at about 872 pt, and a window is never laid out narrower than an iPhone (w / z >= 375). Property-tested in `size-class.test.ts`.
- **Classes:** `compact` < 600; `regular` from 600 until effective width reaches 760 (window 1311 at full zoom); `expanded` from effective 760 (13-inch landscape only). Two-pane only in `expanded`.
- **What zooms:** text, spacing, radii and art by `z` (`s(n)`); control heights and icon glyphs by `1 + (z - 1) * 0.62`, rounded to even (`sc(n)`; at full zoom button 64, field 66, app bar 70, glyph 20 -> 29). Hairlines and `radius.pill` do not scale. The kit does it in `ThemeProvider` (theme keyed on size class, zoom step and font scale, so a resize inside a step does not rebuild it); window measurements live in `useLayout()`. `Icon.size` is physical points. Other numeric kit props are nominal compact values the kit zooms.
- **Effective width** = window / z. Columns, two-pane, max widths (`form` 440 and `reading` 560 effective; `grid` and `full` uncapped), the centred form sheet (420 effective) and the grid table are computed on it. `DensityProductCard` picks its detail level from the card's effective width on iPad.
- **Text:** `k = z`, no Dynamic Type fade: `T = z * min(fs, 2)`, cap 2z (3.45x at full zoom), never below the phone size, so Dynamic Type grows iPad text by the same 2x as on the phone (WCAG 1.4.4). Font sizes round half-step with ties to even.
- **Touch targets:** physical minimum 44 pt; zoomed controls are 44-70 pt (chips use slop to reach 44).
- **Lint:** `DS-RN-WINDOW` (no window reads or `Platform.isPad` in screens) and `DS-RN-RAW-SIZE` (no raw layout numbers in screens). Existing violations are baselined once in `tooling/design/debt-baseline.json`; each T-WP burns its files down.
- **Not zoomed yet:** shadows, 1-2 pt borders, Reanimated distances. The zoomed tab bar is taller than the compact inset the tab layouts pass in; `Screen`, `StickyBar` and the toast add the difference.
