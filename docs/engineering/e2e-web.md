# Browser E2E for seller-web and admin-web (Playwright)

Run: `E2E_PROD=1 tooling/e2e/run.sh seller` or `... admin` (one app at a time, 1 worker, Chromium desktop 1440x900 and mobile 390x844, EN and AR/RTL).
Needs the sandbox disabled (browsers, servers). `E2E_PROD=1` does `next build` + `next start`; without it `next dev` is used, which reports dev-tooling CSP violations (devtools inline styles, eval) that are NOT product findings.

`run.sh` refuses to start if ports 3917/3918/3001/3002 are busy, boots the API (`DEV_FIXTURES=true`), `tooling/e2e/gateway.mjs` (port 3918) and the app, and on exit kills only the PIDs it started plus whatever listens on its own ports.

## Auth and fixtures
The DEV_FIXTURES API has no seller/admin auth (`/v1/seller/*`, `/v1/admin/*` answer 401, `/v1/admin/me` 404), and the apps read the API server-side, so Playwright route mocking cannot help. The tests inject the apps' own session cookie (`sc_session`, `__Host-admin-session`; base64url JSON) and point the apps at the gateway, which returns schema-valid fixtures for the pages that are asserted in depth (store, analytics with k-anonymity suppression, products, orders, admin me, kill switches, approvals, KYC queue, DSAR, ledger) and forwards everything else to the real API (real 401/403/404 states, allowed only as proper error UI). The passkey login itself cannot be exercised headlessly; only the login page render is tested.

## Per-page assertions
No console errors/uncaught exceptions, no failed requests or 4xx/5xx (except 401/403/404 on pages without fixtures), CSP header with nonce, zero `securitypolicyviolation` events, `dir` and computed direction, Tab reaches an element in `<main>`, no horizontal page overflow at 390px, a11y heuristics (lang, one main, h1, names, labels, duplicate ids), full-page screenshot to `docs/design-system/screenshots/web-*.png`.

## Gaps
`@axe-core/playwright` is not installed (needs: `pnpm add -D @axe-core/playwright` at root); `helpers.ts` uses DOM heuristics instead, which do not cover contrast or ARIA validity. Needs listed in the findings file.
