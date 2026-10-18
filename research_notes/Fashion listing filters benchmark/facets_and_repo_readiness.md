# Facet taxonomy and repo data readiness (Z-OUTLET, off-price fashion, Egypt)

Scope note: repo and spec only, read-only. No web search was run, so Egypt value lists (sizes, colour names, materials, price bands) are proposals, not cited facts. Line numbers are from the working tree on 2026-10-16.

## 1. What do spec section 4/5/9/10/11/12 require, and what do the repo's search layers expose today?

### Takeaway
The API `SearchFilter` already carries 21 wire facets (price, colour, material, condition, department, discount, 30-day-low, new arrivals, rating, free delivery, payment-aware, my-size). The mobile app sends only 10 of them, and no response returns facet counts. The biggest gaps are size, brand, sort, in-stock and any seller-entered attributes (colour, material, size) actually reaching the index.

### Cited findings (repo)
- Spec section 4 lists the full facet set (budget, payment-aware, my size only, local/global, stores, category tree, verified discount %, price, colour, material, pattern, fit, occasion, vibe, modest, season, condition x4, delivery speed, free delivery, Fulfilled-by-HAUL, rating, verified only, lowest price 30 days, ending soon, new arrivals); max 30 facets, page 50 (`docs/haul-master-prompt-v3.md`, section 4 "Filters" and "Security").
- Spec section 12: budget data is private, never used by promotions/ads/ranking; section 20.5 says budget fit is "computed on-device or as a request-time filter only".
- API wire schema `SearchFilterSchema` (`apps/api/src/modules/search/domain/schema.ts:23-47`): budget_max, fits_remaining_budget, installments_available, monthly_max, payable_with_store_credit, cod_available, my_size_only, world, store_ids, category_ids, min_verified_discount_pct (int 5-100, line 35), price_min, price_max, colors (StringArray, line 38), materials (39), conditions (40), departments (41), free_delivery_eligible, verified_discount_only, lowest_30d_only, new_arrivals, min_rating (1-5, line 46). `.strict()` (48), facet cap `MAX_FACETS` (78).
- Facets absent from the wire schema: sizes, brand_ids, pattern, fit, occasion, vibe, modest, season, delivery speed, Fulfilled-by-HAUL, in_stock_only, ending soon, sort. `docs/plan/api-client-gap.md:184,187` states `SearchFilter` has no `new_since`, `in_stock_only`, `brand_ids`, `sizes` or `sort`.
- Index row `IndexedProduct` (`apps/api/src/modules/search/domain/ports.ts:10-33`) holds colors, materials, condition, department, categoryIds, verifiedDiscountPct, lowest30d, freeDeliveryEligible, rating, inStock, listedAtMs. It has no size, brand, pattern, fit, occasion or modest field. SQL table `search_documents` has matching columns (`packages/db/migrations/0023_search.sql:61-88`, colors/materials at 71-72, rating at 78).
- Response `SearchResults` (`docs/api/openapi.yaml:34376-34405`): items, page, total_estimate, applied_filters, relaxed_filter, did_you_mean, degraded. No `facet_counts`. api-client-gap.md:161 confirms "no per-store facet counts". `GET /v1/search` has only `q`, `filters`, cursor, limit (openapi.yaml:2263-2285); no sort param.
- Public (logged-out) search accepts only bounded public facets and answers 400 for budget, size, account or address facets (`openapi.yaml:30310`). This matches the privacy rule.
- Typesense adapter is a stub with no network client (`apps/api/src/modules/search/adapters/typesense.ts:17`; `docs/specs/search.md:9-13`). Production facet counts therefore also need Typesense or Postgres `GROUP BY`.
- Postgres fallback applies `min_rating` (`adapters/postgres-fts.ts:63`) and `my_size_only` via a live fact `facts.inMySize` (`application/search.ts:193`). The relaxation order already ranks facets by importance (`docs/specs/search.md:48-51`).
- Catalog data model: `Sku` has `sizeLabel` (free text, 1-20 chars) and optional `color` (free text) (`packages/domain/src/catalog/product.ts:75-85`). `Product` has `categoryId`, optional `brandId`, `condition`, `department`, optional single-string `material`, `sizeChartId` (87-107). Free-text colour/size/material means no normalised value set yet. CSV import has `material,size_label,color` columns (`docs/specs/catalog.md:72`).
- I found no place in `apps/api/src` (outside tests and the stylist bag fixture, `stylist/application/bag.ts:75` `colors: []`) that populates `colors`/`materials` on `IndexedProduct` from catalog data. Treat colour and material facets as unproven end to end until an index feeder is confirmed.
- Search lexicon canonical ids already exist: colours white, black, red, blue, navy, green, yellow, pink, beige, brown, grey, purple, orange; materials linen, cotton, wool, leather, silk, denim, satin (`packages/domain/src/search/lexicon.ts`, `c("white","color",...)` list from line 38). These have AR/EN/Franco forms and are the natural canonical keys for facet values.
- Mobile `SearchFilter` (`apps/mobile/src/features/search/model.ts:10-33`) has budgetMax, mySizeOnly, conditions (4 values, line 7), verifiedDiscountOnly, installmentsAvailable, payableWithCredit, storeIds, world, categoryIds, priceMin/Max, department, dev-only newIn/inStock. It has no colour, material, size, brand, rating, free-delivery, 30-day-low or min-discount field.
- Mobile wire mapper `filterToWire` (`apps/mobile/src/features/search/api.ts:11-26`) sends: budget_max, my_size_only, conditions, verified_discount_only, installments_available, payable_with_store_credit, store_ids, world, category_ids, price_min/max, departments. It drops newIn/inStock.
- Shop-all model: `ShopFilters` = q, categoryIds, budget(min/max), department (`apps/mobile/src/features/shop-all/model.ts:397-405`); `ShopSort` = relevance, priceLow, priceHigh, discount (117-118), applied client-side on loaded pages only (`sortItems`, line 120; api-client-gap.md:161). `toSearchFilter` (448-458) maps stores, onSale to verifiedDiscountOnly, categories, department, price. `filterBadgeCount` (519) counts categories, budget, stores, department, onSale.
- Filter sheet `FiltersSheet.tsx:27-50` order today: Quick filters (On sale checkbox), Sort, Category, Budget, Stores. Only these sections exist.
- Screen pills `ShopAllScreen.tsx:338`: Category, Brand, Size, Price all just open the same sheet (`pill()` lines 329-335, `setFiltersSheet(true)`), so Brand and Size pills have no matching section. Quick chips (341-348): On sale (real), New Arrivals and In Stock only under `__DEV__` and do nothing in production.
- i18n: `shopFilter.*` exists in EN (`packages/i18n/src/en.ts:354-396`) and AR (`ar.ts:357-`) but covers category, budget, clear-all and empty states only. `shopAll.pillBrand/pillSize/pillPrice` exist in both (en.ts:291-293, ar.ts:294). There are no keys for colour, material, size, condition values, rating, fit, occasion or delivery filters in the `shopFilter` group (not verified for other groups, e.g. a condition label may exist in PDP strings).
- Budget privacy copy already shipped: `shopFilter.privacy` "Your budget only filters this list. It is not saved or shared." (en.ts ~line 386).

### Inferences
- The cheapest path is: wire up existing API facets in the mobile model (colors, materials, minVerifiedDiscountPct, lowest30dOnly, freeDeliveryEligible, minRating, conditions UI, newArrivals), since the server already validates them.
- Facet counts (spec section 4 "live count") need a new response field. Today the client can only show `total_estimate` for the whole filter, so per-value counts must be hidden.

### Gaps
- Whether a production index feeder fills colours and materials was not confirmed (no writer found by grep). A builder should check the outbox projection into `search_documents`.
- Sort server-side does not exist (client sorts loaded pages only).

## 2. Per-facet readiness matrix

Legend: S = in index/schema, A = in API wire schema, M = in mobile SearchFilter, I = i18n AR/EN present, Seller = needs seller data entry, ML = needs section 11 attribute extraction.

| # | Facet | S | A | M | I | Seller | ML | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Verified discount (On sale toggle) | yes | yes (`verified_discount_only`) | yes | yes (`shopAll.onSale`) | no (computed by section 9) | no | READY-NOW (shipped) |
| 2 | Min verified discount 10/20/30/50 | yes | yes (`min_verified_discount_pct`, min 5) | no | no | no | no | NEEDS-API-lite (client only: add field + mapper + i18n) |
| 3 | Price range + histogram | yes (price_amount) | yes (`price_min/max`) | yes | yes | no | no | READY-NOW (range). Histogram NEEDS-API (no counts) |
| 4 | Budget "fits my budget" | yes | `budget_max`, `fits_remaining_budget` | `budgetMax` | yes | no | no | READY-NOW but keep on-device (spec section 12) |
| 5 | Category tree | yes | yes | yes | yes | yes (category pick) | no | READY-NOW |
| 6 | Department Women/Men/Kids/Unisex | yes | yes | yes | check | yes (default unisex) | no | READY-NOW |
| 7 | Stores / My Stores / world | yes | yes | yes | yes | no | no | READY-NOW |
| 8 | Condition x4 | yes | yes | yes (type, no sheet UI) | partial | yes (minor defect needs photo, catalog.md:64) | no | READY-NOW logic; NEEDS UI + labels |
| 9 | Colour | yes | yes (`colors`) | no | no | yes (free-text `Sku.color`) | optional | NEEDS-DATA (normalise to palette) |
| 10 | Material | yes | yes (`materials`) | no | no | yes (single `Product.material`) | optional | NEEDS-DATA |
| 11 | Size (S-M-L, EU numeric) | no (not in `IndexedProduct`) | no | no (`mySizeOnly` only) | pill label only | yes (`Sku.sizeLabel` free text) | no | NEEDS-API + NEEDS-DATA |
| 12 | My size only | live fact | yes | yes | no UI | needs size profile + chart (spec section 10) | no | NEEDS-API (fails closed without profile); hidden until sizing data |
| 13 | Brand | `brandId` on Product only | no | no (`brand` display only) | pill only | optional | no | NEEDS-API + NEEDS-DATA (api-client-gap.md:187) |
| 14 | Rating (4 plus) | yes | yes (`min_rating`) | no | no | no (reviews) | no | NEEDS-API-lite; hide until reviews exist |
| 15 | Lowest price in 30 days | yes (`lowest30d`) | yes | no | no | no | no | READY-NOW on server; add client toggle |
| 16 | Free delivery eligible | yes | yes | no | no | store threshold | no | NEEDS-API-lite (client toggle) |
| 17 | New arrivals | yes (`listedAtMs`) | yes (`new_arrivals`) | dev-only `newIn` | chip label | no | no | NEEDS-API-lite: map to `new_arrivals` (gap doc says missing; schema.ts:44 now has it, verify) |
| 18 | In stock only | `inStock` | no (index only pre-filters in-stock) | dev-only | chip label | no | no | DEFER/hide: results are already in-stock only (ports.ts contract "in_stock only") |
| 19 | Installments / pay with credit / COD | enrichment | yes | yes | check | provider quotes | no | READY-NOW logic; fails closed without provider data (Unconfigured adapters, CLAUDE.md) |
| 20 | Delivery speed | no | no | no | no | courier SLA | no | DEFER |
| 21 | Fulfilled-by-HAUL | no | no | no | no | Phase 2 | no | DEFER |
| 22 | Ending soon | no | no | no | no | needs offer end time (api-client-gap.md:60) | no | DEFER |
| 23 | Pattern, fit, occasion, vibe, modest, season | no | no | no | no | many | yes (section 11 `product_attributes`) | DEFER (NEEDS-DATA via ML) |

## 3. Recommended facet order

Sheet (top to bottom): 1 Sort (server-side later), 2 Verified discount (toggle plus 10/20/30/50 steps), 3 Price (range plus bucketed histogram when counts exist), 4 Category, 5 Department, 6 Size (when data exists), 7 Colour (swatches), 8 Brand, 9 Condition, 10 Material, 11 Stores, 12 Delivery and payment group (free delivery, installments, store credit), 13 Rating, 14 Lowest in 30 days, 15 Budget "fits remaining" (on-device). Collapsed by default: material, stores, delivery/payment, rating.

Sticky quick chips (max 4-5): On sale (verified), Under X EGP presets, New arrivals, Free delivery, Lowest in 30 days. Keep pills Category / Size / Brand / Price, but a pill whose section is missing must open the sheet scrolled to a real section; today the Brand and Size pills open nothing relevant (`ShopAllScreen.tsx:338`).

Hide until data exists (spec rule: never fake data): Size and My size, Brand, Colour, Material, Rating, Ending soon, Delivery speed, Fulfilled-by-HAUL, pattern/fit/occasion/vibe/modest/season, In stock chip, and any facet value with zero count. Show a facet only if the response (or loaded page) has at least one product with that attribute.

## 4. Egypt-specific facet values (proposals, uncited)

- Clothing sizes: XS, S, M, L, XL, XXL, 3XL as the primary display, with numeric EU 34-48 for women's and 44-58 for men's trousers/suits, UK/US as a secondary toggle. Arabic labels: use Latin letters in both locales (common in Egyptian retail); add the size-system label in Arabic ("مقاس"). Store a normalised `size_system` plus `size_value` rather than free text.
- Shoes: EU 35-47 (women 35-41, men 39-47), half sizes optional.
- Kids: age ranges 0-3 m, 3-6 m, 6-12 m, 1-2, 2-3, 4-5, 6-7, 8-9, 10-11, 12-14 years (AR: "شهور", "سنوات").
- 16-colour palette (id, AR, hex): black أسود #111111; white أبيض #FFFFFF; grey رمادي #8E8E93; beige بيج #D9C3A5; brown بني #7B4B2A; navy كحلي #1F2A44; blue أزرق #2563EB; light blue سماوي #7DD3FC; green أخضر #2E8B57; olive زيتي #6B7B3A; yellow أصفر #F4C430; orange برتقالي #F28C28; red أحمر #D62828; pink وردي #F4A6C0; purple بنفسجي #7E57C2; gold/silver multi: use "multi" متعدد. Align the first 13 ids with existing lexicon ids; add light blue, olive, multi.
- Materials AR/EN: cotton قطن, linen كتان, polyester بوليستر, viscose فيسكوز, wool صوف, denim دنيم/جينز, leather جلد, silk حرير, satin ساتان (satin, silk, wool, linen, cotton, denim, leather already in lexicon; add polyester, viscose).
- Fits: slim ضيق, regular عادي, relaxed/loose واسع, oversized أوفر سايز (needs section 10 data).
- Occasions: work شغل, wedding guest فرح, Eid عيد, Ramadan رمضان, beach بحر, gym جيم, university جامعة (section 11 occasions; ML or seller tag).
- Modest criteria (to be set by product with counsel/community input, not from sources): long sleeves covering the elbow, hem at or below mid-calf, neckline high, non-sheer. Section 11 says modest mode excludes items below a sleeve/neckline threshold, so this needs structured garment attributes and should not ship as a seller-ticked flag alone.
- Price bands in EGP (piastres on the wire): under 500, 500-1,000, 1,000-2,000, 2,000-5,000, 5,000+; histogram buckets of 250 EGP up to 2,000, then 1,000 EGP steps, plus an open-ended last bucket. Choose after looking at real catalog quantiles (not available; data is synthetic).
- Discount thresholds: 10/20/30/50 percent and up, verified only. Server minimum is 5 (`schema.ts:35`), so 10/20/30/50 are valid. Copy must say "verified discount" and never imply a % off for unverified items (spec section 5/9).

### Gaps
- No external source consulted for size standards, Arabic colour naming or modest-fashion criteria; a follow-up researcher should cite a size-chart standard (EN 13402 or retailer charts) and Egyptian retailer filters.
- No real price distribution exists (synthetic data only per CLAUDE.md "Current phase").
