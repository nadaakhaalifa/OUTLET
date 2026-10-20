# Charting stack and web architecture for rich dashboards (Next.js, React 19, Arabic-first RTL, strict CSP, a11y)

Research scope note: roughly 14 tool calls (stopped early on diminishing returns from the search tool). Many library-level facts (bundle sizes, stars, release dates, RTL behaviour, Postgres/ClickHouse docs, Playwright/Chromatic) were NOT verified against primary sources and are listed under Gaps or labelled INFERRED (from general knowledge, unverified). Treat INFERRED as hypotheses to test in a spike.

## Repo's current choices (read-only check)

### Takeaway
No charting library is installed today; web apps are Next ^16.4 / React 19.2.3 with a strict nonce CSP, so the choice is greenfield and must fit the existing CSP.

### Cited Findings
- DOCUMENTED (repo): `apps/seller-web/package.json` deps are only `@outlet/domain, i18n, ui-tokens, validation, next ^16.4.0, react 19.2.3, zod`. No chart library found in seller-web; grep of the admin-web and seller-web `src` found only SVG use in `identity-mark.tsx` and `QrCode.tsx` (hand-rolled). `packages/` has no `ui-web` (only `ui-native`, `ui-tokens`, `i18n`).
- DOCUMENTED (repo): `apps/admin-web/src/security/csp.ts` builds `default-src 'none'`, `script-src 'self' 'nonce-X' 'strict-dynamic'` (`'unsafe-eval'` only in development), `style-src 'self' 'nonce-X'` (no `unsafe-inline`), `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self' <apiOrigin>`, `frame-ancestors 'none'`. Consequences: any library injecting inline `style="..."` attributes or `<style>` without the nonce may violate `style-src` (see CSP section), and any library using `eval`/`new Function` fails in production.
- DOCUMENTED (repo): `packages/ui-tokens` exists and is a dependency of seller-web; chart theming should read tokens.

### Inferences
- Because there is no `ui-web` package, a small `packages/ui-charts` (or `ui-web`) wrapper layer would be the place to centralise token theming, RTL, a11y table fallback and CSP-safe defaults.

### Gaps
- admin-web / seller-web build-time details (style handling by Next, `style` attribute usage) not inspected beyond csp.ts.

## Library comparison (maintenance, bundle, SSR/RSC, RTL, a11y, licence, theming, coverage)

### Takeaway
Evidence gathered is thin: Recharts 3 ships keyboard/screen-reader support by default; ECharts has first-class ARIA descriptions and decal patterns; Highcharts needs a paid licence for company use. Everything else (bundle size, stars, RTL, maintenance dates) is unverified. Provisional recommendation (INFERRED): Apache ECharts (tree-shaken, SVG renderer) as primary for breadth (funnel, heatmap, Sankey, treemap, geo/choropleth, gauge, boxplot built in), with hand-written SVG for sparklines/bullet/KPI tiles; Recharts only if the team prefers a React-declarative API for simple line/bar/area. Must be validated by a CSP spike.

### Cited Findings
- Recharts 3.0.0: "accessibilityLayer is now on on all polar and cartesian charts by default. Tab into the chart and use the arrow keys to navigate" — [newreleases.io recharts 3.0.0](https://newreleases.io/project/npm/recharts/release/3.0.0)
- Recharts 3.1.0 removed `role=application` from the wrapper; 3.10.0 added accessibilityLayer/title/desc props to Sankey, so Recharts 3.x is actively released (3.10.0 exists) and has a Sankey — [3.1.0](https://newreleases.io/project/npm/recharts/release/3.1.0), [3.10.0](https://newreleases.io/project/npm/recharts/release/3.10.0)
- ECharts ARIA: opt-in via `echarts.use(AriaComponent)` and `aria.show: true`; generates an `aria-label` description from title/series/data; `aria.description` overrides for dense charts; decal patterns (since ECharts 5) add a non-colour cue (`aria.decal.show`) — [ECharts handbook: ARIA](https://echarts.apache.org/handbook/en/best-practices/aria/)
- Highcharts: dual licence; commercial licence required for company projects/internal operations; free CC BY-NC only for non-profit, personal sites, school projects; commercial price not published (third-party listing "from $176/month" is unverified) — [Highcharts education page](https://www.highcharts.com/education/), [G2 pricing](https://www.g2.com/products/highcharts/pricing)
- Mantine charts (built on Recharts) state `accessibilityLayer` defaults to true — [Mantine charts docs](https://mantine.dev/llms/charts-getting-started.md)

### Inferences (unverified, from general knowledge)
- INFERRED: ECharts is Apache-2.0, supports canvas and SVG renderers, has built-in funnel, heatmap, sankey, treemap, gauge, map (needs registered GeoJSON), candlestick, and a custom series for bullet/waterfall (waterfall via stacked bars with transparent base). Bundle can be reduced via modular `echarts/core` imports.
- INFERRED: Recharts (MIT, SVG, React components) covers line/bar/area/pie/radar/funnel/treemap/sankey/scatter but has no choropleth/heatmap/gauge primitives; waterfall and bullet are composed manually.
- INFERRED: visx (MIT, low-level D3+React primitives, SVG) gives full control over RTL, a11y and CSP but requires building each chart; Nivo (MIT, D3-based, includes heatmap, sankey, funnel, treemap, choropleth, bullet; uses SVG/canvas and react-spring); Tremor (Tailwind + Recharts; Tremor was acquired by Vercel in 2025 per general knowledge, not verified); Observable Plot (ISC, concise, SVG, not React-native); Chart.js (MIT, canvas, limited RTL via options, a11y weak because canvas); uPlot (MIT, very small canvas time-series, little a11y); Highcharts (commercial, best built-in a11y module, but licence cost).
- INFERRED: Canvas charts are opaque to assistive tech and need a table fallback; SVG gives per-mark ARIA/keyboard focus but costs DOM nodes above ~5-10k marks.

### Gaps
- Not found/not verified: bundle sizes (bundlephobia), GitHub stars/last release for visx, Nivo, Tremor, Observable Plot, Chart.js, uPlot, ECharts; RSC/SSR compatibility statements for each (all interactive libraries need `"use client"`; INFERRED); RTL behaviour of each library (searches returned nothing on Recharts RTL; ECharts `option` page fetch did not expose RTL info); Nivo/uPlot maintenance status 2025-26.

## Special charts and Egypt GeoJSON

### Takeaway
A CC BY 4.0 source for Egypt governorate (ADM1) boundaries exists (geoBoundaries); Stanford's Egypt governorate shapefile is restricted. HDX/OCHA Egypt boundaries licence was not confirmed.

### Cited Findings
- geoBoundaries ADM1 (incl. global CGAZ_ADM1 GeoJSON) recorded as CC BY 4.0 in a catalog record; citation Runfola et al. 2020, PLoS ONE 15(4): e0231866. Secondary source, licence page not checked directly — [CoyPu catalog](https://service.tib.eu/ldm_coypu/ldmservice/dataset/geoboundaries1)
- HDX Egypt ADM0-2 boundaries (OCHA ROMENA/HDX, CAPMAS, OSM contributors); licence not shown in results — [BTAA/Stanford listing and HDX mentioned in search](https://geo.btaa.org/catalog/stanford-tp306xd1863)
- Stanford "Egypt boundaries" governorate shapefiles are restricted to Stanford affiliates (do not use) — [Berkeley GeoData](https://geodata.lib.berkeley.edu/catalog/stanford-tp306xd1863)

### Inferences
- INFERRED: Governorate count and recent changes (new governorates created after 2008) mean the GeoJSON must be checked against the 27-governorate list used by the courier coverage table; simplify polygons (mapshaper) to cut payload and bundle as a static asset served from `'self'` (fits `connect-src 'self'`). Egypt's Natural Earth admin-1 and GADM licence (non-commercial restriction in GADM terms, INFERRED) not verified; prefer geoBoundaries with attribution.
- INFERRED: Funnel, treemap, Sankey, gauge, heatmap, choropleth are all native in ECharts; bullet and waterfall are best hand-built SVG (simple rects) for exact a11y and RTL control.

### Gaps
- Natural Earth and GADM licences not fetched; HDX licence not confirmed; no check of which library supports bullet/waterfall natively.

## CSP and security

### Takeaway
Under the repo's `style-src 'self' 'nonce-X'` and no `unsafe-eval`, libraries that inject inline style attributes or evaluate code are the risk; this must be proven with a spike in production CSP mode. No library-specific CSP documentation was found.

### Cited Findings
- A Grafana forum thread reports an ECharts execution error under a CSP with nonce + strict-dynamic and without `'unsafe-eval'`; no answer in the results (so ECharts under a strict CSP is a documented concern, not a resolved one) — [Grafana community](https://community.grafana.com/t/issues-with-improving-csp-in-grafana/143714)
- Nonces cover `<script>`/`<style>` elements, not style attributes; a common workaround is `style-src-attr 'unsafe-inline'` with nonced `style-src-elem` (not confirmed for any chart library) — [CodeProject CSP overview](https://legacy.codeproject.com/Articles/1909172/What-Web-Developers-Need-to-Know-About-Content-Sec), [Neptune CSP guide](https://docs.neptune-software.com/neptune-dxp-open-edition/24.15/cockpit-overview/developing-csp-safe-apps.html)
- Recommend testing in `Content-Security-Policy-Report-Only` first — same Neptune source.

### Inferences
- INFERRED: SVG charts set many `style=` attributes in React (React sets them via the CSSOM `element.style.x=`, which CSP does not block; only attributes in server HTML or `setAttribute('style')` are blocked) — verify in a spike. ECharts SVG renderer sets attributes (not style strings) for most marks; tooltips use inline style strings and `innerHTML`, a CSP/Trusted Types concern; use `renderMode: 'richText'` tooltips or a custom React tooltip (INFERRED).
- INFERRED: Trusted Types (`require-trusted-types-for 'script'`) will break libraries that assign `innerHTML` (ECharts HTML tooltips, Chart.js legends); a policy wrapper or custom tooltips needed. Not verified.
- INFERRED (spec T5): vendor all chart code through the bundler (no CDN scripts) so SRI is moot; keep script inventory entry per chart lib; pin versions with lockfile + `pnpm audit`/OSV; prefer fewer, mature dependencies.

### Gaps
- No primary-source statement of CSP/Trusted Types compatibility for ECharts, Recharts, visx, Nivo, Chart.js, uPlot, Highcharts; Chart.js canvas does not use inline styles on the canvas content itself (INFERRED).

## Accessibility

### Takeaway
Provide for every chart: text summary, a real data table alternative, keyboard operability, non-colour cues and reduced-motion handling. Chartability gives the audit framework.

### Cited Findings
- Chartability: heuristics set (POUR-CAF), 50 tests with 14 critical; the "no table" critical test passes when a thorough text description nearby or a data table is provided; keyboard input-modality is a critical test (mouse features must work with keyboard) — [Eurostat/EU data visualisation guide](https://data.europa.eu/apps/data-visualisation-guide/intermediate-accessibility-audit-with-chartability), paper: [Eurographics CGF](https://diglib.eg.org/handle/10.1111/cgf14522)
- ECharts aria description + decals (see above). Recharts 3 keyboard layer on by default (see above).

### Inferences
- INFERRED: Pattern: `<figure>` + `<figcaption>` with the generated sentence summary (trend, max, min, change vs previous period) in AR/EN, a "View as table" toggle rendering a semantic `<table>` (same data, same Intl formatting), and `prefers-reduced-motion` disabling animation (ECharts `animation:false`). 3:1 contrast on marks and decals/shape redundancy for WCAG 2.2 AA. Dashboard tiles: sparklines get `role="img"` with `aria-label` stating latest value and delta.
- INFERRED: the `dataviz` skill/palette tooling in this environment may be used for validated colour palettes.

### Gaps
- Official Chartability site not fetched; no testing of screen-reader behaviour per library.

## RTL and number formatting

### Takeaway
Not verified for any library; plan on a wrapper that handles RTL explicitly.

### Cited Findings
- None found. Search for Recharts RTL returned no results; "not found".

### Inferences
- INFERRED: Most chart libs do not auto-mirror. For RTL: reverse the x-axis for time series only if product decides (time-axis direction in Arabic UIs is a design decision; many apps keep time left-to-right while mirroring legends, y-axis side, and layout), position y-axis on the right, align legends/tooltips with `dir="rtl"`, render axis labels with `Intl.NumberFormat('ar-EG')` (Eastern Arabic digits) or `'ar-EG-u-nu-latn'` per user numeral preference (spec §25), money from bigint piastres formatted via a single helper, and dates with `Intl.DateTimeFormat('ar-EG', {timeZone:'Africa/Cairo'})`. Must be verified in a spike per library.

### Gaps
- No library RTL documentation retrieved.

## Server-side aggregation and time zones

### Takeaway
Only Egypt DST facts were verified. Recommend (INFERRED) incremental rollup tables keyed by Cairo-local day/hour for the first release, with ClickHouse deferred until configured.

### Cited Findings
- Egypt reinstated DST in 2023; summer time runs from the last Friday of April to the last Thursday of October; 2026 DST began Friday 24 April 2026. Law number conflicting (34/2023 per Egypt Today vs 24/2023 per Egypt Independent) — [Ahram Online](https://english.ahram.org.eg/NewsContentP/1/566547/Egypt/Egypt-to-move-clocks-forward-one-hour-on-Friday-fo.aspx), [Egypt Today](https://www.egypttoday.com/Article/1/149096/When-will-daylight-saving-time-end-in-2026), [Egypt Independent](https://www.egyptindependent.com/egypt-to-implement-daylight-saving-time-on-friday/)

### Inferences (unverified)
- INFERRED: Store timestamps as `timestamptz` UTC; compute day buckets with `date_trunc('day', ts AT TIME ZONE 'Africa/Cairo')` so DST days have 23 or 25 hours (Egypt changes at midnight, so a local day can be 23 h/25 h and 00:00 may be skipped on the spring transition); keep the tzdata package updated since rules changed in 2023. Materialised views refreshed by pg_cron are simple but `REFRESH MATERIALIZED VIEW CONCURRENTLY` recomputes in full and needs a unique index; incremental summary tables updated by the outbox consumer give <=15 min freshness cheaply and match the spec's outbox; ClickHouse (spec target, unconfigured) fits large event analytics later. Partition by month; add `statement_timeout`, row limits, and keyset (cursor) pagination for tables; ETag from rollup `updated_at`; Redis cache keyed by (store_id, range, tz, version); previous-period query = same grain over shifted range computed in one query with a window or two CTEs, aligned by local day; approximate counts via HyperLogLog (`hll` extension) or `reltuples` only for non-financial counts; k-anonymity (spec: k>=50) enforced in the query layer by `HAVING count(DISTINCT user) >= 50` plus complementary-suppression to stop differencing, in a single repository function used by all seller endpoints.

### Gaps
- No Postgres/ClickHouse documentation fetched; no sources on pg_cron, matview concurrency, or approximate-count methods.

## Real-time (SSE vs WebSocket vs polling)

### Takeaway
For one-way live order/ops feeds, SSE or short polling fits Next route handlers; buffering by proxies/rewrites is the main pitfall.

### Cited Findings
- Practical SSE-in-Next checklist from community sources: return the `Response`/stream before async work, set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` behind nginx-type proxies, `export const dynamic = "force-dynamic"`, send keepalive comments, avoid `rewrites()` for SSE (one user report that Next 16 rewrites buffered event streams; unverified) — [Medium: Fixing slow SSE in Next.js](https://medium.com/@oyetoketoby80/fixing-slow-sse-server-sent-events-streaming-in-next-js-and-vercel-99f42fbdb996), [Upstash SSE guide](https://upstash.com/blog/sse-streaming-llm-responses), [cubic.dev PR report](https://cubic.dev/pr/lfnovo/open-notebook/pull/770), [Vercel community](https://community.vercel.com/t/can-sse-be-implemented-with-only-next-js-api-routes/11063)

### Inferences
- INFERRED: SSE is simpler than WebSocket for server-to-client only, works with cookie auth (EventSource cannot set headers; use cookies or a short-lived ticket), reconnects with `Last-Event-ID`; HTTP/1.1 has 6 connections/origin limit per browser (HTTP/2 lifts it). Backpressure: coalesce events into 1-5 s batches, bounded per-connection queues, drop to polling on overflow. For freshness SLO of 15 min on analytics, poll with ETag; reserve SSE for the ops live view (order queue, drops). Needs `connect-src 'self'` only if same origin (matches CSP).

### Gaps
- No primary Next.js docs fetched; no load-test data; WebSocket in Next not evaluated.

## Export (CSV/XLSX/PDF, watermark, audit, CSV injection)

### Takeaway
OWASP lists CSV injection triggers and notes it is hard to fully mitigate; escape on export and audit every export.

### Cited Findings
- OWASP: cells starting with `=`, `+`, `-`, `@`, or Tab (0x09) can execute as formulas; OWASP calls the issue hard to fully mitigate — [OWASP CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection). Common mitigation: prefix risky cells with a single quote (and quote the field); older sources list fewer trigger characters; `defusedcsv` exists for Python — same search, [CWE-1236](https://shoulder.dev/threats/cwe/CWE-1236)

### Inferences
- INFERRED: Apply the escape to every user-controlled string cell (store names, product titles, buyer names), also CR (0x0D), but not to typed numeric cells (keep numbers as numbers, so negative amounts are not mangled); XLSX: write strings as typed string cells (not formulas) which removes most risk; watermark = footer/header with requester id, timestamp, export id (PDF overlay, and a trailing metadata row in CSV); audit row in append-only `audit_log` (spec A2.9) with filters, row count, hash of file; scheduled emails link to an authenticated download rather than attaching data.

### Gaps
- No library-specific sources (exceljs, pdf-lib, Playwright PDF); no source on email report security.

## Performance budgets and testing

### Takeaway
No sources gathered; recommendations are INFERRED.

### Cited Findings
- None (web.dev, TanStack, Playwright, Chromatic pages not fetched) — "not found".

### Inferences
- INFERRED: Budgets: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1 (Core Web Vitals thresholds, general knowledge); lazy-load below-fold charts with `next/dynamic` (client) and render server-side skeleton + summary text; chart JS chunk budget (e.g. <= 150 KB gz, to be set after measuring); tables virtualised with TanStack Table + TanStack Virtual beyond ~200 rows; Playwright `toHaveScreenshot` across AR/EN x light/dark x RTL with animations disabled (a self-hosted alternative to Chromatic, avoiding another SaaS processor); contract tests: Zod schema for each analytics endpoint response plus Pact (spec A2.10); property tests with fast-check (already in seller-web devDeps): sum of parts == total in piastres (bigint, no floats), rollup(day) sum == rollup(hour) sum, DST-day boundaries (23/25 h), previous-period alignment, k-anonymity suppression never reveals groups < k via differencing.

### Gaps
- All of this section lacks cited sources.
