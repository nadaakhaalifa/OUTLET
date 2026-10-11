# Seller Center Phase 2: design notes

Uses the existing tokens (`@outlet/ui-tokens` via `styles/tokens-css.ts`) and classes in `globals.css`. No new colours or sizes.

## Patterns

- **Page frame**: `section[aria-labelledby]` with an `h2`, then `ScreenFrame` for loading, offline, not configured, empty and error (`role="status"` or `role="alert"`).
- **Stat tiles** (`StatTiles`): `dl.tiles`. A null value renders the hint "Not enough data", never 0.
- **Tables**: `caption` (visually hidden when a heading exists), `th scope="col"` headers, first cell `th scope="row"`. Wrapped in `.tablewrap` for horizontal scroll at narrow widths.
- **Forms**: `ActionForm` with visible `label` per input, 44 px minimum targets (`--target`), errors announced with `role="alert"`. Numeric and ID inputs use `dir="ltr"` inside RTL pages. Date-time inputs are labelled "Cairo time".
- **Countdown** (`ServerCountdown`): text pill, not colour alone; it turns to the `warn` style (border and text) inside 2 hours and always carries words. With no server time it says so.
- **Notes**: `.banner` for rules the seller must read (sponsored rules, open-box no-percent rule, k-anonymity notice); `.hint` for secondary copy.

## Accessibility (WCAG 2.2 AA intent)

Labels on all inputs, programmatic table structure, 3 px focus outline from the shared stylesheet, no information by colour alone, no timers that expire sessions, text can reflow (no fixed heights), logical properties for RTL. Hub lookup input sets `aria-invalid` and `aria-describedby` on error.

## Copy rules

Arabic is authoritative; every key exists in AR and EN (`i18n/phase2-ar.ts` is typed `Record<keyof en>`). No percent-off, "was" price, urgency or social-proof copy anywhere in these screens. Product name is Z-OUTLET.
