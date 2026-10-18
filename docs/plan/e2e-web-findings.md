# E2E web findings (Playwright, production build, Chromium)

Final results (production build, axe WCAG 2.0/2.1/2.2 A+AA, zero serious/critical asserted on every page, plus overflow, CSP, dir, focus, heuristics): seller-web 88/88 passed, admin-web 52/52 passed.

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-1 | Medium | seller-web mobile: `.shell` grid `1fr` made `<main>` grow to content width (531-601px at 390px viewport); page scrolled horizontally and the Save button on /catalog/new and /orders actions were off-screen. | Fixed (`minmax(0,1fr)`, `.main{min-width:0}` in globals.css) |
| F-2 | Medium | seller-web RTL mobile /orders: the visually hidden `<caption class="vh">` is `position:absolute` inside a scroller that was not positioned, escaping it and widening the page. | Fixed (`.tablewrap{position:relative}`) |
| F-3 | Medium | admin-web /engineering: inline `style` attribute on the DORA textarea violates `style-src` (CSP, no `unsafe-inline`). | Fixed (class `textarea.wide`) |
| F-4 | Medium | admin-web /engineering: zod JIT probes `new Function`, reported as a `script-src eval` CSP violation in production. | Fixed (`lib/zod-jitless.ts` imported first in `view-models/dora.ts`). Other client bundles that build zod schemas would show the same if added. |
| F-5 | Medium | admin-web /suspensions: `<span style={{inlineSize: N%}}>` progress meter is blocked by the production CSP (style-src-attr), so the bar never renders. Not reproduced in the run (fixture queue is empty). | Fixed: widths are 5% bucket classes `mw-N` (`view-models/meter.ts`, CSS generated into styles.ts, unit test `meter.test.ts`). Not browser-verified with data (fixture queue empty). |
| F-6 | Info | `next dev` emits dozens of CSP violations from Next devtools; not a product issue. Use `E2E_PROD=1`. | Documented |
| F-7 | Info | A concurrent edit in apps/admin-web (brand-review.ts, nav.ts use missing i18n keys `brand.*`, `nav.brandApplications`) currently fails `next build` type-check. Not mine. | Resolved by the other agent; admin build green |
| F-8 | Low | Passkey sign-in cannot be driven headless; no seller/admin auth in DEV_FIXTURES, so session cookies and the gateway fixtures are used. | Limitation |
| F-9 | Info | axe scans now run on every tested page: zero serious/critical violations on all pages and states exercised. Pages reached only via error states (no fixtures) were scanned in their error UI. | Done |
| F-10 | Medium | admin-web had the same `1fr` grid overflow as F-1 on mobile (/flags, /privacy). | Fixed (`minmax(0,1fr)`, `.table-wrap{position:relative}`) |

Not small / not covered: no violations were left open by axe. Authenticated data-rich states for pages without gateway fixtures (most admin and seller secondary pages) are untested beyond their error UI.
