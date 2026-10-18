# Threat model: anonymous catalog reads (`/v1/public/*`)

Spec: `docs/specs/phase-3/shopper-web-seo.md` (P3-06). Surface added in increment 2 of the shopper web. Status: implemented, behind `kill.public_catalog` (default blocked).

## Surface

| Route | Data | Source of truth |
|---|---|---|
| `GET /v1/public/stores`, `/stores/{storeId}` | store card and B5 supplier identity | stores module |
| `GET /v1/public/products/{productId}` | PDP, `units_left` 1..5 only | catalog (+ inventory, price integrity read through their ports) |
| `GET /v1/public/categories` | active taxonomy: id, slug, name, parent_id, position, return_class | catalog taxonomy (same read as `GET /v1/seller/categories`) |
| `GET /v1/public/search` | listing cards | search module (live facts re-read from catalog) |
| `GET /v1/public/sitemap/{stores,products}/{page}` | ids, slugs, product `lastmod` | stores, catalog |

Caller: the Next.js server (server-to-server, no cookies, no CORS). Browsers never call these routes directly; CORS stays closed and no `Set-Cookie` is ever emitted. The authenticated routes (`/v1/stores`, `/v1/products/{id}`, `/v1/search`) are unchanged and still require `shopperBearer`.

## Assets and what must never leave

Per-user state (`is_favorite`, My Stores scope, fit and size recommendation, budget fit, installment quote, address-dependent ETA and COD), seller account data (seller id, KYC state, health score, status other than "active", IBAN, signatory, contact data), exact stock above 5, SKU barcodes, unpublished or non-public stores and products, internal ids not needed to link pages.

## Controls

| Threat | Control | Where it is tested |
|---|---|---|
| Information disclosure through over-broad serialization (API3) | Every wire object is built key by key from an explicit allow-list; domain records are never spread; separate `Public*` OpenAPI schemas | allow-list snapshot tests in `stores.public.http.test.ts`, `catalog.public.http.test.ts`, `search.public.http.test.ts` |
| Per-user leakage through shared caches | Routes read no principal, cookie or header besides `If-None-Match`; viewer is a fixed non-user id; bodies hold no per-user value so `Cache-Control: public` is safe; no `Vary` on credentials is needed | "ignores credentials" tests (bearer and cookie change nothing, no `Set-Cookie`) |
| Enumeration of suspended, vacation, draft or unapproved stores and their products (API1/API5) | Visibility is `status = ACTIVE` and KYC approved and legal identity published, enforced in application code (the catalog reader runs under a system DB session, so RLS does not help here). Every non-public state returns the same 404 body | tests compare bodies for stores 6..10 and a store flipped to invisible or paused |
| Resource exhaustion through unbounded queries (API4) | strict zod query schemas (unknown keys 400), page size 1..50, cursor length caps, `filters` JSON at most 2000 chars and 30 facets, `q` at most 200 chars, sitemap page 1..1000 with 500 items | search and stores suites |
| Business-flow abuse by scrapers (API6) | per-IP limits (products 600/min, stores, categories and search 300/min, sitemaps 60/min) sized for one Next server IP; real bot control stays at the edge (WAF). CDN `s-maxage` absorbs repeat reads | rate-limit test (429 with `Retry-After`) |
| Dishonest price display | Price blocks pass through the domain sanitizer (`sanitizePriceBlock`); search re-asserts "no % off without verified reference"; `claim_id` is only an opaque existence marker | catalog and search suites |
| Personal facets used as an oracle for a user | personal, account and address dependent facets and `my_stores` are refused (400); search runs as the nil user, so favourites, size and budget are empty by construction | search suite |
| Sponsored placement served from a shared cache | sponsored items are filtered out of the anonymous result and `sponsored` is constantly false | search suite |
| Outage amplification and incident response | kill switch `kill.public_catalog` answers 503 `public_catalog_disabled` before any read; fails closed if the gate errors; production default is blocked until an operator allows it | kill-switch tests in catalog and search suites |
| Stale or unsafe indexing of removed products | delisted product of a public store is 410 (spec), draft and paused are 404; sitemap lists only what answers 200 | catalog suite |

Note on `GET /v1/public/categories`: one route serves both anonymous and signed-in clients (a token is ignored, never required, never changes the body). The projection drops `product_type`, `requires_size_chart` and `active`; inactive nodes and subtrees under an inactive parent are omitted so ids of retired categories are not disclosed. The taxonomy is platform-owned and holds no seller data, so the 300 s shared-cache window is safe.

## Residual risks and decisions to confirm

1. **Seller register and tax-card numbers are public on the store and product responses** (B5 requires supplier identity; VR-P3-12 decides only whether the web renders them on indexable pages). Counsel may prefer legal name and governorate only on the anonymous API; this is a one-line change in `public-wire.ts` of stores and catalog.
2. **`claim_id` is exposed on the product page** because the shopper web fails closed without it. It is a random id that grants nothing (claim routes are seller-scoped, 404 for others). Drop it if the web gate is changed to rely on the server sanitizer alone.
3. **Vacation (PAUSED) stores are 404 on the public surface** although signed-in shoppers still see them. This avoids indexing a store that cannot sell, at the cost of temporary de-indexing.
4. **Per-IP limits key on the peer IP**; behind the Next server this is one address. Limits were sized for that and are not a substitute for edge bot management.
5. **Store listing and sitemap read the full store set** (`StoreRepository.all()`), the same as the authenticated directory. Revisit with a keyset query when the store count grows.
6. **Production search facts are still Unconfigured** (`internal.wiring`), so `/v1/public/search` answers 503 in production composition until that port is wired. Store and product reads are real.
