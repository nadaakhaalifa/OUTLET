# Chart spike results (Phase A, report section 6.2)

Run 2026-10-16 against a PRODUCTION build of `apps/admin-web` (`next build` then `next start`, `ADMIN_CHART_SPIKE=1`), Next 16.4.0, headless Chromium via Playwright. CSP as served by `src/proxy.ts`: `script-src 'self' 'nonce-X' 'strict-dynamic'`, `style-src 'self' 'nonce-X'`, no `unsafe-eval`, no `unsafe-inline` (the spec asserts this on every response). Data is synthetic and labelled "Demo data" on every figure.

Page: `/spike/charts` (also `?only=echarts|svg|recharts|recharts-csr|none`, `&perf=1`). Gate: `src/app/spike/gate.ts` (fail closed: served only when `NODE_ENV` is `development` or `test`, or `ADMIN_CHART_SPIKE` is exactly `1`; anything else, including an unset or unexpected `NODE_ENV`, is 404; unit-tested). Not linked from nav. Spec: `tooling/e2e/tests/chart-spike.spec.ts`; raw output `/tmp/chart-spike-findings.json`; Arabic screenshots in `docs/research/chart-spike-screenshots/`.
Versions pinned: echarts 6.1.0, recharts 3.10.1. Both are `devDependencies` of `apps/admin-web` (supply-chain: they are not installed by a production-only install; `next build` bundles them from devDependencies, so the spike builds in the documented workflow, which installs dev dependencies. A CI image that builds with `--prod` installs would fail to resolve them: remove the spike or the imports first).

## Findings

| # | Check | ECharts 6.1 (SVG, tree-shaken) | Hand-written SVG (ui-web) | Recharts 3.10 |
|---|---|---|---|---|
| 1 | Renders under enforcing CSP (line, funnel, heatmap / sparkline, bullet, waterfall / line, bar) | PASS (line, funnel, heatmap render; funnel config was wrong on first run (default max 100), fixed, NOT re-viewed) | PASS | PASS (renders) |
| 2 | Zero CSP violations at load | PASS (0; 136 `style` attributes exist but are set through the CSSOM, which CSP allows) | PASS (0, no style attributes) | **FAIL** with SSR: 3 `style-src-attr` (server-rendered `style=` on the wrapper, `svg`, ResponsiveContainer). PASS (0) when rendered client-only (`ssr:false`, variant `recharts-csr`) |
| 3 | Script eval | PASS (no `script-src eval`) | PASS | PASS |
| 4 | Tooltip, default HTML tooltip | **FAIL**: 28 `style-src-attr` violations on first hover (tooltip is an HTML div styled by attribute); tooltip text was in the DOM | n/a (no tooltip built) | NOT RUN (no tooltip configured) |
| 5 | Tooltip, `renderMode: "richText"` | PASS: 0 violations, tooltip rendered as SVG `<text>` | n/a | NOT RUN |
| 6 | Tooltip off | PASS (0 violations) | n/a | n/a |
| 7 | Bundle added (gzip, from loaded scripts vs `?only=none` baseline of 140,515 B gzip / 469,760 B raw; `next build` in Next 16 prints no sizes, so measured from served chunks) | +197 KB gzip (+586 KB raw) | +2.3 KB gzip (+4.7 KB raw) | +105 KB gzip (+363 KB raw) |
| 8 | axe WCAG 2.2 AA (all impacts) on the page | PASS (0 violations) | PASS (0) | PASS (0) |
| 9 | Keyboard: every toggle reachable and operable, table rows appear | PASS 5/5 | PASS 3/3 | PASS 2/2 |
| 10 | Keyboard inside the chart | none: 0 focusable elements in the chart (no data-point access beyond the table) | none (by design, table is the alternative) | 26 focusable elements via `accessibilityLayer` (svg `role=application` tabindex 0): data points reachable by keyboard. Screen-reader output NOT RUN |
| 11 | Screen reader reading | NOT RUN (no screen reader available). ECharts `aria` (with decal patterns) was enabled; its generated description was not read | NOT RUN (role=img + label + figcaption summary) | NOT RUN |
| 12 | RTL (`dir=rtl`, `admin-locale=ar`, screenshot reviewed for ECharts and hand-written; Recharts measured by coordinates only) | Not mirrored: value axis stays on the left, categories run left to right, legend/visualMap anchored with physical `left`. Heatmap row labels were clipped at my 48 px margin. Digits Western (library default, formatter would be ours) | Layout follows `dir` (card, caption, button mirror); the plot itself runs left to right unless `mirror` is passed (supported by Sparkline and Waterfall geometry, tested). Whether time runs right to left is still an owner/UX decision | Not mirrored (axis left, categories left to right) by coordinates |
| 13 | `<bdi>` Latin store names, Arabic-Indic digits | NOT RUN (no chart takes store names yet; digit choice belongs to the formatter) | NOT RUN | NOT RUN |
| 14 | 5k marks (scatter, SVG), mount time to two animation frames | 112 ms, 5,043 SVG nodes | NOT RUN (no scatter built) | 284 ms, 15,080 SVG nodes (approximate method) |
| 15 | Sankey | NOT RUN (not in spike) | NOT RUN | NOT RUN |
| 16 | Dialog (ui-web): focus trap, Escape, focus returns to opener | PASS (Playwright) | | |

Side finding: the first run showed a `script-src eval` violation on the spike page. Cause: zod's JIT probe (`Function("")`) reaching the browser bundle through `@outlet/ui-web`. Fixed by moving the zod-using CSS generator to the `@outlet/ui-web/css` subpath (server only); a unit test keeps the main entry zod-free. `/login` never had it.

## Recommendation

Use hand-written SVG for sparklines, bullet charts, waterfalls (and simple line/bar/funnel/heatmap when needed): zero CSP issues, +2 KB, full control of RTL and tokens. Keep ECharts as the option for breadth, but ONLY with `tooltip.renderMode: "richText"` (or a custom React tooltip) and with colours passed as resolved token values; the default HTML tooltip fails the production CSP. Do not adopt Recharts: it fails the CSP when server-rendered (needs `ssr:false`, losing server HTML and the text fallback) and costs +105 KB, with no feature we need that the other two lack. Caveats: ECharts is +197 KB gzip, so it must be lazy-loaded per page (the spike does this with `next/dynamic`); chart colours cannot follow the dark-mode CSS variables without re-rendering on scheme change (not tested); RTL mirroring of axes is manual in every option.

Not decided by this spike: Sankey, screen-reader output, Arabic digits, `<bdi>` handling, the funnel/heatmap fixes visually re-checked.

## Design lint scope

`packages/ui-web/src` and `apps/admin-web/src/app/spike` are linted with the design rules (DS-COLOR, DS-RADIUS, parseFloat) and `rtl/no-physical-direction`, via `tooling/design/rules.mjs`, `eslint.config.mjs` and `check-debt.mjs`. New violations in those paths: 0 (ECharts physical option names carry the sanctioned `physical-direction:` comment). The existing web app code is NOT linted yet: enabling it on `apps/admin-web` and `apps/seller-web` would need a baseline pass (not measured).

## Re-run after the code-review fixes (2026-10-16)

Production build (`next build`, `ADMIN_CHART_SPIKE=1`) served with `next start -p 3002`; `playwright test chart-spike` with `SPIKE_STRICT=1`: 9 desktop tests passed (mobile project skipped by design). Changes since the first run: ChartFrame toggle now has a fixed name with `aria-pressed` (the spec asserts both), the spec registers its listeners once per page and detects tooltips only if they appear after hover (the no-tooltip chart must show none), the gate fails closed, the heatmap summary is computed.

| Row | Re-run? | Result |
|---|---|---|
| 2 CSP at load | RE-RUN | none 0, echarts 0, svg 0, recharts 3 (unchanged, SSR), recharts-csr 0 |
| 4, 5, 6 tooltips | RE-RUN (tighter detection) | default HTML tooltip: 28 `style-src-attr` on hover, tooltip found (`Orders180`); richText: 0 violations, SVG `<text>` found; off: 0, nothing found |
| 7 bundle | RE-RUN | none 141,038 B gzip; echarts 338,311 (+197 KB); svg 143,537 (+2.5 KB); recharts 246,088 (+105 KB). Raw: none 471,016 / svg 476,067 |
| 8 axe | RE-RUN | 0 violations for none, echarts, svg, recharts, recharts-csr |
| 9 keyboard toggles | RE-RUN | 5/5, 3/3, 2/2; `aria-pressed` flips false to true to false and the name stays fixed |
| 14 5k marks | RE-RUN | echarts 104 ms / 5,043 nodes; recharts 287 ms / 15,080 nodes |
| 16 dialog | RE-RUN | focus trap, Escape, focus returns: PASS (the Dialog now closes natively; see ui-web tests for the once-only `onClose`) |
| 12 RTL | Screenshots re-taken, NOT re-reviewed visually | coordinates unchanged in kind |
| 1 visual render, 10, 11, 13, 15 | NOT RE-RUN | as in the first run |

Heatmap A3 summary (computed, not hard-coded): "The busiest daypart is 12-16 on 4 of 7 weekdays (peak per weekday: Sat 20-24, Sun 12-16, Mon 16-20, Tue 12-16, Wed 12-16, Thu 20-24, Fri 12-16)." The earlier sentence ("evening dayparts have the most orders on every weekday") was false for this data.

Tooling note: `tooling/e2e/run.sh admin` with `E2E_PROD=1` failed at `next build` in this session (`/_global-error` prerender, "Cannot read properties of null (reading 'useContext')") on every attempt, while the identical `next build` run by hand succeeded. Cause not found; the numbers above come from the manual build and `next start`.
