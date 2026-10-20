# Seller Center design notes

Scope: `apps/seller-web`. Tokens come from `@outlet/ui-tokens` and are emitted as CSS custom properties by
`src/styles/tokens-css.ts` (light, dark by `prefers-color-scheme`, forced via `data-theme`). No colour or size is
hard-coded in components.

## Layout and RTL
- `dir` and `lang` on `<html>` from locale; Arabic default. Only logical CSS properties (`inline-start`, `margin-inline`,
  `text-align:start`). Numerals: Eastern Arabic in `ar`, Latin in `en`; ids, codes, emails and ETA UUIDs are `dir="ltr"`.
- Two-column shell (nav + main) collapses to one column at 800 px. Tables scroll inside `.tablewrap`; no page-level
  horizontal scroll.

## States (every screen)
`ScreenFrame` renders exactly one of: loading (`role=status`), offline (`role=alert`), not configured, empty, error
(localized message, API request id, retry or sign-in), ready. A global banner appears when the browser goes offline.
Route `loading.tsx`, `error.tsx` (generic message, no thrown text) and `not-found.tsx` cover the rest.

## Accessibility (WCAG 2.2 AA)
- Skip link, landmark nav and main, one `h2` per page, table captions and `scope` on headers, all inputs labelled,
  `aria-invalid` plus described error text, live regions for validation summaries.
- Targets: buttons, links in nav and inputs are at least 44 px (`--target`). Focus ring 3 px accent, offset 2 px.
- Contrast: unit-tested for text pairs (4.5:1) and control outlines (3:1) in both schemes. Finding: the `border` token
  is only about 1.4:1 (light) and 1.5:1 (dark), so it is used for decorative dividers only; control outlines use
  `textSecondary`. Recommend raising `border` or adding a `controlBorder` token in `ui-tokens`.
- Colour is never the only signal: warnings carry text; MFA missing and SLA overdue have text labels.
- Reduced motion: no animation is authored; a media query disables any.
- Target size, dragging and authentication criteria (2.5.8, 2.5.7, 3.3.8): no drag interactions; passkey login has no
  cognitive test.

## Components
Shell, ScreenFrame, Countdown (server-time driven), OrderActions, ActionForm, ProductEditor, SizeChartEditor,
CsvChecker, Pager, OfflineBanner, LoginForm. Tiles show `Not enough data` when a value is withheld.

## Content rules
No invented numbers, ratings, urgency or percent-off. Voucher funding is shown as seller and platform percentages.
Markdown suggestions always carry the "no percent-off unless verified" notice from the analytics API.
