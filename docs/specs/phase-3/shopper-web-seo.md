# Spec P3-06: Shopper web with SEO

Refs: §0 platform list item 5, §3, §4, §5, §9.6, §B1, §B5, §B8, §25, §T2, VR-P3-12. Depends on: catalog and search public read paths, price-integrity (badges and evidence summary), stores, drops, auth (web session), i18n, design tokens (`ui-web`), CSP and SRI baseline from admin-web and seller-web. New app `apps/shopper-web` (Next.js).
Status: buildable now; checkout on web is explicitly a later increment (PSP hosted page and SAQ A controls are required before it).

## Flow
Public pages, server-rendered, Arabic default with `/ar` and `/en`: home, store directory and store page, category and search results (indexable facets only), product page (PDP), public drop pages (including countdown from server time), shared wishlists (noindex), help and legal pages, creator and look pages (after P3-04). Login (phone OTP, Apple, Google, passkey) enables bag, wishlist, orders. Web is read-first, then bag and wishlist, then checkout (increment 3), then app-install smart banner and universal-link handoff.

## Rules
- SEO: canonical URLs, `hreflang` ar-EG / en, JSON-LD `Product` with `Offer` price and `availability`, `BreadcrumbList`, `Organization`; sitemaps split by type, regenerated from outbox events; `robots.txt` blocks cart, account and API; faceted URLs: only allow-listed single-facet combinations indexable, rest `noindex,follow`; pagination with canonical to self.
- **Honesty rules apply to markup**: structured data may never expose a strike-through, `priceValidUntil` or aggregate rating unless it comes from the verified output of §9 and real reviews; no fake stock or urgency. A contract test compares JSON-LD to the API source.
- Public display of seller legal identity on PDP (§B5). Whether it appears on indexable pages is VR-P3-12; default shows legal name and governorate, register numbers behind a "seller details" disclosure that is still server-rendered but `data-nosnippet`.
- Rendering: ISR with on-demand revalidation by outbox events (price, stock, status); price and stock shown are re-checked client-side from the API before add-to-bag (staleness SLO 60 s per §4; 5 s on PDP price per §5).
- Performance budgets: LCP < 2.5 s on 4G mid device, CLS < 0.1, JS per page budget set in CI, AVIF/WebP via image CDN; Core Web Vitals field monitoring.
- Privacy: no analytics or ads script before consent (§B1); cookie banner is granular, nothing pre-ticked, withdrawal in footer; strictly necessary cookies only otherwise. CSP with nonces, SRI, script inventory (§B8 techniques), no third-party scripts on payment pages.
- Arabic-first RTL, WCAG 2.2 AA, automated a11y in CI, copy-lint for hard-coded social proof.
- Legal pages Arabic authoritative.

## Edge cases
Out-of-stock PDP stays 200 with "notify me" (not 404) while product lives; delisted product -> 410 or 301 to category; suspended store -> noindex and redirect; duplicate listings (Buy Box): single canonical product group URL; query parameter spam (strip and canonicalise); AR/EN missing translation -> fall back to Arabic, never machine-translated silently; bots and scrapers (rate limit, WAF, do not expose emails or phones); preview and draft pages never indexable; internationalised slugs (Arabic slugs percent-encoded, stable id suffix); search engine caches stale prices (short `Cache-Control`, `lastmod` accurate); user-generated review content escaped.

## Data
No new core entities. `seo_overrides(entity_type, entity_id, title, description, noindex)` admin-editable with audit; `sitemap_state`. Web sessions use the existing session model with cookie flags `Secure; HttpOnly; SameSite=Lax`, CSRF protection on mutations.

## API
Uses existing `/v1` read endpoints via a BFF; new: `GET /v1/public/products/{slug}`, `GET /v1/public/stores/{slug}`, `GET /v1/public/sitemap/{type}/{page}` (cacheable, ETag). Rate limits per IP.

## Events
Analytics (consent-gated): `web_page_viewed`, `web_install_banner_shown`, `web_add_to_bag`; no PII. Outbox consumers: `sitemap.invalidate`, `isr.revalidate`.

## Failure handling
API down -> serve stale ISR page with banner "prices may be out of date" and disable add-to-bag; Typesense down -> Postgres FTS fallback (existing kill switch); revalidation failures retried with backoff; sitemap generation idempotent.

## Security and abuse
Next.js CSP nonce, SRI, HSTS, no secrets in client bundles; open redirect protection on login return URLs; clickjacking `frame-ancestors none`; scraping controls; SSRF none; DAST (ZAP) on staging; dependency audit. OWASP ASVS L2 web matrix extended.

## Metrics
Indexed pages, organic sessions, organic-to-app-install rate, LCP p75, price mismatch incidents (target 0), crawl error rate.

## Acceptance
```
Given a product with no verified evidence, then HTML and JSON-LD contain no strike-through or reference price.
Given a price change event, then the PDP revalidates within 60 s.
Given Arabic locale, then dir=rtl and hreflang alternates are present and self-consistent.
Given no consent, then no analytics script is requested (Playwright network assertion).
Given a delisted product, then 410 and removal from the sitemap on next regeneration.
```

## Implementation notes (increment 1, read-only)
- Built in `apps/shopper-web` (port 3003): home, drops list/detail, store, product, search; `/ar` and `/en` prefixes; sitemap.xml, robots.txt, OG default image, JSON-LD Product/Offer, Organization, BreadcrumbList.
- CSP decision: per-request nonce with `strict-dynamic` plus build-time SRI. Verified in e2e that a static, nonce-less `script-src 'self'` policy blocks Next's inline bootstrap scripts, so full-page ISR and a strict CSP are mutually exclusive. API reads use the Next data cache (revalidate 60 s, tag `public-catalog`). Edge/CDN HTML caching needs a hash-based or edge-injected-nonce design (open item).
- Gaps: `/v1/products/{id}`, `/v1/stores`, `/v1/stores/{id}` and `/v1/search` still require `shopperBearer` in the API; they need `@Public()` (or the `/v1/public/*` routes above) before real anonymous traffic works. Delisted products return 404, not 410. No consent banner is needed yet because no analytics or third-party script exists.
