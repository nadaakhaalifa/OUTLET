# Brand and imagery kit (rebrand v2.1: Ivory, Teal ink, Sand)

**Identity.** Z-OUTLET is calm, professional and clean: warm ivory paper, deep teal-black ink, forest and sage greens, sand accents, generous photography. No concepts, no invented taglines: the product name is **Z-OUTLET**, shown with a wide-tracked Playfair wordmark. Honest data only.

| Role | Light | Dark | Use |
|---|---|---|---|
| `background` | #F4EFE6 ivory | #071A1C deep teal-black | page |
| `surface` | #FAF7F1 | #0D2427 | inputs, raised cards |
| `fill` | #EAE3D6 | #14312F | chips, skeletons, image wells |
| `textPrimary` / `accent` | #0B2527 ink | #F4EFE6 | text, primary button, selected chip and tab |
| `brand` | #12403F teal | #8CC5C0 | focus, active indicators, wordmark hyphen, one hero accent |
| `sand` / `onSand` | #D9BFA0 / ink | #C9AE8A / deep | circular category icon buttons, warm fills (`champagne` is the same value, legacy name) |
| `sage`, `forest` | #7FA58F, #2F5646 | same | decorative: art, illustration |
| `savings` | #14733F | #5BCB7A | verified savings ONLY (hue kept 20 degrees or more away from the brand teal, unit-tested) |
| `danger` | #B3361A | #F27A57 | genuine urgency and errors ONLY |
| `plus` | #86651F | #D4B26A | HAUL Plus ONLY |

All text pairs are WCAG 2.2 AA tested in `packages/ui-tokens/src/index.test.ts` (both schemes).

**Type.** Display: **Playfair Display** (Latin; 400, 500, 600, 400 italic) and **Amiri** (Arabic; kept: a high-contrast Naskh that pairs with Playfair, nothing better is published in `@expo-google-fonts`). UI text: **Inter** (400, 500, 600) and **IBM Plex Sans Arabic**. Files are bundled in `apps/mobile/assets/fonts` and mirrored in each web app's `public/fonts` (SIL OFL 1.1, `LICENSE-*-OFL.txt` alongside; notices in `THIRD_PARTY_NOTICES.md` at the repo root; sourced from the `@expo-google-fonts/playfair-display` and `@expo-google-fonts/inter` 0.4.2 npm tarballs). Scale (web, `typography`): hero 48/54, display 38/46, title1 28/34, quote 22/30 (serif); title2 20, headline 17, lede 17, body 16, callout 15, caption 13, eyebrow 11 tracked uppercase (sans). Native app (density v2, `nativeTypography`): hero 40/46, display 32/38, title1 24/30, quote 19/26; title2 18, headline 16, lede 16, body 15, callout 14, caption 12, eyebrow 10.5; see `density-v2.md`. Buttons, chips, tabs and prices are sentence case Inter 500/600, never uppercase.

**Shape.** Radius `md` 14 (buttons, inputs, size squares), `lg` 18 (cards, images), `xl` 24 (sheets), `pill` (chips, search, on-image buttons, circular icon buttons). Shadows are soft and light: `card`, `lift`, `floating`.

**Marks.** `Monogram`: a Playfair Z with a small full stop on the baseline (teal on paper, sand on dark). `Wordmark`: Playfair Medium outlines, tracked 0.26em, teal hyphen. Both are outlined paths in `brand-geometry.ts` (no font needed to draw them), shared byte-identical with the seller and admin web apps and with `tooling/brand/generate.mjs`. App icon: ivory Z on #0B2527 with a sand dot. Splash mark: ink Z with a teal dot on transparent.

Code: `apps/mobile/src/art` (barrel `index.ts`). Gallery (dev only): `/__styleguide?g=8` (identity), `g=2` buttons, `g=3` fields, `g=5` cards, `g=6` lists/tab bar, `g=9` motion and art. Generator: `node tooling/brand/generate.mjs`.

All product, store and hero art is **PLACEHOLDER** (procedural, deterministic by seed), never presented as real photography; it is replaced by real imagery when it exists. The kit renders editorial stand-ins in the palette: arch window, soft light, floor plane, vignette tinted with the palette's deep tone, and film grain (`grainPaths`).

| Export | Props |
|---|---|
| `Monogram` / `Wordmark` | `size`, `tone` (defaults to the APP theme), `filled` (monogram) |
| `ProductArt` | `kind` (15), `seed`, `ratio`, `tone`, `accessibilityLabel` |
| `StoreCover` / `StoreAvatar` | `seed`, `aspect`; `name`, `size` |
| `HeroArt` | `variant` drop (teal sea), sale (sand linen folds), plus (sage and forest arches), ramadan (night teal), eid (ivory and sand) |
| `Illustration` / `CategoryIcon` | unchanged; accent is sand |

Palettes (8): sea, ink, linen, sand, sage, forest, stone, camel. Constants: `INK #0B2527`, `DEEP #071A1C`, `PAPER #F4EFE6`, `TEAL #12403F`, `SAND #D9BFA0`, `SAGE #7FA58F`.

Screenshots: `docs/design-system/screenshots/rebrand2-*.png` (iPhone 16 Pro, Expo Go; the blue gear is the Expo dev menu button).
