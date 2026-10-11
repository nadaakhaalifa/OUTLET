# Phase 1 wave 2: spec and parity audit

Scope: catalog, stores, wishlists, cart, sizing, notifications (Kysely adapters under `apps/api/src/modules/*/adapters`, in-memory adapters, contract suites, migrations 0012 to 0018, `apps/api/src/persistence.ts`, `app.module.ts`).
Method: read every Kysely adapter against its migration, read each contract suite and its two runners, ran the six module suites, and reproduced three suspected defects against a real migrated PGlite (scratch scripts outside the repo). No source edited.

## What was run (seen output)

| Command | Result |
|---|---|
| `vitest run src/modules/{catalog,stores,wishlists,cart,sizing,notifications}` in `apps/api` | 32 files, 677 tests passed |
| scratch: upsert an existing line in a 50-line cart (migrations 1..15) | `cart ... already holds 50 lines` (reproduced) |
| scratch: `UPDATE fit_feedback SET profile_id = NULL` as `app_user` (migrations 1..17) | `permission denied for table fit_feedback` (reproduced) |

Not run: Postgres 16 server, Stryker, coverage. Suites are green, so the findings below are gaps the suites cannot see.

## Checklist verdicts

| Check | Verdict |
|---|---|
| Kysely and in-memory run the SAME contract suite | Yes for all six (catalog, stores, wishlists, cart: shared `describe*Contract` factory in two runner files; sizing and notifications: one file, two fixtures). Caveats: catalog masks `updatedAtMs` (F8); cart contract has no near-cap case (F1). |
| SQL column names match migrations | Yes. No drift found. Catalog and stores additionally have a column drift map (`CATALOG_COLUMNS`, `STORES_COLUMNS`); the four raw-SQL modules rely on the contract suites exercising every statement, and they do. |
| RLS context set per transaction | Set on every transaction, but wrong identity: see F2, F3. |
| No float money | Pass. Money is bigint end to end, read as text, written as `amount.toString()::bigint`. Only `Number(...)` on money-adjacent data is `rating_avg` (a rating, not money). |
| bigint round-trips | Pass above 2^53 in cart (`9007199254740993`), wishlists (budget and item price), catalog (`list_price_amount`), stores (`free_delivery_threshold_amount`). |
| PDP legal identity matches B5 | Fails: F5. |
| Cart fails loudly | Boot guard and 503 on catalog outage pass. Silent omission on read fails: F4. |

## Findings, ranked

### F1 (High, reproduced) Full bag (50 lines) cannot be saved with any change
`cart_lines_enforce_cap` (0015) is a `BEFORE INSERT` trigger and counts existing rows. `KyselyCartRepository.save` upserts EVERY line with `INSERT ... ON CONFLICT (id) DO UPDATE`; Postgres fires the BEFORE INSERT trigger before conflict resolution, so with 50 rows every upsert raises `check_violation`. Failure scenario: a shopper with 50 lines changes a quantity or moves one line to saved-for-later; the save always fails with a 500 (a removal is fine, it drops to 49 first). Also, adding the 50th line when the new line is ordered before an existing line in `cart.lines` fails, because the count is already 50 when the later existing lines are upserted. The in-memory adapter has no such trigger, so the contract suite passes; the only Kysely cap test sends 51 fresh lines and expects failure.
Fix: write only changed or new lines (diff against loaded lines), or make the trigger fire only on rows that do not already exist; add a contract case "bag with 50 lines accepts a quantity change" run on both adapters.

### F2 (High) Four of six modules never exercise RLS or grants; one grant is already wrong
Wishlists, cart, sizing, notifications hardcode `set_config('app.role','system')` in every transaction (`inTx`/`tx`), so every row policy takes the `OR app_role() = 'system'` branch, and their contract tests connect as the PGlite superuser (no `SET ROLE app_user` anywhere in their pglite tests; only the migration tests drop role). Consequence: grants and policies of 0014, 0015, 0017, 0018 are untested against the adapters. First casualty (reproduced): `KyselyFeedbackRepository.detachProfile` runs `UPDATE fit_feedback`, but 0017 grants `app_user` only `SELECT, INSERT, DELETE` on `fit_feedback`. Production (pool role is a member of `app_user`, per `createPgDatabase`) will get `permission denied` when a size profile is deleted. Fix: add `GRANT UPDATE (profile_id)` plus an owner/system UPDATE policy in a new migration, and run these four contract suites under `SET ROLE app_user`.

### F3 (High) Request identity never reaches the database; owner/tenant isolation is application-only
`persistence.ts` passes `STORES_SYSTEM_SESSION` and `CATALOG_SYSTEM_SESSION` to the stores and catalog runners, which are the two modules that DO support per-request sessions and DO have app_user RLS tests (`kysely.pglite.test.ts`, "RLS context"). In production they run as `system`, so the tested foreign-seller and shopper-visibility policies are inert. The file header admits "request-scoped RLS sessions is open work". RLS is therefore not a second line of defence for any of the six modules; PolicyGuard and resolvers are the only barrier (A2.3 / T3 say both). Needs an ADR deciding how the session is propagated (AsyncLocalStorage `SessionProvider`) and a wave-3 item.

### F4 (High) Cart silently drops lines instead of failing, including on the checkout quote
`buildBagView` filters out lines whose SKU the catalog does not return (`known`), and `continue`s past groups whose store is missing. `lineCount` is `cart.lines.length`, so it still counts the dropped lines (spec cart.md line 33 says "not counted"). `QuoteBagForCheckout` reuses this view, so checkout is quoted for a subset of the bag with no signal. Dropped lines also keep occupying the 50-line cap and have no visible id, so the shopper cannot remove them (spec admits "pruning job gap"). Fix: surface `status: "unavailable"` for unknown SKUs, make the checkout quote return a typed `lines_unresolved` error, and count only rendered lines.

### F5 (High) PDP does not enforce B5; the identity source is a fixture
B5: "Every listing shows seller legal identity ... mandatory". `GetPublicProduct` returns the product with `seller_legal_identity_visible:false` when any of the four fields is blank or the store is unapproved, and the item stays purchasable (acknowledged as open in catalog.md D-1). Compounding: the catalog's `StoreReader` is `fixtures.stores` even when persistence is provided, so production identity does not come from `store_legal_identity_public`; that table also allows NULL `commercial_register_no` and `tax_card_no` (0013) while B5 needs all four, and the stores domain type mirrors the NULLs. Two representations exist (`SellerLegalRecord.legalName` vs `LegalIdentity.legalNameAr`) with no mapper. Fix: make `store_legal_identity_public` CR, tax card NOT NULL for ACTIVE stores (or a publish gate), refuse `active` publish and hide from the public read model when identity is incomplete, and bind `StoreReader` to the stores module.

### F6 (Medium) Kysely adapters for catalog, wishlists, sizing, notifications are unreachable in production
`createPersistence` runs only when `adapters !== "in-memory-dev"`, but `CatalogModule`, `WishlistsModule`, `SizingModule`, `NotificationsModule` all throw `NoProductionAdaptersError` first in that case. Result: the code is fail-closed (good, loud), yet the persistence wiring cannot boot and the "wave 2" adapters are exercised only by their own tests. When these guards are relaxed, note what will silently come with it: `DevAesGcmFieldCipher` (process-random key, P3 measurements unrecoverable after restart), in-memory measurements consent, in-memory fit catalog and order lines, `InMemoryCatalogRead` and owner profiles for wishlists, `FakeProvider` senders. Each needs the same "throw without a real port" guard cart has.

### F7 (Medium) Migrations 0012 and 0017 were edited in place after being committed
Wave 1 commit f86d11f contains both files; the working tree changes them (nullable `catalog_import_products.product_id`, DELETE grants and policies, new `size_demand_events` table). The runner stores a SHA-256 per file and raises `checksum_mismatch` for any database that already applied them. Rule: expand/contract only, applied files immutable. If no environment has applied f86d11f this is harmless; otherwise add `0019_*` instead. Confirm and record.

### F8 (Medium) Adapter parity is masked, not proven, for timestamps
Catalog contract compares via `comparable()` which zeroes `updatedAtMs`; Kysely takes `updated_at` from the touch trigger (DB clock) while in-memory keeps the domain clock. Cart `save(_nowMs)` and wishlists note the same ("after save it is the database clock"). Any consumer using `updatedAtMs` (ETag input, `updated_at` on wire, optimistic UI) sees different values per adapter. Either drop the trigger for these columns and write the domain time, or assert in the contract that `updatedAtMs` is monotonic only.

### F9 (Medium) Scheduled notifications are at-most-once
`KyselyRequestRepository.claimDue` flips `SCHEDULED` to `ACCEPTED` and nulls `scheduled_for` inside a short transaction, then the worker processes outside it. A crash between claim and send leaves the request `ACCEPTED` forever with no lease, reaper or retry; transactional messages (order, security) are affected too. Add a `claimed_at` lease and a reclaim sweep, or process inside the claim transaction.

### F10 (Medium) Unbounded reads on hot or job paths
`KyselyWishlistRepository.listWithDates()` loads every dated wishlist of every user; `itemsByProduct` is unbounded; stores `all()` and `followerCounts()` read and aggregate the whole table per directory request; sizing `cellsForStore` aggregates all weeks. Add pagination/cursor or materialised stats before real volume.

### F11 (Low) Demand k-anonymity enforced only on the read path
`GetSizeDemand` reads raw `size_demand_events` via `cellsForStore` and suppresses cells below 50 in application code, while the comment and migration say sub-50 cells "cannot exist in the table". A second caller of `DemandRepository.cellsForStore` would leak small cells. Read from `seller_size_demand_agg` (RLS-protected, CHECK >= 50) instead.

### F12 (Low) Smaller items
- Catalog `replace` deletes ALL `product_media` rows but re-inserts images only; `kind = 'video'` rows are lost (hydrate also filters to images).
- Catalog list cursor round-trips `created_at` through milliseconds; rows created with sub-millisecond DB-default timestamps could be skipped across pages (all inserts here pass an explicit ms value, so latent).
- Wishlist item and list caps (counts) are check-then-insert with no DB constraint; a concurrent pair can exceed them (the unique index only covers duplicates).
- Sizing: `size_recommendation_log` has no writer, so calibration (ECE metric) cannot run.
- Cart `GET /v1/cart` performs writes (`setUnavailableSince`, event publish) and a publish failure turns a read into a 500.

## Suggested order
F1 and F2 (grant) are small and block real use; F4 and F5 are product-correctness and legal; F3 needs a decision (ADR) before wave 3; F7 needs a yes/no from whoever ran wave 1 migrations.
