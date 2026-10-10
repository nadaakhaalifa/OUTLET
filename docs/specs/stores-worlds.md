# Spec: stores, worlds and favourite stores (P-03 subset, P-05)

Status: wave 1, synthetic data only, in-memory adapters, nothing deployed · Spec refs: §3, §19 (KYC), §B5 (legal identity), §B1 (retention, minimisation), §T3 (authz, RLS) · Data model: `docs/data-model/sellers.md` (stores, store_directory_stats), `docs/data-model/catalog.md` (worlds) · Contract: `docs/api/openapi.yaml` operations `listStores`, `getStore`, `replaceFavoriteStores`, `listFavoriteStores`, `getFavoriteStoreNewCounts`, `markFavoriteStoreSeen` · Migration: `packages/db/migrations/0013_stores.sql` · Module: `apps/api/src/modules/stores`

## Flow
1. The shopper app shows a segmented control `Local | Global | Shop Everything | My Stores`. The choice is a client preference; the server is stateless about it. The API takes `world=local|global|everything|my_stores`.
2. `GET /v1/stores?world=&sort=&cursor=&limit=` returns a page of `StoreSummary`. `local` and `global` filter on `stores.kind`. `everything` merges both. `my_stores` returns the caller's favourites in their saved order (or sorted when `sort` is given explicitly).
3. `GET /v1/stores/{storeId}` returns the store page with seller legal identity (B5).
4. `PUT /v1/me/favorite-stores` replaces the ordered list (0 to 30). `GET /v1/me/favorite-stores` reads it. Both use the same `ETag`; the PUT requires `If-Match`.
5. `GET /v1/me/favorite-stores/new-counts` returns, per favourite, how many products or drops appeared since the caller's `last_seen_at` for that store. `POST /v1/me/favorite-stores/{storeId}/seen` advances `last_seen_at` to the server clock.
6. Seller lifecycle (internal use cases, no HTTP in wave 1): `ApplySellerKycEvent` runs the existing `kycMachine` from `packages/domain` and recomputes visibility of the seller's stores; `ChangeStoreStatus` runs the store lifecycle table below.

## Rules
- **Visibility.** A store is shopper-visible only when `status in (ACTIVE, PAUSED)` AND seller KYC state is `APPROVED` AND its legal identity is published (B5, fail closed; the RLS predicate on `stores` does not check this third condition, the application layer does). `PAUSED` is exposed as `vacation` (listings stay visible, ETA is adjusted elsewhere). `DRAFT` and `SUSPENDED` stores, and stores of a seller whose KYC is not `APPROVED`, never appear in the directory, never in `getStore` (404, indistinguishable from missing), and never in search suggestions.
- **KYC wiring.** The module does not redefine the machine. `ApplySellerKycEvent(sellerId, event, ctx)` calls `kycMachine.transition(state, event, ctx)` and stores the result as `stores.seller_kyc_state` on every store of that seller (a cache; the sellers module stays the source of truth when it lands). A suspended seller (`SUSPENDED`, `TERMINATED`) hides every store of that seller. Reinstatement (`REINSTATE`) restores visibility without any manual step. Invalid transitions and guard failures surface as typed domain errors (`InvalidTransitionError`, `GuardRejectedError`), never as a silent no-op.
- **Store lifecycle** (module-local table, tested for reachability): `DRAFT -> ACTIVE`; `ACTIVE <-> PAUSED`; `ACTIVE|PAUSED -> SUSPENDED`; `SUSPENDED -> ACTIVE` (reinstate); `DRAFT -> SUSPENDED` is not allowed. A store cannot become `ACTIVE` unless seller KYC is `APPROVED`.
- **Favourites.** Max 30, unique, ordered; positions are dense `0..n-1`. Only stores currently visible may be added (an unknown, draft or suspended id is `422 unknown_store`, the same answer for all three so existence is not leaked). `PUT` replaces the whole list. Retained stores keep their `last_seen_at`; newly added stores get `last_seen_at = now`, so a new favourite starts at zero new items.
- **Suspended favourites.** A favourite whose store stops being visible stays in the user's list but is omitted from `stores` and listed under an additive `hidden` array with a reason (`suspended` or `unavailable`) and an Arabic-first message. It is dropped by the next `PUT` (replace semantics), and restored in place if the store is reinstated before that.
- **My Stores zero results.** When `world=my_stores` and the visible result is empty, the page carries an additive `hint` with `kind = "widen_world"` and `suggested_world = "everything"` ("one tap to widen", §3). Other worlds never carry a hint.
- **Sort.** `trending` (default), `biggest_verified_discount`, `new_drops`, `fastest_delivery`, `name`. All use keyset pagination with `id` as tie-break, so a page boundary never repeats or skips a store. Null sort keys sort last. `name` uses Arabic name, code-point order (locale collation is a documented follow-up).
- **Never fake data (A2.13).** `max_verified_discount_pct` is `null` unless the derived stats row holds an integer 5..100 written by pricing-integrity; the module re-validates and nulls anything else. `rating` is `null` when `rating_count = 0`. `follower_count` is derived from `user_favorite_stores`, not seeded. `live_drop` is a derived boolean. No timers, no invented stock.
- **Legal identity (B5).** Legal name (AR required), commercial register no., tax card no. and governorate are shown on the store page from the published projection `store_legal_identity_public`. They are P2 at source but public by legal requirement. No signatory, national id, IBAN or KYC document field is ever read by this module. **VERIFY BEFORE LAUNCH** (register row 7): exact fields required by Law 181/2018, and whether sole-trader (natural person) names may be published.
- **Free-delivery threshold** is read from `stores.free_delivery_threshold_amount` (projection of store settings, default 2,000 EGP = `200000` piastres); the cart module remains the evaluator.

## Edge cases
- More than 30 ids or non-UUID ids in the `PUT` body: 400 (OpenAPI `maxItems: 30`, Zod strict). Duplicate ids: 422 `duplicate_store`. The domain also enforces the cap (`too_many_favorites`, 422) as defence in depth.
- Missing `If-Match` on `PUT`: 428. Stale `If-Match`: 412. `If-Match: *` is accepted only when the list is empty (create-if-absent).
- `markSeen` for a store that is not in the caller's favourites, does not exist, or is hidden: 404, same body in all three cases. Calling it twice is a no-op (idempotent); `last_seen_at` never moves backwards.
- Two devices race on `PUT`: the loser gets 412 and refetches. Positions are written in one transaction with deferred uniqueness.
- A store suspended between GET and PUT: the PUT sees it as unknown and returns 422 naming no store.
- Cursor from another sort or world, tampered cursor, expired shape: 400 `invalid_cursor`.
- `limit` above 50 or below 1: 400. Empty directory: empty `items`, `has_more=false`.
- Clock skew: only the server clock is used for `last_seen_at`.
- Right-to-left: names are `LocalizedText` (AR required); the module sorts and returns raw strings and does no layout.

## Data
Migration `0013_stores.sql`. PII classes follow the privacy fragment `docs/privacy/fragments/stores.yaml`.

| Table | Key columns | PII | Notes |
|---|---|---|---|
| `stores` | id, seller_id (logical), kind, slug UK, name_ar/en, status, seller_kyc_state (cache), health_score, verified_badge, free_delivery_threshold_amount | P0 profile, `seller_id` P2 | Trigger blocks seller-role changes to platform columns. RLS: public-read predicate, tenant, platform roles. |
| `store_directory_stats` | store_id, follower_count, max_verified_discount_pct 5..100 or null, rating_avg/count, live_drop, trending_score, last_drop_at, p80_delivery_hours | P0 | Derived cache. Jobs and pricing-integrity write it. |
| `store_legal_identity_public` | store_id, legal_name_ar/en, commercial_register_no, tax_card_no, governorate | P2, public by law | Published projection. Source of truth is sellers. |
| `user_favorite_stores` | (user_id, store_id) PK, position 0..29 (unique per user, deferrable), last_seen_at | P2 (user key) | Cap of 30 is a constraint. RLS owner-only. |
| `store_activity_events` | id, store_id, kind, occurred_at | P0 | Append-only interim feed for new-since-last-visit. |

Indexes: `stores(kind,status)`, `stores(seller_id)`, `store_directory_stats(trending_score desc, store_id)`, `user_favorite_stores(store_id)`, `store_activity_events(store_id, occurred_at desc)`. Deviations from the data model are listed under "Open items".

## API
| Method and path | Auth | Idempotent | Rate limit | Success |
|---|---|---|---|---|
| `GET /v1/stores` | shopper bearer, `shopper:catalog.read` | n/a | 120/min/user | 200 `StoreSummaryPage` |
| `GET /v1/stores/{storeId}` | shopper bearer, `shopper:catalog.read` | n/a | 120/min/user | 200 `Store`, ETag, 304 |
| `PUT /v1/me/favorite-stores` | shopper bearer, `shopper:stores.write` | optional key, `If-Match` required | 60/min/user | 200 `FavoriteStores` |
| `GET /v1/me/favorite-stores` | shopper bearer, `shopper:stores.read` | n/a | 120/min/user | 200 `FavoriteStores`, ETag, 304 |
| `GET /v1/me/favorite-stores/new-counts` | shopper bearer, `shopper:stores.read` | n/a | 120/min/user | 200 `NewCounts` |
| `POST /v1/me/favorite-stores/{storeId}/seen` | shopper bearer, `shopper:stores.write` | optional key | 60/min/user | 204 |

Errors are Problem+JSON via the platform filter. Token scopes in the table are the OpenAPI declarations; scope enforcement is a platform concern (not yet in the guard, see needs).

## Events
- Domain/outbox events are not emitted in wave 1: `store.status_changed` and `store.suspended` (named in `sellers.md`) are not yet in `docs/analytics/event-taxonomy.md`. The use cases return the transition result so the integrator can publish once the taxonomy owner adds them.
- Analytics: `store_viewed` is a client event owned by the app; the server emits nothing. No PII in any log line.

## Failure handling
- In-memory adapters cannot fail; the Postgres adapter (later) uses one transaction per `PUT` and per KYC cascade, and 503 `Problem` on repository errors.
- Stats cache stale or missing for a store: the store still lists, with `max_verified_discount_pct = null`, `rating = null`, `follower_count = 0`, and sorts after stores with data (fail closed on claims).
- Search/index lag is irrelevant here: the directory reads the primary.

## Security and abuse (threat notes)
| Threat | Control |
|---|---|
| API1 BOLA on favourites and `seen` | Every query is keyed by the token subject; another user's data is unreachable. `seen` for a store not in the caller's list is 404. |
| API3 mass assignment | Zod `.strict()` bodies; response serializers are explicit field lists. `FavoriteStoresUpdate` accepts only `store_ids`. |
| API5 function-level authz | Wave 1 has only shopper routes. Platform columns are protected by a DB trigger so a later seller PATCH cannot un-suspend a store. |
| Enumeration of suspended or draft stores | One 404/422 answer for missing, draft, suspended. Directory never lists them. |
| Info leak of who follows a store | Only aggregate `follower_count`; RLS makes favourites owner-only; seller staff cannot read the table. |
| API4 resource consumption | `limit` max 50, cursor max 512 chars, favourites max 30, per-user rate limits above. |
| API6 scraping the directory | Auth required, per-user limits; no email, phone or address in any response. |
| Cursor tampering | Cursor is validated by schema and bound to (world, sort); it carries no authority, only a position. |
| Legal identity over-exposure (P2) | Projection table with fixed public columns; module never reads KYC or sellers tables. |
| LLM / prompt injection | Not applicable; no LLM in this module. Seller-supplied names are rendered as text only. |
| Logging | Log ids and counts only; never names, legal identity or favourites lists. |

## Metrics
Product: world switch rate, My Stores adoption, scoped-session conversion (§3). SLI: `GET /v1/stores` p95 < 300 ms (read SLO), 5xx rate. Guardrails: share of `PUT` returning 412 (multi-device conflicts), hidden-favourite rate, `widen_world` hint click-through.

## Acceptance (Gherkin, becomes E2E)
- *Given* seeded local and global stores, *when* `world=local`, *then* only `kind=local` visible stores return, and `everything` returns their union with no duplicates across pages.
- *Given* a suspended store, *then* it is absent from every world, `getStore` is 404, and a user who had it as a favourite sees it under `hidden` with the reason.
- *Given* a user with no favourites, *when* `world=my_stores`, *then* `items` is empty and `hint.suggested_world = everything`.
- *Given* a user, *when* they PUT 31 ids, *then* 400 and the list is unchanged; with 30, 200 and the order preserved.
- *Given* a favourite with 3 products published after `last_seen_at`, *then* new-counts shows 3; after `seen`, 0, and a repeated `seen` is a no-op.
- *Given* seller KYC `APPROVED -> SUSPENDED`, *then* all its stores vanish; `REINSTATE` brings them back.
- Every route: no token 401, wrong audience 401, suspended account 403, other user's object 404.

## Open items and deviations (report to integrator)
1. OpenAPI is additive-extended in two places that are required by §3 but absent from the schemas: `FavoriteStores.hidden[]` and `StoreSummaryPage.hint`. Both are omitted when empty, so existing clients and schema checks that tolerate absent optional fields keep working.
2. `Store.legal_identity` in OpenAPI lacks `governorate` (B5 requires it). The module returns it. OpenAPI needs the property.
3. `sort` values `trending`, `new_drops`, `fastest_delivery` need derived columns not in the data model (`trending_score`, `last_drop_at`, `p80_delivery_hours`); added to `store_directory_stats`.
4. `Store.free_delivery_threshold` is projected on `stores`; `store_settings` ownership stays with sellers/cart.
5. `stores.seller_kyc_state` is a cache of the seller KYC state until the sellers module migration exists.
6. Store status `PAUSED` maps to the wire value `vacation`; OpenAPI has no `draft`, which is never exposed.
7. Name sort is code-point order, not Arabic collation.

## Wave 2: Postgres adapters (stores, favourites, activity feed)

Status: implemented · ADR-0020 · Code: `apps/api/src/modules/stores/adapters/kysely/**` · Selected by `StoresModule.forRoot(config, { persistence: { runner, session } })`; in-memory stays the default.

**Rules.**
- Reads run under the injected identity. Policy `stores_select` is a public-read predicate: shoppers AND anonymous callers see ACTIVE/PAUSED + APPROVED stores, staff additionally their tenant, platform roles all. Application code still applies `isShopperVisible` (legal identity published) and `hiddenReason`; a module that must explain a suspended favourite has to read under a platform identity, which is why the default wiring session is the caller's choice, not hard-coded.
- `save` is insert (ops/system) or update. Stats and legal identity are rewritten only when they changed, so a seller editing presentation fields never touches platform-written tables. The guard trigger rejects seller changes to status, KYC cache, badge, score, kind, seller and slug.
- Favourites are class A: list/replace work for the session user (or system). `replace` is delete + insert in one transaction; the DEFERRABLE `(user_id, position)` unique constraint makes reorders safe.
- `followerCounts` runs as `system` and returns counts only.
- The activity feed is append-only; `record` is ops/system.

**Edge cases / known limits.** `save` with `legalIdentity: null` deletes the public legal identity row (ops/system only, DELETE policy in 0013). Follower counts come from the SECURITY DEFINER aggregate `store_follower_counts()` (counts only), so the adapter keeps the caller's identity. `numeric(3,2)` rating round-trips through `toFixed(2)`.

**Security.** Tests cover shopper/anonymous/foreign-seller visibility, platform-column guard, tenant-scoped edits, private favourites (read and write), aggregate-only follower counts and feed append denial.

**Acceptance (executable).** `adapters/kysely/kysely.pglite.test.ts` runs `test/contract/repositories.contract.ts` on both adapters, plus RLS and column-drift checks.
