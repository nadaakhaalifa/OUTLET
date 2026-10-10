# Spec: Catalog (products, SKUs, media, taxonomy, condition, bulk import, public read model)

Phase 1 wave 1, task P-04 · Spec refs: master prompt §4, §5, §19, §B5, §A2.4, §A2.13, §A2.15, §A3 · Data model: `docs/data-model/catalog.md` · API: `docs/api/openapi.yaml` tags `Catalog` and `Seller Catalog` · Migration: `packages/db/migrations/0012_catalog.sql` · Status: Draft for review, synthetic data only, nothing deployed.

Naming: the master prompt says HAUL, the product is Z-OUTLET. Legal text in this document is engineering input, not legal advice. Items tagged **VERIFY BEFORE LAUNCH** are tracked in `docs/compliance/verify-register.md` by the integrator.

## 0. Scope

In scope: brands, category taxonomy, products, variants (SKU rows), media references, defect photos, condition rules, Arabic-mandatory text, seller legal identity exposure on the public read model, listing lifecycle, bulk CSV import (pure parser and validator, dry run, per-row error report) and the public product read model.

Out of scope here (owned elsewhere, consumed through ports): price evidence and badges (pricing-integrity), stock levels and reservations (inventory), size chart content and fit maths (sizing), uploads and `media_assets` (platform), store and KYC data (sellers), drops and Buy Box (Phase 2).

Operations covered (OpenAPI operationId): `getProduct`, `listSellerProducts`, `createSellerProduct`, `getSellerProduct`, `updateSellerProduct`, `createSellerCatalogImport`, `getSellerCatalogImport`. The price, stock, size-chart, price-history, price-evidence, fit and alert operations on the same tags belong to other modules.

## 1. Flow

### 1.1 Seller creates a product (single)
1. Seller staff sends `POST /v1/seller/products` with Arabic title (required), optional English title, optional description, category, optional brand, condition, SKUs (size label, price, optional GTIN, colour, seller SKU, initial stock), optional upload ids for images and defect photos, optional size chart id.
2. The API resolves the store from the actor's brand grants (single allowed store, or the `X-Store-Id` header when staffing several), then validates with the pure domain validator. Nothing is trusted from the client except the declared fields (mass-assignment allow-list, section 7).
3. The product is created in `draft`. Draft products may be incomplete as to images and size chart but never as to Arabic title and valid SKUs.
4. Seller later sets `status: active` through `PATCH`. The publish gate (2.4) runs. On failure the response is 422 with the list of unmet requirements.
5. Each state change appends an outbox event (`product.created`, `product.updated`, `product.status_changed`). Price changes after creation go through the pricing endpoint (`sku.price_changed`, owned by pricing-integrity).

### 1.2 Seller bulk import (CSV)
1. Seller uploads the CSV through the platform upload flow (gives an `upload_id`), then `POST /v1/seller/catalog/imports {upload_id, dry_run}`. `dry_run` defaults to **true**.
2. The service reads the upload (store-scoped), runs the pure parser and validator, stores an import record with counts and the per-row error report.
3. Dry run: the catalog is not touched. The response status is `dry_run_complete`.
4. Real run (`dry_run: false`): only products whose rows all validate are created, one product with all its SKUs atomically. Products with any failing row are skipped entirely and reported. Status `completed` (or `failed` when every row failed).
5. `GET /v1/seller/catalog/imports/{importId}` returns counts and `error_report_url`.

### 1.3 Shopper reads a product
`GET /v1/products/{productId}` returns the public read model. Price and stock are read from their source on every request (section 2.7). A product that is not `active` returns 404 to shoppers, indistinguishable from a missing id.

## 2. Rules

### 2.1 Text (B5, A2.15)
- `title.ar` and `description.ar`, when a description is supplied, must contain at least one Arabic-script letter (Unicode blocks Arabic, Arabic Supplement, Arabic Extended-A, Presentation Forms-A and -B) after trimming. A string of digits, Latin text or whitespace is rejected with `arabic_text_required`. Rationale: CPL 181/2018 requires Arabic product data (VERIFY BEFORE LAUNCH whether a Latin brand name with Arabic generic noun is enough; default is the stricter check).
- `title.ar` length 1 to 200, `description.ar` 1 to 2000, English optional with the same maxima. Control characters are rejected. Text is treated as untrusted (LLM01, output encoding at render).
- A product cannot be published without an Arabic title (draft creation also requires it: there is no Arabic-less draft).

### 2.2 Condition (section 4)
Values: `new_with_tags`, `new_without_tags`, `sample`, `minor_defect`. `minor_defect` requires at least one defect photo upload id at create and at every update that touches condition or defect photos. Changing a product away from `minor_defect` clears nothing automatically (photos are kept, harmless). A defect disclosed in photos is not a return reason (returns module).

### 2.3 SKUs
- 1 to 100 SKUs per product (OpenAPI). `size_label` 1 to 20 chars, unique per `(color, size_label)` within the product (case-insensitive after trim).
- `price.amount` is a positive integer of piastres, VAT-inclusive, currency `EGP`. No "was" price, reference price, discount or badge field exists on input (mass-assignment guard, section 7).
- `barcode_gtin`, when present, must be GTIN-8, 12, 13 or 14 digits with a valid check digit. Uniqueness: `(store_id, gtin, color_code, size_label)` when GTIN is present; `(store_id, seller_sku)` when present.
- `initial_stock` is passed to the inventory module through the `StockSeedPort`. Catalog never stores stock.

### 2.4 Listing lifecycle
States (wire form): `draft`, `active`, `paused`, `auto_paused_price_parity`, `delisted`.

| From | Event | To | Actor |
|---|---|---|---|
| `draft` | `publish` | `active` | seller, gate applies |
| `active` | `pause` | `paused` | seller |
| `paused` | `resume` | `active` | seller, gate re-applies |
| `active`, `paused` | `auto_pause_price_parity` | `auto_paused_price_parity` | system only (pricing-integrity) |
| `auto_paused_price_parity` | `resume` | `active` | system only, after the parity fix |
| `draft`, `active`, `paused`, `auto_paused_price_parity` | `delist` | `delisted` | seller or system |

`delisted` is terminal. A seller cannot clear `auto_paused_price_parity` (the PATCH enum only has `active` and `paused`; a seller `active` request on an auto-paused product is 422 `invalid_transition`). Invalid transitions return 422 `invalid_transition`.

Publish gate (all must hold, otherwise the unmet list is returned): Arabic title; Arabic description present; at least one image; at least one SKU with positive price; `minor_defect` has a defect photo; if the category has `requires_size_chart = true`, a size chart id that sizing reports as validated. Decision (ADR-record candidate): the data model's Flow says a validated chart is required to publish while its Rules say a missing chart only disables size advice. We implement the Rules reading by default (`requires_size_chart` false) and make the Flow reading a per-category switch, so product can choose per product type without a code change.

### 2.5 Seller legal identity (B5)
The public read model exposes `seller_legal_identity_visible: true` only when the store's legal name, commercial register number, tax card number and governorate are all present and the store is approved. The identity values themselves are read from `sellers` at read time and are never copied onto the product. The identity projection (`publicSellerIdentity`) exposes exactly four fields (legal name, commercial register number, tax card number, governorate) and never the signatory, national id, IBAN or contact data. The OpenAPI `Product` schema carries only the boolean; see deviation D-1.

### 2.6 Bulk import (section 19)
- Format: UTF-8 (BOM tolerated), RFC 4180 quoting, CR LF or LF, comma separated, header row required, max 5,000 data rows, max 256 KiB at the parser level, max 40 columns, max 4,096 characters per cell.
- One row per SKU. Rows of one product share `product_ref` (seller-chosen key, 1 to 64 chars `[A-Za-z0-9._-]`). Product-level columns must be identical across a product's rows, otherwise every row of that product fails with `product_columns_mismatch`.
- Columns: `product_ref, title_ar, title_en, description_ar, description_en, category_slug, brand_slug, condition, material, size_label, color, seller_sku, barcode_gtin, price_egp, initial_stock, image_upload_ids, defect_photo_upload_ids`. Unknown columns are an error (`unknown_column`), missing required columns fail the whole file (`missing_column`) with zero rows processed.
- `price_egp` is a decimal string `^[0-9]{1,10}(\.[0-9]{1,2})?$` converted to piastres with integer arithmetic only. Arabic-Indic digits and commas as decimal separators are rejected, not guessed.
- Upload id lists are `;` separated UUIDs; every id must resolve to an upload owned by the same store, else `upload_not_found` (no cross-tenant existence leak).
- A cell beginning with `=`, `+`, `-`, `@`, tab or CR is accepted as data (it is validated like any text) but is never echoed into the error report, and any CSV the system later exports must prefix such cells with `'` (CSV injection). The error report contains row numbers, column names and machine codes only.
- Each failed row appears once with all its errors (max 20 per row). A row that is valid but belongs to a product with a failing sibling is reported `product_group_invalid`.
- Dry run and real run use the same validator and must produce identical error reports for the same bytes.
- Counters: `rows_total` = data rows, `rows_failed` = rows with at least one error or in an invalid product group, `rows_ok = rows_total - rows_failed`.

### 2.7 Public read model: nothing is cached as truth
- SKU price is read from the product repository at request time; stock is read from the `StockReader` port at request time; the price block comes from the `PriceBlockReader` port (pricing-integrity). The read model has no cache and no stored copy of price or stock beyond the SKU's own `list_price_amount` column.
- `units_left` is exposed only when real available stock is 1 to 5, otherwise `null` (section 5 rule). `available` is `true` when stock is at least 1 and the SKU is `active`.
- When pricing-integrity has no verified evidence (or the port is unavailable), the price block is `{price, badge: "none", reference_price: null, discount_pct: null, claim_id: null, installment_quote: null}`. The catalog never computes a reference or percentage.
- ETag is a SHA-256 over the serialised body. `If-None-Match` match returns 304. A price or stock change changes the body and therefore the ETag.
- `delivery_eta` is omitted (courier SLA belongs to fulfillment). `video_url` omitted until media pipeline exists.

### 2.8 Return eligibility on the read model
Derived from `categories.return_class`: `standard` returnable with `window_days` 14; `hygiene`, `personalized`, `non_returnable` are not returnable with reason codes. Windows count from delivery (returns module). Defect rights (30 days) are not category based. VERIFY BEFORE LAUNCH: exclusions list (master prompt B5).

## 3. Edge cases
- Zero, negative, non-integer or above `9_999_999_99` piastres (EGP 9,999,999.99) price: 422 `price_out_of_range`.
- Duplicate `(color, size_label)` within a product: 422 `duplicate_variant`.
- Duplicate GTIN in the same store across products: 409 `gtin_conflict` (no value echoed).
- Stale update: `If-Match` version mismatch 412, missing `If-Match` 428. The OpenAPI lists both on `updateSellerProduct`.
- Delisted product: PATCH 422 `invalid_transition`; GET by seller still works; shopper 404.
- Seller suspended or store not approved: write routes 403 via policy (actor or grant status); public read of that store's products is the sellers module's concern (suspension flips products via an outbox consumer, Phase 1 integrator task).
- Unknown category or brand: 422 `category_not_found` / `brand_not_found`. Inactive category: 422 `category_inactive`.
- Concurrent imports with the same `Idempotency-Key`: idempotency interceptor (409 in flight, replay on repeat).
- RTL: all text stored as given (no bidi control stripping beyond control characters); rendering is the client's job. Bidi override characters (U+202A to U+202E, U+2066 to U+2069) are rejected in titles to prevent spoofing.
- Deleted or suspended actors: policy guard 403 (`account_not_active`).

## 4. Data
See `docs/data-model/catalog.md` for entities; this module's migration is `0012_catalog.sql` and implements: `brands`, `categories`, `products`, `skus`, `product_media`, `product_defects`, `catalog_imports`, `catalog_import_errors`. Deviations from the data model, all deliberate:

| Item | Data model | Implemented | Reason |
|---|---|---|---|
| Enum case | `DRAFT, ACTIVE` | lowercase snake | ADR-0018 persists the wire form |
| Status set | `DRAFT, ACTIVE, PAUSED, DELISTED` | adds `auto_paused_price_parity` | OpenAPI `SellerProduct.status` and section 9.3 enforcement ladder |
| `store_id` FK | enforced to `stores` | logical (no FK) | `stores` is created by the sellers migration, not yet merged; integrator adds the FK in a later expand migration |
| `size_chart_id` | logical to sizing | logical | sizing owns the chart |
| `media_asset_id` | enforced to platform | logical | `media_assets` migration not merged |
| `offer_groups`, `drops`, `saved_searches` | Phase 2 / other | not created | out of scope for P-04 |
| `description_ar` | NOT NULL | nullable | OpenAPI input makes `description` optional; draft needs no description, publish gate requires it |
| `condition` | enum | adds `material` text column | OpenAPI `material` |

PII class: all P0 (public catalog content). Seller free text is untrusted, never P2/P3. Tenancy: `store_id` on products, skus (denormalised), media, defects, imports. Retention per data model (`catalog_content`; imports 90 days proposed). Privacy tags: `docs/privacy/fragments/catalog.yaml`.

## 5. API (conforms to OpenAPI; no changes to openapi.yaml)

| Operation | Route | Auth | Idempotent | Rate limit |
|---|---|---|---|---|
| getProduct | `GET /v1/products/{productId}` | buyer bearer, scope `shopper:catalog.read`, self, active products only | n/a (ETag) | 120/min per user |
| listSellerProducts | `GET /v1/seller/products` | seller bearer, `seller:catalog.read`, brand grant with `store_product` read | n/a | 120/min per user |
| createSellerProduct | `POST /v1/seller/products` | seller bearer, `seller:catalog.write`, role owner/manager/catalog | required `Idempotency-Key` | 60/min per user |
| getSellerProduct | `GET /v1/seller/products/{productId}` | resource authorization `store_product:read` | n/a (ETag) | 120/min per user |
| updateSellerProduct | `PATCH /v1/seller/products/{productId}` | resource authorization `store_product:update`, `If-Match` required | optional key | 60/min per user |
| createSellerCatalogImport | `POST /v1/seller/catalog/imports` | seller bearer, write role | required key | 10/hour per user |
| getSellerCatalogImport | `GET /v1/seller/catalog/imports/{importId}` | seller bearer, read role, own store only | n/a | 120/min per user |

Token scope mapping: the OpenAPI scopes `seller:catalog.read|write` are carried by the platform's generic `seller:read|write` token scopes that `@outlet/policy` rules require (`docs/security` matrix owns the mapping).

Pagination: opaque cursor (base64url of `(created_at_ms, id)`), shared platform defaults (default limit 20, max 50). Cursor is validated; a malformed cursor is 400.

Errors: Problem+JSON via the platform filter. Domain failures are 422 with `code` and `errors[]` of `{pointer, code}`; no internal ids.

## 6. Events
Outbox (typed in this module, at-least-once, consumers idempotent): `product.created`, `product.updated`, `product.status_changed`. Payload carries ids, status, store id and version only (P0/P1; no seller free text). `sku.price_changed` is emitted by the pricing module, not here; at create time the initial price is announced as part of `product.created` with `sku_ids` and the pricing consumer seeds `price_events` from the creation event (reconcile with the pricing agent, see needs). Analytics: `product_viewed` is a client event (event-taxonomy 6.1); no server analytics event is emitted by this module.

## 7. Security and abuse (threat notes)
STRIDE summary.

| Threat | Vector | Control | Test |
|---|---|---|---|
| Spoofing | Buyer token on seller routes | audience check in guard (`seller_api` vs `buyer_api`) | 401 on wrong audience |
| Tampering (mass assignment, API3) | Client sends `status`, `store_id`, `version`, `was_price`, `discount_pct`, `badge`, `offer_group_id` | Zod `.strict()` DTOs; server-controlled fields never read from the body | 400 `validation_failed` test |
| Repudiation | Who changed a product | policy guard audit record for every decision; outbox event with actor id | audit sink assertion |
| Information disclosure (BOLA, API1) | Seller A reads or edits seller B's product or import | resolver returns resource with `storeId`; `decide()` gives 404; repository queries are always store-scoped; RLS in migration | cross-tenant 404 tests on every `{id}` route |
| Information disclosure | Draft/paused products to shoppers | public read requires `active`, else 404 | test |
| Information disclosure | Seller identity PII (signatory, IBAN) | projection allow-list of 4 fields | unit test |
| DoS (API4) | Huge CSV, 100 SKUs x many products, regex backtracking | size and row caps, linear parser, no regex on unbounded input, rate limits | unit tests with caps |
| Injection | HTML/JS in titles, bidi spoof, CSV formula | stored as data, control and bidi-override rejection, never echoed in reports, export prefixing rule | unit tests |
| SSRF (API7) | Image/upload references | only platform upload ids accepted, never URLs | validator rejects non-UUID |
| Elevation (BFLA, API5) | Catalog-role staff doing finance, warehouse writing products | policy rules: write needs owner/manager/catalog | 403 test for `support` and `warehouse` |
| Business abuse (API6) | Listing spam, duplicate SKU inflation | per-user rate limit, 100 SKU cap, import 10/hour | rate-limit test |
| Fake data | Seller-supplied discount or fake stock displayed | no input field exists; read model gets badge only from pricing port; stock only from inventory port | contract test: no `reference_price` without port output |
| LLM01 | Seller text in future AI features | untrusted marker in spec and data class; no LLM use in this module | n/a |

OWASP API Top 10 2023 mapping: API1 (resolver + RLS), API2 (platform auth), API3 (strict DTOs, explicit serialisers), API4 (caps, rate limits), API5 (role rules), API6 (limits), API7 (no URL input), API8 (platform config), API9 (OpenAPI conformance), API10 (ports validate their input with Zod in adapters, none consumed here).

## 8. Failure handling
- Ports (StockReader, PriceBlockReader, SellerIdentityReader) are called with a 2 s budget in production adapters. Failure of the price block port degrades to badge `none` (fail closed for claims). Failure of the stock port: SKU `available: false`, `units_left: null` (fail closed for purchasing) and the response is still 200. Failure of the identity reader: `seller_legal_identity_visible: false`.
- Import: the whole file is validated before any write. The real run applies products in batches of 500 rows' worth of products; each product is one repository `createProductWithSkus` call (atomic in the Postgres adapter). A crash mid-run is resumable because creating a product with an already used `(store_id, import_id, product_ref)` is a no-op (unique key in the import-product map).
- Outbox write is in the same transaction as the state change in production adapters; the in-memory adapter records events in order.
- Retries: none on the request path; clients retry with the same idempotency key.

## 9. Metrics
Catalog completeness (Arabic title, image, size chart, GTIN), listing-to-publish time, import dry-run to real-run ratio, import row failure rate by code, public read p95 under 300 ms (read SLO), 304 ratio, publish-gate rejection reasons. No user identifiers in metrics.

## 10. Acceptance (Gherkin)
- Given a create request whose Arabic title is empty or Latin-only, then 422 `arabic_text_required` and no product exists.
- Given condition `minor_defect` and no defect photo, then 422 `defect_photo_required`.
- Given a product with condition `minor_defect` and defect photos, when published with an image and a priced SKU, then status `active`.
- Given a CSV with 3 rows of which one is invalid, when imported with `dry_run: true`, then `rows_failed: 1`, the catalog is unchanged and the error report names row and column; and when imported with `dry_run: false` the valid product is created, the failing product is not.
- Given the same file in dry run twice, then both reports are equal and the product count is unchanged.
- Given seller A and a product of seller B, GET/PATCH by A returns 404 and the response body is identical to a missing id.
- Given an active product with no price evidence, GET returns badge `none` and `reference_price: null`, always.
- Given stock 3, the SKU shows `units_left: 3`; given stock 40, `units_left: null`.
- Given a size chart whose measurements decrease with size order, the structure validator rejects it with `non_monotonic`; fit maths is not evaluated.

## 11. Deviations and open items (reported to the integrator)
- D-1: `Product` has only `seller_legal_identity_visible` (boolean). B5 says every listing shows the legal identity; a `seller_legal_identity` object (legal name, register number, tax card, governorate) must be added to the schema, or a store-profile endpoint must carry it. The module already produces the four-field projection.
- D-2: `CatalogImport.error_report_url` is a URI; there is no file store yet. The dev adapter returns a `data:text/csv;base64,...` URI (capped at 64 KiB, truncated with a final marker row). Production must publish the report to private object storage and return a signed URL of at most 15 minutes.
- D-3: no OpenAPI parameter selects the store for multi-store staff. The module accepts an optional `X-Store-Id` header; OpenAPI should list it on the seller catalog operations.
- D-4: `getProduct` is `shopperBearer` in OpenAPI while the A3 table says public; the module follows OpenAPI. If the PDP must be reachable by guests (not in Phase 1: guest bag is unsupported) change both.
- D-5: Taxonomy browse endpoints (categories, brands) are not in OpenAPI. The module resolves `category_id` and `brand_id` from seeded taxonomy and exposes none.
