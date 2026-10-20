# Authorization matrix

Status: recounted from the matrix rows, `docs/api/openapi.yaml` and `unserved-baseline.json` on 2026-10-18 (includes the seller store balance `GET /v1/seller/stores/:storeId/balance` and the admin payouts summary `GET /v1/admin/finance/payouts/summary`); originally generated 2026-10-12 (Phase 3 integration: visual search, seller categories, brand-application provisioning retry, auto-buy terms; earlier Phase 2 integration: subscriptions, gift cards, budget, stylist, recommendations, history, rewards, drops, waiting room, price crawler, hub, resale, ads). The machine check is `apps/api/test/authz-matrix.test.ts` (run through `apps/api/src/authz-matrix.test.ts`); it fails when a registered route has no matrix row, when a row has no route, when a route has no `@Public`/`@AuthenticatedSelf`/`@Authorize` declaration, or when this document omits an implemented route.

Master prompt A2.10: every endpoint has an integration test including a negative authorization test.

## Numbers

- OpenAPI operations: 539
- Implemented in `apps/api`: 506 product operations + 2 operational probes (`/v1/health`, `/v1/ready`, not in the contract) = 508 registered routes
- Not yet implemented: 33 (23 gaps in the baseline, 10 planned)
- Covered by the matrix: 508 of 508 registered routes (one row each, no duplicates; shared-harness versus per-module split not recounted, see the machine check)

## What each row is checked for

| Check | Applies to | Expectation |
|---|---|---|
| (a) No credentials | protected routes | 401, `WWW-Authenticate: Bearer`, problem body with only the documented keys |
| (a2) Malformed or unknown bearer | protected routes | 401 |
| (a3) No credentials | public routes | reachable (declared `@Public`) |
| (b) Wrong audience (`seller_api` token on a buyer route) | protected routes | 401 |
| (b2) Suspended subject | protected routes | 403 `account_not_active` |
| (c) Another user's object id | object-id routes | 404, body identical to a non-existent id, no side effect |
| (d) Response fields | all routes | only allow-listed keys; no secrets, no echoed input |

No admin or seller route exists yet, so a dedicated shopper-on-admin 403 row cannot be written; the policy-engine unit tests and `auth.privacy.http.test.ts` probe controllers cover that decision path. When the first seller or admin route lands, add a (b) shopper-token row for it.

## Implemented operations

| Operation | Authorization | Object id | Covered |
|---|---|---|---|
| `POST /v1/auth/age-gate` | public | - | yes |
| `POST /v1/auth/apple` | public | - | yes |
| `POST /v1/auth/google` | public | - | yes |
| `POST /v1/auth/logout` | self | - | yes |
| `POST /v1/auth/otp/request` | public | - | yes |
| `POST /v1/auth/otp/verify` | public (appAttest; challenge-bound; `mode: existing_only` creates nothing and is 404 while flag.guest_browsing is blocked) | - | yes |
| `POST /v1/auth/passkey/assert` | public | - | yes |
| `POST /v1/auth/passkey/assert/options` | public | - | yes |
| `POST /v1/auth/passkey/register` | self | - | yes |
| `POST /v1/auth/passkey/register/options` | self | - | yes |
| `POST /v1/auth/refresh` | public | - | yes |
| `GET /v1/me/privacy/consents` | self | - | yes |
| `PATCH /v1/me/privacy/consents` | self | - | yes |
| `GET /v1/me` | self | - | yes |
| `GET /v1/me/sessions` | self | - | yes |
| `DELETE /v1/me/sessions/:sessionId` | resource: session delete | yes (404 for foreign) | yes |
| `GET /v1/me/sessions/:sessionId` | resource: session read | yes (404 for foreign) | yes |
| `POST /v1/seller/auth/otp/request` | public | - | yes |
| `POST /v1/seller/auth/otp/verify` | public | - | yes |
| `POST /v1/seller/auth/passkey/assert/options` | public | - | yes |
| `POST /v1/seller/auth/passkey/assert` | public | - | yes |
| `POST /v1/seller/auth/totp/assert` | public | - | yes |
| `POST /v1/seller/auth/passkey/register/options` | self (seller_api; enrol token only where noted) | - | yes |
| `POST /v1/seller/auth/passkey/register` | self (seller_api; enrol token only where noted) | - | yes |
| `POST /v1/seller/auth/totp/enrol` | self (seller_api; enrol token only where noted) | - | yes |
| `POST /v1/seller/auth/totp/confirm` | self (seller_api; enrol token only where noted) | - | yes |
| `GET /v1/seller/auth/sessions` | self (seller_api; enrol token only where noted) | - | yes |
| `DELETE /v1/seller/auth/sessions/:sessionId` | self (seller_api; enrol token only where noted) | yes (404 for foreign) | yes |
| `POST /v1/seller/auth/logout` | self (seller_api; enrol token only where noted) | - | yes |
| `GET /v1/health` | public (probe, not in OpenAPI) | - | yes |
| `GET /v1/ready` | public (probe, not in OpenAPI) | - | yes |
| `GET /v1/stores` | self | - | yes |
| `GET /v1/stores/:storeId` | self | - (404 for hidden or missing) | yes |
| `GET /v1/me/favorite-stores` | self | - | yes |
| `PUT /v1/me/favorite-stores` | self (If-Match) | - | yes |
| `GET /v1/me/favorite-stores/new-counts` | self | - | yes |
| `POST /v1/me/favorite-stores/:storeId/seen` | self | yes (404 for a store the caller does not follow) | yes |
| `GET /v1/me/wishlists` | self | - | yes |
| `POST /v1/me/wishlists` | self | - | yes |
| `GET /v1/me/wishlists/:wishlistId` | resource: wishlist read | yes (404 for foreign) | yes |
| `PATCH /v1/me/wishlists/:wishlistId` | resource: wishlist update (If-Match) | yes (404 for foreign) | yes |
| `DELETE /v1/me/wishlists/:wishlistId` | resource: wishlist delete | yes (404 for foreign) | yes |
| `POST /v1/wishlists/:wishlistId/items` | resource: wishlist update | yes (404 for foreign) | yes |
| `DELETE /v1/wishlists/:wishlistId/items/:itemId` | resource: wishlist update | yes (404 for foreign) | yes |
| `POST /v1/me/wishlists/:wishlistId/share` | resource: wishlist update | yes (404 for foreign) | yes |
| `DELETE /v1/me/wishlists/:wishlistId/share` | resource: wishlist update | yes (404 for foreign) | yes |
| `GET /v1/shared/wishlists/:token` | public (unguessable token, rate limited, fails closed) | - (404 for unknown, revoked or expired) | yes |
| `GET /v1/cart` | self | - | yes |
| `POST /v1/cart/lines` | self (Idempotency-Key) | - | yes |
| `PATCH /v1/cart/lines/:lineId` | resource: cart update (If-Match) | yes (404 for foreign) | yes |
| `DELETE /v1/cart/lines/:lineId` | resource: cart delete | yes (404 for foreign) | yes |
| `GET /v1/cart/free-delivery-suggestions` | self | - | yes |
| `POST /v1/me/guest-merge` | self (buyer_api, Idempotency-Key, 5/min per user and 20/day per session; flag.guest_browsing, 404 while blocked). Merges only into the token subject's own bag and Saved lists; no object id in the request, no price accepted | - (no foreign object reachable) | yes |
| `GET /v1/public/skus` | public (flag.guest_browsing; device + IP buckets; allow-listed fields, no per-user value) | - (unknown and hidden ids are not distinguished) | yes |
| `GET /v1/public/feed` | public (flag.guest_browsing; personalized=false hard-coded, personal query keys are 400, writes nothing) | - | yes |
| `GET /v1/public/home/banners` | public (flag.guest_browsing; same projection as the shopper read) | - | yes |
| `GET /v1/public/search/suggestions` | public (flag.guest_browsing; prefix only, no recents, no is_favorite) | - | yes |
| `GET /v1/me/size-profiles` | self | - | yes |
| `POST /v1/me/size-profiles` | self | - | yes |
| `GET /v1/me/size-profiles/:profileId` | self (owner-scoped repository) | yes (404 for foreign) | yes |
| `PATCH /v1/me/size-profiles/:profileId` | self (owner-scoped repository, If-Match) | yes (404 for foreign) | yes |
| `DELETE /v1/me/size-profiles/:profileId` | self (owner-scoped repository) | yes (404 for foreign) | yes |
| `GET /v1/fit/recommend` | self (owner-scoped profile) | yes (404 for another user's profile) | yes |
| `GET /v1/products/:productId/fit` | self (owner-scoped profile) | yes (404 for another user's profile) | yes |
| `POST /v1/orders/lines/:orderLineId/fit-feedback` | self (Idempotency-Key) | yes (404 for another user's line) | yes |
| `GET /v1/me/notification-preferences` | self | - | yes |
| `PATCH /v1/me/notification-preferences` | self (If-Match) | - | yes |
| `PUT /v1/me/devices/push-token` | self | - (keyed by user and install id) | yes |
| `GET /v1/me/notifications` | self | - | yes |
| `POST /v1/me/notifications/read` | self | yes (404 for any foreign id, nothing marked) | yes |
| `GET /v1/products/:productId` | self (shopper audience) | - (404 for non-active or hidden store) | yes |
| `GET /v1/seller/categories` | self + store policy `store_product:read` (seller_api) | - | yes |
| `GET /v1/seller/products` | self + store policy `store_product:read` (seller_api) | - | yes |
| `POST /v1/seller/products` | self + store policy `store_product:create` (seller_api, Idempotency-Key) | - | yes |
| `GET /v1/seller/products/:productId` | resource: store_product read (seller_api) | yes (404 for another store) | yes |
| `PATCH /v1/seller/products/:productId` | resource: store_product update (seller_api, If-Match) | yes (404 for another store) | yes |
| `POST /v1/seller/catalog/imports` | self + store policy `store_product:create` (seller_api, Idempotency-Key) | - | yes |
| `GET /v1/seller/catalog/imports/:importId` | resource: store_product read (seller_api) | yes (404 for another store) | yes |
| `PUT /v1/seller/skus/:skuId/stock` | resource: store_inventory update (seller_api, Idempotency-Key) | yes (404 for another store's SKU) | yes |
| `GET /v1/seller/size-charts` | resource: store_product read (seller_api) | - (store from the brand grant) | yes |
| `POST /v1/seller/size-charts` | resource: store_product create (seller_api) | - (store from the brand grant) | yes |
| `GET /v1/seller/size-demand` | resource: store_product read (seller_api) | - (store from the brand grant) | yes |

## Wave 3 operations (orders, returns, promotions, fulfillment, search, DPO breach register)

These routes need module fixtures the shared harness does not seed, so their negative authorization cases (401 without credentials, 403 wrong role or audience, 404 for a non-owned or cross-tenant object) live in the named per-module suite. `apps/api/test/authz-matrix.test.ts` (DELEGATED table) still fails when one of these routes loses its declared authorization mode, its OpenAPI entry, its 401, or its suite file.

| Operation | Authorization | Suite |
|---|---|---|
| `DELETE /v1/admin/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `DELETE /v1/me/privacy/delete` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `DELETE /v1/me/saved-searches/:savedSearchId` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `DELETE /v1/seller/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `GET /v1/admin/privacy/breaches` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `GET /v1/admin/privacy/requests` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `GET /v1/admin/promotions` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `GET /v1/admin/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `GET /v1/me/privacy/delete` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `GET /v1/me/privacy/export/latest` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `GET /v1/me/privacy/export/:exportId` | resource | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `GET /v1/me/returns` | self | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `GET /v1/me/returns/:returnId` | resource | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `GET /v1/me/saved-searches` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `GET /v1/me/saved-searches/:savedSearchId` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `GET /v1/me/orders` | self | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `GET /v1/order-groups/:id` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `GET /v1/search` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `GET /v1/search/suggestions` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `GET /v1/seller/orders` | self | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `DELETE /v1/seller/applications/:id/documents/:documentId` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `GET /v1/seller/applications` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `GET /v1/seller/applications/:id` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `GET /v1/seller/applications/requirements` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `GET /v1/seller/onboarding-checklist` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `PATCH /v1/seller/applications/:id` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/appeal` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/documents` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/documents/:documentId/confirm` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/resubmit` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/submit` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `POST /v1/seller/applications/:id/withdraw` | self | `apps/api/src/modules/sellers/test/sellers.http.test.ts` |
| `GET /v1/seller/orders/:id` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `GET /v1/seller/promotions` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `GET /v1/seller/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `GET /v1/seller/returns` | resource | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `GET /v1/seller/shipments/:shipmentId` | resource | `apps/api/src/modules/fulfillment/test/fulfillment.authz.test.ts` |
| `GET /v1/seller/shipments/:shipmentId/label` | resource | `apps/api/src/modules/fulfillment/test/fulfillment.authz.test.ts` |
| `PATCH /v1/admin/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `PATCH /v1/me/saved-searches/:savedSearchId` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `PATCH /v1/seller/promotions/:promotionId` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `POST /v1/admin/privacy/breaches` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/admin/privacy/breaches/:id/close` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/admin/privacy/breaches/:id/pdpc-notified` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/admin/privacy/breaches/:id/subjects-notified` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/admin/privacy/breaches/:id/triage` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/admin/promotions` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `POST /v1/me/privacy/delete` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/me/privacy/export` | self | `apps/api/src/modules/privacy/privacy.http.test.ts` |
| `POST /v1/me/saved-searches` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `POST /v1/orders/lines/:orderLineId/returns` | resource | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `POST /v1/promotions/evaluate` | public | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `POST /v1/returns/:returnId/dispute` | resource | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `POST /v1/search/parse` | self | `apps/api/src/modules/search/test/search.authz.test.ts` |
| `POST /v1/seller-orders/:id/cancel` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `POST /v1/seller/orders/:id/accept` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `POST /v1/seller/orders/:id/pack` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `POST /v1/seller/orders/:id/reject` | resource | `apps/api/src/modules/orders/test/orders.http.test.ts` |
| `POST /v1/seller/promotions` | self | `apps/api/src/modules/promotions/test/promotions.authz.test.ts` |
| `POST /v1/seller/returns/:returnId/inspect` | resource | `apps/api/src/modules/returns/test/returns.authz.test.ts` |
| `POST /v1/seller/shipments` | self | `apps/api/src/modules/fulfillment/test/fulfillment.authz.test.ts` |
| `POST /v1/webhooks/couriers/:courier` | public | `apps/api/src/modules/fulfillment/test/fulfillment.authz.test.ts` |

## Wave 3b operations (admin, tax-eta, seller-analytics, reviews, referrals, price-integrity)

Same delegation rule as the wave 3 table above: the negative cases live in the named per-module suite and the DELEGATED table in `apps/api/test/authz-matrix.test.ts` fails when a route loses its declared mode, its OpenAPI entry, its 401 or its suite file. Admin routes use the `admin_api` audience, seller routes `seller_api`.

| Operation | Authorization | Suite |
|---|---|---|
| `DELETE /v1/me/reviews/:reviewId` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/admin/approvals` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/approvals/:id` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/elevations` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/elevations/mine` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/flags` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/flags/:key` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/kill-switches` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/brand-applications` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `GET /v1/admin/brand-applications/:id` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/claim` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/release` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/decision` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/cosign` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/retry-provisioning` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/documents/:document_id/read-url` | self | `apps/api/src/modules/admin/brand-review/brand-review.http.test.ts` |
| `GET /v1/admin/kyc/queue` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/kyc/sellers/:sellerId` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/kyc/suspension-reviews` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `GET /v1/admin/moderation/queue` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/admin/tax/categories` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/admin/tax/documents` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/admin/tax/documents/:documentId` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/admin/tax/exemption-audit` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/admin/tax/reconciliation` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/me/referral` | self | `apps/api/src/modules/referrals/referrals.http.test.ts` |
| `GET /v1/me/reviews` | self | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/products/:productId/price-evidence` | self | `apps/api/src/modules/price-integrity/test/http.authz.test.ts` |
| `GET /v1/products/:productId/questions` | public | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/products/:productId/reviews` | public | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/seller/invoices` | resource | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/seller/invoices/:documentId` | resource | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/seller/price-trust` | self | `apps/api/src/modules/price-integrity/test/http.authz.test.ts` |
| `GET /v1/seller/questions` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/seller/reviews` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/aging` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/funnel` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/geography` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/returns` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/sales` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/search-terms` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/sell-through` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/size-curve` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/traffic` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/admin/me` | self | `apps/api/src/modules/admin/admin-me.http.test.ts` |
| `GET /v1/admin/attention` | self | `apps/api/src/modules/admin-attention/test/admin-attention.http.test.ts` |
| `GET /v1/admin/audit-log/verify` | self | `apps/api/src/modules/admin-attention/test/admin-attention.http.test.ts` |
| `GET /v1/admin/metrics/:metricId` | self | `apps/api/src/modules/platform-metrics/test/metrics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/series/:metricId` | resource | `apps/api/src/modules/seller-analytics/test/series.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/series/:metricId/breakdown` | resource | `apps/api/src/modules/seller-analytics/test/series.http.test.ts` |
| `GET /v1/seller/stores/:storeId/analytics/summary` | resource | `apps/api/src/modules/seller-analytics/test/series.http.test.ts` |
| `GET /v1/seller/stores/:storeId/dashboard/summary` | resource | `apps/api/src/modules/seller-analytics/test/dashboard.http.test.ts` |
| `PATCH /v1/me/reviews/:reviewId` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/admin/approvals` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/approvals/:id/approve` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/approvals/:id/reject` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/elevations` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/elevations/:id/activate` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/elevations/:id/revoke` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/kyc/sellers/:sellerId/reinstate` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/kyc/sellers/:sellerId/suspend` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/kyc/suspension-reviews/:id/uphold` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/moderation/:targetType/:targetId/decision` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/admin/pii-views` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `POST /v1/admin/tax/categories/:code/exemption/clear` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `POST /v1/admin/tax/submissions/:documentId/requeue` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `POST /v1/orders/lines/:orderLineId/review` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/products/:productId/questions` | self | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/referrals/attribute` | self | `apps/api/src/modules/referrals/referrals.http.test.ts` |
| `POST /v1/seller/questions/:questionId/answer` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/seller/reviews/:reviewId/reply` | resource | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `POST /v1/seller/stores/:storeId/analytics/exports` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `POST /v1/ugc/reports` | self | `apps/api/src/modules/reviews/reviews.http.test.ts` |
| `PUT /v1/admin/flags/:key` | self | `apps/api/src/modules/admin/admin.http.test.ts` |
| `PUT /v1/admin/tax/categories/:code/exemption` | self | `apps/api/src/modules/tax-eta/test/tax-eta.http.test.ts` |
| `GET /v1/admin/ledger/balances` | self | `apps/api/src/modules/ledger/test/ledger.http.test.ts` |
| `GET /v1/admin/ledger/entries/:id` | self | `apps/api/src/modules/ledger/test/ledger.http.test.ts` |
| `GET /v1/admin/ledger/integrity` | self | `apps/api/src/modules/ledger/test/integrity.http.test.ts` |
| `GET /v1/admin/ledger/integrity/runs` | self | `apps/api/src/modules/ledger/test/integrity.http.test.ts` |
| `POST /v1/analytics/events` | self | `apps/api/src/modules/analytics-ingest/test/ingest.http.test.ts` |
| `POST /v1/webhooks/:provider` | public | `apps/api/src/modules/payments/test/http.test.ts` |
| `GET /v1/payments/methods` | self | `apps/api/src/modules/payments/test/http.test.ts` |
| `GET /v1/me/payment-methods` | self | `apps/api/src/modules/payments/test/http.test.ts` |
| `DELETE /v1/me/payment-methods/:id` | self | `apps/api/src/modules/payments/test/http.test.ts` |
| `POST /v1/checkout/quote` | self | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `POST /v1/checkout` | self | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `GET /v1/checkout/:id` | resource | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `POST /v1/checkout/:id/cancel` | resource | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `POST /v1/checkout/:id/confirm-cod` | resource | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `POST /v1/webhooks/checkout/:provider` | public | `apps/api/src/modules/checkout/test/checkout.http.test.ts` |
| `GET /v1/me/refunds` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/refunds/:id` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/me/addresses` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `POST /v1/me/addresses` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `GET /v1/me/addresses/:addressId` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `PATCH /v1/me/addresses/:addressId` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `DELETE /v1/me/addresses/:addressId` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `POST /v1/me/addresses/:addressId/default` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `GET /v1/coverage/governorates` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `GET /v1/coverage/cities` | self | `apps/api/src/modules/addresses/addresses.http.test.ts` |
| `GET /v1/me/wallet` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/me/wallet/transactions` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/seller/stores/:id/profile` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PUT /v1/seller/stores/:id/profile` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PUT /v1/seller/stores/:id/vacation` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/storefront-preview` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/media/uploads` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/media/uploads/:uploadId/confirm` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/media/product-uploads` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/payout-account` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PUT /v1/seller/stores/:id/payout-account` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/payout-account/history` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/shipping` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PUT /v1/seller/stores/:id/shipping` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/notification-preferences` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PUT /v1/seller/stores/:id/notification-preferences` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/team` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/team/invites` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `DELETE /v1/seller/stores/:id/team/invites/:inviteId` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `PATCH /v1/seller/stores/:id/team/members/:userId` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `DELETE /v1/seller/stores/:id/team/members/:userId` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/team-invites/accept` | self | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/team-invites/decline` | self | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/stores/:id/eta-enrolment` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/eta-enrolment/request` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `POST /v1/seller/stores/:id/eta-enrolment/revoke` | resource | `apps/api/src/modules/seller-settings/test/seller-settings.http.test.ts` |
| `GET /v1/seller/payouts` | self | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/seller/payouts/:id` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/seller/stores/:id/statements` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/seller/stores/:storeId/balance` | resource | `apps/api/src/modules/payouts/test/balance.http.test.ts` |
| `GET /v1/admin/finance/payouts` | self | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/admin/finance/payouts/summary` | self | `apps/api/src/modules/payouts/test/payouts-summary.http.test.ts` |
| `GET /v1/admin/finance/payouts/:id` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `POST /v1/admin/finance/payouts/:id/approve` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `POST /v1/admin/finance/payouts/:id/hold` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `POST /v1/admin/finance/payouts/:id/cancel` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/admin/finance/reconciliation/summary` | self | `apps/api/src/modules/reconciliation/test/recon.http.test.ts` |
| `GET /v1/admin/finance/reconciliation/tickets` | self | `apps/api/src/modules/reconciliation/test/recon.http.test.ts` |
| `GET /v1/admin/finance/reconciliation/tickets/:id` | self | `apps/api/src/modules/reconciliation/test/recon.http.test.ts` |
| `GET /v1/admin/finance/reconciliation/runs` | self | `apps/api/src/modules/reconciliation/test/recon.http.test.ts` |
| `GET /v1/admin/finance/reconciliation/files` | self | `apps/api/src/modules/reconciliation/test/recon.http.test.ts` |

### Phase 2 modules (integration wave)

Subscriptions, gift cards, budget, stylist, recommendations, history, rewards, drops, waiting room, price crawler, hub consolidation, resale lane and ads. Negative authorization (non-owned object 404, missing role 403, wrong audience 401) is proven by each owning suite; the central matrix enforces the declared mode, the 401 without credentials (or a 4xx for public routes), the OpenAPI operation and this row.

| Operation | Authorization | Owning suite |
|---|---|---|
| `GET /v1/admin/resale/listings` | resource | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `GET /v1/admin/hub/consolidations` | resource | `apps/api/src/modules/hub-consolidation/hub.http.test.ts` |
| `GET /v1/seller/hub/consolidations` | resource | `apps/api/src/modules/hub-consolidation/hub.http.test.ts` |
| `GET /v1/seller/stylist/inclusion` | resource | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `GET /v1/seller/me` | resource | `apps/api/src/modules/seller-analytics/test/analytics.http.test.ts` |
| `GET /v1/seller/stores/:storeId/me` | resource | `apps/api/src/modules/seller-analytics/test/seller-me.http.test.ts` |
| `GET /v1/admin/ads/config` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `GET /v1/seller/ads/balance` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `GET /v1/seller/ads/campaigns` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `GET /v1/seller/ads/campaigns/:id` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `GET /v1/seller/ads/reports` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `PATCH /v1/seller/ads/campaigns/:id` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `POST /v1/ads/click` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `POST /v1/seller/ads/campaigns` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `POST /v1/seller/ads/campaigns/:id/pause` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `POST /v1/seller/ads/campaigns/:id/resume` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `POST /v1/seller/ads/topup` | self | `apps/api/src/modules/ads/ads.http.test.ts` |
| `PUT /v1/admin/ads/config` | resource | `apps/api/src/modules/ads/ads.http.test.ts` |
| `GET /v1/admin/ads/invalid-clicks` | resource | `apps/api/src/modules/ads/click-review.http.test.ts` |
| `POST /v1/admin/ads/invalid-clicks/:id/decision` | resource | `apps/api/src/modules/ads/click-review.http.test.ts` |
| `POST /v1/seller/applications/:id/domain-verification` | self | `apps/api/src/modules/brand-verification/brand-verification.http.test.ts` |
| `POST /v1/seller/applications/:id/domain-verification/confirm` | self | `apps/api/src/modules/brand-verification/brand-verification.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/trademark-lookup` | resource | `apps/api/src/modules/brand-verification/brand-verification.http.test.ts` |
| `POST /v1/admin/brand-applications/:id/conflict-resolution` | resource | `apps/api/src/modules/brand-verification/brand-verification.http.test.ts` |
| `GET /v1/admin/price-crawler/incidents` | resource | `apps/api/src/modules/price-crawler/incidents.http.test.ts` |
| `GET /v1/seller/crawl-incidents` | self | `apps/api/src/modules/price-crawler/incidents.http.test.ts` |
| `GET /v1/seller/parity-warnings` | self | `apps/api/src/modules/price-crawler/incidents.http.test.ts` |
| `DELETE /v1/me/budget` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `GET /v1/me/affordability` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `GET /v1/me/budget/summary` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `POST /v1/me/budget/cap-unlock` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `POST /v1/me/budget/plan` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `PUT /v1/me/budget` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `POST /v1/me/auto-buy` | self | `apps/api/src/modules/auto-buy/auto-buy.http.test.ts` |
| `GET /v1/me/auto-buy` | self | `apps/api/src/modules/auto-buy/auto-buy.http.test.ts` |
| `DELETE /v1/me/auto-buy/:id` | self | `apps/api/src/modules/auto-buy/auto-buy.http.test.ts` |
| `POST /v1/me/auto-buy/attempts/:id/cancel` | self | `apps/api/src/modules/auto-buy/auto-buy.http.test.ts` |
| `POST /v1/me/auto-buy/attempts/:id/sca-complete` | self | `apps/api/src/modules/auto-buy/auto-buy-sca-ops.http.test.ts` |
| `GET /v1/admin/auto-buy/manual-review` | self | `apps/api/src/modules/auto-buy/auto-buy-sca-ops.http.test.ts` |
| `POST /v1/admin/auto-buy/manual-review/:id/resolve` | self | `apps/api/src/modules/auto-buy/auto-buy-sca-ops.http.test.ts` |
| `GET /v1/admin/price-matching/config` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/channels` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/crawl-targets` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/forecasts` | resource | `apps/api/src/modules/forecasting/test/forecast.http.test.ts` |
| `GET /v1/seller/stores/:storeId/product-media` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/uploads` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `GET /v1/seller/stores/:storeId/product-media/:jobId` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/process` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/accept` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/use-original` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/rerun` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/refine` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `GET /v1/seller/stores/:storeId/product-media/:jobId/versions` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `POST /v1/seller/stores/:storeId/product-media/:jobId/versions/:version/restore` | resource | `apps/api/src/modules/product-media/test/product-media.http.test.ts` |
| `GET /v1/admin/ranking/shadow/summary` | resource | `apps/api/src/modules/ranking/test/ranking.http.test.ts` |
| `GET /v1/admin/ranking/evaluations` | resource | `apps/api/src/modules/ranking/test/ranking.http.test.ts` |
| `POST /v1/admin/ranking/evaluations` | resource | `apps/api/src/modules/ranking/test/ranking.http.test.ts` |
| `POST /v1/admin/ranking/guardrails/evaluate` | resource | `apps/api/src/modules/ranking/test/ranking.http.test.ts` |
| `GET /v1/seller/stores/:storeId/price-matches` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/odoo-channels` | resource | `apps/api/src/modules/channel-odoo/odoo.http.test.ts` |
| `POST /v1/seller/stores/:storeId/odoo-channels` | resource | `apps/api/src/modules/channel-odoo/odoo.http.test.ts` |
| `POST /v1/seller/stores/:storeId/odoo-channels/:channelId/test` | resource | `apps/api/src/modules/channel-odoo/odoo.http.test.ts` |
| `DELETE /v1/seller/stores/:storeId/odoo-channels/:channelId` | resource | `apps/api/src/modules/channel-odoo/odoo.http.test.ts` |
| `POST /v1/seller/stores/:storeId/channels` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/home/banners` | self | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `GET /v1/admin/home-banners` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `POST /v1/admin/home-banners` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `GET /v1/admin/home-banners/preview` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `GET /v1/admin/home-banners/:id` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `PATCH /v1/admin/home-banners/:id` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `DELETE /v1/admin/home-banners/:id` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `POST /v1/admin/home-banners/:id/schedule` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `POST /v1/admin/home-banners/:id/pause` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `POST /v1/admin/home-banners/:id/resume` | resource | `apps/api/src/modules/home-banners/test/home-banners.http.test.ts` |
| `POST /v1/seller/stores/:storeId/crawl-targets` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `POST /v1/seller/stores/:storeId/crawl-targets/:targetId/verify` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `DELETE /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/drops` | public | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/drops/:id` | public | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/seller/drops` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `PATCH /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/admin/drops/:id/pause` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/admin/drops/ops` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/drops/:id/waitlist` | self | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/seller/drops` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/seller/drops/:id/schedule` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/gift-pots/:id` | resource | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `GET /v1/me/gift-cards` | self | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `GET /v1/shared/gift-pots/:token` | public | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `POST /v1/gift-cards` | self | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `POST /v1/gift-cards/:id/void` | resource | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `POST /v1/gift-cards/redeem` | self | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `POST /v1/gift-pots` | self | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `POST /v1/gift-pots/:id/contribute` | self | `apps/api/src/modules/gift-cards/gift-cards.http.test.ts` |
| `DELETE /v1/me/history` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `GET /v1/me/history` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `GET /v1/me/recently-viewed` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `PATCH /v1/me/settings` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `POST /v1/me/history/pause` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `POST /v1/me/recently-viewed` | self | `apps/api/src/modules/recommendations/history-flows.http.test.ts` |
| `GET /v1/me/orders/:orderGroupId/tracking` | resource | `apps/api/src/modules/hub-consolidation/hub.http.test.ts` |
| `POST /v1/hub/consolidations/:id/dispatch` | resource | `apps/api/src/modules/hub-consolidation/hub.http.test.ts` |
| `POST /v1/hub/receipts` | resource | `apps/api/src/modules/hub-consolidation/hub.http.test.ts` |
| `GET /v1/feed` | self | `apps/api/src/modules/recommendations/recommendations.http.test.ts` |
| `GET /v1/me/recommendations/price-drops` | self | `apps/api/src/modules/recommendations/recommendations.http.test.ts` |
| `GET /v1/me/recommendations/restock` | self | `apps/api/src/modules/recommendations/recommendations.http.test.ts` |
| `GET /v1/products/:productId/similar` | public | `apps/api/src/modules/recommendations/recommendations.http.test.ts` |
| `POST /v1/recommendations/clicks` | self | `apps/api/src/modules/recommendations/recommendations.http.test.ts` |
| `GET /v1/me/auto-buy/terms` | self | `apps/api/src/modules/auto-buy/auto-buy.http.test.ts` |
| `POST /v1/search/visual/uploads` | self | `apps/api/src/modules/visual-search/visual-search.http.test.ts` |
| `POST /v1/search/visual` | self | `apps/api/src/modules/visual-search/visual-search.http.test.ts` |
| `GET /v1/products/:productId/visually-similar` | public | `apps/api/src/modules/visual-search/visual-search.http.test.ts` |
| `GET /v1/resale/listings` | self | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `GET /v1/resale/listings/:id` | self | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `GET /v1/seller/stores/:storeId/resale/listings` | resource | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `POST /v1/hub/resale/listings` | resource | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `POST /v1/seller/stores/:storeId/resale/listings/:id/withdraw` | resource | `apps/api/src/modules/resale-lane/resale.http.test.ts` |
| `DELETE /v1/admin/rewards/challenges/:id` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `GET /v1/admin/rewards/challenges` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `GET /v1/admin/rewards/config` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `GET /v1/games/:game/odds` | public | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `GET /v1/me/rewards` | self | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `POST /v1/admin/games/:game/odds` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `POST /v1/admin/rewards/challenges` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `POST /v1/games/:game/play` | self | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `POST /v1/me/coins/convert` | self | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `PUT /v1/admin/rewards/config` | resource | `apps/api/src/modules/rewards/rewards.http.test.ts` |
| `POST /v1/stylist/capsule` | self | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `POST /v1/stylist/complete-look` | self | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `POST /v1/stylist/feedback` | self | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `POST /v1/stylist/outfits` | self | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `POST /v1/stylist/outfits/:outfitId/add-to-bag` | resource | `apps/api/src/modules/stylist/stylist.http.test.ts` |
| `GET /v1/me/calendar/events` | self | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `POST /v1/me/calendar/events` | self | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `DELETE /v1/me/calendar/events` | self | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `GET /v1/me/calendar/events/:eventId` | resource | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `PATCH /v1/me/calendar/events/:eventId` | resource | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `DELETE /v1/me/calendar/events/:eventId` | resource | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `POST /v1/me/calendar/events/:eventId/outfits` | resource | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `POST /v1/me/calendar/events/:eventId/add-gap-to-bag` | resource | `apps/api/src/modules/outfit-calendar/calendar.http.test.ts` |
| `GET /v1/me/wardrobe/items` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `POST /v1/me/wardrobe/items` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `POST /v1/me/wardrobe/uploads` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `GET /v1/me/wardrobe/owned-slots` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `POST /v1/me/wardrobe/complete` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `DELETE /v1/me/wardrobe` | self | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `GET /v1/me/wardrobe/items/:itemId` | resource | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `PATCH /v1/me/wardrobe/items/:itemId` | resource | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `DELETE /v1/me/wardrobe/items/:itemId` | resource | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `GET /v1/me/wardrobe/items/:itemId/photo` | resource | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `POST /v1/me/wardrobe/items/:itemId/suggest-attributes` | resource | `apps/api/src/modules/wardrobe/wardrobe.http.test.ts` |
| `POST /v1/stylist/chat/sessions` | self | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `GET /v1/stylist/chat/sessions` | self | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `GET /v1/stylist/chat/sessions/:sessionId` | resource | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `POST /v1/stylist/chat/sessions/:sessionId/messages` | resource | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `DELETE /v1/stylist/chat/sessions/:sessionId` | resource | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `GET /v1/me/stylist-chat/settings` | self | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `PATCH /v1/me/stylist-chat/settings` | self | `apps/api/src/modules/stylist/stylist.chat.http.test.ts` |
| `POST /v1/admin/gift-cards/:id/void` | resource | `apps/api/src/modules/gift-cards/gift-cards.admin.http.test.ts` |
| `GET /v1/admin/gift-cards/pots` | resource | `apps/api/src/modules/gift-cards/gift-cards.admin.http.test.ts` |
| `GET /v1/admin/gift-cards/throttle-events` | resource | `apps/api/src/modules/gift-cards/gift-cards.admin.http.test.ts` |
| `GET /v1/admin/subscriptions/metrics` | resource | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `GET /v1/admin/calendar` | self | `apps/api/src/modules/promotions/test/calendar.test.ts` |
| `PUT /v1/admin/calendar` | self | `apps/api/src/modules/promotions/test/calendar.test.ts` |
| `GET /v1/admin/plus/plans` | resource | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `GET /v1/me/plus` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `GET /v1/plus/plans` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `PATCH /v1/admin/plus/plans/:planId` | resource | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/admin/plus/plans` | resource | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/cancel` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/pause` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/reactivate` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/refund` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/resume` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/subscribe` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/plus/switch-plan` | self | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `POST /v1/webhooks/:provider/recurring` | public | `apps/api/src/modules/subscriptions/subscriptions.http.test.ts` |
| `GET /v1/drops/:dropId/queue/status` | self | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/drops/:dropId/queue` | self | `apps/api/src/modules/drops/drops.http.test.ts` |

## Not yet implemented (in OpenAPI, no controller)

Two kinds. Gaps are listed in `apps/api/src/contract/openapi-drift/unserved-baseline.json` (the ratchet only lets this list shrink). Planned operations carry `x-status: planned` and an `x-spec-ref` in the OpenAPI (ADR-0050); most are the dashboard foundations contract (docs/specs/dashboard-foundations.md).

### Gaps (baselined)

| Operation |
|---|
| `DELETE /v1/seller/channels/:channelId` |
| `GET /v1/admin/feature-flags` |
| `GET /v1/products/:productId/price-history` |
| `GET /v1/seller/balance` |
| `GET /v1/seller/channels` |
| `GET /v1/seller/kyc` |
| `GET /v1/seller/price-claims` |
| `GET /v1/seller/store` |
| `PATCH /v1/me` |
| `PATCH /v1/seller/kyc` |
| `PATCH /v1/seller/store` |
| `POST /v1/admin/privacy/requests/:requestId/decision` |
| `POST /v1/me/age-attestation` |
| `POST /v1/onboarding/path` |
| `POST /v1/products/:productId/alerts` |
| `POST /v1/products/:productId/price-reports` |
| `POST /v1/seller/channels` |
| `POST /v1/seller/kyc/documents` |
| `POST /v1/seller/kyc/submit` |
| `POST /v1/seller/price-claims/:claimId/appeal` |
| `POST /v1/seller/price-evidence` |
| `PUT /v1/admin/kill-switches/:key` |
| `PUT /v1/seller/skus/:skuId/price` |

### Planned (x-status: planned)

| Operation |
|---|
| `GET /v1/admin/audit-log` |
| `GET /v1/admin/order-groups/:orderGroupId` |
| `GET /v1/admin/price-integrity/actions` |
| `GET /v1/admin/price-integrity/config` |
| `GET /v1/seller/analytics/summary` |
| `POST /v1/admin/disputes/:disputeId/resolve` |
| `POST /v1/admin/payouts/:payoutId/approval` |
| `POST /v1/admin/refunds/:refundId/approval` |
| `POST /v1/admin/sellers/:sellerId/suspend` |
| `PUT /v1/admin/price-integrity/config` |

Each of these must gain a matrix row in the same change that adds its controller; the suite fails otherwise.

## Phase 3 wave A: family and student plans (spec P3-03)

All routes are `buyer_api` shopper routes. Group routes take no user id: the caller's own group is resolved server side from the token subject, a seat id that is not in that group (another family, a member trying owner actions, a stranger) answers 404 exactly like a missing id, and the owner seat cannot be removed. The invite token authenticates nothing by itself: accept also needs the OTP verified phone that the invite was addressed to, and every mismatch answers 404. Negative cases live in `apps/api/src/modules/subscriptions/family/family.http.test.ts` and `family.application.test.ts`.

| Operation | Authorization | Covered |
| `POST /v1/plus/family` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `GET /v1/me/plus/family` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `POST /v1/plus/family/invites` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `DELETE /v1/plus/family/invites/:memberId` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `POST /v1/plus/family/invites/:token/accept` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `DELETE /v1/plus/family/members/:memberId` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `POST /v1/plus/family/leave` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `POST /v1/plus/student/verify` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `POST /v1/plus/student/verify/callback` | public | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |
| `GET /v1/me/plus/student` | self | `apps/api/src/modules/subscriptions/family/family.http.test.ts` |

`POST /v1/plus/student/verify/callback` is public by design: it is authenticated by the verifier adapter MAC and timestamp window over the raw body, and the production default verifier rejects everything (fail closed until VR-P3-09).

## Phase 3 wave B: creators and affiliates (spec P3-04, ADR-0037)

Creator routes are `buyer_api` shopper routes keyed by the token subject: there is no creator id in any creator URL, a link or look id owned by another creator is a 404 identical to a missing id (store queries are scoped by the caller's creator account). Admin routes are `admin_api`: review actions need an admin console role, payout money routes additionally need the live finance role, and the payout kill switch `kill.creator_payouts` (default blocked) answers 503 before any state change. The two public routes carry no PII: `GET /v1/c/:handle` serves only ACTIVE creators and `POST /v1/affiliate/clicks` always answers 202.

| Operation | Authorization | Covered |
|---|---|---|
| `POST /v1/creator/apply` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/creator/dashboard` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/creator/links` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/creator/links` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `DELETE /v1/creator/links/:linkId` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/creator/looks` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/creator/looks` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `PATCH /v1/creator/looks/:lookId` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/creator/looks/:lookId/publish` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `DELETE /v1/creator/looks/:lookId` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/creator/commissions` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/creator/payouts` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/creator/payout-preference` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/c/:handle` | public | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/affiliate/clicks` | public | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/affiliate/install-tokens` | self | `apps/api/src/modules/creators/test/click-auth.http.test.ts` |
| `GET /v1/admin/creators` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creators/:id/decision` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creators/attributions/:id/void` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-looks/:id/takedown` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `GET /v1/admin/creator-payouts` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-payouts` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-payouts/:id/approve` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-payouts/:id/send` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-payouts/:id/outcome` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |
| `POST /v1/admin/creator-payouts/:id/cancel` | self | `apps/api/src/modules/creators/test/creators.http.test.ts` |

### Phase 3 follow-up: auto-buy SCA completion, MANUAL_REVIEW ops queue, signed install tokens

- `POST /v1/me/auto-buy/attempts/:id/sca-complete` is `buyer_api`, owner-scoped by `(id, caller)` (another shopper's attempt is 404), needs an `Idempotency-Key`, and treats the call as a prompt to look the outcome up at the PSP by idempotency key, never as evidence.
- `GET /v1/admin/auto-buy/manual-review` and `POST /v1/admin/auto-buy/manual-review/:id/resolve` are `admin_api`: the policy `admin_console` decision (passkey, admin audience) is recorded first, then a live `ops`, `finance` or `super_admin` grant is required (support, marketing and the other console roles are 403). Every call appends to the hash-chained admin audit log BEFORE acting and a failed append is a 503 with no state change. There is no dual-approval record in this module: a resolution moves no money (it records what the PSP shows) and is refused when the PSP lookup contradicts it.
- `POST /v1/affiliate/install-tokens` is `buyer_api` self (rate limit 20 per hour per user) and mints a 15 minute HMAC token bound to one hashed device id. `POST /v1/affiliate/clicks` stays public and always 202, but only a click carrying a valid `X-Install-Token` for the same device id hashes into the domain a buyer's device can match; every other click is stored and counted and can never attribute.

## Phase 3 wave C: anonymous catalog reads for the shopper web (spec P3-06)

The only routes where an anonymous caller may read catalog data. They live under `/v1/public/*`, are declared `@Public()` per route, return a strictly allow-listed projection (allow-list snapshot tests in each owning suite), and answer 503 `public_catalog_disabled` while `kill.public_catalog` is blocked (default). The matching authenticated routes (`GET /v1/stores`, `/v1/stores/:storeId`, `/v1/products/:productId`, `/v1/search`) are unchanged and keep `shopperBearer`. Threat model: `docs/security/threat-models/public-catalog.md`.

| Operation | Authorization | Covered by |
|---|---|---|
| `GET /v1/public/stores` | public | `apps/api/src/modules/stores/stores.public.http.test.ts` |
| `GET /v1/public/stores/:storeId` | public | `apps/api/src/modules/stores/stores.public.http.test.ts` |
| `GET /v1/public/sitemap/stores/:page` | public | `apps/api/src/modules/stores/stores.public.http.test.ts` |
| `GET /v1/public/products/:productId` | public | `apps/api/src/modules/catalog/test/catalog.public.http.test.ts` |
| `GET /v1/public/sitemap/products/:page` | public | `apps/api/src/modules/catalog/test/catalog.public.http.test.ts` |
| `GET /v1/public/categories` | public | `apps/api/src/modules/catalog/test/catalog.public.http.test.ts` |
| `GET /v1/public/search` | public | `apps/api/src/modules/search/test/search.public.http.test.ts` |

Negative authorization for these rows (the "cannot reach non-public data" analogue of seller A to seller B): vacation, suspended, draft, KYC-suspended and identity-less stores, and every product of such a store, answer a 404 body identical to a missing id (no enumeration by status); draft and paused products are 404; only a delisted product of a public store is 410; personal facets (`my_size_only`, `fits_remaining_budget`, `budget_max`, `monthly_max`, `cod_available`, `payable_with_store_credit`, `installments_available`, `free_delivery_eligible`) and `world=my_stores` are 400; a bearer token or cookie changes nothing.
