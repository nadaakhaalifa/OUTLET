# Seller Center web app (spec 19, 19.1)

Status: v1 built against the API contract and fakes. No live backend, no browser run (build and HTTP smoke only).
Code: `apps/seller-web` (Next.js 16 App Router, React 19, TypeScript strict, Zod 4).
Related: `docs/design-system/seller-center.md`, `docs/specs/seller-analytics.md`, `docs/specs/price-integrity.md`,
`docs/specs/orders.md`, `docs/specs/returns.md`.

## Flow
1. `/login`: passkey. Server action fetches the WebAuthn challenge (`/v1/auth/passkey/assert/options`), the browser signs
   it, a second server action exchanges it (`/v1/auth/passkey/assert`). Tokens go into an httpOnly cookie. TOTP form is
   present and fails closed (no endpoint; VR-SC-02).
2. `/dashboard`: store lookup, then sales, funnel, traffic, geography and aging reports in parallel for the last 30
   whole UTC days. Sales failing fails the page; a secondary report failing hides only its section.
3. `/catalog`, `/catalog/new` (product editor + size chart editor), `/catalog/import` (CSV pre-check).
4. `/orders`: list, accept, reject (reason), pack, create shipment, AWB label download (streamed through the server).
5. `/returns`: inspection queue; approve works, reject is blocked until uploads exist (VR-SC-03).
6. `/finance`: balance, payouts, statements, invoices from the platform with ETA reference.
7. `/marketing`: seller vouchers, pause or resume. `/team`: invite, remove, MFA status. `/price-trust`: score, ladder
   state, active actions with the cure text, claims. `/settings`: store facts, language, sign out.

## Rules
- Arabic first, RTL via `dir` on `<html>`; English by cookie `sc_locale`. Copy lives in `src/i18n` (flat keys,
  `ar: Record<keyof en>` so a missing key is a compile error) plus a parity test. `packages/i18n` is mobile-shaped and
  its parity script only knows that package, so no keys were added there.
- Money is integer piastres. Wire strings parse to `bigint` in Zod; display uses integer math only (`lib/format.ts`).
  Prices typed by sellers parse from decimal text to piastres without floats.
- Arabic title and description are mandatory and must contain Arabic letters (CPL 181/2018, spec B5).
- Defect photos are mandatory for condition `minor_defect`.
- Size charts reuse the domain `validateChart` (monotonic, plausible deltas, inch to cm). Sizes XS..XXXL and numeric
  labels are sorted before checking so entry order cannot cause a false error.
- Accept SLA countdown: server clock from the HTTP `Date` header at fetch time plus a monotonic elapsed timer. No
  server time or no deadline means no countdown (never a guess). Only orders in PAID or CONFIRMED_COD have a deadline.
- Analytics: freshness is shown with the SLO; suppressed cells are counted, never named; suppressed or absent values
  render "Not enough data", never 0; the markdown notice (no percent-off unless verified) is always shown with aging.
- No fake data: no placeholder numbers anywhere. Unconfigured API means an explicit "not configured" state.
- Voucher copy never presents a voucher as a reference price.

## Edge cases
Offline (fetch failure and `navigator.onLine` banner), 401 (one refresh then sign-in prompt), 403, 404, 429, contract
mismatch (response fails Zod), empty lists, zero-order period (empty, not zeros), cursor pagination via `?cursor=`,
double submit (server action pending state, same Idempotency-Key reused on the 401 retry), stale freshness, suspended
store (status shown in settings), path ids URL-encoded, non-UUID ids rejected in actions and the label route.

## Data
No tables. Browser holds one cookie `sc_session` (httpOnly, Secure, SameSite=Strict, 8 h) with access and refresh
tokens, `sc_locale` (preference) and optionally `sc_install`. PII class of data shown: P2 (buyer first name,
governorate, masked phone relay as provided by the API), P1 elsewhere. No `localStorage`.

## API
Hand-written from `docs/api/openapi.yaml` seller operations (`src/api/client.ts`, `schemas.ts`):
`getSellerStore`, analytics `sales|funnel|traffic|geography|aging`, `listSellerProducts`, `createSellerProduct`,
`updateSellerProduct`, `size-charts`, `catalog/imports`, `listSellerOrders`, `accept|reject|pack`, `createSellerShipment`,
`getSellerShipmentLabel`, `listSellerReturns`, `inspect`, `balance`, `payouts`, `statements`, `invoices`, promotions,
team, `price-trust`, `price-claims`. Writes send an Idempotency-Key (UUID). Base URL: env `SELLER_API_BASE_URL`
(https, or http on loopback only). `fetch` exists only in `api/transport.ts` (boundary test).

## Events
None emitted. Analytics SDKs are not loaded (no consent surface for sellers in this version).

## Failure handling
Transport timeout 10 s, no automatic retry of writes except the single post-refresh replay with the same key.
Reads are `no-store`. Errors map to localized states with the API `request_id` shown for support.

## Security and abuse
- CSP with per-request nonce and `strict-dynamic` in `proxy.ts` (Next 16 name for middleware); no inline scripts or
  style attributes are authored (test); `frame-ancestors 'none'`; `connect-src` limited to the API origin.
- HSTS, nosniff, referrer policy, permissions policy, COOP. Nonce pages are dynamic.
- Authorization is the API's (BOLA/BFLA tests live there). The UI hides actions by status and (when known) role as a
  convenience only; another store's id answers 404 and renders "not found".
- Server actions re-validate all input with Zod; the product draft is re-validated server-side by the same pure rules.
- Label PDFs stream through a route handler so tokens never reach the browser.
- SRI: scripts are same-origin, produced by the build; `experimental.sri` is not enabled here (see gaps).
- OWASP API mapping: API1/API5 (API enforced, UI renders 404/403), API4 (page size 25, cursor), API8 (headers).

## Options compared
- Session storage: (a) httpOnly cookie holding the token pair (chosen, simple, no server state) versus (b) opaque
  BFF session id with server-side store (stronger, needs infra; recorded as VR-SC-08).
- Row error report: (a) client pre-check with the same rules shown before upload (chosen, instant, works offline)
  versus (b) only the server dry run (authoritative but needs the upload endpoint that does not exist yet). Both are
  planned; (a) never replaces (b).
- Countdown clock: (a) device clock (rejected, drift and manipulation) versus (b) server Date + monotonic timer (chosen).

## Metrics
Accept-within-SLA rate (seller health, API side), import first-pass success, dashboard TTFB. SLI/SLO for this app is
the API's; web vitals are not collected yet.

## Acceptance
- Login page renders a passkey button and no data without a session (proxy redirects to `/login`).
- A paid order shows accept and reject and a countdown from server time; a shipped order shows neither.
- An empty period shows the empty state, a suppressed repeat rate shows "Not enough data".
- A minor-defect product without photos is rejected with a field error; Arabic title with Latin letters is rejected.
- A chart with a smaller bust in a larger size is rejected with the size named.
- CSV with wrong rows lists row and column per problem and the counts add up.
- `next build` succeeds offline; CSP header carries a fresh nonce per request.

## Gaps
- Not exercised in a browser: layout, RTL mirroring, focus order and contrast were checked by token math and markup
  review only; no screen reader run.
- Passkey flow is untested against a real authenticator.
- No upload UI or server dry run (VR-SC-03); no product edit page (create and status only); no size chart attach to
  product; no promotion create form; no statement PDF download; no CSV export of analytics; no date range picker.
- Role unknown (VR-SC-01). Seller device platform enum (VR-SC-04).
- `fast-check` is used by tests but not declared in `package.json` (resolved through `packages/domain`).
- SRI attributes not generated; Next 16 build output is same-origin only.
