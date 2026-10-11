# Authorization matrix

Status: generated from the Nest router and `docs/api/openapi.yaml` on 2026-10-11 (Phase 2 integration: subscriptions, gift cards, budget, stylist, recommendations, history, rewards, drops, waiting room, price crawler, hub, resale, ads). The machine check is `apps/api/test/authz-matrix.test.ts` (run through `apps/api/src/authz-matrix.test.ts`); it fails when a registered route has no matrix row, when a row has no route, when a route has no `@Public`/`@AuthenticatedSelf`/`@Authorize` declaration, or when this document omits an implemented route.

Master prompt A2.10: every endpoint has an integration test including a negative authorization test.

## Numbers

- OpenAPI operations: 337
- Implemented in `apps/api`: 289 product operations + 2 operational probes (`/v1/health`, `/v1/ready`, not in the contract) = 291 registered routes
- Not yet implemented: 48
- Covered by the matrix: 291 of 291 registered routes (63 with full shared-harness cases, 228 delegated to per-module suites plus central 401/authz-mode/OpenAPI checks, including the 92 Phase 2 routes)

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
| `POST /v1/auth/otp/verify` | public | - | yes |
| `POST /v1/auth/passkey/assert` | public | - | yes |
| `POST /v1/auth/passkey/assert/options` | public | - | yes |
| `POST /v1/auth/passkey/register` | self | - | yes |
| `POST /v1/auth/passkey/register/options` | self | - | yes |
| `POST /v1/auth/refresh` | public | - | yes |
| `GET /v1/me/privacy/consents` | self | - | yes |
| `PATCH /v1/me/privacy/consents` | self | - | yes |
| `GET /v1/me/sessions` | self | - | yes |
| `DELETE /v1/me/sessions/:sessionId` | resource: session delete | yes (404 for foreign) | yes |
| `GET /v1/me/sessions/:sessionId` | resource: session read | yes (404 for foreign) | yes |
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
| `GET /v1/me/wallet` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/me/wallet/transactions` | self | `apps/api/src/modules/refunds/test/http.test.ts` |
| `GET /v1/seller/payouts` | self | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/seller/payouts/:id` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/seller/stores/:id/statements` | resource | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
| `GET /v1/admin/finance/payouts` | self | `apps/api/src/modules/payouts/test/payouts.http.test.ts` |
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
| `DELETE /v1/me/budget` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `GET /v1/me/affordability` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `GET /v1/me/budget/summary` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `POST /v1/me/budget/cap-unlock` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `POST /v1/me/budget/plan` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `PUT /v1/me/budget` | self | `apps/api/src/modules/budget/budget.http.test.ts` |
| `GET /v1/admin/price-matching/config` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/channels` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/crawl-targets` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `GET /v1/seller/stores/:storeId/price-matches` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `POST /v1/seller/stores/:storeId/channels` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `POST /v1/seller/stores/:storeId/crawl-targets` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `POST /v1/seller/stores/:storeId/crawl-targets/:targetId/verify` | resource | `apps/api/src/modules/price-crawler/crawler.http.test.ts` |
| `DELETE /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/drops` | public | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/drops/:id` | public | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/seller/drops` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `GET /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `PATCH /v1/seller/drops/:id` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
| `POST /v1/admin/drops/:id/pause` | resource | `apps/api/src/modules/drops/drops.http.test.ts` |
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

| Operation |
|---|
| `DELETE /v1/me/addresses/:addressId` |
| `DELETE /v1/seller/channels/:channelId` |
| `DELETE /v1/seller/team/:memberId` |
| `GET /v1/admin/audit-log` |
| `GET /v1/admin/feature-flags` |
| `GET /v1/admin/order-groups/:orderGroupId` |
| `GET /v1/admin/price-integrity/actions` |
| `GET /v1/admin/price-integrity/config` |
| `GET /v1/admin/reconciliation/breaks` |
| `GET /v1/admin/sellers` |
| `GET /v1/admin/sellers/:storeId/kyc` |
| `GET /v1/admin/tax/invoices` |
| `GET /v1/me` |
| `GET /v1/me/addresses` |
| `GET /v1/me/addresses/:addressId` |
| `GET /v1/me/orders` |
| `GET /v1/products/:productId/price-history` |
| `GET /v1/seller/analytics/summary` |
| `GET /v1/seller/balance` |
| `GET /v1/seller/channels` |
| `GET /v1/seller/kyc` |
| `GET /v1/seller/price-claims` |
| `GET /v1/seller/statements` |
| `GET /v1/seller/store` |
| `GET /v1/seller/team` |
| `PATCH /v1/me` |
| `PATCH /v1/me/addresses/:addressId` |
| `PATCH /v1/seller/kyc` |
| `PATCH /v1/seller/store` |
| `POST /v1/admin/disputes/:disputeId/resolve` |
| `POST /v1/admin/payouts/:payoutId/approval` |
| `POST /v1/admin/privacy/requests/:requestId/decision` |
| `POST /v1/admin/refunds/:refundId/approval` |
| `POST /v1/admin/sellers/:storeId/kyc-decision` |
| `POST /v1/admin/sellers/:storeId/suspend` |
| `POST /v1/me/addresses` |
| `POST /v1/me/age-attestation` |
| `POST /v1/products/:productId/alerts` |
| `POST /v1/products/:productId/price-reports` |
| `POST /v1/seller/channels` |
| `POST /v1/seller/kyc/documents` |
| `POST /v1/seller/kyc/submit` |
| `POST /v1/seller/price-claims/:claimId/appeal` |
| `POST /v1/seller/price-evidence` |
| `POST /v1/seller/team` |
| `PUT /v1/admin/kill-switches/:key` |
| `PUT /v1/admin/price-integrity/config` |
| `PUT /v1/seller/skus/:skuId/price` |


Each of these must gain a matrix row in the same change that adds its controller; the suite fails otherwise.
