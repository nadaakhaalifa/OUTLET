# Spec: cart (bag), Phase 1 wave 1, task P-13

Status: DRAFT for review · Spec refs: master prompt §6 (Bag), §7 (price-lock and threshold), §14 (Plus free delivery), §18 (no fake data), A2, A3, T3, T5 · Grounding: `docs/data-model/cart.md`, `docs/api/openapi.yaml` operations `getCart`, `addCartLine`, `updateCartLine`, `removeCartLine`, `getFreeDeliverySuggestions` · ADR-0010 (free-delivery threshold per store before hub consolidation)

Scope: the bag only (carts, cart_lines). Wishlists and product alerts in `docs/data-model/cart.md` are a later task.

## Flow
1. The shopper adds a SKU (`POST /v1/cart/lines`, idempotent). The server reads the SKU's current price and availability from the `CatalogPort`, stores `price_at_add` and the store's free-delivery threshold at add time, and returns the whole bag.
2. `GET /v1/cart` returns one bag grouped by store. Prices, availability, store status, subtotals and free-delivery progress are computed at read from the catalog; none of them is stored.
3. `PATCH /v1/cart/lines/{lineId}` changes the quantity or toggles `saved_for_later`. `DELETE` removes the line.
4. `GET /v1/cart/free-delivery-suggestions?store_id=` returns in-size, in-stock items from the same store, ranked to close the gap.
5. Checkout (another module) calls the exported `QuoteBagForCheckout` use case, which re-prices server side, applies the checkout-time threshold and reports a changed threshold.

## Rules
- One bag per user. No guest bag: every route needs a buyer-audience token (18+ gate is enforced at sign-up).
- At most 50 lines in total (in-bag plus saved for later) and at most 10 units per SKU (ADR: one line per SKU per bag). Adding a SKU that already has a line merges quantity; the merged quantity may not exceed 10.
- Only `IN_BAG`, `available` lines of an `open` store count toward the merchandise subtotal. Saved-for-later and unavailable lines are shown but never charged or counted.
- Free-delivery threshold (ADR-0010): default 200000 piastres (2,000 EGP), configurable per store (`StoreFacts.freeDeliveryThreshold`) and platform wide (`PlatformConfigPort`). It applies to the merchandise subtotal after item-level discounts (the catalog unit price is already net of item discounts) and before vouchers and store credit. VERIFY BEFORE LAUNCH with product and legal (spec §6).
- `unlocked = store open and (Plus member or subtotal >= threshold)`; `remaining = unlocked ? 0 : threshold - subtotal`. A Plus member's delivery fee is 0 for every group, with no minimum.
- The delivery fee shown to the domain is the store's standard fee when the group has billable lines and is not unlocked, else 0. It is an input to checkout, not part of the Cart wire shape (see deviations).
- `price_change`: `dropped` when the live price is below `price_at_add`, `rose` when above, else `none`. Both directions are shown honestly. It is a statement about the shopper's own add, not a "% off" claim, and never produces a strike-through or reference price.
- Re-adding an existing SKU resets `price_at_add` and `threshold_at_add` to the live values (the shopper has just seen them).
- Checkout-time threshold wins: `QuoteBagForCheckout` uses the live threshold and returns `threshold_change {previous, current}` when it differs from `threshold_at_add` of the store's most recently added in-bag line, so the UI can show the change.
- A suspended store's group is `locked_store_suspended`: lines are visible, nothing is counted, and checkout excludes them. Removing them stays possible.
- Suggestions never include SKUs already in the bag, are capped at 20, are empty when the group is already unlocked or the store is suspended, and are ordered: items that alone unlock free delivery by ascending price, then the rest by descending price (fewest items to close the gap).
- Money is bigint piastres, EGP only. Wire amounts are decimal strings.

## Edge cases
- Concurrent edits from two devices: optimistic `carts.version`; the use case retries up to 3 times then returns 409 `cart_conflict`.
- `PATCH` needs `If-Match` (428 when absent, 412 when stale). The bag ETag is a hash of the wire body, so a price move between GET and PATCH yields 412 and the client re-reads.
- SKU sold out or store suspended at add time: 422 `sku_unavailable` / `store_suspended`. Unknown SKU: 422 `unknown_sku`.
- SKU becomes unavailable after add: the line stays, `availability: unavailable`, checkout continues with the rest. The first read that notices emits `cart.line_unavailable` once (tracked by `unavailable_since`); it clears when stock returns.
- SKU delisted from the catalog (no facts): the line is omitted from responses and is not counted (gap: pruning job, see needs).
- Zero, negative, fractional or more than 10 quantity: 400 from Zod.
- A foreign or unknown `lineId`: 404, byte-identical body, no side effect. Non-UUID: 404 at the guard.
- Free-delivery threshold of 0: always unlocked. Threshold changed after add: see checkout rule.
- Empty bag: `groups: []`, `line_count: 0`.

## Data
Migration `0015_cart.sql` (expand only). PII classes in `docs/privacy/fragments/cart.yaml`.

| Table | Key columns | Notes |
|---|---|---|
| `carts` | `id`, `user_id` unique FK users, `currency`, `version`, `updated_at` | class A (owner) RLS |
| `cart_lines` | `id`, `cart_id` FK, `sku_id`, `store_id`, `qty` 1..10, `price_at_add_amount` >= 0, `threshold_at_add_amount` null, `state`, `source`, `source_ref`, `unavailable_since`, `added_at` | unique `(cart_id, sku_id)`; 50-line trigger; RLS through the parent cart |

`sku_id` and `store_id` have no database foreign key in this migration because the catalog tables ship in a later wave (logical references, to be enforced when catalog lands). Deviation from `docs/data-model/cart.md`: uniqueness is on `(cart_id, sku_id)` for both states (one line per SKU), and `threshold_at_add_amount` and `unavailable_since` are new columns.

## API
| Method and path | Auth | Idempotent | Rate limit | Success |
|---|---|---|---|---|
| `GET /v1/cart` | buyer, self | n/a | 120/min/user | 200 `Cart` + ETag, 304 on `If-None-Match` |
| `POST /v1/cart/lines` | buyer, self | required | 60/min/user | 201 `Cart` |
| `PATCH /v1/cart/lines/{lineId}` | buyer, owner of line (policy `cart:update`) | optional key, `If-Match` required | 60/min/user | 200 `Cart` |
| `DELETE /v1/cart/lines/{lineId}` | buyer, owner of line (policy `cart:delete`) | optional key | 60/min/user | 200 `Cart` |
| `GET /v1/cart/free-delivery-suggestions?store_id=` | buyer, self | n/a | 120/min/user | 200 `FreeDeliverySuggestions` |

Errors are Problem+JSON (`validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `cart_conflict`, `line_limit_reached`, `sku_unit_limit_reached`, `sku_unavailable`, `store_suspended`, `unknown_sku`, `rate_limited`).

Deviations from the OpenAPI skeleton (reported, `openapi.yaml` not edited): the `CartGroup` has no `delivery_fee` field although the acceptance text says "shipping fee becomes 0"; checkout owns shipping and receives it from `QuoteBagForCheckout`. `POST` also documents 409 for version conflict.

## Events
- Outbox: `cart.line_unavailable {user_id, cart_id, sku_id, reason}` (taxonomy row exists). Reasons: `sold_out`, `store_suspended`.
- Analytics `add_to_bag` and `free_delivery_unlocked` are client events in the taxonomy; the server emits nothing for them.
- No PII in events beyond the user id the taxonomy already classes P2.

## Failure handling
- Catalog port failure on read: 503 `catalog_unavailable` (Retry-After), never a bag priced from stale data. Writes fail closed the same way.
- Repository conflict: retry x3 with no backoff (in-process), then 409.
- Idempotent POST: the platform interceptor replays the stored response for the same key and 422s on a different body.
- The unavailable-event publish is best effort; a lost publish is re-evaluated on the next read because `unavailable_since` is saved only after publish succeeds.

## Security and abuse
- BOLA (API1): the cart is resolved from the token subject only; line routes authorise through `decide()` on a resolver that returns the true owner, so a foreign id is 404 (indistinguishable from missing). Database RLS repeats the owner predicate.
- Mass assignment (API3): strict Zod schemas on request bodies; responses are explicit serialisers.
- Resource consumption (API4): 50 line cap, 10 unit cap, suggestion cap 20, rate limits above.
- Business flow (API6): bag spam bounded by the caps and per-user rate limits; no price or discount accepted from the client.
- Threat notes (STRIDE): Tampering, a client-supplied price is never read. Information disclosure, no PII in the bag and other users' carts are unreachable. Repudiation, state changes are idempotent and versioned. DoS, caps and rate limits. Elevation, a seller or admin token fails the audience check (401).
- No fake data: no counters, timers or discounts are produced here; `reference_price` and `discount_pct` in suggestions pass through only when the catalog marks the badge `verified_discount`, otherwise they are forced to null.

## Metrics
Multi-store bag rate, free-delivery unlock rate, AOV uplift (A/B), bag read p95 < 300 ms (read SLO), conflict rate (guardrail), `unavailable` lines per read (supply health).

## Acceptance
- Store A at 1,950 EGP plus a 60 EGP item from A: `unlocked`, `remaining` 0, delivery fee 0.
- Store B at 2,100 EGP alone: unlocked.
- Plus member: every group unlocked, delivery fee 0, `plus_member: true`.
- 51st line: 422 `line_limit_reached`. 11th unit of a SKU: 422 `sku_unit_limit_reached`.
- Price drop after add: `price_change: dropped`; rise: `rose`; same: `none`.
- Threshold changed between add and checkout: quote uses the live value and reports `threshold_change`.
- Foreign line id on PATCH or DELETE: 404 identical to a missing id. No token: 401. Seller-audience token: 401. Suspended subject: 403.
- Property tests: totals never negative, group subtotal equals the sum of counted lines, `unlocked` is monotonic in subtotal, remaining + subtotal >= threshold when locked.

## Wave 2: Postgres adapter and boot guard
- `KyselyCartRepository` (`apps/api/src/modules/cart/adapters/kysely-store.ts`) implements `CartRepository` over migration 0015 (raw SQL, Zod rows, one `system`-role transaction per call).
- Concurrency: `save` is a compare-and-set on `carts.version` (`update ... where version = expected`); when it matches, lines are replaced in the same transaction, so a stale writer changes nothing. `setUnavailableSince` does not bump the version. The 50-line cap trigger from 0015 surfaces as a thrown error and rolls the save back.
- Exact values: `price_at_add` and `threshold_at_add` are `bigint` read as text and parsed with `BigInt` (tested above 2^53). A line re-added for an existing SKU under a new id replaces the old row (UNIQUE cart_id, sku_id). Lines read back in `added_at, id` order.
- Shared contract suite (`test/repository-contract.ts`) runs against in-memory and Kysely/PGlite with the real migrations. After `save`, `updated_at` is the database clock (touch trigger), so equality ignores `updatedAtMs`.
- Boot guard: outside `NODE_ENV=test`, `CartModule.forRoot` throws `MissingCartPortsError` unless `catalog` (pricing and stock), `membership` and `platformConfig` are supplied. No silent empty `FakeCatalog`, no implicit "nobody is Plus", no unconfigured threshold. The error names what is missing. In test mode the fixtures are still used.
- Consequence: `AppModule` calls `CartModule.forRoot(config)` with no overrides, so a non-test boot (dev server) now fails until the catalog and membership adapters are wired there (integrator).
- Not part of this wave: outbox publishing of `cart.line_unavailable`.
