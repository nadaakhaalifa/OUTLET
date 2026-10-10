# Authorization matrix

Status: generated from the Nest router and `docs/api/openapi.yaml` on 2026-10-10. The machine check is `apps/api/test/authz-matrix.test.ts` (run through `apps/api/src/authz-matrix.test.ts`); it fails when a registered route has no matrix row, when a row has no route, when a route has no `@Public`/`@AuthenticatedSelf`/`@Authorize` declaration, or when this document omits an implemented route.

Master prompt A2.10: every endpoint has an integration test including a negative authorization test.

## Numbers

- OpenAPI operations: 159
- Implemented in `apps/api`: 16 product operations + 2 operational probes (`/v1/health`, `/v1/ready`, not in the contract) = 18 registered routes
- Not yet implemented: 143
- Covered by the matrix: 18 of 18 registered routes

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
| `GET /v1/stores` |
| `GET /v1/stores/:storeId` |
| `PUT /v1/me/favorite-stores` |
| `GET /v1/me/favorite-stores` |
| `GET /v1/me/favorite-stores/new-counts` |
| `POST /v1/me/favorite-stores/:storeId/seen` |
| `GET /v1/search` |
| `GET /v1/search/suggestions` |
| `POST /v1/search/parse` |
| `GET /v1/me/saved-searches` |
| `POST /v1/me/saved-searches` |
| `GET /v1/me/saved-searches/:savedSearchId` |
| `PATCH /v1/me/saved-searches/:savedSearchId` |
| `DELETE /v1/me/saved-searches/:savedSearchId` |
| `GET /v1/products/:productId` |
| `GET /v1/products/:productId/price-history` |
| `GET /v1/products/:productId/price-evidence` |
| `GET /v1/products/:productId/fit` |
| `POST /v1/products/:productId/alerts` |
| `POST /v1/products/:productId/price-reports` |
| `GET /v1/me/size-profiles` |
| `POST /v1/me/size-profiles` |
| `GET /v1/me/size-profiles/:profileId` |
| `PATCH /v1/me/size-profiles/:profileId` |
| `DELETE /v1/me/size-profiles/:profileId` |
| `GET /v1/fit/recommend` |
| `POST /v1/orders/lines/:orderLineId/fit-feedback` |
| `GET /v1/cart` |
| `POST /v1/cart/lines` |
| `PATCH /v1/cart/lines/:lineId` |
| `DELETE /v1/cart/lines/:lineId` |
| `GET /v1/cart/free-delivery-suggestions` |
| `POST /v1/checkout/quote` |
| `POST /v1/checkout` |
| `GET /v1/order-groups/:orderGroupId` |
| `GET /v1/me/orders` |
| `POST /v1/seller-orders/:sellerOrderId/cancel` |
| `POST /v1/webhooks/:provider` |
| `POST /v1/webhooks/couriers/:courier` |
| `GET /v1/me/wishlists` |
| `POST /v1/me/wishlists` |
| `GET /v1/me/wishlists/:wishlistId` |
| `PATCH /v1/me/wishlists/:wishlistId` |
| `DELETE /v1/me/wishlists/:wishlistId` |
| `POST /v1/wishlists/:wishlistId/items` |
| `DELETE /v1/wishlists/:wishlistId/items/:itemId` |
| `POST /v1/me/wishlists/:wishlistId/share` |
| `DELETE /v1/me/wishlists/:wishlistId/share` |
| `GET /v1/shared/wishlists/:token` |
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
| `GET /v1/seller/products` |
| `POST /v1/seller/products` |
| `GET /v1/seller/products/:productId` |
| `PATCH /v1/seller/products/:productId` |
| `PUT /v1/seller/skus/:skuId/price` |
| `PUT /v1/seller/skus/:skuId/stock` |
| `GET /v1/seller/size-charts` |
| `POST /v1/seller/size-charts` |
| `POST /v1/seller/catalog/imports` |
| `GET /v1/seller/catalog/imports/:importId` |
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
| `GET /v1/me/notification-preferences` |
| `PATCH /v1/me/notification-preferences` |
| `PUT /v1/me/devices/push-token` |
| `GET /v1/me/notifications` |
| `POST /v1/me/notifications/read` |

Each of these must gain a matrix row in the same change that adds its controller; the suite fails otherwise.
