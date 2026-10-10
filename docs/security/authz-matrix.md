# Authorization matrix

Status: generated from the Nest router and `docs/api/openapi.yaml` on 2026-10-10. The machine check is `apps/api/test/authz-matrix.test.ts` (run through `apps/api/src/authz-matrix.test.ts`); it fails when a registered route has no matrix row, when a row has no route, when a route has no `@Public`/`@AuthenticatedSelf`/`@Authorize` declaration, or when this document omits an implemented route.

Master prompt A2.10: every endpoint has an integration test including a negative authorization test.

## Numbers

- OpenAPI operations: 160
- Implemented in `apps/api`: 61 product operations + 2 operational probes (`/v1/health`, `/v1/ready`, not in the contract) = 63 registered routes
- Not yet implemented: 99
- Covered by the matrix: 63 of 63 registered routes

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

## Not yet implemented (in OpenAPI, no controller)

| Operation |
|---|
| `GET /v1/me` |
| `PATCH /v1/me` |
| `POST /v1/me/age-attestation` |
| `POST /v1/me/privacy/delete` |
| `DELETE /v1/me/privacy/delete` |
| `POST /v1/me/privacy/export` |
| `GET /v1/me/privacy/export/:exportId` |
| `GET /v1/me/addresses` |
| `POST /v1/me/addresses` |
| `GET /v1/me/addresses/:addressId` |
| `PATCH /v1/me/addresses/:addressId` |
| `DELETE /v1/me/addresses/:addressId` |
| `GET /v1/search` |
| `GET /v1/search/suggestions` |
| `POST /v1/search/parse` |
| `GET /v1/me/saved-searches` |
| `POST /v1/me/saved-searches` |
| `GET /v1/me/saved-searches/:savedSearchId` |
| `PATCH /v1/me/saved-searches/:savedSearchId` |
| `DELETE /v1/me/saved-searches/:savedSearchId` |
| `GET /v1/products/:productId/price-history` |
| `GET /v1/products/:productId/price-evidence` |
| `POST /v1/products/:productId/alerts` |
| `POST /v1/products/:productId/price-reports` |
| `POST /v1/checkout/quote` |
| `POST /v1/checkout` |
| `GET /v1/order-groups/:orderGroupId` |
| `GET /v1/me/orders` |
| `POST /v1/seller-orders/:sellerOrderId/cancel` |
| `POST /v1/webhooks/:provider` |
| `POST /v1/webhooks/couriers/:courier` |
| `GET /v1/me/wallet` |
| `GET /v1/me/wallet/transactions` |
| `GET /v1/me/referral` |
| `POST /v1/referrals/attribute` |
| `POST /v1/promotions/evaluate` |
| `GET /v1/admin/promotions` |
| `POST /v1/admin/promotions` |
| `GET /v1/admin/promotions/:promotionId` |
| `PATCH /v1/admin/promotions/:promotionId` |
| `DELETE /v1/admin/promotions/:promotionId` |
| `GET /v1/seller/promotions` |
| `POST /v1/seller/promotions` |
| `GET /v1/seller/promotions/:promotionId` |
| `PATCH /v1/seller/promotions/:promotionId` |
| `DELETE /v1/seller/promotions/:promotionId` |
| `GET /v1/seller/kyc` |
| `PATCH /v1/seller/kyc` |
| `POST /v1/seller/kyc/documents` |
| `POST /v1/seller/kyc/submit` |
| `GET /v1/seller/store` |
| `PATCH /v1/seller/store` |
| `GET /v1/seller/team` |
| `POST /v1/seller/team` |
| `DELETE /v1/seller/team/:memberId` |
| `PUT /v1/seller/skus/:skuId/price` |
| `GET /v1/seller/orders` |
| `GET /v1/seller/orders/:sellerOrderId` |
| `POST /v1/seller/orders/:sellerOrderId/accept` |
| `POST /v1/seller/orders/:sellerOrderId/reject` |
| `POST /v1/seller/orders/:sellerOrderId/pack` |
| `POST /v1/seller/shipments` |
| `GET /v1/seller/shipments/:shipmentId` |
| `GET /v1/seller/shipments/:shipmentId/label` |
| `GET /v1/seller/returns` |
| `POST /v1/seller/returns/:returnId/inspect` |
| `POST /v1/seller/channels` |
| `GET /v1/seller/channels` |
| `DELETE /v1/seller/channels/:channelId` |
| `POST /v1/seller/price-evidence` |
| `GET /v1/seller/price-claims` |
| `POST /v1/seller/price-claims/:claimId/appeal` |
| `GET /v1/seller/price-trust` |
| `GET /v1/seller/balance` |
| `GET /v1/seller/payouts` |
| `GET /v1/seller/statements` |
| `GET /v1/seller/analytics/summary` |
| `POST /v1/orders/lines/:orderLineId/returns` |
| `GET /v1/me/returns` |
| `GET /v1/me/returns/:returnId` |
| `POST /v1/returns/:returnId/dispute` |
| `GET /v1/admin/sellers` |
| `GET /v1/admin/sellers/:storeId/kyc` |
| `POST /v1/admin/sellers/:storeId/kyc-decision` |
| `POST /v1/admin/sellers/:storeId/suspend` |
| `GET /v1/admin/order-groups/:orderGroupId` |
| `POST /v1/admin/disputes/:disputeId/resolve` |
| `POST /v1/admin/refunds/:refundId/approval` |
| `POST /v1/admin/payouts/:payoutId/approval` |
| `GET /v1/admin/audit-log` |
| `GET /v1/admin/feature-flags` |
| `PUT /v1/admin/kill-switches/:key` |
| `GET /v1/admin/reconciliation/breaks` |
| `GET /v1/admin/price-integrity/actions` |
| `GET /v1/admin/price-integrity/config` |
| `PUT /v1/admin/price-integrity/config` |
| `GET /v1/admin/privacy/requests` |
| `POST /v1/admin/privacy/requests/:requestId/decision` |
| `GET /v1/admin/tax/invoices` |

Each of these must gain a matrix row in the same change that adds its controller; the suite fails otherwise.
