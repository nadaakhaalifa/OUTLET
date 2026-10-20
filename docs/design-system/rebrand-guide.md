# Rebrand guide for screen agents (v2.1: Ivory, Teal ink, Sand)

Direction: professional, clean, spotless. Warm ivory paper, deep teal-black ink, full-bleed editorial photography, rounded shapes, Playfair display titles over Inter UI text. Reference: the owner's 12-screen sheet (adopt the visual language only: no invented models, copy or taglines; honest data). Read `brand.md` for tokens and `foundation.md` for primitives. Gallery: `/__styleguide` (`?g=2` buttons, `g=3` fields, `g=5` cards, `g=6` lists and tab bar, `g=8` identity, `lang=ar`, `theme=dark`).

## Apply checklist
1. Import everything from `../ui` (re-exports `@outlet/ui-native`). Never raw hex; use `useTheme().colors`.
2. Page: `<Screen title=...>`. The title is a Playfair display that collapses into the app bar on scroll. Heroes use `FullBleedHero` (pass `cornerRadius={20}` and `bleed={false}` for the inset rounded banner); actions on photos are `Button onImage` (light ivory pill, ink text) or `IconButton variant="solid"` (ivory disc: back, heart).
3. Type: `hero` once per screen at most, `display` page titles ("More than just clothes." style), `title1` section heads, `SectionHeader` for list sections (Inter 600), `Eyebrow` for small labels. Prices: `PriceBlock` (Inter 600, tabular). Body copy is Inter; never set Latin text in the serif except titles.
4. Colour: `Button` primary (deep teal-black) is the action; `variant="brand"` (teal) at most once per screen; `secondary` is an ink outline; `onImage` for photos. Selected chip, tab and size = dark fill. Category shortcuts = `IconButton variant="sand"` with `caption`. Emerald only for verified savings, coral only for urgency/errors, gold only for Plus.
5. Shape: buttons and inputs radius 14, cards and images 18, sheets 24, chips and search pill. `Card variant="elevated"` is the one raised card (soft shadow); default `plain` is unboxed. No boxes within boxes.
6. Inputs: `SearchField` (pill with leading search icon) for search; `TextField` is a rounded box with floating label and optional `leadingIcon`. `SizeSelector` is rounded squares, selected = dark.
7. Navigation: `TabBar` is flat, ivory, hairline top, icon + label, filled glyph when active (`activeIcon` or the `-outline` name without suffix). Use `tabBarInset()` for bottom padding (56 + home indicator). Do not float it.
8. Lists: `ListRow` with hairline dividers and a mirrored chevron; grids are 2-up `ProductCard` with the heart on the photo. Wrap items in `<Reveal index={i}>`; `Skeleton` for loading.
9. Press: `PressScale`, `Button`, `ListRow`, `IconButton` already spring and tick. Toggles use `selectionTick()`, success `successNotice()`.
10. Art: always through `ProductArt`/`StoreCover`/`HeroArt` (placeholder, follows the theme).
11. RTL and Arabic: start/end only; Arabic display is Amiri and text is Plex Sans Arabic automatically; no tracking on Arabic.

## Motion presets (`@outlet/ui-tokens` `motion`)
Durations instant 120, fast 200, base 320, slow 480, hero 720. Easing `standard [0.22,1,0.36,1]`, `exit`, `inOut`. Springs `settle`, `glide`, `press` (damping ratio >= 1: no bounce). Stagger 60 ms step, 16 pt travel, 520 ms, max 8 items. Press scale 0.97.

## Worklet rule (this crashed Expo Go once)
Code inside `useAnimatedStyle` / gesture handlers must not call plain JS helpers from other modules (only Reanimated functions and inline math or functions marked `'worklet'`). Pure helpers in `logic/motion.ts` are for tests and JS-side use. Expo Go only: no new native modules.

## Do / don't
Do: ivory space, one serif headline, edge-to-edge photography with rounded corners, hairline rows, one dark action per screen, sentence-case labels. Don't: the v1 palette (dark red and near-black), uppercase tracked buttons, floating tab pill, hard square corners, more than one teal `brand` element per screen, bounce, fake urgency or stock, emoji, raw hex, hand-rolled fade-ins (use `Reveal`/`FadeIn`).

## Migration notes from v1
Token keys are unchanged (`brand`, `champagne`, `glass*` kept) so screens compile; `brand` now means teal, `champagne` equals `sand`. New: `sand`, `onSand`, `sage`, `forest`, `shadows.card`, `SearchField`, `IconButton variant="sand"|"solid"`, `Card variant="elevated"`, `FullBleedHero cornerRadius`, `TabBarItem.activeIcon`. Removed: Bodoni Moda and Plex Sans (Latin) assets; art exports `BORDEAUX` (v1 palette constant), `ROSEWOOD`, `GOLD`, `OBSIDIAN` (use `TEAL`, `SAND`, `DEEP`).
