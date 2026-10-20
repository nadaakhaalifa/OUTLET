# Brand mode (seller app)

Approved brands ("has an account to show its products and its own dashboard") get their own app experience with the same Z-OUTLET v2 brand system (ivory, teal ink, sand; see `brand.md`). Code: `apps/mobile/src/features/brand-mode`, routes `apps/mobile/src/app/brand-mode/**`, i18n namespace `brandMode`.

## Entry
- Me tab switcher (owned by the Me feature) reads `getBrandModePort()`; `registerBrandMode()` (root layout) installs `BrandModeFromBrandPort`: entry exists only when `BrandPort.account()` succeeds (API: 403/404 means no approved brand). `enter()` pushes `/brand-mode`.
- With a real backend configured an approved brand lands in brand mode at launch (`landingForSignedIn`, app/index.tsx). In dev without a backend the fixture brand is offered in Me only.
- Brand mode has its own flat tab bar: Dashboard, Products, Orders, Store. Product form is a hidden tab (bar hidden). Back to shopping: icon top right of Dashboard.
- Dev preview: `?theme=dark&lang=ar` on any brand-mode route.

## Screens
- Dashboard: sales/orders today (null = "Not enough data" + privacy hint, never 0), freshness label, awaiting-accept list with SLA countdown from SERVER time (clock offset from payload), low stock, payout summary (eligible, releasing, held + reasons), price trust with fixes, store health.
- Products: search, filters, status and claim badges (claims come from the server only), add/edit form: multi-photo (library + camera, bulk upload with progress, cover/reorder/delete), Arabic title required with inline validation, condition (defect photos required), price parsed to piastres (Western/Eastern digits) with the "no % off unless verified" explainer, size grid with stock, size chart picker, SKU/barcode (GTIN check digit), autosave of drafts (1.5 s), publish gate listing exactly what is missing.
- Orders: queues (to accept, to pack, shipped, returns, done); detail sheet with buyer masked (first name + governorate; relay line only from ACCEPTED), accept / reject with reason / pack / print AWB / ready for pickup, return inspection sheet. Actions are role-gated and hidden after the SLA breaches.
- Store: profile, return policy (statutory 14/30 minimum shown and enforced), shipping origin and handling time (12 to 168 h), vacation (max 90 days), payout bank account (EG IBAN mod-97, masked display, name-match result, 48 h hold notice, strong-factor step-up sheet within 300 s), team (invite by phone, revoke, owner only), notification preferences (new order and SLA warnings locked on), link to the full Seller Center.

## States
Skeletons while loading; last good data kept in memory and marked stale when a refresh fails offline; offline / generic error with retry; `session_expired` re-auth prompt; `forbidden` role view; `unsupported` points to the Seller Center. Dev banner states fixture data.

## Ports
`BrandPort` (model.ts) with `InMemoryBrandPort` (fake.ts, dev default) and `ApiBrandPort` (api.ts). Missing operations: docs/plan/api-client-gap.md.

## Known limits
Offline cache is per process (no async-storage dependency); order list has no server time so countdowns reuse the dashboard clock offset; photo reorder is by buttons, not drag.
