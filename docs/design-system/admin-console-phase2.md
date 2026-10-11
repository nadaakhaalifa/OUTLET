# Admin Console Phase 2 design notes

Uses the existing token stylesheet (`apps/admin-web/src/app/styles.ts`), logical CSS properties (RTL default, EN mirrors), 44 px minimum targets.

## Patterns
- **Switch state badge**: `Allowed` = `badge ok`, `Blocked` = `badge bad`. State is always text, never colour alone. Never "on/off".
- **Change dialog**: native `<dialog>` via `ReasonDialog`; title names the capability; description states the resulting state and its effect, then the audit note; mandatory enumerated reason select.
- **Not measured**: plain text "Not measured" (never 0, never a dash that looks like a value); explanatory `muted` note for missing endpoints.
- **Odds editor**: table of labelled inputs (each input has an accessible name), a live total (`aria-live=polite`), an `alert` list of refusal reasons, publish disabled until valid. Numeric fields use `dir=ltr`.
- **Freeze banner**: `role=alert` notice with danger border; event rows use text badges (Upcoming / Release freeze / Running).
- **Progress**: native `<progress>` with an `aria-label` for the labelled-pairs target.
- **Proxy notice**: `role=note` when DORA numbers use a proxy, so a proxy never reads as a production metric.

## WCAG 2.2 AA checklist
Keyboard-only operation (native controls and dialog), visible 3 px focus ring (existing `:focus-visible`), 44 px targets (`--tap`), labels on every input, status conveyed in text, errors announced with `role=alert`, no motion, contrast from the shared tokens (light and dark), reading order follows DOM in both directions.
