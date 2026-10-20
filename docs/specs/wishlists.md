# Wishlists with intent (spec section 8)

Status: Phase 1 wave 1, synthetic data only, in-memory adapters, nothing deployed · Module: `apps/api/src/modules/wishlists` · Migration: `0014_wishlists.sql` · Data model: `docs/data-model/cart.md` (wishlist entities) · API: `docs/api/openapi.yaml` tag `Wishlists` · Privacy fragment: `docs/privacy/fragments/wishlists.yaml`

The data model housed wishlists inside the cart area (I-67). The code gets its own module (`wishlists`) because its authorization, sharing and alert behaviour has nothing in common with the bag. Table ownership is unchanged.

## Flow
1. Shopper saves a product: `POST /v1/wishlists/{id}/items`. Lists are created first with an intent (`need`, `want`, `treat`, `buy_later_this_month`, `birthday`, `eid_ramadan`, `gift_for_someone`, `custom`), optional target date, optional budget, optional 24 h cool-off (Want only).
2. The shopper browses lists (`GET /v1/me/wishlists`, cursor paginated) and a list with items (`GET /v1/me/wishlists/{id}`, ETag).
3. Updates (`PATCH`) are optimistic: `If-Match` carries the ETag of the detail representation.
4. Sharing: `POST /v1/me/wishlists/{id}/share` returns a URL carrying a 128-bit token, shown once. Only its SHA-256 is stored. `DELETE .../share` revokes it. A new share request rotates (revokes the previous token and issues a new one).
5. A friend opens `GET /v1/shared/wishlists/{token}` (public, 20/min per IP). They see nickname, title, intent, target date and items, never the owner's address or phone.
6. A gift purchase from a shared list ships to the owner's hidden address through an address token. This module defines the port only (`GiftAddressTokenPort`); the buyer never receives an address.
7. Alerts are planned here and sent elsewhere. Signals from catalog and pricing arrive at `HandleCatalogSignal`; a daily job calls `ScheduleDateAlerts`. Both emit `wishlist.alert_due` outbox events. This module never sends a message.

## Rules
| # | Rule | Default (configurable, proposed) |
|---|---|---|
| R1 | Intent is one of the eight values and is immutable after creation | |
| R2 | `title` 1..80 characters after trim, no control characters | |
| R3 | `target_date` is a calendar date, not before today in Africa/Cairo at creation or when changed | |
| R4 | `budget` is a positive EGP amount, integer piastres, at most 10,000,000 EGP (1,000,000,000 piastres). Amount is stored with the wishlist, not in the budget module (see "Deviations") | |
| R5 | `gift_for` is required for `gift_for_someone` and forbidden for every other intent. Nickname 1..40, occasion 0..40, date optional | |
| R6 | `cool_off_enabled` is accepted only for intent `want` (422 `cool_off_requires_want`) | |
| R7 | Cool-off: an item added to an enabled list gets `cool_off_until = added_at + 24 h`, computed on the server from the injected clock. The read model returns `cool_off_until` only while it is in the future, else `null`. Turning cool-off off clears pending timers. There is no client timer and no fake countdown. | 24 h |
| R8 | Item price is the catalog price at the moment of adding (`added_price`); the client cannot supply it | |
| R9 | A product that is not listed cannot be added (422 `product_unavailable`). `sku_pref` must belong to the product (422 `sku_not_in_product`) | |
| R10 | One item per `(wishlist, product, sku_pref)` (422 `duplicate_item`) | |
| R11 | Limits: 50 lists per user, 200 items per list (422 `wishlist_limit_reached`, `item_limit_reached`) | 50 / 200 |
| R12 | Share token: 16 random bytes from the CSPRNG, base64url (22 chars). Stored as SHA-256 hex. Shown once. Optional `expires_at` in the future and at most 365 days out | 365 d |
| R13 | `visibility` is `shared` only while the link is neither revoked nor expired | |
| R14 | Delisted product: the item stays as a ghost (`state = delisted_ghost`, `current_price = null`), computed at read from the catalog. Ghosts are omitted from the shared view | |
| R15 | Gift-wrap flag (`hide_prices_from_owner` on the share request): the shared view sets `price_hidden = true` per item and removes the product price block | |
| R16 | Alert rules below | |

### Alert rules (R16)
| Alert | Fires when | Never fires when |
|---|---|---|
| `price_drop_verified` | catalog or pricing integrity sends a `verified_price_drop` signal whose new price is lower than the item's `added_price` | the signal is a plain seller price cut (no such signal type exists, so it cannot be built) |
| `back_in_size` | `back_in_size` signal for the item's `sku_pref` | item has no `sku_pref` |
| `low_stock` | `stock_level` signal with `1 <= available <= 3` for the item's `sku_pref`, or any SKU of the product if none preferred | `available` is 0 (that is out of stock, not low) or above 3 |
| `date_approaching` | list `target_date` (or `gift_for.date`) is exactly 7 or 1 Cairo calendar days away | any other distance |

Every alert carries a dedupe key (`price_drop:<item>:<claim>`, `back_in_size:<item>:<event>`, `low_stock:<item>:<sku>:<event>`, `date:<list>:<date>:<n>`). The first claim wins; replays are no-ops (at-least-once delivery, idempotent consumer, A2.7).

## Edge cases
- Concurrent PATCH from two devices: second gets 412; client refetches.
- Add the same item twice quickly: second is 422 `duplicate_item`, not a second row.
- Delete a list: items, share token and alert dedupe rows go with it. A previously shared link returns 404 at once.
- Share link expired: identical 404 to unknown and revoked tokens (no oracle).
- Owner suspended or deleted: lists are not served on the shared route (adapter responsibility; in-memory fixtures do not model it, listed as open item).
- Gift list whose date has passed: no alerts (only 7 and 1 days ahead fire).
- Zero items, zero budget fields, maximum title length, Arabic and mixed-direction titles are accepted as plain text.
- Money in the wire is an integer string of piastres; floats are rejected at the boundary.
- A catalog outage on read: `current_price = null`, state computed as `active` (never reported delisted on an unknown); the product block is omitted.
- Eastern Arabic digits in dates are not accepted; `target_date` is ISO `YYYY-MM-DD`.

## Data
Migration `0014_wishlists.sql`. PII classes follow `data_inventory.yaml` (P0 public, P1 internal, P2 personal, P3 sensitive).

| Table | Key columns | Indexes | PII |
|---|---|---|---|
| `wishlists` | `id`, `user_id` FK users, `intent`, `title`, `target_date`, `budget_amount`, `budget_currency`, `cool_off_enabled`, `gift_nickname`, `gift_occasion`, `gift_date`, `share_token_hash` UNIQUE, `share_created_at`, `share_expires_at`, `share_revoked_at`, `share_hide_prices`, `created_at`, `updated_at` | `(user_id, created_at DESC, id DESC)`, partial `(target_date)` where set | P2 |
| `wishlist_items` | `id`, `wishlist_id`, `user_id` (denormalised for RLS), `product_id` (logical FK to catalog, added when catalog lands), `sku_pref_id`, `added_amount`, `added_currency`, `note`, `cool_off_until`, `added_at` | unique `(wishlist_id, product_id, COALESCE(sku_pref_id, nil))`, `(product_id)` | P2 (`note`), P1 |
| `wishlist_alert_dedupe` | `dedupe_key` PK, `wishlist_id` FK cascade, `created_at` | PK | P1 |

RLS: user-owned class A for `wishlists` and `wishlist_items` (`user_id = app_user_id()` or role `system`), per verb with `WITH CHECK`. `wishlist_alert_dedupe` is system only. The shared-token read and the alert jobs run as role `system`; the HTTP layer never lets a client choose that.

## API
Conforms to the existing OpenAPI operations; rate limits from `x-rate-limit`.

| Operation | Route | Authz | Idempotency-Key | Limit |
|---|---|---|---|---|
| listWishlists | `GET /v1/me/wishlists` | shopper, self | n/a | 120/min user |
| createWishlist | `POST /v1/me/wishlists` | shopper, self | optional | 60/min user |
| getWishlist | `GET /v1/me/wishlists/{wishlistId}` | shopper, owner (read) | n/a | 120/min user |
| updateWishlist | `PATCH /v1/me/wishlists/{wishlistId}` | owner (update), `If-Match` | optional | 60/min user |
| deleteWishlist | `DELETE /v1/me/wishlists/{wishlistId}` | owner (delete) | optional | 60/min user |
| addWishlistItem | `POST /v1/wishlists/{wishlistId}/items` | owner (update) | optional | 60/min user |
| removeWishlistItem | `DELETE /v1/wishlists/{wishlistId}/items/{itemId}` | owner (update) | optional | 60/min user |
| createWishlistShareLink | `POST /v1/me/wishlists/{wishlistId}/share` | owner (update) | optional | 10/hour user |
| revokeWishlistShareLink | `DELETE /v1/me/wishlists/{wishlistId}/share` | owner (update) | optional | 60/min user |
| getSharedWishlist | `GET /v1/shared/wishlists/{token}` | public | n/a | 20/min IP, fail closed |

Errors are RFC 9457 problems. Foreign and missing object ids are both 404. Unauthenticated 401, wrong audience 401, suspended 403.

## Events
Outbox (same transaction as the state change in the production adapter; envelope `aggregateType = wishlist`, payload carries ids only, no title, nickname, note or amount):

| Event | Payload |
|---|---|
| `wishlist.shared` | `wishlist_id`, `user_id`, `expires_at` or null, `hide_prices` |
| `wishlist.share_revoked` | `wishlist_id`, `user_id` |
| `wishlist.alert_due` | `wishlist_id`, `item_id` or null, `user_id`, `product_id` or null, `sku_id` or null, `alert_type`, `days_before` or null, `dedupe_key` |

`wishlist.gift_purchased` (data model) is produced by the orders flow and is not emitted here. Analytics events `wishlist_added` (client) and `wishlist_alert_sent` (notifications) exist in the taxonomy; no analytics event is typed in this module.

## Failure handling
- Catalog read failure on GET: degrade as in Edge cases; never fail the read for it. On add: 503 `catalog_unavailable` (cannot record an honest `added_price`).
- Event publish failure after a state change: the production adapter writes the outbox row in the same transaction, so there is no partial state. The in-memory adapter cannot fail.
- Alert signal replay: dedupe key claim returns false, no event, no error.
- Limiter failure on the shared route: fail closed (503), because the route is an enumeration surface.

## Security and abuse
Threat notes (STRIDE, short):
- **Spoofing**: bearer audience `buyer_api` only; suspended actors blocked by the guard.
- **Tampering**: DTOs are strict allow-lists (`.strict()`), prices are never client supplied (API3), `If-Match` prevents lost updates.
- **Repudiation**: guard decisions are audited by the platform sink; share create and revoke emit events.
- **Information disclosure**: BOLA (API1) answered with 404 for foreign ids; the shared view returns nickname, title, intent, date and product summaries only; no user id, no address, no phone, no budget. Hidden recipient address never leaves the users module (port only). Token stored hashed; token only in the creation response; logs never carry it (path param is not logged by the request context).
- **Denial of service**: 20/min per IP on the shared route, cursor limit max 50, 50 lists and 200 items per user, 10 share creations per hour.
- **Elevation**: all `{wishlistId}` routes use `Authorize` with the policy rule `shopper.wishlist.owner`; use cases re-check ownership.
- **Enumeration**: 128-bit tokens; unknown, revoked and expired are byte-identical 404; the IP limit makes online guessing infeasible. Malformed tokens are 400 (format is public).
- OWASP API Top 10 mapping: API1 BOLA, API3 property level, API4 resource consumption, API6 sensitive flow (share), API8 misconfiguration.

## Metrics
Save to purchase conversion by intent, cool-off regret reduction (return rate of cool-off purchases vs control), share link creations and opens, alert CTR (owned by notifications). SLIs: p95 read under 300 ms, shared read p95 under 300 ms.

## Acceptance (Gherkin, becomes E2E)
- Given a Want list with cool-off on, when an item is added, then `cool_off_until` is exactly 24 h after the server time and is `null` once 24 h have passed.
- Given user B and user A's list id, when B reads, updates, deletes, shares or adds an item, then 404 in every case and A's data is unchanged.
- Given a shared list, when the owner revokes, then the same token returns 404 immediately and the 404 body equals that of a never-issued token.
- Given 21 shared reads from one IP in a minute, then the 21st is 429.
- Given a gift-wrap share, then every shared item has `price_hidden = true` and no price.
- Given a delisted product, then the owner sees `delisted_ghost` with `current_price = null` and the shared view omits it.
- Given a plain price cut, then no alert; given a verified price drop below the added price, then exactly one `wishlist.alert_due` even if the signal is delivered twice.
- Given a list dated 7 days ahead, then one `date_approaching` event (days_before 7); on the next day-count 6 none; at 1 day one more.

## Deviations from the data model and OpenAPI (reported to integrator)
1. Budget amount: the data model keeps only `has_budget` (amount in budget module, I-45/I-48). OpenAPI `Wishlist.budget` is a `Money`. The amount is stored locally on the wishlist as a P2 column and is never imported by or exported to the budget module. DPO to confirm P2 vs P3 (already marked `verify` in the inventory).
2. `SharedWishlist.items[].product` is `ProductSummary` whose `price` is required. Under gift wrap the price block is removed, which violates the schema. Proposed: make `ProductSummary.price` optional in the shared variant.
3. `hide_prices_from_owner` is ambiguous (the spec says the gift-wrap flag hides prices from the recipient). Implemented as: viewers of the share link see no prices. The owner's own detail view is unaffected so budgets still work. Open question for product.
4. `ShareLink.url` base: this module uses an injectable base URL (default `https://outletnk.invalid/w`); production config key to be added to `AppConfig`.
5. Wishlist `visibility` has only `private` and `shared`; the data model's `LINK` maps to `shared`.

## Wave 2: Postgres adapter
- `KyselyWishlistRepository` (`apps/api/src/modules/wishlists/adapters/kysely-store.ts`) implements `WishlistRepository` over migration 0014 with raw SQL and Zod-validated rows (ADR-0020). One transaction per call under the `system` DB role; authorization stays in the policy guard, RLS still protects every other role.
- Exact round-trips: share-token hash is 64-char lowercase hex in the domain and 32 raw bytes (`bytea`) in the table via `decode`/`encode`; budgets and `added_price` are `bigint` read as text and parsed with `BigInt` (tested above 2^53); timestamps travel as ISO strings and read back as epoch ms.
- Cascade: `delete(list)` relies on `ON DELETE CASCADE` for items and alert dedupe keys.
- One shared contract suite (`test/repository-contract.ts`) runs against the in-memory repository and Kysely on PGlite with the real migrations 0001-0015. Contract note: after `save`, `updated_at` is the database clock (touch trigger), so equality ignores `updatedAtMs`.
- Wiring: `WishlistsModule.forRoot(config, { repository })` accepts the adapter; the default remains the in-memory fixture. Outbox publishing for `WishlistEvent` is not part of this wave.
- Not verified on PGlite: concurrent claims of the same dedupe key (the PK makes it safe on Postgres; run on PG16 before relying on it).

## Persistence invariants (security)
- `save` is owner-scoped (`where id and user_id = actor`); a save for a list owned by someone else changes nothing.
- Revocation is monotonic: a save carrying the same share token hash never clears an existing `revoked_at`, so a stale snapshot cannot resurrect a revoked link. Only a new token (share/rotate) replaces it.
- Covered by the shared repository contract (in-memory and Kysely/PGlite).

## Guest browsing note (ADR-0055, behind `flag.guest_browsing`)
Saved items of a signed-out shopper live on the device only (intents need, want, treat, later; no server write). After sign-in `POST /v1/me/guest-merge` adds them to the account's default list of that intent (the oldest list with that intent; created with an Arabic title if none, within the 50-list cap), deduplicated by product (a product already in the list is a duplicate, nothing changes), each list capped at 200 items, with the SERVER price as `added_price`. Bag lines that cannot stay in the bag (over the 50-line cap, sold out) land in the `want` list. Products that are unknown, delisted or without a price are counted as `unavailable` and not saved. Gift, birthday and custom lists and sharing stay account-only.
