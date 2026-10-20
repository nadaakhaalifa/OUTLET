# API client gaps (for the API owner)

Found while wiring the mobile ports to `docs/api/openapi.yaml`. Nothing here is invented in the app: where the contract lacks a field, the adapter leaves it empty/neutral or declares the call unsupported (`PortError`, cause `unsupported by the API contract`). Format: operationId, what is missing, what the app does today.

## A. Real API disagreed with the OpenAPI (resolved; the "known drift" test is gone and the four operations now have success-parse tests)
| operationId | Decision (which side was right) |
|---|---|
| `getFeed` | Code right: `degraded` is the list of fallbacks (`ranker_down`, `ann_down`) and carries more information than a boolean. No consumer read it. Spec changed to an enum array. |
| `getMyPlus` | Code right: `entitlements.groups` is `{commerce_benefits, app_features}`, which is the ADR-0004 Plan A split the app and App Review need. No consumer read it. Spec changed to that object. |
| `getMyReferral` | Spec right (it is the contract the app consumes). Code now returns `share_url`, `friend_offer`, `referrer_reward`, `rewarded_this_year`, `yearly_cap`, `referrals[]` (no referee identity). Code-only extras kept and added to the spec as optional: `pending_count`, `rewarded_count`, `milestone`, `own_offer` (replaces the old `offer`; `deep_link` is now `share_url`). |
| `getWallet` | Spec right (mobile adapters use `total`, `sub_balances`, `as_of`). Code now emits that shape; held credit is no longer in `total`. `GET /v1/me/wallet/transactions` also drifted (internal kinds vs the spec enum, not caught because the list was empty); fixed the same way. |
| `getMe`, `listAddresses`, `getAccountDeletion` | `getMe` returns 200 after OTP login (fixed by the auth agent). `listAddresses` had **no route at all** (hence 404): `GET /v1/me/addresses` now exists and returns an empty page for a user with none. Create/get/update/delete address remain unimplemented (see needs owner). `getAccountDeletion` 404 means "no request yet" and is handled as eligible. |

## B. Missing fields or operations the app needs
| operationId | Needed |
|---|---|
| `listStores` / `StoreSummary` | `newest_drop_at`, `delivery_days`, trending rank, `status`. App ranks by server order and leaves the others null. |
| `getFreeDeliverySuggestions` | DONE: new `FreeDeliverySuggestion` (ProductSummary + `sku_id`, optional `size_label`). `sku_id` is always sent; `size_label` is sent when the catalog adapter supplies it (the cart port field `SuggestionFacts.sizeLabel` exists, the production catalog adapter does not fill it yet). The app drops suggestions with no size. |
| `getCart` / `CartLine` | `availability` distinguishes only available/unavailable; app needs sold_out vs paused. |
| `getProduct` | Product `status` (paused), `defect_note` text, a defect window (only one `window_days`; app uses the 14/30 day statutory minimums from B5 for the missing one), `seller_legal_identity` is optional but mandatory by B5. |
| `quoteCheckout` / `Quote` | Per-group `delivery_options[]` (code, name, fee, eta_days), vouchers list with per-code discount, line titles and verified reference price per line, payment method display names, store credit balance, courier coverage table (governorates/cities). App composes one "standard" option from `shipping_fee`, reads the balance from `getWallet`, and has no coverage list. |
| `createAddress` | App `AddressDraft` has no `recipient_name` / `phone_e164`, so checkout can only use an existing saved address that matches the draft. |
| `createCheckout` | No way for the app to send `delivery_options` for options the quote never listed (omitted). |
| `cancelSellerOrder` | `reason` is required; the port has none, app sends `changed_mind`. |
| (none) returns preview | `GET /v1/orders/lines/{id}/return-eligibility` with `ReturnEligibility` (eligible, message ar/en, delivered_at, windows, exchange_in_stock, allowed_refund_targets, shipping payer). `ReturnsPort.load` is unsupported until then. |
| `createReturn` | Photo upload flow for `photo_upload_ids` (app only has local uris). |
| `SellerOrder` | e-receipt UUID/QR (spec B4); shipment `delivered_at`. |
| `getWishlist` / `Wishlist` | Share url and expiry of an existing link; endpoint to start a cool-off on first Buy press (app: unsupported). |
| `getMyPlus` / `getPlusPaywall` | `min_age`, `sales_enabled`, trial eligibility; app uses 21 (B6 default), `true`, and derives eligibility from `getMe.age_band`. |
| `subscribePlus` | Requires `payment_token_ref` from the PSP SDK; `PlusPort.subscribe` has no token, so it is unsupported. |
| `getWallet` | DONE: gift-card sub-balances carry `lot_id` (card id); transactions carry `sub_balance` and `lot_id`. Still missing: `last4` for gift-card lots. |
| `listMyGiftCards` | `scheduled_at`; `GET` for gift pots (no list-my-pots operation); gift-card expiry months (app shows 36). |
| `purchaseGiftCard` | `payment_method` is required, `PurchaseRequest` has none: unsupported. |
| `createGiftPot` / `contributeToGiftPot` | Needs `design`, `channel`, `organiser_nickname` (port has title only) and the owner's `share_token` + `payment_method`: unsupported. |
| `getMyBudgetSummary` | Next-cycle installments, wishlist affordability list, server time. App uses 0n, [] and the device clock. |
| `requestAccountDeletion` | DONE: optional body `acknowledge_credit_forfeiture` (the server already enforced it with 409). Still missing: a pre-request blocker/forfeiture preview. |
| (none) | DONE: `GET /v1/me/privacy/export/latest` (`getLatestDataExport`, 404 when none). |
| `generateStylistOutfits` | Per item: title, store name, size label, image; per store: delivery fee; request `vibe`. App sends occasion, modest and budget only and shows empty titles. |
| (none) | Stylist swap: operation returning the swapped outfit (only `swap_in/swap_out` feedback exists): unsupported. |
| `convertMyCoins` | A `coins` amount in the request: unsupported (converting a partial amount is impossible). |
| `playRewardsGame` | The `odds_version` the shopper saw, so the server can reject a stale odds screen; `nextAvailableAt` on `getMyRewards.games`. |
| `getDropQueueStatus` | Poll interval hint (app: 2 s). No leave-queue operation (leave is local). Rejection `code` values for join (per-user limit, members only, sold out, paused, not live, under age): app matches substrings. |
| `getPublicDrop` | Store name (app calls `getStore`). |
| Auth | Real App Attest / Play Integrity assertion source (`X-App-Attest`): the app has no native module, so attested routes need the dev attestation header or a native provider. `OtpChallenge` has `attempts_remaining` only; the sends-so-far counter is derived. |

## C. Operations that need If-Match
`updateCartLine`, `updateWishlist`, `updateSizeProfile` require `If-Match`. The ports carry no concurrency token, so adapters GET first and send that ETag (a lost-update window exists between the two calls). Consider letting ports return and accept the version.

## D. Needs owner (not done: each needs a product or cross-module design decision)
- `getCart` sold_out vs paused: the catalog port (`SkuFacts.available`) is a boolean; the reason is a catalog fact.
- `getProduct` paused status, `defect_note`, defect window, mandatory `seller_legal_identity`: catalog module (owned by the catalog agent).
- `listStores` suspended flag: suspended stores are never listed (hidden by rule); `getStore` already has `status` and hidden favourites carry a reason. A list-level flag needs a decision on showing suspended stores. `newest_drop_at`, `delivery_days`, trending rank need new store read models.
- `SellerOrder` e-receipt UUID/QR: tax-eta stores the ETA UUID but nothing links a document to a seller order for the orders module; needs a bridge port and a decision on QR content.
- `convertMyCoins` partial `coins` amount: coins are already store credit sub-balances, so what "convert" means is a rewards product decision.
- Address create/get/update/delete: needs a storage design (P3 field encryption, courier coverage table, default-address rules). Only list exists, over an explicit empty book in production.
- Gift-card void approvals are single-use per process only; a durable consumption record (migration plus `data_inventory` entry) is needed to make the approval single-use across processes.
- Waiting room and drop admission in production fail closed until `secrets.manager` and `queue.redis` have real adapters (VR-16); drop checkout returns 503 until then.

## Home rails (discovery wave)
- `ProductSummary` has no listing created-at and no offer end time: "New drops" follows the server's search order and "Ending soon" is empty until the API exposes an end time per priced offer.
- The hero drop's store name is not on `PublicDrop` (only `store_id`); the hero shows the drop title only.

## Brand mode (apps/mobile/src/features/brand-mode)
The adapter `ApiBrandPort` calls only operations present in `operations.ts`: sellerMe, getSellerStore, getSellerAnalyticsSummary, getSellerBalance, getSellerPriceTrust, listSellerOrders, accept/reject/packSellerOrder, listSellerProducts, listSellerSizeCharts, listSellerReturns, listSellerTeam, removeSellerTeamMember. Everything else rejects with `unsupported` (the UI points to the Seller Center), never fake data.
- Seller settings routes of `docs/specs/seller-settings.md` (`/v1/seller/stores/{storeId}/...`: profile PUT, vacation, media uploads + confirm + product bulk, payout-account, shipping, notification-preferences, team invites by phone, eta-enrolment) are NOT in the generated client at the time of writing. Needed for: store profile save, logo/cover upload, payout IBAN + name-match + strong-factor, shipping origin and handling time, vacation, notification prefs, phone invite.
- Strong-factor step-up for sellers (`verifyStrongFactor`): no operation found; the UI sends a 6-digit code to the port.
- Product save/publish: `createSellerProduct` needs category UUIDs and upload ids (no category list or signed bulk image upload operation), `updateSellerProduct` needs `If-Match` (no etag on SellerProduct). `categories()` and `uploadPhotos()` are therefore unsupported in API mode.
- `markReady` (ready for pickup) and `inspectSellerReturn` need `createSellerShipment`/`ReturnInspectRequest` shapes the port does not map yet; AWB label download (`getSellerShipmentLabel`, binary) is not wired.
- Dashboard: server "now" is not returned by analytics (uses `freshness_at` max device time); held-payout reasons, next payout date, store health score and dispatch/cancellation rates are not on the wire (shown as "Not enough data").
- Seller Center URL comes from `EXPO_PUBLIC_SELLER_CENTER_URL` (not in app config yet).

### Backend re-check (this wave)
- Already in OpenAPI, generated client and controllers (not gaps any more): all seller-settings routes (profile, vacation, media uploads/confirm/product-uploads, payout-account (+history), shipping, notification-preferences, team + phone invites, eta-enrolment), `getSellerShipmentLabel` (binary), `inspectSellerReturn` (`ReturnInspectRequest`), `updateSellerProduct` (PATCH with `If-Match`, status active|paused is the publish; ETag is on `getSellerProduct`), and addresses create/get/update/delete/default (controller, tests and OpenAPI exist). The mobile adapter still needs wiring (apps/mobile not touched here).
- New: `GET /v1/seller/categories` (`listSellerCategories`, schemas `SellerCategory`, `SellerCategoryList`), covered in the catalog authz matrix.
- Still no backend: ready-for-pickup (no seller order/shipment transition route exists; `packSellerOrder` and `createSellerShipment` are the nearest), strong-factor step-up as a seller operation, signed shopper photo upload, per-product ETag on the list payload.

## Purchase screens
- Shopper signed photo upload: no operation exists, so `PhotoUploadPort` is an on-device fake; `createReturn` only receives `photo_upload_ids` when they look like server UUIDs (they do not, today).
- Address create/edit in checkout: the checkout form still only picks saved addresses; the Me > Addresses screen now covers create/edit/delete/default (see Addresses below).
- Bag: sold-out vs paused share one wire value; the bag shows "sold out" for both.

## Addresses (Me > Addresses) and sign-out
`ApiAddressesPort` uses listAddresses, createAddress, updateAddress, deleteAddress, setDefaultAddress, listCoverageGovernorates, listCoverageCities; sign-out uses `logout`. Nothing is missing for these flows. Remaining gaps:
- `Address.courier_coverage`, `cod_eligible` and `quality_score` are not surfaced in the UI yet (no design for them).
- `logout` revokes only the current session; "sign out of all devices" would use `listSessions`/session delete operations (not wired).
- No `X-Device`/push-token unregister operation was found for sign-out; push token cleanup is not done.
- Map pin picker for addresses stays the `MapPinPort` fake (no native module), so addresses saved from Me carry no pin.

## Phase 3 wave C part 1: stylist chat, outfit calendar, wardrobe
Every operationId used exists in the generated client (nothing is invented). Used: `createStylistChatSession`, `listStylistChatSessions`, `getStylistChatSession`, `sendStylistChatMessage`, `deleteStylistChatSession`, `getStylistChatSettings`, `updateStylistChatSettings`, `addStylistOutfitToBag` (existing outfit flow), `listMyCalendarEvents`, `createMyCalendarEvent`, `updateMyCalendarEvent`, `deleteMyCalendarEvent`, `clearMyCalendar`, `generateCalendarEventOutfits`, `addCalendarGapToBag`, `listWardrobeItems`, `createWardrobeItem`, `updateWardrobeItem`, `deleteWardrobeItem`, `clearWardrobe`, `issueWardrobeUpload`, `suggestWardrobeAttributes`, `getWardrobeItemPhoto`, `completeFromWardrobe`.
Gaps and workarounds (no missing operation, but contract limits the UI):
- Chat blocks are `looseObject` on the wire (`StylistChatBlock` only types `type`). The adapter validates each block with a local Zod schema and drops malformed or unknown ones. Suggest typing `text`, `outfits`, `chips`, `quick_actions` as a discriminated union in the OpenAPI.
- `StylistChatSession` has no title or last-message preview, so the sessions list shows only the date and whether history was saved.
- No bulk "erase all chats": the app deletes sessions one by one (`deleteStylistChatSession` per id). A `DELETE /v1/stylist/chat/sessions` would make erase atomic and idempotent.
- The daily chat limit is only visible as `quota.remaining_today` on a turn, not on `listStylistChatSessions` or `getStylistChatSettings`; the "turns left" hint appears after the first turn of a visit.
- Outfit items (chat, calendar gap, wardrobe completion) carry no title, store name or size label (same gap as `generateStylistOutfits`): cards show the slot name and the live catalogue price.
- Calendar: device-calendar import (`source: "device"`) is not offered (needs a native calendar module, out of scope for Expo Go). There is no reminder-specific consent operation: the UI explains that reminders are service messages for events the shopper created and uses `reminders_enabled`. `use_remaining_budget` needs the `budget_insights` consent flow in the UI and is sent as `false`.
- Calendar writes and wardrobe/chat writes rely on the client-generated UUIDv7 Idempotency-Key per call; ports carry no caller key, so a user retry after an ambiguous network failure is a new key.
- Wardrobe: photo URLs need one `getWardrobeItemPhoto` call per tile (no thumbnail or URL on `WardrobeItem`); `suggestWardrobeOwnedSlots` is not wired (the stylist toggle uses `completeFromWardrobe` only); `completeFromWardrobe.kind` has no beach/gym, so those occasions are sent as `custom`; `season` is not sent. `suggestWardrobeAttributes` can need the `cross_border_ml` consent (403 `consent_required`): the UI points to the Privacy Center.
- Wardrobe signed upload uses the global `fetch` for the file read and the PUT (no native upload module). The upload URL is rejected unless https (or a local dev host).

## Phase 3 mobile wave C part 2: visual search, auto-buy, family and student plans
Adapters: `features/visual-search/api.ts`, `features/auto-buy/api.ts`, `features/family/api.ts`. Only operationIds present in `operations.ts` are used (`issueVisualSearchUpload`, `searchByImage`, `getVisuallySimilarProducts`, `getProduct`, `createProductAlert`, `listAutoBuyRules`, `createAutoBuyRule`, `cancelAutoBuyRule`, `cancelAutoBuyAttempt`, `getMyPlusFamily`, `getMyStudentStatus`, `getPlusPaywall`, `inviteFamilyMember`, `revokeFamilyInvite`, `removeFamilyMember`, `leaveFamily`, `acceptFamilyInvite`, `startStudentVerification`).

### Visual search
| operationId | Missing | What the app does today |
|---|---|---|
| `searchByImage` / `VisualSearchItem` | `title`, store name and image: the item has only ids, category id, price and the verified percentage. | Hydrates the first 12 items with `getProduct` (failure tolerant). A miss leaves the title empty; art is the placeholder kit. Consider adding `title` and `store_name` to the item. |
| `searchByImage` / `VisualSearchItem` | The verified reference price next to `verified_discount_pct`. | No strike-through is ever built from the percentage. The tile shows the plain price (never a % off without a verified claim). |
| `issueVisualSearchUpload` | HTTP method and whether `url` is absolute are not in the contract. | `PUT` with the returned `headers` to `url` (matches the server's in-memory simulation). |
| `searchByImage` | `crop` is in the request but the app has no garment detector or crop UI (no native module). | Not sent. |

### Auto-buy
| operationId | Missing | What the app does today |
|---|---|---|
| `getAutoBuyTerms` (resolved 2026-10-12) | `GET /v1/me/auto-buy/terms?locale=` now returns `{version, locale, text}` (template with `{{item}}` placeholders, DRAFT until VR-P3-02). | The adapter can call it; regenerate and switch `ApiAutoBuyPort.terms` over. |
| `listAutoBuyRules` capability (resolved 2026-10-12, partial) | `capabilities.unattended_available` is now on the list response. A saved-card list operation is still missing, so unattended mode remains uncreatable from the app. | Wire `capabilities()` to the field. |
| (none) session assurance | The app cannot tell whether the session is passkey-assured (creation needs `step_up_required` otherwise). No native passkey module either. | `passkeySession: null`: the form is shown and a 403 `step_up_required` becomes a clear "confirm with your passkey first" message. |
| `listAutoBuyRules` (resolved 2026-10-12) | `server_time` is now returned. | Anchor the 15-minute countdown to it. |
| `AutoBuyRule` | `product_id` and a title: the rule has `sku_id` only. | Rows show the size and prices; "Open item" appears only when a product id is known (never in API mode). |
| `AutoBuyRule` / `AutoBuyAttempt` schema drift (resolved) | `latest_attempt`, `payment_method`, `notice_sent_at`, `cancel_deadline`, `failure_reason` and `order_group_id` are `nullable` in the OpenAPI and the generated client matches. | None. |
| `createAutoBuyRule` | `payment_token_ref` needs a saved-card token the app cannot obtain (PSP SDK, same gap as `subscribePlus`). | Unattended mode is therefore not creatable from the app today. |

### Family and student plans
| operationId | Missing | What the app does today |
|---|---|---|
| `createPlusFamily` | Needs `payment_token_ref` from the PSP SDK (same gap as `subscribePlus`). | Not wired: the family section shows the plan and says the plan is started by the person who pays; seat management works for existing owners and members. |
| `getMyStudentStatus` | No verifier name (spec asks for an honest "verified by {provider}"). | `verifier: null`: copy reads "Verified by our verification partner". |
| `acceptFamilyInvite` | The invite link format (host, path, how the SMS or WhatsApp template embeds the token) is not specified anywhere in the contract. | Route `app/family-invite/[token].tsx` (`zoutlet://family-invite/<token>` and `https://<APP_LINK_HOST>/family-invite/<token>` once the host is configured). Token regex `^[A-Za-z0-9_-]{16,128}$` is checked before any request; never logged or rendered. |
| `inviteFamilyMember` | Refusal codes are not enumerated in the OpenAPI; mapped from the controller (`age_gate` with `min_age`, `invite_seats_full`, `invite_seat_churn_limit`, `invite_already_in_family`, `invite_self_invite`, `invite_already_invited`, `invite_owner_not_entitled`, `invite_group_ended`, `invite_delivery_failed`, `conflict`). | Each maps to a plain reason; unknown codes remain failures. |
| `getMyPlusFamily` | A "no family" answer is a 404. | Treated as `family: null`, not an error. |
| (none) | Student price purchase (`subscribePlus` with `plus_student`) needs the same PSP token. | Only verification start and status are in the app. |

## Phase 3 web wave C (Seller Center and Admin Console)
Only operations present in `packages/api-client/src/generated/operations.ts` are used. Both web apps keep their own hand-written, Zod-parsed clients (as before); the schemas mirror the generated contract.

### Seller Center
| operationId | Missing | What the web app does today |
|---|---|---|
| `getSellerStoresByStoreIdForecasts` | No export or CSV operation for forecasts (watermarked or otherwise). | No export button is shown. Nothing is generated client-side, so no unwatermarked copy can leak. |
| `getSellerStoresByStoreIdForecasts` | Reason codes are free strings (not an enum in the contract). Known codes come from `packages/domain/src/forecasting` and the build use case. | Unknown codes render a neutral sentence; the raw code is never shown as copy. |
| `getSellerStoresByStoreIdForecasts` | The 503 `demand_forecasting_disabled` problem code is not listed in the OpenAPI responses. | Any 503 is shown as "forecasting is paused", not as a generic error. |
| `listStoreChannels` / `connectStoreChannel` | No disconnect or rotate operation for store channels (`disconnectSellerChannel` covers only `/v1/seller/channels/{channelId}`). `status` is a free string. | Connect and list only; status shown as the server states it. |
| `connectStoreChannel` | The format of `token_ref` / `kms_key_ref` (how a seller obtains a KMS reference) is not documented; only 8 to 256 characters. | The form accepts opaque references only and says never to paste a secret. A conservative pattern (no spaces) is enforced client-side. |

### Admin Console
| operationId | Missing | What the web app does today |
|---|---|---|
| (none) creator commissions | No admin read for commissions. `listCreatorCommissions` is `/v1/creator/commissions` (creator bearer). | The Creators page says there is no endpoint and shows nothing. |
| `listCreatorsForReview` | No search, cursor or count; `limit` max 50. | First 50 per status filter. |
| `listCreatorPayoutsAdmin` | No server-side flag in the payout row saying whether the current admin may approve; the page compares `created_by` with `/v1/admin/me` `user_id`. | Approve is disabled for the creator of the payout; the API still answers 403 `dual_approval_required` as the authority. |
| `approveCreatorPayout` and friends | No `approval_id` linkage to `/v1/admin/approvals` (dual approval is "a different admin than created_by"). | No approval ID field on the Creators page. |
| `adminEvaluateRankingGuardrails` | Result is not persisted or listed. | The result is shown once after submit (redirect with query parameters, validated by Zod). |
| `adminListPlusPlans` | None for the family and student editor: `kind` and `seat_limit` exist on the admin plan and the publish request. | Editor offers kind and seats (2 to 8, family only). `student` verification price rules are not in the contract. |
| `getAdminKillSwitches` / registry | The kill-switch list now covers all 53 registry keys. The admin view-model pins `PHASE2_SWITCH_KEYS` and the label and effect text to `packages/feature-flags` in `phase3.test.ts`, so a new registry key fails the unit test until it has AR and EN copy. | n/a |

## Mobile Home banner, Stores list and Shop everything (/shop-all)
Uses only `search` (`filters` JSON with `world` and `store_ids`, max 30) and `listStores`.
| operationId | Missing | What the app does today |
|---|---|---|
| `search` | No sort parameter and no per-store facet counts. | Sort sheet orders the pages loaded so far (labelled); store sheet shows no counts. |
| `listStores` | No item count per store; no follow/unfollow toggle in the stores port. | Rows show verified discount and rating only when present; no follow toggle on Home rows. |
| `listPublicDrops` | Drop has no store name. | Banner shows an empty store line when unknown; no drop detail route, banner opens Explore. |
| (none) store page | No dedicated store route exists. | Store rows open `/shop-all?store=<id>` (catalogue filtered to that store). |

## Mobile Home offers carousel and quick actions (features/home-banners)
| operationId | Missing | What the app does today |
|---|---|---|
| `listHomeBanners` (GET /v1/home/banners) | CLOSED. `ApiHomeBannersPort` calls the generated operation, maps wire art hints (warm/cool/neutral/festive) to hero art, drops malformed items via `normaliseBanners`, anchors the slide clock to `server_time`, sends `If-None-Match` and reuses the last list on 304, and returns the last good list (or empty) on any error. | Production builds show the carousel when the backend returns items. |
| analytics catalog | CLOSED. `home_banner_impression` / `home_banner_click` (owner catalog, consent `analytics`, props `banner_id`, `position`, `sponsored`, `cta_kind`) are in the catalog, taxonomy and `docs/analytics/events.md`; `ClientBannerAnalytics` forwards to the consent-gated `ClientAnalytics.track`. | Nothing is sent before analytics consent. Remaining: sponsored banners have no server-side billing event (no `ad_impression` equivalent), so sponsored reporting relies on consented client events only. |
| search/category cta route | CLOSED. `search` and `category` ctas route to `/shop-all` with `q`, `category`, `min`, `max` (piastres converted to EGP, min floored, max ceiled). The plain `/search` route still reads only `q` (unchanged, not needed by banners). | n/a |
| voucher cta | No voucher detail route. | Opens `/rewards`. |
| `/drops` | Route accepts `id` and is used as is. | n/a |

## Mobile Home layout v2 (features/home: offers, drops carousel, departments, filter)
| Area | Gap | What the app does today |
|---|---|---|
| Department boxes (Women, Men, Kids, Accessories) | RESOLVED by migration 0086 and `docs/plan/department-attribute.md`: product `department` enum, `departments` search filter, `department` on summaries. Women, Men and Kids open `/shop-all?department=<x>`; Accessories opens the `accessories` category (text fallback). | Live once the API is deployed; the shop-all route ignores an unknown value. |
| Upcoming drops | `listPublicDrops` has no store name (already listed above). | Cards show the drop title and a countdown from server time; the store line is empty until the API sends it. |
| Home filter: clothes category and budget on "New drops" | `ProductSummary` in the Home payload carries no category id, so the catalogue rail cannot be filtered client side. | When a category or budget is active the "New drops" rail is fetched through `GET /v1/search` with `category_ids` and price bounds (same SearchFilter as Shop everything); World still scopes by store kind on the client. Budget stays in memory only. |
| Multi-category route param | `/shop-all?category=` accepted one slug. | `parseShopRouteParams` now accepts comma-separated slugs (max 30). |

## Shop everything: New Arrivals / In Stock chips (board v4 screen 2)
`SearchFilter` has no `new_arrivals` or `in_stock` fields. The chips render only under `__DEV__` and are visual toggles with no effect on results; hidden in production. Needs wire fields `new_since` and `in_stock_only` on `GET /v1/search`.

## Search: New In / In Stock chips and Sort / Brand / Size pills (board v4 screen 7)
`SearchFilter` has no `new_since`, `in_stock_only`, `brand_ids`, `sizes` or `sort` fields. "New In" and "In Stock" are optional dev-only `newIn` / `inStock` filter fields honoured only by `InMemorySearchPort` (`supportsDevFacets`); the chips are hidden in production and the wire adapter ignores them. The Sort / Brand / Size pills open the existing filter sheet (no sort, brand or size sections yet). Result `brand` and the dev photo slot are optional `SearchItem` fields that real adapters leave unset (brand then falls back to the store name). Needs wire fields on `GET /v1/search` plus a `brand` on the product summary.
