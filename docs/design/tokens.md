# Design tokens (Outlex)

Source of truth: `packages/ui-tokens/tokens.json` (W3C Design Tokens format: `$type`, `$value`, aliases like `{color.green.800}`). Look target: `docs/design/ui-reference-spec.md`. The palette is our own: warm cream, forest green, lime accent. It copies no other brand.

## How tokens are layered

1. **Primitives** (`color.*`, `font.*`, `space.*`, `radius.*`, `elevation.*`, `motion.*`). Raw values. UI code must not use these directly.
2. **Semantic theme tokens** (`theme.light.*`, `theme.dark.*`). Same keys in both themes. UI code uses these only (for example `bg.page`, `text.primary`, `action.primary.bg`).
3. Build step (Style Dictionary, later task) turns the JSON into CSS variables for web and a TS object for React Native. The JSON is edited by hand; the outputs are generated.

## Palette

| Role | Light | Dark |
|---|---|---|
| Page background | cream `#F7F4EE` | night `#0F1812` |
| Surface (cards, panels) | white `#FFFFFF` | `#16221A` |
| Subtle background | `#EDE8DC` | `#1E2D23` |
| Primary text | `#1A201C` | `#F1EFE8` |
| Primary action | dark green `#1F3D2B`, text `#FBF9F4` | lime `#C6F23A`, text `#0E1A13` |
| Discount pill | lime `#C6F23A`, text `#16291E` | same |
| Savings | text `#2B5239`, soft bg `#DCEDE0` | text `#8FC29E`, bg `#16291E` |
| Warning | text `#744500` on `#FBEBC8` | text `#F0C265` on `#2B2210` |
| Critical | text `#A32018` on `#FADBD8` | text `#FF9E96` on `#33191A` |
| Verified badge | text `#0E5A63` on `#D6EEF0` | text `#7CC6CF` on `#12302F` |

Rules:
- **Lime is an accent, not a text colour.** Lime on cream is only 1.18:1. It is used as a pill fill (with dark green text inside) and as a glow. Never as text or as the only focus indicator.
- **Focus** is a 2 px solid ring (`focus.ring`: dark green in light, lime in dark) plus an optional 4 px glow (`focus.glow`). The ring alone meets 3:1. The reference images show a lime glow; we keep it but add the ring so keyboard focus is visible on cream.
- **Savings green** is used only for verified savings (master prompt A2.13). The "verified" badge colour is separate from savings so a verified badge is never confused with a discount.
- **Urgency colours:** there is no "urgency coral". Warning and critical are for real states only (low stock, errors), never for fake timers.
- Colour is never the only signal: every status has an icon and a text label.

## Type

| Token | Value |
|---|---|
| `font.family.sans` | IBM Plex Sans Arabic, IBM Plex Sans, system-ui. UI and body in Arabic and Latin. |
| `font.family.serif` | Fraunces (Latin display headings), Noto Naskh Arabic (Arabic headings). Headings only. |
| `font.family.script` | Caveat (Latin), Aref Ruqaa (Arabic). Decoration only: taglines that also exist as plain text. |
| Scale | xs 12, sm 14, md 16 (body), lg 18, xl 20, 2xl 24, 3xl 30, 4xl 38, 5xl 48 px |
| Weights | 400, 500, 600, 700 |
| Line height | tight 1.2 (headings), normal 1.5 (Latin body), arabic 1.8 (Arabic body) |

Notes: body text is never below 14 px (16 px default). Arabic text uses the larger line height. Fonts are self-hosted, `font-display: swap`, subset to Arabic and Latin. Support text zoom to 200% without loss. The script font never carries meaning on its own.

## Space, radius, elevation, motion

- **Space:** 4-pt scale. `space.N` = N x 4 px (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16). Touch targets are at least 44 x 44 px.
- **Radius:** none 0, sm 6, md 10, lg 16, xl 24, pill 999.
- **Elevation:** 0 to 3 (soft shadows). In dark theme, separate layers with surface steps and a border instead of shadows.
- **Motion:** instant 0, fast 120, base 200, slow 320 ms; easings standard, enter, exit. **Reduced motion:** when `prefers-reduced-motion` is on, use `motion.reduced` (0 ms moves, 100 ms fades), turn off auto-advance and momentum auto-scroll on carousels, and keep arrow buttons and keyboard control. Swipe and drag still work (user driven).
- **RTL:** use logical properties (`margin-inline-start`, `inset-inline-end`). Icons that show direction (arrows, chevrons) mirror; media icons and logos do not.
- **Breakpoints:** sm 480, md 768, lg 1024, xl 1280. Mobile first.

## WCAG 2.2 AA contrast check

Command: `node tooling/design/contrast.mjs` (plain Node, no dependencies; exit code 1 if a pair fails). It resolves aliases in `tokens.json` and checks each pair below at 4.5:1 for text (SC 1.4.3) and 3:1 for focus rings and input borders (SC 1.4.11, 2.4.13). Large text and bold text would only need 3:1 but we hold everything to 4.5:1.

Result on 2026-11-07: **all pairs pass.** No colour had to be changed after the first run. The lowest text ratio is 5.41 (muted text on the subtle background, light theme). The lowest non-text ratio is 3.06 (dark input border on surface). The row `discount.bg` on `bg.page` (1.18) is information only: the pill's own text is checked (`discount.text` on `discount.bg`), and the pill is never the only way to see the discount.

Re-run the script whenever `tokens.json` changes. CI should run it (task for the CI owner).

| theme | foreground | background | ratio | min | result |
|---|---|---|---|---|---|
| light | text.primary #1A201C | bg.page #F7F4EE | 15.09 | 4.5 | pass |
| light | text.primary #1A201C | bg.surface #FFFFFF | 16.57 | 4.5 | pass |
| light | text.primary #1A201C | bg.subtle #EDE8DC | 13.55 | 4.5 | pass |
| light | text.secondary #3E4942 | bg.page #F7F4EE | 8.55 | 4.5 | pass |
| light | text.secondary #3E4942 | bg.surface #FFFFFF | 9.39 | 4.5 | pass |
| light | text.secondary #3E4942 | bg.subtle #EDE8DC | 7.68 | 4.5 | pass |
| light | text.muted #526058 | bg.page #F7F4EE | 6.03 | 4.5 | pass |
| light | text.muted #526058 | bg.surface #FFFFFF | 6.62 | 4.5 | pass |
| light | text.muted #526058 | bg.subtle #EDE8DC | 5.41 | 4.5 | pass |
| light | text.link #2B5239 | bg.page #F7F4EE | 8.08 | 4.5 | pass |
| light | text.link #2B5239 | bg.surface #FFFFFF | 8.87 | 4.5 | pass |
| light | text.inverse #FBF9F4 | bg.inverse #1F3D2B | 11.34 | 4.5 | pass |
| light | action.primary.text #FBF9F4 | action.primary.bg #1F3D2B | 11.34 | 4.5 | pass |
| light | action.primary.text #FBF9F4 | action.primary.bgHover #2B5239 | 8.43 | 4.5 | pass |
| light | action.secondary.text #1F3D2B | action.secondary.bg #EDE8DC | 9.76 | 4.5 | pass |
| light | discount.text #16291E | discount.bg #C6F23A | 11.80 | 4.5 | pass |
| light | savings.text #2B5239 | bg.page #F7F4EE | 8.08 | 4.5 | pass |
| light | savings.text #2B5239 | bg.surface #FFFFFF | 8.87 | 4.5 | pass |
| light | savings.onBg #1F3D2B | savings.bg #DCEDE0 | 9.79 | 4.5 | pass |
| light | warning.text #744500 | warning.bg #FBEBC8 | 6.87 | 4.5 | pass |
| light | warning.text #744500 | bg.page #F7F4EE | 7.38 | 4.5 | pass |
| light | critical.text #A32018 | critical.bg #FADBD8 | 5.83 | 4.5 | pass |
| light | critical.text #A32018 | bg.page #F7F4EE | 6.89 | 4.5 | pass |
| light | verified.text #0E5A63 | verified.bg #D6EEF0 | 6.52 | 4.5 | pass |
| light | verified.text #0E5A63 | bg.page #F7F4EE | 7.19 | 4.5 | pass |
| light | focus.ring #1F3D2B | bg.page #F7F4EE | 10.87 | 3 | pass |
| light | focus.ring #1F3D2B | bg.surface #FFFFFF | 11.93 | 3 | pass |
| light | border.input #6B766F | bg.page #F7F4EE | 4.30 | 3 | pass |
| light | border.input #6B766F | bg.surface #FFFFFF | 4.72 | 3 | pass |
| light | discount.bg #C6F23A | bg.page #F7F4EE | 1.18 | 1 | pass |
| dark | text.primary #F1EFE8 | bg.page #0F1812 | 15.74 | 4.5 | pass |
| dark | text.primary #F1EFE8 | bg.surface #16221A | 14.28 | 4.5 | pass |
| dark | text.primary #F1EFE8 | bg.subtle #1E2D23 | 12.55 | 4.5 | pass |
| dark | text.secondary #C3CBC4 | bg.page #0F1812 | 10.92 | 4.5 | pass |
| dark | text.secondary #C3CBC4 | bg.surface #16221A | 9.91 | 4.5 | pass |
| dark | text.secondary #C3CBC4 | bg.subtle #1E2D23 | 8.70 | 4.5 | pass |
| dark | text.muted #9AA59D | bg.page #0F1812 | 7.11 | 4.5 | pass |
| dark | text.muted #9AA59D | bg.surface #16221A | 6.45 | 4.5 | pass |
| dark | text.muted #9AA59D | bg.subtle #1E2D23 | 5.67 | 4.5 | pass |
| dark | text.link #8FC29E | bg.page #0F1812 | 8.95 | 4.5 | pass |
| dark | text.link #8FC29E | bg.surface #16221A | 8.12 | 4.5 | pass |
| dark | text.inverse #1A201C | bg.inverse #F7F4EE | 15.09 | 4.5 | pass |
| dark | action.primary.text #0E1A13 | action.primary.bg #C6F23A | 13.75 | 4.5 | pass |
| dark | action.primary.text #0E1A13 | action.primary.bgHover #B2DD28 | 11.28 | 4.5 | pass |
| dark | action.secondary.text #8FC29E | action.secondary.bg #1E2D23 | 7.13 | 4.5 | pass |
| dark | discount.text #0E1A13 | discount.bg #C6F23A | 13.75 | 4.5 | pass |
| dark | savings.text #8FC29E | bg.page #0F1812 | 8.95 | 4.5 | pass |
| dark | savings.text #8FC29E | bg.surface #16221A | 8.12 | 4.5 | pass |
| dark | savings.onBg #BBDCC4 | savings.bg #16291E | 10.33 | 4.5 | pass |
| dark | warning.text #F0C265 | warning.bg #2B2210 | 9.42 | 4.5 | pass |
| dark | warning.text #F0C265 | bg.page #0F1812 | 10.87 | 4.5 | pass |
| dark | critical.text #FF9E96 | critical.bg #33191A | 8.17 | 4.5 | pass |
| dark | critical.text #FF9E96 | bg.page #0F1812 | 9.13 | 4.5 | pass |
| dark | verified.text #7CC6CF | verified.bg #12302F | 7.27 | 4.5 | pass |
| dark | verified.text #7CC6CF | bg.page #0F1812 | 9.34 | 4.5 | pass |
| dark | focus.ring #C6F23A | bg.page #0F1812 | 13.94 | 3 | pass |
| dark | focus.ring #C6F23A | bg.surface #16221A | 12.65 | 3 | pass |
| dark | border.input #5C6F63 | bg.page #0F1812 | 3.37 | 3 | pass |
| dark | border.input #5C6F63 | bg.surface #16221A | 3.06 | 3 | pass |
| dark | discount.bg #C6F23A | bg.page #0F1812 | 13.94 | 1 | pass |

All pairs pass WCAG 2.2 AA

## Still to do (not part of this task)

- Style Dictionary build to CSS variables and a React Native object.
- Check text over photos and 3D storefront images (needs a scrim token; test per image).
- Verify Plex Sans Arabic and Fraunces licences and subsetting (both are open licence; confirm in the design-system task).
- Hover, pressed and disabled states for each action token (disabled text is exempt from contrast, but keep 3:1 where possible).
