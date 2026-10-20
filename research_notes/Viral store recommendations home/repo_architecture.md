# Repo architecture for a "Recommended stores" home module (engagement + virality)

All paths relative to /Users/nadakhalifa/OUTLET. Read-only investigation. Line numbers from the working tree at 2026-10-16.

## Home "stores" section today

### Takeaway
The section is already a 3-to-5-row list on Home, fed by `GET /v1/stores?sort=trending`, but the server `trending_score` has NO production writer (only dev seeds), so "trending" is effectively seed data or zeros. Followers are the only real per-store popularity metric. The app shows up to 5 rows (not 3) and pins live drops first.

### Cited Findings (repo)
- Section order constant: `HOME_SECTION_ORDER = ["offers","quickActions","departments","drops","rails","stores"]` at apps/mobile/src/features/home/model.ts:259; asserted in home-layout.test.ts:12.
- Render block: apps/mobile/src/features/home/HomeScreen.tsx:270-282: `homeRows.length > 0` -> `SectionTitle t("shopAll.storesTitle")`, `homeRows.map(... <StoreListRow .../>)`, then a "See all stores" PressScale (`testID home-see-all-stores`) routing to `/stores` (toStores, line 144). Row tap -> `router.push({pathname:"/shop-all", params:{store:id}})` (openStore, line 174).
- Data source: `homeRows = useMemo(() => homeStoreRows(dir.rows))` (HomeScreen.tsx:134); `dir = buildDirectory(stores, w.world, w.sort)` (line 123); `stores` come from `useWorld` `w.state.stores` (line 122) which loads via `ApiWorldsPort.listStores()`.
- `homeStoreRows(stores, max = 5)` in apps/mobile/src/features/shop-all/model.ts:142-148: filters `status==="active"`, sorts by `liveDrop` first, then `trendingRank`, stable index; slice(0,5). Default is 5 rows, not 3 (the 3-row note is not what the code does; check home.test/ HomeScreen tests if "three" came from a design board).
- `ApiWorldsPort` apps/mobile/src/features/worlds/api.ts:11-33: calls generated `client.listStores({query:{world:"everything", sort:"trending", limit:50}})` paged by `collectPages(...,10)`; `trendingRank: i + 1` is simply the server order index; `newestDropAtMs: null`, `deliveryDays: null` (wire lacks them; doc comment lines 5-9; docs/plan/api-client-gap.md:17,52,162).
- `StoreSummary` shape: apps/mobile/src/features/worlds/model.ts:12-26 (id, name, kind, status, maxVerifiedDiscountPct, rating, followerCount, liveDrop, trendingRank, newestDropAtMs, deliveryDays, isFavourite).
- Row component `StoreListRow` apps/mobile/src/features/home/banner.tsx:52-75: avatar (`StoreAvatar`), name, optional "LIVE" eyebrow, meta line from `worlds.discountUpTo` and `shopAll.ratingValue`; i18n keys `shopAll.storesTitle`/`seeAllStores` at packages/i18n/src/en.ts:311-312 (AR counterpart in ar.ts).
- States: whole Home `state.status` loading -> `GridSkeleton` (HomeScreen.tsx:~231), error -> `ErrorState` with retry (offline variant) (~228). The stores block itself has NO skeleton/error: it simply does not render when `homeRows` is empty (stores load in a separate hook `useWorld`; failure there yields `stores=[]` silently, HomeScreen.tsx:122). World-level empty states: `WorldEmpty` (parts.tsx:164-175) for noStores/noFavourites/favouritesHidden; "widen" action.
- World scoping: `buildDirectory` (worlds/model.ts ~line 100+) filters active stores by world (local/global/everything/myStores) then sorts with `compareStores` (model.ts ~65-92).

### Inferences
- A new module slots between `rails` and the existing `stores` block (or replaces its ordering) without changing `HOME_SECTION_ORDER` semantics; the section order test must be updated.
- Missing per-section loading/error is a gap to fix when adding the new module.

### Gaps
- I did not locate a test asserting exactly three rows; `max` default is 5.

## Stores, worlds, `sortStores('trending')`, existing popularity metrics

### Takeaway
Client `trending` is purely `a.trendingRank - b.trendingRank` (rank = server list position). Server `trending` sorts by `store_directory_stats.trending_score DESC`. That column exists but nothing in production code computes it.

### Cited Findings
- `sortStores` apps/mobile/src/features/stores-directory/model.ts:62-72: `if (sort === "trending") r = a.trendingRank - b.trendingRank;` tie-break by normalized name then id. `filterStores` lines 49-60. `DirectorySort` comment lines 11-12: "the wire returns trending order".
- `compareStores` apps/mobile/src/features/worlds/model.ts: same trendingRank logic.
- Server: apps/api/src/modules/stores/domain/directory.ts:13 `trending: { dir: "desc", key: (s) => s.stats.trendingScore }`; `orderingFor` application/directory.ts:57-59 defaults `trending` (my_stores -> favorite_position); controller adapters/public.controller.ts:66-79 (keyset cursor, `limit` default 24).
- Table `store_directory_stats` packages/db/migrations/0013_stores.sql:80-94: `trending_score integer NOT NULL DEFAULT 0 CHECK (>=0)`, index `store_directory_stats_trending_idx (trending_score DESC, store_id)`; columns follower_count, max_verified_discount_pct, rating_avg/count, live_drop, last_drop_at, p80_delivery_hours, refreshed_at. Described as "Derived cache. Jobs and pricing-integrity write it" (docs/specs/stores-worlds.md:42).
- Writers: only `KyselyStoreRepository.save` (adapters/kysely/repositories.ts:149-160) writing whatever `store.stats` holds; values originate from `provisioning/provision-store.ts:22` (0) and `adapters/dev-seed.ts:72-82` (synthetic 90/70/70/50/10/5). No batch job, outbox consumer or worker computes trending_score, rating, live_drop or last_drop_at (grep over apps/api/src found none outside tests and seeds). STATUS: dev-fixture-only.
- Followers: `follower_count` derived from `user_favorite_stores` via SECURITY DEFINER `store_follower_counts()` (repositories.ts:221-226; directory.ts:30-47). This is the only live per-store popularity metric. Favourites cap 30 per user (stores-worlds.md:17).
- Store health: `stores.health_score`, `verified_badge` (stores-worlds.md:41); `seller_health_scores` incl. `return_rate` (docs/data-model/sellers.md:169-175,241) - spec/data-model; check migration before relying on it.
- No per-store referral, share, view or conversion metric exists. `store_activity_events` (id, store_id, kind, occurred_at) is an interim append-only feed for new-since-last-visit (stores-worlds.md:45).
- Mobile fixture stores: `FIXTURE_STORES` (worlds/model.ts) and `devOutletsFixture()` (stores-directory/dev-fixtures.ts, guarded by `__DEV__`; physical outlets, null in production).

### Inferences
- The cleanest plug-in point is to have the new job write `store_directory_stats.trending_score` (or a sibling table) so `/v1/stores?sort=trending` and Home both improve with no mobile change.

### Gaps
- No geographic dimension on stores in the directory; `store_legal_identity_public.governorate` is the seller's registered governorate (stores-worlds.md:22), not shopper demand cohort.

## Analytics foundation

### Takeaway
Typed, consent-aware event catalogue exists; the needed engagement events mostly exist but are not all emitted. Warehouse (ClickHouse + dbt) is SPEC ONLY.

### Cited Findings
- Catalogue: packages/analytics/src/analytics-events.ts (`defineEvent`), generated doc docs/analytics/events.md (header says generated; regenerate with `node packages/analytics/scripts/generate-events-doc.mjs`). Rules: P0/P1 flat props only.
- `store_viewed` (analytics-events.ts:88-93; events.md:13): client, consent `analytics`, props `store_id, world, source`. Spec stores-worlds.md:63: "store_viewed is a client event owned by the app; the server emits nothing."  grep of apps/mobile/src finds NO emitter for `store_viewed` or `world_selected` (only consent plumbing in apps/mobile/src/features/consent.ts, workspace.ts).
- `add_to_bag` (events.md:30): `product_id, sku_id, store_id, quantity, source`. `wishlist_added` (events.md:27): `product_id, intent` (no store_id; join via product). `order_delivered` (events.md:35): server, strictly necessary, `seller_order_id, delivery_attempts` (join to store). `referral_shared` (events.md:49): `surface` only, no store/product/share id. `referral_converted` (events.md:50): `referral_id`, server.
- No follow/unfollow-store analytics event, no store-share event, no store-impression event. `recommendation_impression` (events.md:55; consent `personalization`) has `module, model_version, item_count, personalized` and is the closest impression pattern.
- Consent purposes (packages/analytics/src/purposes.ts:4-14): marketing_push, marketing_whatsapp, marketing_email, analytics, personalization, budget_insights, measurements, location_precise, cross_border_ml. No purpose for "declared shopping preference". `STRICTLY_NECESSARY` allowed only for server-origin events.
- Warehouse: docs/data-model/analytics-ingest.md:6,131-135 (ClickHouse, dbt marts, `warehouse_models`, k>=50, ingest queue) and docs/specs/seller-analytics.md:81 ("ClickHouse serving out of scope for v1"). The only code reference is apps/api/src/production/unconfigured.ts:32 `"analytics.warehouse": { kind: "external", note: "ClickHouse event source" }` (Unconfigured, fails closed per ADR-0029). No dbt project, no ClickHouse DDL found. Seller analytics v1 is served from Postgres (migration 0028_seller_analytics.sql).
- k-anonymity precedent: `K_ANONYMITY_MIN = 50` apps/api/src/modules/sizing/adapters/kysely-store.ts:322; `materializeAggregates(week, k)` rejects k < 50 (lines 367-368). seller-analytics spec: constant, counted on DISTINCT `shopper_key`, "no parameter to lower it" (docs/specs/seller-analytics.md:35); geography cells governorate k>=50 (line 31).

### Inferences
- Initial batch must run in Postgres (like sizing/seller analytics) reading an events table, not ClickHouse.

### Gaps
- Not verified: whether a Postgres `analytics_events` landing table exists for ingest (see migration 0028 and modules/analytics); needs a follow-up check before choosing source tables.

## Personalisation and privacy plumbing

### Takeaway
No gender field exists in the live schema. Age band and locale exist. A self-declared "shop for" preference would be new personal data requiring consent/purpose, inventory, RoPA and DPIA updates.

### Cited Findings
- `gender_pref` appears only in docs/data-model/users.md:63 (`user_profiles`, "nullable, optional"); grep of packages/db/migrations and apps/api/src finds no `gender_pref`/`user_profiles` (doc-only).
- Users age: migration 0047_auth_hardening.sql:5-16 adds `age_band ('18_20','21_plus')`, `limited_capacity`, `dob_ciphertext` (P3, field-encrypted). Locale: `locale ('ar','en')` in seller auth 0053:20; user locale per spec §1.
- Addresses: migration 0050_addresses.sql: `coverage_governorates`, `coverage_cities`, address `governorate_code`/`city_code` (plain P2 columns, header line 10). No "district" level in the coverage tables beyond city (cities keyed by governorate_code+code). So a governorate x city cohort is feasible from the default address; "district" is not modelled as a lookup (check line 59-74 for any district column before promising it).
- Personalization: spec §13 toggle `PATCH /v1/me/settings {personalization:false}`; recommendations controller takes `personalized` (apps/api/src/modules/recommendations/adapters/recommendations.controller.ts:27,87-93,118) and returns `personalized` flag; in-memory ranker uses `baselineScore`/`popularity-v1` when false (adapters/in-memory.ts:150-153). Ranking feature vector schema rejects user features when not personalized (modules/ranking/domain/schemas.ts: `user_features_present_when_not_personalized`, strict keys; `forbiddenFeatureKeys`).
- Budget isolation lint: .dependency-cruiser.cjs:61-83 (`budget-isolated-from-targeting-and-ranking`, `budget-isolated-from-ranking-domain`; paths apps/api/src/modules/budget/, packages/domain/src/budget/). A new store-recommendation module must not import budget; add it to the `from` list if it lives outside ranking domain.
- Privacy artefacts: docs/privacy/data_inventory.yaml (CI fails on untagged column per master prompt B1), ropa.md, dpia-*.md (budget, fit, fraud, stylist; none for engagement ranking), retention-schedule.md. Runtime inventory snapshot apps/api/src/modules/privacy/application/inventory.snapshot.ts:194 already tags `store_directory_stats` (trending_score P1, not_personal). New tables must be added to the snapshot and per-module fragments (docs/privacy/fragments/*.yaml pattern per stores-worlds.md:37).

### Inferences
- A "shop for" preference (e.g. women/men/kids/all) needs: (a) new column on `user_profiles` (to be created), class P2, optional, user-deletable, included in DSAR export; (b) consent purpose `personalization` (existing) is the least-new route - a new purpose changes the B1 purpose list and consent UI; (c) data_inventory + RoPA row + DPIA addendum; (d) never used as a sensitive inference; it is self-declared and optional; (e) never sent to sellers, and cohort aggregates stay k>=50.
- Governorate cohort from the default address is P2 processing; use the coarse code only, at job time, never stored per user in the aggregate.

### Gaps
- Not checked: whether `users`/`profiles` tables carry district; whether a consent UI string set exists for a new purpose.

## Ranking spec and per-store data

### Takeaway
Spec and domain code already define diversity, 5% exploration and price-trust/seller-health features at PRODUCT level; nothing ranks STORES. Per-store health fields exist in data model; return rate/rating are partially derived.

### Cited Findings
- Master prompt: docs/haul-master-prompt-v3.md §20.5 (two-stage ranking, diversity <=2 consecutive per store, Thompson exploration capped 5% of impressions, bot filtering, budget fit never stored as feature), §20.6 (recommendations), §20.4 Buy Box.
- docs/specs/phase2/05-recommendations-history.md:10,58 (Thompson Beta(clicks+1, misses+1), hard cap floor(5% * list), none for lists under 20); docs/specs/phase-3/ranking-v2.md:16 (exploration none for bot score >= 700 permille). ADR-0023 recommendation retrieval store.
- Code: packages/domain/src/ranking/features.ts (names incl. `seller_health`, `price_trust`, `store_affinity`, `return_rate`), pipeline.ts (EXPLORATION_CAP_PERCENT), apps/api/src/modules/ranking (`ranking.controller.ts`, `kysely-store.ts`, shadow/eval, migrations 0079/0080), recommendations module (migration 0040). `kill.ml_ranking` registered (packages/feature-flags/src/registry.ts:~33).
- Per-store data: `stores.health_score`, `verified_badge`; `seller_health_scores(return_rate...)` (sellers.md:169-175); `store_directory_stats.rating_avg/count`, `max_verified_discount_pct`, `live_drop`, `last_drop_at`; price trust score via price-integrity (`price_claims.trust_score`, spec §9.4).

### Gaps
- Exact writers of `health_score` / `seller_health_scores` not traced; treat as spec-level until confirmed.

## Anti-gaming primitives and plug-in points

### Cited Findings
- Referral fraud graph: apps/api/src/modules/referrals/domain/rules.ts re-exports `detectSelfReferral`, `clusterSizeOf`, `isClusterSuspicious`, `suspiciousClusters` from packages/domain referrals; migration 0026_referrals.sql stores device and payment fingerprints only as SHA-256 hex (header line 10; `payment_fingerprint_hash` line 34).
- Bot scoring: `isBotRequest` / `BOT_SCORE_THRESHOLD_PERMILLE` (ranking bridge.ts) excludes bot traffic from exploration/eval.
- Verified purchase: reviews module (migration 0030) verified-purchase only; `order_delivered` is a server, strictly-necessary event (ground truth, hard to fake).
- Price-integrity enforcement ladder (spec §9.5, module price-integrity): demotion/suspension; a store ranking job should read suspended/demoted state and exclude it (stores must satisfy `isShopperVisible`, stores/domain/store.ts, used in application/directory.ts).
- Kill-switch pattern: ADR-0028 (polarity: `true` allows, default false blocks); registry packages/feature-flags/src/registry.ts KILL_SWITCHES/PHASE2_KILL_SWITCHES with `description` stating blocked behaviour; admin web kill-switch view apps/admin-web/src/view-models/killswitch.ts. New switch suggestion `kill.store_recommendations`.
- Batch pattern: modules `retention` (application/purge.ts), sizing `materializeAggregates`, workers composed in apps/api/src/main.worker.ts, outbox relay (packages/outbox, migrations 0004/0008).

## Proposal (minimal build)

1. Events (packages/analytics, add + regenerate events.md): 
   - `store_impression` (client, consent `analytics`): `store_id, module, position`.
   - `store_followed` / `store_unfollowed` (server, strictly necessary, from `PUT /v1/me/favorite-stores` diff): `store_id`.
   - `store_shared` (client, `analytics`): `store_id, surface`; extend `referral_shared` or add `store_id?` optional.
   - Wire the already-defined `store_viewed` in the mobile store/shop-all screen (currently not emitted). `add_to_bag`, `order_delivered`, `referral_converted` exist; reuse.
   - Cohort not carried in events (no governorate in props, per P0/P1 rule); the batch joins pseudonymous shopper key to coarse governorate server-side.
2. Aggregate: `store_engagement_daily(store_id, day, cohort_governorate, cohort_segment, viewers_distinct, impressions, ctr_num, follows_net, add_to_bag_distinct, delivered_orders, referral_conversions_distinct, returns, refreshed_at)`, PK (store_id, day, cohort_governorate, cohort_segment); P1 aggregate, no shopper key stored. Rows with `viewers_distinct < K` (K = 50, reuse `K_ANONYMITY_MIN` pattern, not lowerable) rolled up to governorate then national; segment dimension dropped first. Plus `store_recommended_cache(cohort_key, rank, store_id, score, computed_at)`.
3. Score: Bayesian-smoothed, capped, rank-normalised: `score = w1*log1p(distinct_add_to_bag) + w2*follows_net + w3*delivered_not_returned + w4*referral_conversions_distinct(capped per referrer) ...` decayed (half-life 7d), multiplied by gates: store visible, price-trust and health above floor, no active enforcement. Anti-gaming: count DISTINCT shopper keys, per-device/IP/payment-fingerprint dedupe (reuse referral cluster rules), exclude bot-scored, count conversions only after return window or delivery (`order_delivered`), winsorise, cap any single actor's contribution to 1. Exploration for new stores <=5% slot (Thompson, reuse ranking pipeline constant), diversity <=1 store per kind in top slots optional.
4. Batch + cache: nightly worker (main.worker.ts pattern, retention/sizing style) -> table; Redis/HTTP cache per cohort with ETag; fallback chain cohort -> governorate -> national -> existing trending order -> hide module (never fake).
5. API: `GET /v1/stores/recommended?governorate=&district=&shop_for=&limit=` (shopper bearer, `shopper:catalog.read`, 120/min/user, ETag); response = `StoreSummary` items + `cohort_level: district|governorate|national` + `basis` (no raw metrics). Add to docs/api/openapi.yaml (additive), regenerate packages/api-client, note in docs/plan/api-client-gap.md. Params validated with Zod strict; governorate from codes in `coverage_governorates`; ignore client cohort if personalization off -> national.
6. Mobile: new `ApiRecommendedStoresPort` in features/stores-directory or worlds; `useRecommendedStores`; Home block reusing `StoreListRow`/`SectionTitle` with own skeleton, hide-on-empty, error-hide; update `HOME_SECTION_ORDER` and home-layout.test.ts; emit `store_impression` (consent-gated). i18n (packages/i18n ar.ts first, then en.ts): `home.recommendedStoresTitle`, `home.recommendedStoresA11y`, `home.recommendedBasisGovernorate` (e.g. "popular in {{governorate}}"), `home.recommendedBasisNational`. No fake counts shown.
7. Privacy: optional `shop_for` self-declaration under purpose `personalization`; data_inventory + RoPA + DPIA addendum; exclude budget modules (lint rule extension).
8. Kill switch `kill.store_recommendations` (blocked default per ADR-0028) + OpenFeature flag; 503 -> app hides module.
9. Tests: unit/property (fast-check) for score monotonicity, one-actor cap, sybil (N devices same fingerprint cluster counts once), bot exclusion, no negative scores; k-threshold test (cohort < 50 rolls up, K cannot be lowered, mutation test on the constant); authz test (unauthenticated 401; no PII in response); contract/Pact for new endpoint; migration test (pglite pattern as in modules/*/migration.test.ts); mobile model tests for homeStoreRows replacement and states; copy-lint (tooling/copy-lint) for no hard-coded social proof; Stryker on the scoring module (>=80%).

## Dev-fixture-only today
- `trending_score` values (dev-seed.ts:72-82), `FIXTURE_STORES`, `devOutletsFixture`, `InMemoryStoresDirectoryPort`, ClickHouse warehouse (Unconfigured), `store_viewed` emission (not wired), `gender_pref` (doc only).
