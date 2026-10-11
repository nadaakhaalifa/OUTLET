# Phase 1 wave 1: independent review

Scope: catalog, stores, wishlists, cart, inventory, sizing, notifications, persistence (specs in `docs/specs`, code under `apps/api/src/modules`, `apps/api/src/platform/db`, `packages/domain/src/{catalog,cart,inventory,sizing}`, migrations 0012 to 0018).
Method: read each spec's acceptance section, mapped it to test names, grepped the code for rule violations (non-determinism, `any`, ts-ignore, non-null `!`, floats, console/logger, social proof), and ran the suites. No source was edited.

## What was actually run (seen output)

| Command | Result |
|---|---|
| `vitest run src/catalog src/cart src/inventory src/sizing` in `packages/domain` | 11 files, 178 tests passed |
| `vitest run` over the 7 modules + `src/platform/db` in `apps/api` | 27 files, 582 tests passed |
| `tsc --noEmit` in `apps/api` and `packages/domain` | no output (clean) |
| `eslint` on all module and platform paths | no output (clean) |

Not run: `tooling/db/inventory-concurrency.sh` (needs a real Postgres 16 binary), Stryker (sizing spec itself says it crashes in the sandbox), coverage. Domain >= 90% coverage and mutation >= 80% are therefore UNVERIFIED by this review.

## Cross-cutting findings (ranked)

1. **Only inventory has a database adapter.** `grep Kysely` finds production persistence only in `modules/inventory` and `platform/db`. Catalog, stores, wishlists, cart, sizing and notifications run solely on in-memory adapters. Their migrations are tested in isolation (PGlite), but no repository has ever executed against its migration, so column-name, type and RLS-context drift between code and SQL is undetectable. ADR-0020/persistence.md step 4 requires the Kysely adapter to pass the same port contract test; that does not exist for six modules.
2. **Privacy fragments deliverable missing.** `docs/privacy/fragments/` does not exist; no `<module>.yaml` was written. Instead `docs/privacy/data_inventory.yaml` shows as modified in the working tree, which the task forbade. All new tables appear to be present in it (checked every `CREATE TABLE` in 0012..0018; only the partition child `size_recommendation_log_default` is absent, which is acceptable). Who edited it is not attributable from here; confirm no wave-1 agent broke the "do not edit" rule and that PII classes were reviewed (wishlists `budget_amount`, `note`, `notification_push_tokens`).
3. **Mutation >= 80% (A2.10) on reservation is not set up.** Stryker configs exist for `cart` and `sizing` only. `packages/domain/src/inventory` (reservation, claim, TTL policy) has none, and ledger/promotions are out of scope here. The sizing score (94.3%) is from a hand-rolled harness, not Stryker, and the cart spec records no score at all.
4. **Inventory concurrency acceptance is not in the automated test suite.** The 100 units / 10,000 attempts scenario lives in a shell script that I could not run and that is not referenced from any CI workflow I could find (grep for `inventory-concurrency` in yml/json/md returned nothing). Vitest uses single-connection PGlite, so SKIP LOCKED concurrency and "no unit left RESERVED" are unproven by `pnpm test`.
5. **B5 legal identity is not on the product page wire.** `catalog/adapters/wire.ts:64` emits only `seller_legal_identity_visible: boolean`. B5 and the catalog spec (D-1) say every listing shows legal name, register number, tax card, governorate. The store detail does return identity, but the PDP does not. Open until OpenAPI gains the object.
6. **Cross-module ports have only fakes.** Cart's `CART_CATALOG` defaults to `FakeCatalog` (empty, with a 4,500 piastre delivery fee in the fixture); sizing, wishlists, stores activity, notifications consent/contact are similarly stubbed. Safe as shipped (empty by default), but if the integrator registers `CartModule.forRoot()` with no overrides the bag silently returns nothing priced. Registration should fail loudly without a real port.
7. **Stock-pool ownership leak risk is documented, not tested at HTTP level for buyers**: inventory exposes only `PUT /v1/seller/skus/{id}/stock`; reservation use cases have no HTTP route, so no buyer authz test applies. Fine, but the integrator must not expose them without one.

No violations found by grep in non-test code: no `Date.now`/`Math.random`/`new Date()` in domain or application (randomness only behind `EntropyPort` and in the sizing dev cipher adapter), no `any`, ts-ignore or non-null assertions (two `eslint-disable no-control-regex` lines in wishlists/notifications templates are justified), no floats on money (money is bigint piastres; `Number(...)` hits are cursor, GTIN, stock-count parsing), no console/logger output, no hard-coded social proof strings.

## Catalog

Spec: `docs/specs/catalog.md` s10.

| Acceptance criterion | Covered by |
|---|---|
| Empty or Latin-only Arabic title: 422 `arabic_text_required`, nothing created | http `rejects missing, Latin-only and blank Arabic titles with 422 and creates nothing`; domain `property: a title without any Arabic letter is always rejected`; migration `requires an Arabic title...` |
| `minor_defect` without photo: 422 | http `requires defect photos for minor_defect`; domain `requires defect photos for minor_defect...` |
| minor_defect + photos + image + priced SKU publishes to `active` | http `publishes only when the gate holds and reports every unmet requirement` |
| CSV dry run vs real run, per-row report | http `defaults to dry run, never mutates, and is repeatable`; `applies only valid products on a real run and the result equals the dry-run report` |
| Same file dry run twice equal | same `repeatable` test; domain `is pure: identical bytes give identical reports` |
| Seller A on seller B's product: 404 identical to missing | authz `404 for another tenant, identical to a missing object` |
| No evidence: badge `none`, `reference_price: null` | http `shows no reference price, percent or badge without pricing evidence, and live stock rules`; domain `never shows a reference price or discount without a complete verified claim`; migration `has no was-price... column` |
| Stock 3 shows 3, stock 40 null | domain `property: units_left only for stock 1..5`; http live stock rules (the exact 3/40 pair is covered by the property, not as a literal example) |
| Decreasing chart: `non_monotonic` | domain `property: reversing a strictly increasing chart is non_monotonic` |

Not covered or weak:
- No HTTP-level test that a size chart attached to a product is validated on publish (only the pure validator is tested).
- D-1 (legal identity object) open, see cross-cutting 5. D-2 `error_report_url` is a `data:` URI; no signed-URL path exists.
- No Stryker config (not mandated for catalog, but price display logic in `public-view.ts` guards a legal rule and would merit one).
- Taxonomy (categories/brands) has no read endpoints (D-5), so shoppers cannot discover valid `category_id` values.

Rule check: Arabic mandatory enforced in domain and DB; money bigint; every route in the authz matrix test (`covers every route registered by the module`); formula-injection guard on CSV; no cell values echoed.

## Stores / worlds

Spec: `docs/specs/stores-worlds.md`.

| Acceptance criterion | Covered by |
|---|---|
| world=local only local visible; everything is union without duplicates across pages | `local shows only visible local stores...`, `paginates with an opaque cursor without repeats...`, property `covers every item exactly once...` |
| Suspended store: absent everywhere, 404, appears under `hidden` with reason | `never lists suspended, draft, seller-suspended...`, `answers 404 identically...`, `hides a suspended favourite with an explanation and restores it on reinstatement` |
| No favourites + my_stores: empty with `hint.suggested_world = everything` | `starts empty, My Stores shows the widen hint, then follows the saved order` |
| 31 ids 400 unchanged; 30 ok with order | `accepts 30 and rejects 31 at the boundary`; property `any accepted replace has dense unique positions and at most 30 rows` |
| new-counts 3, then 0 after seen, repeated seen no-op | `counts activity after last_seen_at, resets on seen, and seen is idempotent` |
| KYC APPROVED to SUSPENDED hides all stores; REINSTATE restores | `hides every store of a seller whose KYC is suspended and restores them on REINSTATE`; `seller-lifecycle.test.ts` |
| Every route: 401, wrong audience 401, suspended 403, other user's object 404 | `negative authorization` it.each over all 6 routes plus `another user's favourites are unreachable...` |

Not covered or weak:
- The spec lists 31 as "400"; the code returns 400 from Zod and relies on a domain 422 as defence in depth; behaviour matches the test comment but the spec text should say so.
- No wrong-role (non-shopper) 403 test, but there is no role distinction on these routes (shopper grant only); the grant check is covered only implicitly by the audience test. Wishlists tests it explicitly (`403 for an actor without the shopper grant`); stores does not.
- Sort `trending`, `new_drops`, `fastest_delivery` rely on stats columns no producer writes yet (deviation 3); only dev seed populates them. `last_seen_at` counters rely on `store_activity_events` that only a test hook appends (in-memory.ts:53).
- Name sort is code-point order, not Arabic collation (deviation 7) although the test is named `sorts by Arabic name ascending`; the name overstates.
- `store_viewed` / `world_selected` are client events, not emitted here; fine.

Rule check: hidden-favourite messages carry `ar` and `en`; no rating or discount without evidence (`exposes only verified-style data`, `publicDiscountPct` property). No violations.

## Wishlists

Spec: `docs/specs/wishlists.md`.

| Acceptance criterion | Covered by |
|---|---|
| Want + cool-off: `cool_off_until` exactly +24 h, null after | domain `is exactly 24 hours after adding, only for enabled Want lists...`; http `computes the 24 h cool-off on the server and drops it when the time has passed` |
| User B on A's list: 404 for read, update, delete, share, add item | `list is scoped to the caller`, `an item id from another list of the same owner is 404`, and the per-route 404 assertions (lines ~150, 247, 573). Share and add-item-to-foreign-list are covered by the objectRoutes it.each |
| Revoked token 404 immediately, same body as never-issued | `issues a hashed 128-bit token, serves the shared view with no PII and revokes immediately`, `expires links and rotates tokens` |
| 21st shared read from one IP: 429 | `rejects malformed tokens with 400 and rate-limits enumeration to 20/min per IP` |
| Gift wrap: `price_hidden` and no price | `gift wrap hides prices, omits ghosts and never exposes an address` |
| Delisted: owner sees ghost with null price, shared omits | `keeps a delisted product as a ghost with no current price`, `gift wrap ... omits ghosts` (shared omission is asserted only under gift wrap; confirm for a plain share) |
| Plain cut: no alert; verified drop: exactly one even if delivered twice | `emits verified price drops once, never for a price rise, and ignores unknown signal kinds` (replays the same event id; a second event with a different id for the same claim is not tested) |
| 7 days / 6 none / 1 day | domain `fires date alerts only at exactly 7 and 1 Cairo days`; http `emits date alerts at 7 and 1 days, once each` |

Not covered or weak:
- Replay with a new `event_id` but the same `claim_id` or an unchanged price is untested; dedupe is keyed so it likely holds, but not proven.
- The rate limit is declared via `@RateLimit(... "closed")`; the test proves the platform limiter is wired, not that the key is the real client IP rather than a spoofable `X-Forwarded-For`. That depends on the platform limiter, not verified here.
- Master prompt s8 items not built, correctly deferred but not tracked in the spec: chip-in group gift card, gift purchase to hidden address token, "Buy" turning into "Remind me tomorrow" UI rule (server provides `cool_off_until` only).
- Deviations 1 to 3 (budget amount stored locally, `ProductSummary.price` required, ambiguous `hide_prices_from_owner`) are open decisions; deviation 3 changes a privacy-visible semantic and needs product sign-off before launch.
- Budget amount stored on `wishlists` is P2/P3 ambiguous (DPO flag). The lint rule "budget tables not importable by promotions/ads" is not applicable yet but should cover `wishlists.budget_amount`.

Rule check: events carry no title, nickname or amount (`carries no title, nickname or amount in event payloads`); no fake timers (cool-off derived from server clock); share tokens hashed 128-bit. No violations.

## Cart / bag

Spec: `docs/specs/cart.md`.

| Acceptance criterion | Covered by |
|---|---|
| A 1,950 + 60 unlocks, fee 0; B 2,100 free | domain `store A 1,950 + a 60 EGP item unlocks free delivery`, `store B at 2,100 EGP alone is free`; http `store A 1,950 + a 60 EGP item unlocks; store B 2,100 alone is free` |
| Plus member all groups unlocked, `plus_member: true` | `Plus member: every group unlocked, plus_member true` |
| 51st line 422, 11th unit 422 | http `rejects the 11th unit of a SKU with 422`, `rejects the 51st line with 422 and still merges at 50`; migration `caps a bag at 50 lines` |
| dropped / rose / none | http `shows dropped, rose and none; never a reference price on the bag`; domain `is honest in both directions` |
| Threshold change reported at quote | http `quote reports the previous and current threshold, and no change when equal`; domain `is null when unchanged or unknown, reported when different` |
| Foreign line 404 identical; 401 no token; seller token 401; suspended 403 | `cart.authz.test.ts`: `never exposes another user`, `... is 404, identical to a missing id, and has no side effect`, `a seller_api token is 401, a suspended subject is 403`, `every controller route is in the matrix` |
| Property tests (non-negative, sum, monotonic, remaining) | `pricing.property.test.ts` (6 tests, names match each invariant) |

Not covered or weak:
- Spec s6 "price rose since you added" is covered; "bundle suggestions" and "move to wishlist with intent" are not implemented (no endpoint; OpenAPI has none).
- `free_delivery_unlocked` and `add_to_bag` are client events, nothing server-side to test; consistent with spec line 64.
- Threshold rule "after item-level discounts, before vouchers and credit" is tested only with undiscounted prices; there is no discount input in the module yet, so the rule is vacuously true. Flag for checkout wave.
- Concurrency: `retries three times then reports a conflict` covers optimistic locking in memory; the SQL repository does not exist (cross-cutting 1).
- Stryker config present, score not recorded in the spec.

Rule check: money bigint, `assertNonNegative`, non-integer quantity throws; Arabic name present in fixture store summary; no stock numbers shown. No violations.

## Inventory

Spec: `docs/specs/inventory.md` s10, ADR-0005.

| Scenario | Covered by |
|---|---|
| 1 Concurrent reserves never oversell (100 units, 10k attempts) | **Only** `tooling/db/inventory-concurrency.sh` (not run here, not in CI). In vitest: domain/application `never oversells and keeps every invariant under random operations`, `available rows never exceed free stock even with seller decreases`, PGlite `all-or-nothing across SKUs...`, `sweeps expired reservations...`, differential `returns the same outcomes and levels for 200 seeded operations` (3 seeds). Single connection, so real concurrency is not exercised |
| 2 Multi-SKU all-or-nothing, shortfall names B with 1 | domain `is all-or-nothing across SKUs and reports every shortfall`; PGlite `all-or-nothing across SKUs, and a failed attempt leaves no reservation behind` |
| 3 Fawry pool, 24 h, drop SKU refused | `Fawry draws from the Fawry pool for 24 h and never from STANDARD`, `refuses a drop SKU for Fawry and serves it from the drop pool otherwise`, `moves stock to the Fawry pool and Fawry holds never touch STANDARD` |
| 4 Cut below promised: succeeds, oversell recorded, held order claimable | http `lowering stock below promised units is accepted and recorded as an oversell, never silently`; `honours reserved orders on a decrease and records the shortfall`; `negative seller adjustment honours reserved orders and records an oversell penalty`. "no new reservation can be made" has no explicit assertion by name |
| 5 Other store's SKU: 404 identical | http `another store`, `is idempotent, version guarded, and never lets one tenant touch another`, PGlite `refuses a SKU that belongs to another store`, `hides levels from other stores and from shoppers` |
| Authz | 401 unauth, buyer audience 401, garbage 401, support 403, shopper grant 403, missing scope 403, suspended 403 (stock.controller.test) |

Not covered or weak:
- Scenario 1 as stated is not reproducible from `pnpm test`; see cross-cutting 4. The spec's own finding that a prior version failed 1 run in 3 shows that a few vitest runs prove nothing.
- No mutation config (cross-cutting 3).
- No explicit test that a reservation attempt is refused (`insufficient`) after a decrease below promised units.
- Per-user/per-device purchase limits not built (spec open Q2); drops hoarding is unmitigated until the admission module.
- Seller `set` touches STANDARD pool only (open Q3); a seller with a Fawry allocation sees a total that does not equal what they set. Real user-facing inconsistency pending product decision.
- Reserve path statement timeout (2 s), PgBouncer and `application_name` tagging are not exercised (platform spec says PGlite cannot verify).
- Pool-sweeper schedule (pg_cron every 30 s) is not wired; only the use case exists.

Rule check: "real stock only at 5 or fewer and never zero" tested; no fake counters; no PII in oversell events. No violations.

## Sizing

Spec: `docs/specs/sizing.md`.

| Acceptance criterion | Covered by |
|---|---|
| Two `too_small` in brand X shift up one step, explanation cites 2 | api `shifts up after two too_small in the same brand and cites the count (acceptance)`; domain `two too_small in the same brand shifts one size up and cites the count` |
| No validated chart: 404 `fit_unavailable` | api `returns 404 fit_unavailable when the store has no validated chart` |
| Waist 300: 400; inches stored cm x2.54 rounded 0.1 | domain `rejects a waist above 250 cm`, `accepts a plausible body and rounds to 0.1`, `converts inches to cm...`; api `rejects impossible measurements with a pointer and does not store anything` |
| Child with DOB: 400 | api `children hold only measurements and a nickname: date of birth or photo is a 400`; migration `has no date of birth, photo or plaintext measurement columns` |
| No measurements consent: 422 | api `requires the measurements consent for measurements and usual size...`, `stops using measurements the moment the consent is withdrawn` |
| 19 vs 20 events community fit | domain `is insufficient at 19 and decided at 20`, `19 events give no community fit and no shift`; api `shows community fit only with at least 20 events, with the count` |
| Size is a chart label, confidence in [0,1] | domain `always recommends a size that exists in the chart, with confidence in [0,1]` |
| 49 vs 50 demand cells | domain `keeps 50 and drops 49`; api `returns only cells with at least 50 and never anything personal`; migration `refuses ... a demand cell below 50` |
| Authz every endpoint | `it.each(buyerRoutes)` and `it.each(sellerRoutes)` 401s, `seller write: 403 for a support role`, `another user`, `is tenant scoped: store B never sees store A charts`, `no seller route reaches profiles or feedback` |
| Mutation >= 80% | **Unverified**: Stryker crashed; 94.3% from a custom harness of 194 mutants; integrator must record the official score |

Not covered or weak:
- Master prompt s10 target "calibration ECE < 0.05" and "size-related return rate -10%" are not measurable here (no data); no test or placeholder metric job.
- Fit layer 4 (brand-level size bias) and layer 3 (per-user latent size) are not implemented; the engine is heuristic (ease + item flag + own-history shift). The spec states this implicitly; the master prompt calls for a hierarchical model. Acceptable for wave 1 but should be called out in the Phase 1 plan.
- Measurements consent revocation is tested through the API; retroactive purge of derived `size_recommendation_log` rows on withdrawal is not tested.
- Cipher is a dev in-memory AES-GCM with a random key per process (`in-memory.ts:169`); data would be unreadable after restart. Production KMS envelope adapter missing; test `fails closed with 503 when the cipher is down` is good.
- No `tsc`/lint issues; `size_recommended` event emitted server-side only with product id and confidence (correct, no measurements).

Rule check: Arabic explanation text present for every code (`always carries Arabic text for every code`); P3 fields encrypted bound to profile id and field; no plaintext columns. No violations.

## Notifications

Spec: `docs/specs/notifications.md`.

| Acceptance criterion | Covered by |
|---|---|
| Marketing push without consent never sent (inbox only) | `never sends marketing push without consent; the inbox still gets it`; domain `suppresses marketing without consent`; property `marketing is sent only when consent, preference, caps and quiet hours all allow it` |
| 1 per Cairo day, 3 per rolling 7 days | domain `caps at 1 per day and 3 per week`; app `allows 1 per day and 3 per rolling 7 days`, `a deferred or suppressed message does not consume the cap`, `resets at Cairo midnight, not UTC midnight` |
| 23:30 marketing scheduled 09:00; shipped sent immediately | `defers marketing at 23:30 to 09:00 while transactional goes out immediately`; DST tests (`is correct across the DST start night`, `...end night, in both passes of the repeated hour`) |
| Template without Arabic body cannot activate | domain `cannot be activated without an Arabic body`; migration `will not activate a template without an Arabic body` |
| WhatsApp rejection: transactional goes to SMS, marketing does not | `falls back to SMS for a transactional message`, `never falls back to SMS for marketing`, domain `never sends SMS marketing, whatever the consent flag says` |
| Same event twice sends once | `sends once however many times the same outbox message is delivered`, `returns the earlier request and sends once`, `collapses concurrent identical requests` |
| Cannot read or mark another user's inbox | http `POST /v1/me/notifications/read -> 404 for another user`, `GET ... never returns another user`, `PUT /v1/me/devices/push-token cannot overwrite another user`; migration RLS tests |
| 401 / seller token 401 / suspended 403 on all routes | ROUTES it.each (3 tests) |

Not covered or weak:
- Quiet-hour rule "dropped never delayed past expiry" covered (`drops (never delays)...`); "marketing <= 1 push/day" under multi-channel (push + WhatsApp same day) is not tested: caps are per push channel only in the tests.
- Unsubscribe link/endpoint (`/v1/unsubscribe/{token}`), WhatsApp BSP webhook and admin template CRUD are deferred (deviation 3). PDPL "easy withdrawal" is met in-app through preferences only; any marketing email or WhatsApp template going live needs the unsubscribe route first.
- No real `ConsentPort` adapter (deviation 7): the integrator must bind it. If bound to a permissive stub, marketing consent is bypassed; the module should fail closed (deny marketing) when no consent port is bound. Not verified that it does.
- `notification_push_tokens` store raw push tokens (P2). `keeps tokens, phones and emails out of every stored record` proves log and inbox rows are clean, but the token table itself needs field encryption or at minimum a retention job (none tested).
- Wrong-role 403 N/A (shopper-only routes).
- Recipient contact comes from a fake `ContactPort`; no test of phone masking.

Rule check: preferences default every marketing flag off ("never pre-ticked" tested); SMS marketing hard-off; Arabic default render with EN fallback (`renders Arabic by default, English when asked, Arabic when English is missing`); analytics event carries only `alert_type` and `channel`; bidi/control characters stripped. No PII-in-log violation found.

## Persistence (platform/db, migration runner helpers)

Spec: `docs/specs/persistence.md`.

| Acceptance criterion | Covered by |
|---|---|
| Commit stores state and outbox row; rollback leaves neither | `persistence.test.ts` (17 tests, passed) |
| RLS: foreign owner 0 rows; foreign writes fail; anonymous nothing | same file |
| Idempotent insert: one row, one event | same file |
| `application_name`, `statement_timeout`, identity set inside and absent after | same file |
| Relay ordering, head blocking, DLQ, replay, retry | same file |
| Column maps equal `information_schema` | same file (drift test) |

Test names inside `persistence.test.ts` were not individually enumerated by the grep (they use a different `it` form), so the mapping above is by the spec's own list and the 17 passing tests, not by name. Treat as moderately verified.

Not covered or weak:
- The spec itself lists what PGlite cannot prove: statement timeout enforcement, SKIP LOCKED, PgBouncer transaction-mode behaviour (session-level `SET` vs `SET LOCAL`), real `pg` pool I/O. Only the inventory Postgres 16 script touches a real server, and only for stock.
- Only inventory consumes the kit (cross-cutting 1). `session-context.ts` (`dbSessionContext`) has its own test, but no controller outside inventory passes a session to a DB.
- `Cols` drift test pattern must be replicated per module; none of the other six modules did, so their repositories cannot even drift-test.

## Verdict

Wave 1 is a strong spec-and-domain wave: 760 tests pass, typecheck and lint clean, authz negative tests present on every HTTP route of every module, and no float-money, fake-stock or PII-logging violations were found. It is not yet a persistence wave: six of seven modules have no database adapter. Blocking before integration sign-off: cross-cutting 1 (adapters or an explicit deferral ADR), 2 (fragments or an explicit acceptance of the direct inventory edit), 3 and 4 (mutation config and CI for the concurrency script). Product decisions needed: wishlist `hide_prices_from_owner` semantics, seller `set` vs Fawry pool, PDP legal identity wire shape.
