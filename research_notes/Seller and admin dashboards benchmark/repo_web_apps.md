# Repo audit: Z-OUTLET web front ends (seller-web, admin-web, web design system)

Read-only audit, 2026-10-16. Paths relative to /Users/nadakhalifa/OUTLET. No web sources used; all findings are from the repo, so "Source" = file:line. A prior audit exists at docs/research/research_notes/Marketplace seller dashboard design/current_implementation_audit.md (not re-verified here).

## 1. Pages, routes, data sources, states

### Takeaway
Both apps are server-rendered Next 16 apps whose pages call the real API through typed clients (Zod-validated); there are no hard-coded business fixtures in the pages. Fixtures exist only in the e2e gateway (tooling/e2e/gateway.mjs). Visually the pages are plain tables/definition lists; the only "KPI" visual is a text tile.

### Cited Findings
**Stack.** next ^16.4.0 (installed 16.4.0), react/react-dom 19.2.3, zod ^4, typescript ~6.0.3, vitest ^3.2.7 (apps/seller-web/package.json, apps/admin-web/package.json; installed versions from node_modules). Workspace deps: @outlet/domain, i18n, ui-tokens, validation (admin also devDep feature-flags). Dev ports 3001 (seller) and 3002 (admin).

**Seller Center routes** (apps/seller-web/src/app/*/page.tsx; all call `pageCtx()` -> loader in loaders.ts / loaders-phase2.ts -> `ScreenFrame`):
- /dashboard (app/dashboard/page.tsx:84-93; loadDashboard loaders.ts:42): sales tiles, funnel table, traffic table, geography table, aging/markdown table; real API: GET /v1/seller/store plus /v1/seller/stores/{id}/analytics/{sales,funnel,traffic,geography,aging} (api/client.ts:137-150). Shows freshness banner, k-anonymity suppression notes. No charts: `<dl class="tiles">` and `<table>` only (dashboard/page.tsx:41-48, 52-55).
- /catalog (+ /catalog/new, /catalog/import per e2e list; only catalog/page.tsx exists as a top-level file in my listing, subroutes not enumerated), /orders, /returns, /finance, /marketing (promotions), /ads, /drops, /resale, /insights, /media, /forecasts, /channels, /hub, /price-trust, /team, /settings (+ settings/layout.tsx), /start, /apply, /apply/[id], /onboarding, /login. Nav list: view-models/nav.ts:9-27 (17 items).
- /finance (app/finance/page.tsx): balance tiles (available/pending/held/negative carry), payouts table, statements table (gross/commission/VAT/refunds/net), tax invoices table with ETA UUID; real API /v1/seller/balance, /payouts, /statements, /invoices (client.ts:187-190).
- /insights (app/insights/page.tsx): markdown recommendations table, size-curve tables per product; stylist-inclusion section is a literal "unavailable" note (insights/page.tsx:62-63).
- Page root app/page.tsx is 5 lines (redirect).
- States: every screen renders one of loading/offline/not_configured/empty/error/ready via `ScreenState` (view-models/screen-state.ts:5-11) and `ScreenFrame` (components/ScreenFrame.tsx:9-31). Retry is a plain `<a href="">` (ScreenFrame.tsx:24-26). Global app/loading.tsx, error.tsx, not-found.tsx exist. components/OfflineBanner.tsx exists. "loading" kind is declared but loaders return awaited results, so streaming/skeletons are not used (app/loading.tsx is one `<p role=status>`).
- Shell: components/Shell.tsx:8-11 states "Role is not exposed by the API yet (no seller "me"), so all links are listed" and calls `navFor(null)`; page-context.ts:11-14 hard-wires `role: null`. So seller nav RBAC filtering (nav.ts:30-32) is built but never active.
- No mobile nav/hamburger found in seller Shell (sidebar only; CSS responsive not checked in detail).

**Admin Console routes** (apps/admin-web/src/app/(console)/*/page.tsx; layout (console)/layout.tsx; login/page.tsx): / (home), approvals, elevation, sellers, brand-applications (+ /mine, /[id], loading.tsx), suspensions, price-integrity, flags, privacy, tax, finance, returns, promotions, plus, gift-cards, rewards, calendar, drops, price-matching, ads, resale-hub, engineering, moderation, creators, ranking, pii. Nav registry with role gates: view-models/nav.ts:17-44 (26 items).
- Home (app/(console)/page.tsx:7-46): three count tiles (brand applications unassigned/mine/SLA-late) via c.api.brandQueue limit 50 ("50+" label, comment at :10 says no API count exists), then a bare `<ul>` of links to every nav item. Not a dashboard.
- Flags (flags/page.tsx): kill-switch board grouped, Allowed/Blocked badge, reason-code dialog per switch; real API GET /v1/admin/flags, PUT /v1/admin/flags/{key} (client.ts:133-136).
- Suspensions (suspensions/page.tsx:10-50): table with SLA clock badge + `.meter` bar, uphold/reinstate (ReasonDialog). Real API /v1/admin/kyc/suspension-reviews.
- Plus (plus/page.tsx:10-87): plan versions table, publish/approval forms, SwitchStrip of kill switches; metrics section is literal "not measured" placeholders (plus/page.tsx:81-85, PLUS_METRICS_NOT_MEASURED).
- Engineering (engineering/page.tsx:7-26): DORA is NOT fetched from API. User pastes/uploads a DORA report JSON into a client component (components/dora-loader.tsx:13-58) parsed in browser by Zod (view-models/dora.ts:28-33). Renders a metrics table + weekly series table; null metrics show "not measured". Cost/gCO2e rows are "not measured" placeholders (dora.ts:56, engineering/page.tsx:21-23). tooling/e2e/dora-report.sample.json is the sample.
- Approvals page (approvals/page.tsx:1-40+): approval inbox with covers/amount/expiry/state, approve/reject actions, self-approval blocking via approvalInbox (selfId, selfRoles).
- Admin API surface: ~70 endpoints in api/client.ts:100-248 (approvals, elevations, pii-views, flags, kyc, privacy, tax, ledger, reconciliation, price-integrity, plus, rewards, games odds, drops pause, price-matching, ads, creators, creator payouts, ranking, moderation, promotions, brand-applications).
- States: `ErrorBlock`, `Empty`, `Flash`, `Badge`, `WritesDisabledNote`, `PageHeader` (components/ui.tsx:30-73); error kinds incl. offline/unavailable/forbidden/contract mapped to i18n (ui.tsx:15-28). brand-applications has loading.tsx skeleton (.skeleton CSS styles.ts:137). Other admin pages have no loading.tsx.
- Layout: left `<nav class="side">` 240px, `<main>`, sticky topbar with language toggle + sign-out only (layout.tsx:19-39). No search, breadcrumbs, user menu, notifications, or role/identity display.

**Spec coverage, Seller (spec section 19)** (from routes above): present: onboarding/KYC (apply, onboarding, start), catalog + CSV import (CsvChecker.tsx, view-models/csv-import.ts), size-chart editor (SizeChartEditor.tsx), channel integrations (/channels), drops, orders with accept countdown/pack/ship/AWB label (client.ts:167-181), returns inspect, finance (balance/payouts/statements/e-invoices), marketing/promotions, ads, team with roles, price trust, analytics (dashboard + insights + forecasts), photo cutouts (/media), resale, hub tracking. Absent or thin: no Seller Health Score page (not found by name), no storefront builder, no Q&A response screen, no scheduled reports/CSV export of analytics (not found), no ROAS/voucher-ROI view beyond /ads, no carbon view, no passkey/TOTP management screen outside login (SellerAuthFlow.tsx has passkey+TOTP enrol).
**Spec coverage, Admin (spec section 23)**: present: sellers/KYC, brand applications, price-integrity monitor, drops, promotions, gift cards, rewards, Plus plans, calendar (mega events), privacy/DPO, tax/ETA, finance/ledger/recon, returns/disputes queue, moderation, ads config, ranking shadow, creators, feature flags, approvals (dual approval), elevation (JIT), PII views with reason codes. Absent (also per prior audit line 277): platform analytics (GMV, take rate, contribution margin, cohorts, funnel, war room), support desk/WhatsApp inbox, audit-log viewer, user/order lookup, merchandising/homepage builder UI, logistics SLA console, SCI/FinOps dashboards (placeholders only), anomaly alerts, RBAC management UI.

### Inferences
- Rebuilding the admin Home as a real overview needs new API aggregates: only brand-queue counts exist as live tile data.
- Seller dashboard data layer is the strongest asset (typed analytics endpoints with freshness/k-anon metadata); only the visual layer is missing.

### Gaps
- Did not read every page/loader line by line (~45 pages); the seller subroutes under catalog/ (new, import) were referenced via e2e list but not opened.
- Not verified whether the real API implements each analytics/admin endpoint or only the dev fixtures gateway does.

## 2. Charts and data visualisation

### Takeaway
No chart library anywhere. Total visualisation inventory: text KPI tiles, one pure-CSS horizontal "meter" bar (admin), a QR-code SVG (seller), and HTML tables. DORA series is a table, not a graph.

### Cited Findings
- A grep for recharts, chart.js, d3, victory, visx, echarts, nivo, uplot across all package.json files in apps/ and packages/ returned nothing. Seller/admin dependency lists contain only next, react, react-dom, zod and workspace packages (package.json files above).
- Only inline SVGs in web apps: components/QrCode.tsx:9 (seller) and the wordmark/monogram identity SVGs (admin components/identity-mark.tsx, seller components/Identity.tsx). No `<polyline>`/sparkline code found by grep.
- Admin meter: view-models/meter.ts:1-8 quantises a 0..1 fraction to 21 buckets because "The CSP forbids inline style attributes, so widths are CSS classes `mw-N`"; CSS generated by METER_CSS (appended at app/styles.ts:138); used in suspensions/page.tsx:33 (aria-hidden). Also `<meter>` element styled at styles.ts:109-112 (.sla-meter).
- Tile pattern: admin `.tiles/.tile/.tile-n` (styles.ts:134-136, Playfair display numerals, tabular-nums) and seller `<dl class="tiles">` (StatTiles.tsx:5-15; dashboard/page.tsx:41-48). Null values render "no value", never zero (StatTiles.tsx:4).
- Kill switches: view-models/killswitch.ts: 42+ Phase 2/3 keys (PHASE2_SWITCH_KEYS :12-23) plus EXPECTED_KILL_SWITCHES from ./flags; Allowed/Blocked vocabulary (ADR-0028, :6-9); grouped board built by killSwitchBoard (:236); rendered as grouped tables (flags/page.tsx:27-46) and compact `SwitchStrip` (components/switch-strip.tsx) on feature pages.
- CSP constraint relevant to charting: style-src is `'self' 'nonce-…'` with no 'unsafe-inline' (admin security/csp.ts:38; seller csp.ts similar); script-src uses nonce + 'strict-dynamic'; img-src 'self' data:. Inline `style=""` attributes are blocked, so any chart must use CSS classes, SVG presentation attributes, or nonce'd style elements (SVG `width`/`x` attributes work; `style=` does not).

### Inferences
- A chart library that injects inline styles (many do) would violate the CSP; hand-rolled SVG or a library audited for CSP-nonce support is the fit. Bundle impact unconstrained (no budget, see section 7).

### Gaps
- Did not check the seller csp.ts directive list line by line (79 lines).

## 3. Web design system

### Takeaway
There is no `packages/ui-web`; "web design system" = @outlet/ui-tokens (TS tokens, RN-shaped) re-derived into CSS strings separately in each app, with a bespoke CSS-in-TS stylesheet and a handful of app-local components. The design lint and debt baseline target mobile only.

### Cited Findings
- `packages/` contains: analytics, api-client, auth-core, db, domain, feature-flags, i18n, idempotency, outbox, policy, privacy, ui-native, ui-tokens, validation. No ui-web (bfs error: packages/ui-web: No such file).
- packages/ui-tokens/src/index.ts exports colors (light/dark), spacing, radius, typography, motion, shadows, minTouchTarget (imports at admin app/styles.ts:1 and seller styles/tokens-css.ts:1). Tests: index.test.ts, drift.test.ts.
- Seller CSS derivation: apps/seller-web/src/styles/tokens-css.ts (vars `--c-*`, `--s-*`, `--r-*`, `--t-*`, motion `--d1..3`, `--ease`; dark follows OS "unless forced") + app/globals.css (96 lines) + onboarding.css. Admin derivation: app/styles.ts:1-141 (vars un-prefixed `--background`, `--sp-*`, `--r-*`) injected as one string. Two parallel, divergent token-to-CSS pipelines with different variable names and class vocab (seller `.tablewrap`, `.hint`, `.banner`, `.vh`; admin `.table-wrap`, `.muted`, `.notice`, `.sr-only`).
- Visual language: ivory paper/deep teal ink, hairlines, Playfair Display (Amiri for Arabic) display, Inter + IBM Plex Sans Arabic text; fonts self-hosted in public/fonts (TTF, not WOFF2) duplicated in both apps. Glass/blur topbar with `prefers-reduced-transparency` fallback (admin styles.ts:62,65-67).
- RTL: `<html lang dir>` set from locale (seller layout.tsx:28; admin layout.tsx:13, lang "ar-EG"); CSS uses logical properties (inset-inline-start, padding-inline, border-inline-end) throughout; `:lang(ar){letter-spacing:0!important;text-transform:none!important}` (styles.ts:37). e2e asserts dir and computed direction for every page (helpers.ts:55-56). Arabic is the default locale (admin console.ts LOCALE cookie `admin-locale`; seller `sc_locale`); i18n ar.ts/en.ts: admin 855/856 lines, seller split ar/en + phase2/phase3/onboarding files; i18n.test.ts in each app checks parity.
- Design docs: docs/design-system/ (README, foundation, ux-principles, seller-center.md, seller-center-phase2.md, admin-console.md, admin-console-phase2.md, density-v2.md, navigation.md, brand*.md, board-v4, screenshots/).
- Design lint: tooling/design/rules.mjs GLOBS cover only `apps/mobile/src/**` and `packages/ui-native/src/**` (rules.mjs:13-19); rules DS-COLOR, DS-FONT, DS-RADIUS, DS-RN-COMPONENT, DS-MOTION-REANIMATED. tooling/design/debt-baseline.json keys are apps/mobile paths. RTL lint `rtl/no-physical-direction` is also mobile + ui-native only (eslint.config.mjs:104-108). So web apps have NO design-token lint, no raw-colour lint, no physical-direction lint (CSS logical props are by convention + styles.test.ts / tokens-css.test.ts).
- Components: admin components/ui.tsx (PageHeader, ErrorBlock, Empty, Badge, Flash, WritesDisabledNote), reason-dialog.tsx (native `<dialog>`), switch-strip.tsx, pii-viewer.tsx, odds-editor.tsx, brand-ui.tsx, brand-document-viewer.tsx, identity-mark.tsx. Seller: Shell, TopBar, ScreenFrame, ErrorNotice, StatTiles, Pager, ActionForm, DynamicForm, ProductEditor, SizeChartEditor, CsvChecker, Uploads, MediaCompare, Countdown/ServerCountdown, OfflineBanner, SettingsNav, QrCode, SellerAuthFlow. No shared primitives across apps (Button = `.btn` CSS class; Table = raw `<table>`; no Tabs/Card/Dialog/Toast/Skeleton/Chart component; `.card` exists in admin CSS only).
- Accessibility checks: tooling/e2e/tests/helpers.ts:35-77 `checkPage` runs per page: CSP nonce present + no CSP violations, dir/direction, Tab reaches main within 40 presses, no horizontal overflow, @axe-core/playwright (wcag2a/aa/21a/21aa/22aa; fails on serious/critical), heuristic scan (lang, one main, h1, alt, names, labels, duplicate ids), console errors, failed requests; writes full-page screenshots to docs/design-system/screenshots/. @axe-core/playwright ^4.13.0 and @playwright/test ^1.64.0 are root devDeps (package.json:19,21). (Comment at helpers.ts:34 says axe is not installed; stale.)
- Playwright: tooling/e2e/playwright.config.ts: projects desktop 1440x900 and mobile 390x844, workers 1, 90 s timeout; visual project only with E2E_VISUAL=1 (maxDiffPixelRatio 0.02). Visual: tests/visual.spec.ts (23 lines) = login + 1-2 pages x EN/AR x light/dark; baselines dir tooling/e2e/visual-baselines/ "created on first update run" (docs/engineering/visual-regression.md:7-10); opt-in, not in default gate (:3). Mobile Maestro visual flow is "authored, not executed" (:27).
- E2E fixtures: tooling/e2e/gateway.mjs (227 lines) answers authenticated reads with schema-valid fixtures and proxies the rest to the real API; includes `/v1/admin/me` fixture (roles incl. super_admin) so admin e2e exercises role UI even though the real API lacks the endpoint. Kill-switch keys parsed from packages/feature-flags/src/registry.ts. run.sh orchestrates.
- e2e specs: seller.spec.ts (77 lines) pages list of 19 routes x EN/AR plus targeted tests (forecast ranges, media compare, k-anon suppression, Arabic title required, CSV dry-run, order countdown); admin.spec.ts (49 lines) 13 pages x EN/AR, kill switches all Allowed/Blocked, creator payouts disabled while Blocked, DORA sample loads; design.spec.ts (23 lines) screenshots light/dark x AR/EN.

### Inferences
- A dashboard redesign would need to decide whether to create packages/ui-web (shared components + a single CSS derivation) or keep per-app CSS; today duplication is high and no lint prevents token drift on web beyond unit tests.

### Gaps
- Did not open docs/design-system/*.md contents (only listed), nor ux-principles.md rules.
- `tooling/copy-lint` scope (fake social proof lint) not checked for web coverage.

## 4. Auth, RBAC, sessions, CSP, dual approval, VR-AC-01

### Takeaway
Admin auth is passkey-only with rotated httpOnly session cookie, per-request CSP nonce, role-filtered nav, posture gating and dual-approval UI; but role/posture all depend on GET /v1/admin/me, which the API does not implement (VR-AC-01), so in practice nav shows everything and sensitive writes are disabled. Seller has passkey+TOTP login and no role awareness.

### Cited Findings
- Admin login: app/login/page.tsx:6-20 renders `PasskeyLogin` (components/passkey-login.tsx:10-64): beginPasskeyAction -> navigator.credentials.get (userVerification "required", 60 s) -> finishPasskeyAction -> `window.location.assign("/")`. Server actions in server/actions.ts:155-170; webauthn serialization in session/webauthn.ts. Only passkey; no TOTP fallback in admin UI.
- Admin session: cookie via session/refresh.ts (SESSION_COOKIE, encode/decode), httpOnly+secure+sameSite strict, 12 h (console.ts:49-51, proxy.ts:7); refresh rotation happens in proxy.ts:28-33 before render; failed refresh clears cookie. `getConsole()` (server/console.ts:75-103) redirects to /login if no cookie or API says unauthorized. installId is hard-coded `"00000000-0000-4000-8000-000000000000"` (console.ts:65, proxy.ts:30) - a shared constant, not per-device (noted as observation).
- Seller session: server-context.ts:9-79 cookie `sc_session` (base64url JSON of tokens, 8 h, httpOnly, secure, strict); proxy.ts:19-29 only checks cookie presence ("optimistic sign-in redirect") with `isPublicPath`/`isApplicantPath`; installId cookie `sc_install`. Login/enrolment: components/SellerAuthFlow.tsx (passkey register/assert + TOTP enrol/confirm/assert, recovery codes), view-models/auth-flow.ts.
- CSP + headers: admin security/csp.ts:30-53 (default-src none; script 'self' nonce 'strict-dynamic'; style nonce only; connect to API origin; frame-ancestors none; form-action self; upgrade-insecure-requests in prod) and SECURITY_HEADERS :56-65 (HSTS preload, nosniff, no-referrer, XFO DENY, COOP/CORP same-origin, Permissions-Policy, cache-control no-store). Nonce minted per request (proxy.ts:15), forwarded via `x-nonce`. Seller: csp.ts (79 lines), same pattern plus upload origins. Tests: admin security/csp.test.ts, seller test/csp.test.ts; e2e asserts nonce on every page.
- RBAC (admin): `navFor(roles)` filters 26 items by role (nav.ts:17-52); "Hiding is a convenience: every request is re-authorised by the API" (nav.ts:12-16). `roles === null` -> show everything (nav.ts:47,50). Layout shows notice "nav.rolesUnknown" (layout.tsx:41). Home gates brand tiles by navAllowsPath (page.tsx:9).
- Posture: view-models/posture.ts:14-21 fails closed: me null -> "unknown", sensitiveWritesEnabled false; device untrusted, IP allow-list required for finance/super_admin, assurance must be "passkey". Banner in layout.tsx:42; pages disable write controls via `writes = c.posture.sensitiveWritesEnabled` (flags/page.tsx:14, plus/page.tsx:17) and show WritesDisabledNote.
- Dual approval UI: /approvals page (approvals/page.tsx) + view-models/approvals.ts (approvalInbox with selfId, selfRoles to block self-approval, coversNow, blocked reasons) + approveAction/rejectAction (actions.ts:39-44); money/plan writes require an `approval_id` field (plus/page.tsx:68) with "request approval" form (:72-79). JIT elevation: /elevation page + request/activate/revoke actions (actions.ts:82-96). PII access: /pii + pii-viewer.tsx + viewPiiAction with reason code (actions.ts:129-150). ReasonDialog (native dialog) collects reason codes for flag/suspension changes.
- VR-AC-01: docs/compliance/verify-register.md:142 "Admin Console assumes GET /v1/admin/me (effective roles, standing roles, assurance, posture). The endpoint does not exist; until it does the console shows all links, treats posture as unknown and disables sensitive writes". Client: api/client.ts:100 `me: ... path "/v1/admin/me"`; schema marked "PROPOSED endpoint" (api/schemas.ts:42); docs/specs/admin-console-web.md:8,31,53; docs/plan/status-2026-10.md:16; docs/plan/phase-1-wave-4-integration.md:142. A grep of apps/api/src and packages for "admin/me" returned no matches, consistent with the gap (grep scope: those two dirs only). Practical effect in a real environment: me() fails (non-401) -> `identity=null` (console.ts:93) -> roles null, posture unknown -> banner + all write buttons disabled. The e2e gateway fakes /v1/admin/me, so e2e does not exercise this real-world state.
- Seller "me" gap: Shell.tsx:8 and page-context.ts:11 say no seller "me" endpoint; role-based nav (nav.ts) inactive; team page lists roles (owner/manager/fulfilment/catalog/finance).

### Inferences
- Until VR-AC-01 closes, an admin redesign cannot demo role-aware dashboards against the real API; design should handle `roles === null` and `posture unknown` as first-class states.
- Seller dashboards cannot be role-tailored (finance vs fulfilment views) until a seller identity endpoint exists.

### Gaps
- Did not verify admin session/refresh.ts internals or API-side authorization.
- Did not confirm whether `/v1/admin/me` exists on a branch outside the grep scope.

## 5. Tests and typecheck

### Takeaway
Both apps typecheck clean and unit tests pass; coverage is view-model/loader heavy, no component/DOM tests, browser coverage only via opt-in e2e that I did not run.

### Cited Findings
- `pnpm --filter @outlet/seller-web typecheck` (tsc --noEmit): no errors printed. `pnpm --filter @outlet/admin-web typecheck`: no errors printed. (Run today.)
- `pnpm --filter @outlet/seller-web test`: 12 files, 181 tests passed (e.g. onboarding.test.ts 48, view-models.test.ts 27, client.test.ts 12, tokens-css.test.ts 10, product-media.test.ts 10). Test files in apps/seller-web/src/test/ plus view-models/phase3.test.ts, lib/format.test.ts, i18n/i18n.test.ts.
- `pnpm --filter @outlet/admin-web test`: 12 files, 145 tests passed (phase2.test.ts 22, vm.test.ts 29, session.test.ts 8, client.test.ts 6, styles.test.ts 5, csp.test.ts 4, etc.).
- vitest runs in node (no jsdom/@testing-library in app package.json): no React component or DOM tests in either app. boundaries.test.ts exists in both (import-boundary checks).
- E2E (Playwright) specs listed in section 3; not run by me (needs apps + gateway running via tooling/e2e/run.sh). Status doc says "Maestro/Playwright harnesses exist" (docs/plan/status-2026-10.md:16); no recorded green run seen.
- Pages with no dedicated e2e: admin brand-applications, gift-cards, rewards, calendar, drops, price-matching, ads, resale-hub, moderation, pii, promotions, price-integrity, returns (admin.spec.ts:7 PAGES list has 13 of ~27 routes); seller 19 routes covered, /login, /apply, /onboarding partly (login test only).
- Prior turbo logs exist: apps/*/.turbo/turbo-typecheck.log.

### Gaps
- No coverage numbers collected for the two apps; Stryker/mutation not applicable to web per docs.

## 6. Dependencies, performance and bundle budgets

### Takeaway
No bundle or performance budget is configured for either web app.

### Cited Findings
- grep for budget|size-limit|bundle in apps/*-web/next.config.ts, .github/workflows/ci.yml and root package.json returned nothing. Spec asks for bundle-size budget fitness function (master prompt T11) and CI image-payload checks (T10) but not implemented for web (as far as grep shows).
- Dependencies are minimal (no UI kit, no state lib, no CSS framework, no icon lib, no data-fetching lib): all rendering is RSC + server actions + a few client components ("use client" in dora-loader, passkey-login, reason-dialog etc.). Styles: one injected CSS string (admin) / globals.css (seller). Fonts: TTF files (~12 files per app) via @font-face with font-display swap, no preload seen.
- CI lint step `pnpm lint` (ci.yml:37) exists; no Lighthouse/web-vitals job seen by grep (searched only for the terms above).

### Inferences
- Adding a charting dependency has no guardrail today; a budget would need to be introduced alongside it.

### Gaps
- Next build output (route sizes) not generated (no build run; time).
- next.config.ts contents not read.
