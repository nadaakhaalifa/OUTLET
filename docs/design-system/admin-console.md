# Admin Console design notes

Scope: `apps/admin-web`. Principles: calm, dense, honest. One next action per row. State is always visible: loading, empty, error, offline, forbidden, not configured.

## Tokens
Colors, spacing, radius and type come from `@outlet/ui-tokens` and are emitted as CSS variables in `src/app/styles.ts` (light, with `prefers-color-scheme: dark`). No hex values in components. `danger` is reserved for destructive or overdue states; `accent` for the primary action and "ok".

## RTL first
Arabic is the default locale (`dir="rtl"`, `lang="ar-EG"`). Layout uses logical properties only (`inline-size`, `padding-inline`, `inset-inline-start`, `border-inline-end`, `text-align: start`). Identifiers, ids, keys and codes are `dir="ltr"`; user text is `dir="auto"`. Numerals follow `ar-EG` formatting; money shows `ج.م` after the number in Arabic and `EGP` before it in English.

## Components
- Shell: skip link, side navigation (role filtered), top bar (language, sign out), banners (not configured, roles unknown, posture).
- Table: wrapped in a horizontal scroller for phone width; header cells are `th`.
- Badge: tone ok, warn (dashed), bad, neutral. Status is never conveyed by color alone (text label always present).
- ReasonDialog: native `<dialog>`, required select of enumerated reason codes, hidden ids, cancel and submit. Focus returns to the trigger.
- PiiViewer: dialog form, result card with live region, hide now and auto hide after 60 s.
- Meter: 8 px bar for the 5-business-day window; turns danger color when overdue.
- Notice: `role="alert"` for errors, `role="status"` for success.

## Accessibility (WCAG 2.2 AA)
44 px minimum targets, visible 3 px focus ring, semantic landmarks (`nav`, `main`), skip link, labels bound to controls, `prefers-reduced-motion` honoured, no motion beyond dialogs. Contrast is inherited from the token pairs.

## Content rules
Every string exists in AR and EN; `ar.ts` is typed `Record<MessageKey, string>` so a missing key fails the build, and a test checks placeholder parity. No marketing copy, no invented numbers, no sample rows. Legal clocks (72 h, 3 days, 5 business days) are shown with the server-computed deadline.
