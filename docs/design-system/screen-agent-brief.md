# Screen agent brief (read this first, every screen agent)

> v1 brief, kept for process. Identity is superseded by rebrand v2.1: read `brand.md` and `rebrand-guide.md` first.

The owner said about the first version of the app: "I didn't like the app design at all". The target is **clear, direct, elite luxury: not a regular store** (v1 wording said glass; v2 is calm, professional and clean, see `brand.md`). The foundation is built (`docs/design-system/foundation.md`, `packages/ui-tokens`, `packages/ui-native`, `apps/mobile/src/theme`, `apps/mobile/src/art`). Your job is to rebuild screens on it. Read `foundation.md` and `brand.md` first.

## Design rules (non-negotiable)
- **Stark and quiet.** White / near-black pages, ink buttons, one neutral fill (#F2F2F0 / #1C1C1B). No grey boxes around everything: use whitespace and hairlines. Emerald only for verified savings, coral only for real urgency and errors, gold only for Plus.
- **Imagery first.** Full-bleed images, edge to edge, minimal text under products (name, price). Product images are the placeholder art kit (`ProductArt`, `StoreCover`, `HeroArt`) until sellers upload real photos: pass them through `imageNode` / `coverNode`.
- **Glass** (`GlassSurface`, the glass tab bar, sheets, sticky bars, overlays over imagery) with a solid fallback under Reduce Transparency and AA contrast over any image (use `Scrim`).
- **Type:** IBM Plex Sans / IBM Plex Sans Arabic via the theme `Text` variants; small tracked uppercase `Eyebrow` labels (Latin only); light display titles; prices tabular.
- **Motion:** slow and smooth (280 to 360 ms), no bounce, respect Reduce Motion.
- **One clear next action per screen.** No dead ends: every empty / error / offline state has an `EmptyState` with an illustration and an action.
- **Honesty:** never show fake stock, timers, reviews, viewers, counters or discounts. A strike-through price or percentage appears only through `PriceBlock`'s `claim` (verified). Countdowns use SERVER time. Copy-lint (`node tooling/copy-lint/cli.mjs`) must stay at 0 findings.
- **Arabic first, RTL first-class.** Use start/end style props only, `Icon directional` or `chevronName(isRTL)` for arrows, test AR and EN, light and dark. 44 pt minimum targets, accessible names on every icon button, Dynamic Type safe.

## Component API (from the foundation agent)
- Import UI from `../ui` (or the feature-relative path to `src/ui`) and theme from `../theme`. `Screen` takes `title`, `onBack`, `trailing`, `footer`, `onRefresh`, `padded`; it handles safe-area insets and the tab-bar padding itself, so do not add your own.
- `PriceBlock` and `ProductCard` take pre-formatted money text plus `priceMinor`; a `claim` is `{referenceMinor, percent, verified, referenceText, percentText}`; anything not verified and arithmetically consistent renders as a plain price.
- `FullBleedHero` inside `Screen` for edge-to-edge heroes; `StickyBar` as `footer` for totals and primary actions.
- Money formatting stays in `features/money-display.ts` (bigint piastres, Western/Eastern digits by locale).

## Code rules
- TS strict, no `any`, no `@ts-ignore`, Zod at boundaries. Pure view-model functions are unit-tested with vitest (there is no RN renderer): keep screens thin, logic in `model.ts`.
- Features follow `apps/mobile/src/features/<feature>/{model.ts, <Feature>Screen.tsx, <feature>.test.ts}` with a port interface and an in-memory fake (dev default), plus an API adapter (`api.ts`) over the generated client `@outlet/api-client` (`apps/mobile/src/services/api-client.ts`). Real adapters are used when `EXPO_PUBLIC_API_BASE_URL` is set. Do not invent endpoints: use the operationIds in `packages/api-client/src/generated/operations.ts`; if something is missing record it in `docs/plan/api-client-gap.md`.
- **Shared files** (`apps/mobile/src/state/ports.ts`, `packages/i18n/src/en.ts` and `ar.ts`, `apps/mobile/src/app/(tabs)/_layout.tsx`): other agents edit them at the same time. Re-read immediately before every edit, make small additive edits only (your own namespace / your own port), never reformat or reorder. i18n: every key in AR and EN (parity is enforced).
- No git (no stash/checkout/reset), no `pnpm install`, never `pkill`/`killall` with patterns. If `npx` fails with EAGAIN use `node node_modules/<pkg>/...` directly. Write each file with one Write call and do not stall.

## Looking at your work (mandatory)
An iPhone 16 Pro simulator (`10FC4BE5-E470-43D7-A7B9-65BC00709106`) is booted and Metro runs on port 8081 (do not start another; leave it alone; edits hot-reload). The Bash sandbox may need to be disabled for `xcrun`.
- Open a route: `xcrun simctl openurl booted "exp://172.20.10.2:8081/--/<route>"`, wait about 8 s, then `xcrun simctl io booted screenshot /tmp/<name>.png` and Read the PNG (you can view images).
- Look at EVERY screen you build in light, dark and Arabic (the foundation styleguide shows how to switch: query params `?theme=dark&lang=ar`, see `__styleguide.tsx`), fix overlaps, clipping, weak contrast, awkward spacing, anything that does not look like an elite fashion app. Save final screenshots to `docs/design-system/screenshots/<area>-*.png`.
- If the app shows a red error screen, read it, fix your code. If you suspect duplicate native modules, tell the owner session (do not edit `metro.config.js`).

## Verify before finishing
`cd apps/mobile && npx vitest run && npx tsc --noEmit`; `cd ../.. && npx eslint apps/mobile packages/i18n packages/ui-native`; `node .github/scripts/i18n-check.mjs`; `node tooling/copy-lint/cli.mjs`. Return a summary with real numbers, what you verified on the simulator (light/dark/AR), and what you could not do.
