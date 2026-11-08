# Outlex API: Phase 1 OpenAPI skeleton

Status: **draft for owner review, 2026-11-07.** Code name Outlet NK. Documents only: no server implements this yet. Not legal advice; ⚠ items map to `docs/compliance/verify-register.md`.

- Contract: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).
- Scope: the Phase 1 **web MVP** (BUILD-PROMPT §10). Mobile-only endpoints (App Attest, push tokens) are Phase 2.
- Names: tables and columns from `docs/data-model.md` (the ERD wins over older spec names).
- Later, the OpenAPI generated from the NestJS code replaces this file (ADR-0001). The route-inventory test API-T09 then checks that every running route is here, with a policy guard, an idempotency guard (if mutating) and pagination (if a list).

**Size:** 209 operations on 186 paths. 104 mutating, 98 of them take `Idempotency-Key`. 66 list routes, all keyset-paginated.

## 1. Conventions (short)

| Topic | Rule |
|---|---|
| Base path | `/v1/{market}/…`. `market` is the lower-case `markets.id` (`eg` → `EG`). Only `GET /v1/markets` is global. Old versions get `Deprecation` and `Sunset` headers ≥ 6 months ahead. |
| Language | `Accept-Language: ar-EG` (default) or `en-EG`. Arabic fields (`*_ar`) are always filled; English (`*_en`) is optional. Error texts are i18n keys. |
| Money | Always `{"amount_minor": "129900", "currency": "EGP"}`. `amount_minor` is a 64-bit integer **as a string** (JSON numbers lose precision). Never floats. An ERD pair `total_minor` + `currency` appears in the API as `total: Money`. Rates are basis points (`*_bp`, 1400 = 14%). Weights are integer grams, sizes integer millimetres. |
| "% off" | `PriceDisplay.reference_price`, `display_discount_bp` and `member_discount_bp` exist **only** when the price is VRP-verified by Price Watch, the evidence is fresh (72 h, fail closed) and the store display mode allows it. Otherwise the fields are **absent** (not `null`, not `0`). The schema enforces this with `if/then`, and every such field carries `x-vrp-verified-only: true`. A seller's "was" price is never shown. Discover-deals bands and "biggest discount" sorting use only verified values. |
| Auth | See §2. Bearer tokens only. On the web, the Next.js BFF keeps tokens in `HttpOnly; Secure; SameSite` cookies with CSRF protection and calls the API with `Authorization: Bearer`. The API re-checks every request (never trusts Next.js middleware, CVE-2025-29927). |
| Authorization | Deny by default. Every operation has `x-authz` (policy rule, principal, tenant, roles, negative tests). Object not found **or** not owned → **404**. Valid principal but wrong role, wrong principal type, missing passkey or step-up → **403**. Tenant comes from the token (`user_id`) or `X-Store-Id` (`store_id`) and is set with `SET LOCAL` per transaction (RLS, PgBouncer-safe). Ids sent in the **body** (address, media, location, SKU…) are ownership-checked too (`x-authz.body_refs_owned`). |
| Idempotency | Every mutating route takes `Idempotency-Key` (client UUIDv7), stored 24 h. Same key + other body → 422; same key in flight → 409; replay → stored response. Exceptions: provider **webhooks** (dedup by provider event id) and **pure** POSTs (`/checkout/quote`, `/shipping/quote`, `/search/parse`: no side effects). Token-issuing auth routes use mode `no_response_store`: the key blocks duplicates but tokens are never stored; a replay returns 409 `idempotency-key-consumed`. |
| Pagination | Keyset only: `cursor` (opaque) + `limit` (1–50, default 20). Response `{items, next_cursor}`; `next_cursor = null` on the last page. No OFFSET. |
| Errors | `application/problem+json` (RFC 9457) with `type`, `title`, `status`, `code`, `request_id`, optional `errors[]`. No stack traces. 400 bad input or unknown field (strict DTOs) · 401 no/invalid token, other market, bad webhook signature · 403 role/principal/passkey/age gate · 404 missing or not owned · 409 state conflict, price changed, stock shortfall · 410 sold one-off product page · 412/428 `If-Match` · 422 business rule · 429 with `Retry-After`. |
| Concurrency | Versioned resources (listings, store settings, storefront, KYC) return `ETag`; writes need `If-Match`. |
| Caching | Each cacheable 2xx documents its exact `Cache-Control` header. Price and stock are **never** served stale: `GET …/products/{id}/offer` has `max-age ≤ 5`. Personal routes are `private, no-store`. |
| Rate limits | `x-rate-limit` lists each limit with `source`: `build-prompt` (BUILD-PROMPT §4 table), `spec` (a named spec) or `default` (chosen here, tune by measurement). Keys prefer user, device, phone hash and store; IP only at the edge with CGNAT-aware thresholds. Every limit answers 429 + `Retry-After`. |
| Events | `x-outbox-events` names the domain events (from `docs/analytics/events.md` §6) written in the same transaction. |
| Kill switches | `x-kill-switch` names the switch that disables the route (payment methods, COD, store credit, payouts, LLM features, search engine). |
| Bot defence | `X-Turnstile-Token` on age gate, OTP request, checkout and price reports (web replacement for App Attest, ADR-0007). `X-Admission-Token` (Waiting Room) on live drops. |

### Default rate limits (source `default`)

| Surface | Read | Write |
|---|---|---|
| Public | 600/min per IP-with-NAT at the edge + 120/min per device | n/a |
| Shopper | 120/min per user | 30/min per user (bag: 60/min) |
| Seller (per store) | 300/min | 120/min |
| Admin (per staff) | 120/min | 30/min |

## 2. Security schemes

| Scheme | Who | Notes |
|---|---|---|
| `shopperJwt` | Shoppers | Access JWT 10 min, audience `outlet:{market}`, `amr` claim. Refresh: opaque, device-bound, rotated every use, reuse revokes the family. |
| `sellerJwt` | Seller staff | Same token family (users are shared, DM-09) **plus** passkey in `amr`, an active `store_members` row for `X-Store-Id`, and a role from `x-authz.roles` (owner, manager, catalog, warehouse, finance, support). |
| `adminPasskeySession` | Staff | Separate principal (`staff_accounts`), after SSO + device posture + passkey; IP allow-list for Finance and Super-admin. Dual approval for money and role grants. |
| `webhookHmac` | PSP, courier, Shopify/Woo | HMAC over the raw body, timestamp ±5 min, provider IP allow-list at the edge, dedup by provider event id. |
| none | Public | Catalog, village, passport, price proof, auth start. |

## 3. Decisions I defaulted

Each compares at least two options. None is irreversible; each can change before code exists.

| ID | Decision | Options compared | Why (2–3 lines) |
|---|---|---|---|
| API-01 | Market as a **path segment** `/v1/{market}/…` | (a) `X-Market` header (b) path segment | Cloudflare does not vary its cache on custom headers, so a header would mix markets in cached public responses. A path segment routes to the right data cell at the edge with one rule and matches the web URLs (`/eg-ar/`, ADR-0006 #12). Tokens are market-bound (accounts are per cell, DM-02). |
| API-02 | **One user token family** for shoppers and seller staff; seller routes add passkey + `X-Store-Id`; admins have their own session | (a) separate seller login (b) shared token + store scope | Matches DM-09 (one identity, brand owners also shop). Store scope in a header keeps the Price Watch spec paths (`/v1/seller/channels`) and the store switcher simple. |
| API-03 | **Bearer only** at the API; cookies and CSRF live in the Next.js BFF | (a) API accepts cookies (b) BFF converts cookie → bearer | One auth path in the API, no CSRF surface there, and tokens never reach page JavaScript (ADR-0007). |
| API-04 | A valid token of the **wrong principal type** gets **403**, not 401 | (a) 401 audience error (b) 403 | Gives every authenticated route a clean "wrong role → 403" test (BUILD-PROMPT §2) and matches master prompt A2.10 ("shopper → admin route = 403"). 401 stays for missing, invalid, expired or other-market tokens. |
| API-05 | Checkout quote is **pure** with a signed `quote_token` (10 min); `POST /checkout` writes `checkout_sessions`, `shipment_quotes`, reserves and creates the intent | (a) persist a session at quote time (b) pure quote + token | Spec says quote has no side effects; a token gives the 10-min price lock without holding stock. If the price moved, checkout returns 409 `price-changed` with a fresh quote. |
| API-06 | **Age gate before account creation** (`POST /auth/age-gate` → short-lived `age_gate_token`) | (a) DOB after sign-up (b) DOB first | Master prompt §1 acceptance: an under-18 DOB must store no PII beyond the device hash, so the check must come before the phone or federated identity is stored. |
| API-07 | "Member" for `member_only` display mode = **signed-in shopper of the market** in Phase 1 | (a) Plus members only (b) signed-in | Plus is Phase 2 (ADR-0004), so (a) would hide member discounts from everyone. Reversible config; **owner D3 may change it.** Verified-only rule applies either way. |
| API-08 | **Spec route names adapted to ERD names** (see §4) | (a) keep spec paths (b) ERD names | The ERD is authoritative for names; keeping two vocabularies would leak into the generated client. |
| API-09 | Anonymous consent lives in a **first-party cookie at the BFF** and syncs to `consent_records` at sign-in | (a) anonymous consent API by device (b) cookie + sync | No personal-data write before an account exists; analytics SDKs still wait for consent (PRIV-T04). |
| API-10 | Return requests are **per seller order** with lines | (a) per order line (master prompt §22) (b) per seller order | The ERD has `return_requests` per seller order with `return_lines`; one pickup and one inspection per store parcel. |
| API-11 | Phase 1 rejects international shipping with 422 `international-not-enabled` but the fields exist | (a) omit fields (b) fields + kill switch | Global-ready (ADR-0006) without enabling DAP before Phase 2 (shipping spec §10). |
| API-12 | Payout items are a **separate paginated route** | (a) embed in payout (b) sub-route | Every list must be paginated; a large payout can net hundreds of items. |
| API-13 | Default rate limits where BUILD-PROMPT §4 is silent (table in §1) | (a) none (b) conservative defaults | Every route needs a limit (API4). Defaults are marked `source: default` and are tuned with k6. |

## 4. Conflicts and gaps found (for review)

| # | Where | What | What I did |
|---|---|---|---|
| C1 | `docs/specs/price-watch.md` §7 vs ERD | Spec route `POST /v1/seller/listings/{id}/price-check`; the ERD entity is `products` | Used `/seller/products/{product_id}/price-check`. Spec should be updated. |
| C2 | Master prompt §22 vs ERD | `POST /v1/orders/lines/{id}/returns` vs `return_requests` per seller order | Used `/seller-orders/{seller_order_id}/returns` with lines (API-10). |
| C3 | `docs/analytics/events.md` §2 vs ERD DM-01 | Events use `market_id` `eg` (lower case); ERD uses `EG` | API path uses lower case and maps to upper case. events.md should say `EG`. |
| C4 | Ledger chart §6 vs events.md §6 | `ledger.entry_posted` vs `journal_entry.posted` | Not referenced by any route here (no HTTP write to the ledger). Resolved: `journal_entry.posted` (events.md name) is used in both files. |
| C5 | ADR-0009 vs ERD | ADR uses `defect_passports.public_code`, status `active/sold/withdrawn`; ERD has `item_units.passport_code` and status `IN_STOCK…DONATED` | Used ERD names (ADR-0009 itself says ERD names win). |
| C6 | ERD `products` | No `version` column, but wizard writes need optimistic locking | ETag is derived from `updated_at`; consider adding `version` to `products`. |
| C7 | Master prompt §7 vs BUILD-PROMPT | App Attest on checkout/OTP | Replaced by Turnstile on the web (ADR-0007). App Attest returns with apps in Phase 2. |
| C8 | ADR-0008 / D1 | Plan fees and commission have no numbers | `SellerPlan.monthly_fee` and `commission_bp` are nullable and stay null until D1. |
| C9 | Shipping spec §8 | `GET /v1/shipping/countries` | Left out: Phase 1 is Egypt only. Add with international export (Phase 2). |

## 5. Route count by area

| Area | Operations |
|---|---|
| Markets and config | 4 |
| Auth and sessions | 15 |
| Me, privacy, wallet | 23 |
| Village, stores, deals, drops | 11 |
| Catalog, passport, price proof | 7 |
| Search | 3 |
| Cart | 6 |
| Checkout and orders | 8 |
| Returns and refunds (shopper) | 8 |
| Media uploads | 2 |
| Webhooks | 3 |
| Seller Center | 80 |
| Admin Console | 39 |
| **Total** | **209** |

By security: seller JWT + X-Store-Id 76, shopper JWT 54, admin passkey session 37, public 27, public (+ optional shopper) 6, seller JWT (passkey) 4, webhook HMAC 3, shopper or seller JWT 2.

### Phase 1 items not in this skeleton (next pass)
Wishlists and shared family wishlists (feature 10), reviews and fit-photo reviews (11), see-it-first requests (19), WhatsApp pay links (44), size profiles and My Size feed (4), saved searches, notification preferences and in-app inbox, promotions/vouchers/bundles admin and seller CRUD (6), drop builder and waiting-room admin, seller analytics, admin catalog moderation, payouts approval UI beyond the generic approval queue. The ERD already models them; the routes follow the same conventions.

## 6. Route table: authorization and required negative tests

Every row becomes an automatic test (POL-T01/POL-T02, API-T01). "Other tenant" = the caller tries another user's or store's object; "wrong role" = a valid principal without the right role. `n/a` = no tenant object or no role on that route (the test then checks the route's own gate).

| # | Method | Path (under `/v1`) | operationId | Auth | Policy · roles | Other tenant → 404 | Wrong role → 403 |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/markets` | `listMarkets` | public | `market.list` | n/a | n/a |
| 2 | GET | `/{market}/config` | `getMarketConfig` | public | `market.config.read` | n/a | n/a |
| 3 | GET | `/{market}/geo-areas` | `listGeoAreas` | public | `geo.list` | n/a | n/a |
| 4 | GET | `/{market}/calendar-events` | `listCalendarEvents` | public | `calendar.list` | n/a | n/a |
| 5 | POST | `/{market}/auth/age-gate` | `submitAgeGate` | public | `auth.age_gate` | n/a | n/a |
| 6 | POST | `/{market}/auth/otp/request` | `requestOtp` | public | `auth.otp.request` | n/a | n/a |
| 7 | POST | `/{market}/auth/otp/verify` | `verifyOtp` | public | `auth.otp.verify` | n/a | n/a |
| 8 | POST | `/{market}/auth/apple` | `signInWithApple` | public | `auth.federated` | n/a | n/a |
| 9 | POST | `/{market}/auth/google` | `signInWithGoogle` | public | `auth.federated` | n/a | n/a |
| 10 | POST | `/{market}/auth/passkeys/assert/options` | `passkeyAssertOptions` | public (+ optional shopper) | `auth.passkey.assert` | n/a | n/a |
| 11 | POST | `/{market}/auth/passkeys/assert/verify` | `passkeyAssertVerify` | public (+ optional shopper) | `auth.passkey.assert` | n/a | n/a |
| 12 | POST | `/{market}/auth/passkeys/register/options` | `passkeyRegisterOptions` | shopper JWT | `auth.passkey.register` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 13 | POST | `/{market}/auth/passkeys/register/verify` | `passkeyRegisterVerify` | shopper JWT | `auth.passkey.register` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 14 | POST | `/{market}/auth/refresh` | `refreshSession` | public | `auth.refresh` | n/a | n/a |
| 15 | POST | `/{market}/auth/logout` | `logout` | shopper JWT | `auth.logout` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 16 | GET | `/{market}/me/sessions` | `listMySessions` | shopper JWT | `session.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 17 | DELETE | `/{market}/me/sessions/{session_family_id}` | `revokeMySession` | shopper JWT | `session.revoke_own` | user B's session_families id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 18 | GET | `/{market}/me/passkeys` | `listMyPasskeys` | shopper JWT | `passkey.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 19 | DELETE | `/{market}/me/passkeys/{passkey_id}` | `revokeMyPasskey` | shopper JWT | `passkey.revoke_own` | user B's passkey_credentials id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 20 | GET | `/{market}/me` | `getMe` | shopper JWT | `me.read` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 21 | PATCH | `/{market}/me` | `updateMe` | shopper JWT | `me.update` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 22 | GET | `/{market}/me/preferences` | `getMyPreferences` | shopper JWT | `me.preferences.read` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 23 | PUT | `/{market}/me/preferences` | `putMyPreferences` | shopper JWT | `me.preferences.write` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 24 | GET | `/{market}/me/addresses` | `listMyAddresses` | shopper JWT | `address.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 25 | POST | `/{market}/me/addresses` | `createMyAddress` | shopper JWT | `address.create_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 26 | PATCH | `/{market}/me/addresses/{address_id}` | `updateMyAddress` | shopper JWT | `address.update_own` | user B's addresses id -> 404, no side effect; body id of another tenant (fields.governorate_id) -> 404 | staff session token -> 403 wrong-principal |
| 27 | DELETE | `/{market}/me/addresses/{address_id}` | `deleteMyAddress` | shopper JWT | `address.delete_own` | user B's addresses id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 28 | GET | `/{market}/me/privacy/consents` | `listMyConsents` | shopper JWT | `consent.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 29 | PATCH | `/{market}/me/privacy/consents` | `updateMyConsents` | shopper JWT | `consent.write_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 30 | POST | `/{market}/me/privacy/export` | `requestMyDataExport` | shopper JWT | `privacy.export_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 31 | POST | `/{market}/me/privacy/delete` | `requestMyAccountDeletion` | shopper JWT | `privacy.delete_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 32 | DELETE | `/{market}/me/privacy/delete` | `cancelMyAccountDeletion` | shopper JWT | `privacy.delete_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 33 | GET | `/{market}/me/privacy/requests` | `listMyPrivacyRequests` | shopper JWT | `privacy.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 34 | GET | `/{market}/me/privacy/requests/{privacy_request_id}` | `getMyPrivacyRequest` | shopper JWT | `privacy.read_own` | user B's privacy_requests id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 35 | GET | `/{market}/me/followed-stores` | `listMyFollowedStores` | shopper JWT | `follow.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 36 | PUT | `/{market}/me/followed-stores/{store_id}` | `followStore` | shopper JWT | `follow.write_own` | unknown or non-public store -> 404 | staff session token -> 403 wrong-principal |
| 37 | DELETE | `/{market}/me/followed-stores/{store_id}` | `unfollowStore` | shopper JWT | `follow.write_own` | user B's store_follows id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 38 | GET | `/{market}/me/alerts` | `listMyAlerts` | shopper JWT | `alert.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 39 | POST | `/{market}/products/{product_id}/alerts` | `createProductAlert` | shopper JWT | `alert.create_own` | unknown or non-public product -> 404 | staff session token -> 403 wrong-principal |
| 40 | DELETE | `/{market}/me/alerts/{alert_id}` | `deleteMyAlert` | shopper JWT | `alert.delete_own` | user B's product_alerts id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 41 | GET | `/{market}/me/wallet` | `getMyWallet` | shopper JWT | `wallet.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 42 | GET | `/{market}/me/wallet/movements` | `listMyWalletMovements` | shopper JWT | `wallet.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 43 | GET | `/{market}/village` | `getVillage` | public | `village.read` | n/a | n/a |
| 44 | GET | `/{market}/stores` | `listStores` | public | `store.list_public` | n/a | n/a |
| 45 | GET | `/{market}/stores/{store_slug}` | `getStore` | public | `store.read_public` | unknown or non-public store -> 404 | n/a |
| 46 | GET | `/{market}/stores/{store_slug}/shelves` | `listStoreShelves` | public | `store.read_public` | unknown or non-public store -> 404 | n/a |
| 47 | GET | `/{market}/stores/{store_slug}/products` | `listStoreProducts` | public | `store.read_public` | unknown or non-public store -> 404 | n/a |
| 48 | GET | `/{market}/categories` | `listCategories` | public | `category.list` | n/a | n/a |
| 49 | GET | `/{market}/deals/bands` | `listDealBands` | public | `deals.read` | n/a | n/a |
| 50 | GET | `/{market}/deals` | `listDeals` | public | `deals.read` | n/a | n/a |
| 51 | GET | `/{market}/drops` | `listDrops` | public | `drop.list_public` | n/a | n/a |
| 52 | GET | `/{market}/drops/{drop_id}` | `getDrop` | public | `drop.read_public` | unknown or non-public drop -> 404 | n/a |
| 53 | GET | `/{market}/drops/{drop_id}/items` | `listDropItems` | public | `drop.read_public` | unknown or non-public drop -> 404 | n/a |
| 54 | GET | `/{market}/resolve` | `resolveRoute` | public | `route.resolve` | n/a | n/a |
| 55 | GET | `/{market}/products/{product_id}` | `getProduct` | public (+ optional shopper) | `product.read_public` | unknown or non-public product -> 404 | n/a |
| 56 | GET | `/{market}/products/{product_id}/offer` | `getProductOffer` | public (+ optional shopper) | `product.read_public` | unknown or non-public product -> 404 | n/a |
| 57 | GET | `/{market}/passports/{passport_code}` | `getDefectPassport` | public | `passport.read_public` | unknown or non-public passport -> 404 | n/a |
| 58 | GET | `/{market}/products/{product_id}/price-evidence` | `getPriceEvidence` | public | `price_proof.read_public` | unknown or non-public product -> 404 | n/a |
| 59 | GET | `/{market}/skus/{sku_id}/price-history` | `listPriceHistory` | public | `price_proof.read_public` | unknown or non-public sku -> 404 | n/a |
| 60 | POST | `/{market}/products/{product_id}/price-reports` | `reportPrice` | shopper JWT | `price_report.create` | unknown or non-public product -> 404 | staff session token -> 403 wrong-principal |
| 61 | GET | `/{market}/search` | `search` | public (+ optional shopper) | `search.query` | n/a | n/a |
| 62 | GET | `/{market}/search/suggest` | `searchSuggest` | public (+ optional shopper) | `search.query` | n/a | n/a |
| 63 | POST | `/{market}/search/parse` | `parseSearchQuery` | shopper JWT | `search.parse` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 64 | GET | `/{market}/cart` | `getCart` | shopper JWT | `cart.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 65 | POST | `/{market}/cart/lines` | `addCartLine` | shopper JWT | `cart.write_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 66 | PATCH | `/{market}/cart/lines/{cart_line_id}` | `updateCartLine` | shopper JWT | `cart.write_own` | user B's cart_lines id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 67 | DELETE | `/{market}/cart/lines/{cart_line_id}` | `deleteCartLine` | shopper JWT | `cart.write_own` | user B's cart_lines id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 68 | POST | `/{market}/cart/lines/{cart_line_id}/defect-ack` | `acknowledgeDefects` | shopper JWT | `cart.write_own` | user B's cart_lines id -> 404, no side effect; body id of another tenant (defect_card_id) -> 404 | staff session token -> 403 wrong-principal |
| 69 | GET | `/{market}/cart/free-delivery-suggestions` | `listFreeDeliverySuggestions` | shopper JWT | `cart.read_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 70 | POST | `/{market}/shipping/quote` | `quoteShipping` | shopper JWT | `shipping.quote` | own scope only: RLS test that user B's rows are never returned or changed; body id of another tenant (dest_geo_area_id) -> 404 | staff session token -> 403 wrong-principal |
| 71 | POST | `/{market}/checkout/quote` | `quoteCheckout` | shopper JWT | `checkout.quote` | own scope only: RLS test that user B's rows are never returned or changed; body id of another tenant (address_id, cart_line_ids) -> 404 | staff session token -> 403 wrong-principal |
| 72 | POST | `/{market}/checkout` | `placeOrder` | shopper JWT | `checkout.place` | own scope only: RLS test that user B's rows are never returned or changed; body id of another tenant (address_id) -> 404 | staff session token -> 403 wrong-principal |
| 73 | GET | `/{market}/order-groups` | `listMyOrderGroups` | shopper JWT | `order_group.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 74 | GET | `/{market}/order-groups/{order_group_id}` | `getOrderGroup` | shopper JWT | `order_group.read_own` | user B's order_groups id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 75 | POST | `/{market}/order-groups/{order_group_id}/cancel` | `cancelOrderGroup` | shopper JWT | `order_group.cancel_own` | user B's order_groups id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 76 | POST | `/{market}/order-groups/{order_group_id}/seller-orders/{seller_order_id}/cancel` | `cancelSellerOrder` | shopper JWT | `seller_order.cancel_own` | user B's seller_orders id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 77 | POST | `/{market}/order-groups/{order_group_id}/cod-confirmation` | `confirmCodOrder` | shopper JWT | `order_group.cod_confirm_own` | user B's order_groups id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 78 | POST | `/{market}/seller-orders/{seller_order_id}/returns` | `createReturn` | shopper JWT | `return.create_own` | user B's seller_orders id -> 404, no side effect; body id of another tenant (lines[].order_line_id, lines[].item_unit_id, evidence_media_ids) -> 404 | staff session token -> 403 wrong-principal |
| 79 | GET | `/{market}/returns` | `listMyReturns` | shopper JWT | `return.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 80 | GET | `/{market}/returns/{return_id}` | `getMyReturn` | shopper JWT | `return.read_own` | user B's return_requests id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 81 | POST | `/{market}/returns/{return_id}/cancel` | `cancelMyReturn` | shopper JWT | `return.cancel_own` | user B's return_requests id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 82 | POST | `/{market}/returns/{return_id}/evidence` | `addReturnEvidence` | shopper JWT | `return.evidence_own` | user B's return_requests id -> 404, no side effect; body id of another tenant (media_ids) -> 404 | staff session token -> 403 wrong-principal |
| 83 | POST | `/{market}/returns/{return_id}/dispute` | `openReturnDispute` | shopper JWT | `dispute.create_own` | user B's return_requests id -> 404, no side effect; body id of another tenant (media_ids) -> 404 | staff session token -> 403 wrong-principal |
| 84 | GET | `/{market}/refunds` | `listMyRefunds` | shopper JWT | `refund.list_own` | own scope only: RLS test that user B's rows are never returned or changed | staff session token -> 403 wrong-principal |
| 85 | GET | `/{market}/refunds/{refund_id}` | `getMyRefund` | shopper JWT | `refund.read_own` | user B's refunds id -> 404, no side effect | staff session token -> 403 wrong-principal |
| 86 | POST | `/{market}/media/uploads` | `createUpload` | shopper or seller JWT | `media.upload` | upload owner is bound to the caller (RLS) | shopper requesting a seller-only purpose -> 403 |
| 87 | POST | `/{market}/media/{media_id}/complete` | `completeUpload` | shopper or seller JWT | `media.upload` | user B's / store B's media_assets id -> 404 | shopper requesting a seller-only purpose -> 403 |
| 88 | POST | `/{market}/webhooks/psp/{provider}` | `receivePspWebhook` | webhook HMAC | `webhook.psp` | n/a: bad HMAC -> 401, stale timestamp -> 401, replayed event id -> 200 duplicate=true with no side effect | n/a |
| 89 | POST | `/{market}/webhooks/couriers/{courier_code}` | `receiveCourierWebhook` | webhook HMAC | `webhook.courier` | n/a: bad HMAC -> 401, stale timestamp -> 401, replayed event id -> 200 duplicate=true with no side effect | n/a |
| 90 | POST | `/{market}/webhooks/channels/{channel_type}` | `receiveChannelWebhook` | webhook HMAC | `webhook.channel` | n/a: bad HMAC -> 401, stale timestamp -> 401, replayed event id -> 200 duplicate=true with no side effect | n/a |
| 91 | POST | `/{market}/seller/onboarding` | `startSellerOnboarding` | seller JWT (passkey) | `seller.onboard` | own memberships only (RLS on store_members) | session without passkey amr -> 403 passkey-required |
| 92 | GET | `/{market}/seller/stores` | `listMySellerStores` | seller JWT (passkey) | `store.list_member` | own memberships only (RLS on store_members) | session without passkey amr -> 403 passkey-required |
| 93 | POST | `/{market}/seller/invites/accept` | `acceptStoreInvite` | seller JWT (passkey) | `store.invite_accept` | own memberships only (RLS on store_members) | session without passkey amr -> 403 passkey-required |
| 94 | GET | `/{market}/seller/kyc` | `getKycCase` | seller JWT + X-Store-Id | `kyc.read` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 95 | PATCH | `/{market}/seller/kyc` | `updateKycCase` | seller JWT + X-Store-Id | `kyc.write` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 96 | POST | `/{market}/seller/kyc/documents` | `addKycDocument` | seller JWT + X-Store-Id | `kyc.write` · owner | X-Store-Id of a store where the caller is not a member -> 404; body id of another tenant (media_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 97 | DELETE | `/{market}/seller/kyc/documents/{kyc_document_id}` | `removeKycDocument` | seller JWT + X-Store-Id | `kyc.write` · owner | X-Store-Id of a store where the caller is not a member -> 404; store B's kyc_documents id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 98 | POST | `/{market}/seller/kyc/submit` | `submitKycCase` | seller JWT + X-Store-Id | `kyc.submit` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 99 | GET | `/{market}/seller/agreements` | `listSellerAgreements` | seller JWT + X-Store-Id | `agreement.read` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 100 | POST | `/{market}/seller/agreements/{agreement_version_id}/accept` | `acceptSellerAgreement` | seller JWT + X-Store-Id | `agreement.accept` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 101 | GET | `/{market}/seller/payout-instruments` | `listPayoutInstruments` | seller JWT + X-Store-Id | `payout_instrument.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 102 | POST | `/{market}/seller/payout-instruments` | `addPayoutInstrument` | seller JWT + X-Store-Id | `payout_instrument.write` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 103 | GET | `/{market}/seller/store` | `getSellerStore` | seller JWT + X-Store-Id | `store.read_member` · owner, manager, catalog, warehouse, finance, support | X-Store-Id of a store where the caller is not a member -> 404 | all store roles allowed; no passkey amr -> 403 |
| 104 | PATCH | `/{market}/seller/store` | `updateSellerStore` | seller JWT + X-Store-Id | `store.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 105 | GET | `/{market}/seller/store/settings` | `getStoreSettings` | seller JWT + X-Store-Id | `store.read_member` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 106 | PUT | `/{market}/seller/store/settings` | `putStoreSettings` | seller JWT + X-Store-Id | `store.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 107 | GET | `/{market}/seller/store/storefront` | `getStorefrontDraft` | seller JWT + X-Store-Id | `storefront.read` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 108 | PUT | `/{market}/seller/store/storefront` | `putStorefrontDraft` | seller JWT + X-Store-Id | `storefront.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; body id of another tenant (logo_media_id, cover_media_id, custom_render_media_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 109 | POST | `/{market}/seller/store/storefront/publish` | `publishStorefront` | seller JWT + X-Store-Id | `storefront.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 110 | GET | `/{market}/seller/store/members` | `listStoreMembers` | seller JWT + X-Store-Id | `team.read` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 111 | POST | `/{market}/seller/store/invites` | `inviteStoreMember` | seller JWT + X-Store-Id | `team.write` · owner | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 112 | DELETE | `/{market}/seller/store/members/{store_member_id}` | `removeStoreMember` | seller JWT + X-Store-Id | `team.write` · owner | X-Store-Id of a store where the caller is not a member -> 404; store B's store_members id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 113 | GET | `/{market}/seller/store/locations` | `listStoreLocations` | seller JWT + X-Store-Id | `location.read` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 114 | POST | `/{market}/seller/store/locations` | `createStoreLocation` | seller JWT + X-Store-Id | `location.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 115 | GET | `/{market}/seller/products` | `listSellerProducts` | seller JWT + X-Store-Id | `product.read_store` · owner, manager, catalog, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 116 | POST | `/{market}/seller/products` | `createProductDraft` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 117 | GET | `/{market}/seller/products/{product_id}` | `getSellerProduct` | seller JWT + X-Store-Id | `product.read_store` · owner, manager, catalog, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 118 | PUT | `/{market}/seller/products/{product_id}/photos-condition` | `putProductPhotosCondition` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (media[].media_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 119 | PUT | `/{market}/seller/products/{product_id}/defect-card` | `putDefectCard` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (items[].photo_media_id, items[].hotspot_media_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 120 | PUT | `/{market}/seller/products/{product_id}/details` | `putProductDetails` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (size_chart_id, brand_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 121 | PUT | `/{market}/seller/products/{product_id}/price-stock` | `putProductPriceStock` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (skus[].id, skus[].stock[].location_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 122 | PUT | `/{market}/seller/products/{product_id}/shipping` | `putProductShipping` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (profiles[].sku_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 123 | GET | `/{market}/seller/products/{product_id}/readiness` | `getProductReadiness` | seller JWT + X-Store-Id | `product.read_store` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 124 | POST | `/{market}/seller/products/{product_id}/price-check` | `runPriceCheck` | seller JWT + X-Store-Id | `price_check.run` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (sku_ids) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 125 | POST | `/{market}/seller/products/{product_id}/publish` | `publishProduct` | seller JWT + X-Store-Id | `product.publish` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 126 | POST | `/{market}/seller/products/{product_id}/pause` | `pauseProduct` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 127 | POST | `/{market}/seller/products/{product_id}/resume` | `resumeProduct` | seller JWT + X-Store-Id | `product.publish` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 128 | POST | `/{market}/seller/products/{product_id}/archive` | `archiveProduct` | seller JWT + X-Store-Id | `product.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 129 | POST | `/{market}/seller/products/{product_id}/copilot` | `runListingCopilot` | seller JWT + X-Store-Id | `copilot.run` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 130 | GET | `/{market}/seller/products/{product_id}/units` | `listItemUnits` | seller JWT + X-Store-Id | `unit.read` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 131 | POST | `/{market}/seller/products/{product_id}/units` | `createItemUnits` | seller JWT + X-Store-Id | `unit.write` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's products id with own X-Store-Id -> 404; body id of another tenant (sku_id, location_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 132 | GET | `/{market}/seller/units/{item_unit_id}/qr-label` | `getPassportLabel` | seller JWT + X-Store-Id | `unit.read` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's item_units id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 133 | GET | `/{market}/seller/size-charts` | `listSizeCharts` | seller JWT + X-Store-Id | `size_chart.read` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 134 | POST | `/{market}/seller/size-charts` | `createSizeChart` | seller JWT + X-Store-Id | `size_chart.write` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 135 | GET | `/{market}/seller/inventory` | `listInventoryLevels` | seller JWT + X-Store-Id | `inventory.read` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 136 | POST | `/{market}/seller/inventory/adjustments` | `adjustInventory` | seller JWT + X-Store-Id | `inventory.adjust` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404; body id of another tenant (sku_id, location_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 137 | GET | `/{market}/seller/inventory/adjustments` | `listInventoryAdjustments` | seller JWT + X-Store-Id | `inventory.read` · owner, manager, catalog, warehouse | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 138 | GET | `/{market}/seller/orders` | `listSellerOrders` | seller JWT + X-Store-Id | `seller_order.read_store` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 139 | GET | `/{market}/seller/orders/{seller_order_id}` | `getSellerOrder` | seller JWT + X-Store-Id | `seller_order.read_store` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404; store B's seller_orders id with own X-Store-Id -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 140 | POST | `/{market}/seller/orders/{seller_order_id}/accept` | `acceptSellerOrder` | seller JWT + X-Store-Id | `seller_order.transition` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's seller_orders id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 141 | POST | `/{market}/seller/orders/{seller_order_id}/reject` | `rejectSellerOrder` | seller JWT + X-Store-Id | `seller_order.transition` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; store B's seller_orders id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 142 | POST | `/{market}/seller/orders/{seller_order_id}/pack` | `packSellerOrder` | seller JWT + X-Store-Id | `seller_order.transition` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's seller_orders id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 143 | POST | `/{market}/seller/shipments` | `createShipment` | seller JWT + X-Store-Id | `shipment.create` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404; body id of another tenant (seller_order_ids, courier_service_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 144 | GET | `/{market}/seller/shipments` | `listShipments` | seller JWT + X-Store-Id | `shipment.read` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 145 | GET | `/{market}/seller/shipments/{shipment_id}` | `getShipment` | seller JWT + X-Store-Id | `shipment.read` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404; store B's shipments id with own X-Store-Id -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 146 | GET | `/{market}/seller/shipments/{shipment_id}/label` | `getShipmentLabel` | seller JWT + X-Store-Id | `shipment.read` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's shipments id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 147 | GET | `/{market}/seller/returns` | `listSellerReturns` | seller JWT + X-Store-Id | `return.read_store` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 148 | GET | `/{market}/seller/returns/{return_id}` | `getSellerReturn` | seller JWT + X-Store-Id | `return.read_store` · owner, manager, warehouse, support | X-Store-Id of a store where the caller is not a member -> 404; store B's return_requests id with own X-Store-Id -> 404 | member with role finance -> 403; no passkey amr -> 403 |
| 149 | POST | `/{market}/seller/returns/{return_id}/inspect` | `inspectReturn` | seller JWT + X-Store-Id | `return.inspect` · owner, manager, warehouse | X-Store-Id of a store where the caller is not a member -> 404; store B's return_requests id with own X-Store-Id -> 404; body id of another tenant (lines[].return_line_id, media_ids) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 150 | POST | `/{market}/seller/channels` | `connectChannel` | seller JWT + X-Store-Id | `channel.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; body id of another tenant (consent_agreement_version_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 151 | GET | `/{market}/seller/channels` | `listChannels` | seller JWT + X-Store-Id | `channel.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 152 | GET | `/{market}/seller/channels/{channel_id}` | `getChannel` | seller JWT + X-Store-Id | `channel.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404; store B's channel_connections id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 153 | POST | `/{market}/seller/channels/{channel_id}/verify` | `verifyChannel` | seller JWT + X-Store-Id | `channel.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; store B's channel_connections id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 154 | DELETE | `/{market}/seller/channels/{channel_id}` | `disconnectChannel` | seller JWT + X-Store-Id | `channel.write` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; store B's channel_connections id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 155 | GET | `/{market}/seller/channels/{channel_id}/matches` | `listChannelMatches` | seller JWT + X-Store-Id | `channel.read` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's channel_connections id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 156 | PATCH | `/{market}/seller/channels/{channel_id}/matches/{match_id}` | `decideChannelMatch` | seller JWT + X-Store-Id | `channel.match_decide` · owner, manager, catalog | X-Store-Id of a store where the caller is not a member -> 404; store B's product_matches id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 157 | GET | `/{market}/seller/price-trust` | `getPriceTrust` | seller JWT + X-Store-Id | `price_trust.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 158 | GET | `/{market}/seller/price-claims` | `listPriceClaims` | seller JWT + X-Store-Id | `price_claim.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 159 | GET | `/{market}/seller/price-findings` | `listPriceFindings` | seller JWT + X-Store-Id | `price_finding.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 160 | GET | `/{market}/seller/price-findings/{finding_id}` | `getPriceFinding` | seller JWT + X-Store-Id | `price_finding.read` · owner, manager, catalog, finance | X-Store-Id of a store where the caller is not a member -> 404; store B's price_findings id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 161 | POST | `/{market}/seller/price-findings/{finding_id}/appeal` | `appealPriceFinding` | seller JWT + X-Store-Id | `price_finding.appeal` · owner, manager | X-Store-Id of a store where the caller is not a member -> 404; store B's price_findings id with own X-Store-Id -> 404; body id of another tenant (evidence_media_id, connection_id) -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 162 | GET | `/{market}/seller/balance` | `getSellerBalance` | seller JWT + X-Store-Id | `finance.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 163 | GET | `/{market}/seller/statements` | `listSellerStatements` | seller JWT + X-Store-Id | `finance.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 164 | GET | `/{market}/seller/payouts` | `listPayouts` | seller JWT + X-Store-Id | `payout.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 165 | GET | `/{market}/seller/payouts/{payout_id}` | `getPayout` | seller JWT + X-Store-Id | `payout.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404; store B's payouts id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 166 | GET | `/{market}/seller/payouts/{payout_id}/items` | `listPayoutItems` | seller JWT + X-Store-Id | `payout.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404; store B's payouts id with own X-Store-Id -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 167 | GET | `/{market}/seller/tax-documents` | `listSellerTaxDocuments` | seller JWT + X-Store-Id | `finance.read` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 168 | GET | `/{market}/seller/plans` | `listSellerPlans` | seller JWT (passkey) | `plan.list` | own memberships only (RLS on store_members) | session without passkey amr -> 403 passkey-required |
| 169 | GET | `/{market}/seller/plan-subscription` | `getPlanSubscription` | seller JWT + X-Store-Id | `plan.read_store` · owner, manager, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 170 | GET | `/{market}/seller/plan-invoices` | `listPlanInvoices` | seller JWT + X-Store-Id | `plan.read_store` · owner, finance | X-Store-Id of a store where the caller is not a member -> 404 | member with role support -> 403; no passkey amr -> 403 |
| 171 | POST | `/{market}/admin/auth/passkey/options` | `adminPasskeyOptions` | public | `admin.auth` | n/a | n/a |
| 172 | POST | `/{market}/admin/auth/passkey/verify` | `adminPasskeyVerify` | public | `admin.auth` | n/a | n/a |
| 173 | POST | `/{market}/admin/auth/logout` | `adminLogout` | admin passkey session | `admin.auth` · any_staff | staff of another market -> 401 market-mismatch | shopper or seller token -> 403 wrong-principal |
| 174 | GET | `/{market}/admin/kyc-cases` | `adminListKycCases` | admin passkey session | `admin.kyc.read` · ops, trust_safety | staff of another market -> 401 market-mismatch | staff without ops/trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 175 | GET | `/{market}/admin/kyc-cases/{kyc_case_id}` | `adminGetKycCase` | admin passkey session | `admin.kyc.read` · ops, trust_safety | object of another market -> 404 | staff without ops/trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 176 | POST | `/{market}/admin/kyc-cases/{kyc_case_id}/decision` | `adminDecideKycCase` | admin passkey session | `admin.kyc.decide` · ops, trust_safety | object of another market -> 404 | staff without ops/trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 177 | POST | `/{market}/admin/stores/{store_id}/suspend` | `adminSuspendStore` | admin passkey session | `admin.store.suspend` · trust_safety | object of another market -> 404; body id of another tenant (finding_id) -> 404 | staff without trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 178 | POST | `/{market}/admin/stores/{store_id}/reinstate` | `adminReinstateStore` | admin passkey session | `admin.store.reinstate` · trust_safety | object of another market -> 404 | staff without trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 179 | GET | `/{market}/admin/price-integrity/findings` | `adminListPriceFindings` | admin passkey session | `admin.price_integrity.read` · trust_safety, ops | staff of another market -> 401 market-mismatch | staff without trust_safety/ops -> 403; shopper or seller token -> 403 wrong-principal |
| 180 | GET | `/{market}/admin/price-integrity/enforcement-actions` | `adminListEnforcementActions` | admin passkey session | `admin.price_integrity.read` · trust_safety, ops | staff of another market -> 401 market-mismatch | staff without trust_safety/ops -> 403; shopper or seller token -> 403 wrong-principal |
| 181 | POST | `/{market}/admin/price-integrity/enforcement-actions/{enforcement_action_id}/review` | `adminReviewEnforcementAction` | admin passkey session | `admin.price_integrity.review` · trust_safety | object of another market -> 404 | staff without trust_safety -> 403; shopper or seller token -> 403 wrong-principal |
| 182 | GET | `/{market}/admin/price-integrity/stores/{store_id}/trust` | `adminGetStorePriceTrust` | admin passkey session | `admin.price_integrity.read` · trust_safety, ops | object of another market -> 404 | staff without trust_safety/ops -> 403; shopper or seller token -> 403 wrong-principal |
| 183 | GET | `/{market}/admin/price-integrity/reports` | `adminListPriceReports` | admin passkey session | `admin.price_integrity.read` · trust_safety, ops | staff of another market -> 401 market-mismatch | staff without trust_safety/ops -> 403; shopper or seller token -> 403 wrong-principal |
| 184 | GET | `/{market}/admin/reconciliation/runs` | `adminListReconciliationRuns` | admin passkey session | `admin.recon.read` · finance | staff of another market -> 401 market-mismatch | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 185 | POST | `/{market}/admin/reconciliation/runs` | `adminStartReconciliationRun` | admin passkey session | `admin.recon.run` · finance | staff of another market -> 401 market-mismatch | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 186 | GET | `/{market}/admin/reconciliation/runs/{reconciliation_run_id}/items` | `adminListReconciliationItems` | admin passkey session | `admin.recon.read` · finance | object of another market -> 404 | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 187 | POST | `/{market}/admin/reconciliation/items/{reconciliation_item_id}/resolve` | `adminResolveReconciliationItem` | admin passkey session | `admin.recon.resolve` · finance | object of another market -> 404 | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 188 | GET | `/{market}/admin/approval-requests` | `adminListApprovalRequests` | admin passkey session | `admin.approval.read` · finance, security, dpo, super_admin | staff of another market -> 401 market-mismatch | staff without finance/security/dpo/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 189 | POST | `/{market}/admin/approval-requests/{approval_request_id}/decision` | `adminDecideApprovalRequest` | admin passkey session | `admin.approval.decide` · finance, security, dpo, super_admin | object of another market -> 404 | staff without finance/security/dpo/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 190 | GET | `/{market}/admin/privacy/requests` | `adminListPrivacyRequests` | admin passkey session | `admin.privacy.read` · dpo | staff of another market -> 401 market-mismatch | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 191 | GET | `/{market}/admin/privacy/requests/{privacy_request_id}` | `adminGetPrivacyRequest` | admin passkey session | `admin.privacy.read` · dpo | object of another market -> 404 | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 192 | POST | `/{market}/admin/privacy/requests/{privacy_request_id}/decision` | `adminDecidePrivacyRequest` | admin passkey session | `admin.privacy.decide` · dpo | object of another market -> 404 | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 193 | GET | `/{market}/admin/privacy/breaches` | `adminListBreaches` | admin passkey session | `admin.breach.read` · dpo, security | staff of another market -> 401 market-mismatch | staff without dpo/security -> 403; shopper or seller token -> 403 wrong-principal |
| 194 | POST | `/{market}/admin/privacy/breaches` | `adminCreateBreach` | admin passkey session | `admin.breach.write` · dpo, security | staff of another market -> 401 market-mismatch | staff without dpo/security -> 403; shopper or seller token -> 403 wrong-principal |
| 195 | POST | `/{market}/admin/privacy/breaches/{breach_id}/transition` | `adminTransitionBreach` | admin passkey session | `admin.breach.write` · dpo | object of another market -> 404 | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 196 | GET | `/{market}/admin/privacy/transfer-register` | `adminListTransfers` | admin passkey session | `admin.privacy.read` · dpo | staff of another market -> 401 market-mismatch | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 197 | GET | `/{market}/admin/privacy/consent-stats` | `adminGetConsentStats` | admin passkey session | `admin.privacy.read` · dpo | staff of another market -> 401 market-mismatch | staff without dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 198 | GET | `/{market}/admin/privacy/pii-access-log` | `adminListPiiAccessLog` | admin passkey session | `admin.privacy.read` · dpo, security | staff of another market -> 401 market-mismatch | staff without dpo/security -> 403; shopper or seller token -> 403 wrong-principal |
| 199 | GET | `/{market}/admin/tax/documents` | `adminListTaxDocuments` | admin passkey session | `admin.tax.read` · finance | staff of another market -> 401 market-mismatch | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 200 | GET | `/{market}/admin/tax/documents/{tax_document_id}` | `adminGetTaxDocument` | admin passkey session | `admin.tax.read` · finance | object of another market -> 404 | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 201 | POST | `/{market}/admin/tax/documents/{tax_document_id}/resubmit` | `adminResubmitTaxDocument` | admin passkey session | `admin.tax.resubmit` · finance | object of another market -> 404 | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 202 | GET | `/{market}/admin/tax/reconciliation` | `adminListEtaReconciliation` | admin passkey session | `admin.tax.read` · finance | staff of another market -> 401 market-mismatch | staff without finance -> 403; shopper or seller token -> 403 wrong-principal |
| 203 | GET | `/{market}/admin/staff` | `adminListStaff` | admin passkey session | `admin.rbac.read` · security, super_admin | staff of another market -> 401 market-mismatch | staff without security/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 204 | GET | `/{market}/admin/roles` | `adminListRoles` | admin passkey session | `admin.rbac.read` · security, super_admin | staff of another market -> 401 market-mismatch | staff without security/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 205 | POST | `/{market}/admin/staff/{staff_id}/role-assignments` | `adminRequestRoleGrant` | admin passkey session | `admin.rbac.grant` · security, super_admin | object of another market -> 404 | staff without security/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 206 | DELETE | `/{market}/admin/staff/{staff_id}/role-assignments/{role_assignment_id}` | `adminRevokeRole` | admin passkey session | `admin.rbac.revoke` · security, super_admin | object of another market -> 404 | staff without security/super_admin -> 403; shopper or seller token -> 403 wrong-principal |
| 207 | GET | `/{market}/admin/audit-log` | `adminListAuditLog` | admin passkey session | `admin.audit.read` · security, dpo | staff of another market -> 401 market-mismatch | staff without security/dpo -> 403; shopper or seller token -> 403 wrong-principal |
| 208 | GET | `/{market}/admin/feature-flags` | `adminListFeatureFlags` | admin passkey session | `admin.flags.read` · ops, security, finance | staff of another market -> 401 market-mismatch | staff without ops/security/finance -> 403; shopper or seller token -> 403 wrong-principal |
| 209 | POST | `/{market}/admin/feature-flags/{flag_key}/kill-switch` | `adminToggleKillSwitch` | admin passkey session | `admin.flags.kill` · ops, security | object of another market -> 404 | staff without ops/security -> 403; shopper or seller token -> 403 wrong-principal |

## 7. How to check this file

```bash
ruby -ryaml -e 'YAML.load_file(ARGV[0])' docs/api/openapi.yaml   # parses
```
A structural check was also run (all `$ref`s resolve; every operation has operationId, tag, security, `x-authz`, `x-rate-limit`, `x-market`; every mutating route except webhooks and pure POSTs has `Idempotency-Key`; every list has `cursor` + `limit ≤ 50`; every route has 400/422/429 and authenticated routes 401/403; no float or raw `*_minor` fields). A full OpenAPI linter (Redocly or Spectral) is a Phase 0b CI task, because no new packages were installed for this draft.

## Related
`docs/BUILD-PROMPT.md` §2–§5 · `docs/data-model.md` · ADR-0001, 0003, 0005, 0006, 0007, 0008, 0009 · `docs/specs/price-watch.md` · `docs/specs/shipping-domestic-international.md` · `docs/specs/ledger-chart-of-accounts.md` · `docs/security/threat-models.md` · `docs/security/api-top10-mapping.md` · `docs/analytics/events.md`.
