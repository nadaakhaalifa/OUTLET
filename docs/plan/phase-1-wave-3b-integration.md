# Phase 1, wave 3b integration

Integrator pass over the standalone modules finished after the wave 3 integrator: price-integrity, referrals, tax-eta, seller-analytics, admin, reviews and privacy (privacy files were not touched, another agent owns them), plus verification that orders, returns, promotions, fulfillment and search are wired.

## What changed

1. **`packages/domain/src/index.ts`**: added namespaced exports `orders`, `fulfillment`, `priceIntegrity`, `referrals`, `tax`, `sellerAnalytics`, `admin`, `reviews`, `privacy` (`returns`, `promotions`, `search` already existed). The flat `export *` of orders and fulfillment stays because tested callers use it; nothing was renamed.
2. **Bridges** now import from `@outlet/domain` (reviews, seller-analytics, referrals `rules.ts`, price-integrity `domain.ts`, tax-eta, admin). Because the namespace objects cannot be spread, each bridge re-exports with `export import X = ns.X` (values, classes) and `export type X = ns.X` (types; generics `KAnonymized<V>`, `KCell<V>`, `KGated<T>`, `Validated<T>` are written out). Aliases only, no behaviour change.
3. **Layer violations**: moved `seller-analytics/domain/ports.test.ts`, `seller-analytics/application/consume.test.ts` to `seller-analytics/test/`, and `referrals/application/referrals.test.ts` to `referrals/test/`, fixing relative imports. No rule was weakened.
4. **`apps/api/src/app.module.ts`** now registers PriceIntegrity, Referrals, TaxEta, SellerAnalytics, Admin and Reviews (Orders, Returns, Promotions, Fulfillment, Search were already registered).
   - In-memory default; `createPersistence` Kysely adapters when `adapters !== in-memory-dev`.
   - Explicit DEVELOPMENT FIXTURES, dev config only (`config.adapters === in-memory-dev && env !== test`) for tax-eta (FakeEtaPort, signed store, delegations, events), seller-analytics (audit, event source, product-store lookup) and reviews (all seven ports). Production passes none, so boot fails with the module's MissingPorts error.
   - Catalog prices: `PriceBridgeModule` binds `PRICE_BLOCK_READER` (price-integrity service) into the catalog fixtures' price reader after boot. Price-integrity evidence wins; the catalog fixture reader answers SKUs with no history (absent = no verified claim).
5. **`apps/api/src/persistence.ts`**: `PersistenceWiring` extended with `priceIntegrity`, `referrals`, `tax`, `sellerAnalytics`, `admin`, `reviews` (outside the listed edit paths, needed for step 4; additive only).
6. **Authz matrix** (`apps/api/test/authz-matrix.test.ts`, entered from `src/authz-matrix.test.ts`): 59 DELEGATED rows (admin, tax-eta, seller-analytics, reviews, referrals, price-integrity), each pointing at the owning module's HTTP suite. The delegated probe now supports PUT and accepts 200 for public GET lists. `docs/security/authz-matrix.md` has a new "Wave 3b operations" table.
7. **OpenAPI**: 55 operations added (paths for admin approvals, elevations, pii-views, flags, kill-switches, kyc, moderation, tax console, seller invoices, seller analytics, reviews, Q&A, UGC reports). New tag `Reviews`.
8. **Privacy docs**: processor `eta_portal` (category `tax_authority`, added to `tooling/privacy/inventory-schema.mjs`) added to `data_inventory.yaml` and to the three tax tables; `generate-ropa.mjs` regenerated ropa.md, processors-register.md and retention-schedule.md.
9. `.stryker-tmp-*` directories under `packages/*`: none present after the cleanup find.

## Verification (real outputs)

| Check | Result |
|---|---|
| `pnpm -r typecheck` | all packages and apps Done, no errors |
| `pnpm lint` | `eslint .` clean |
| `apps/api` vitest, authz matrix | 373 passed |
| `apps/api` vitest, whole package | 125 of 126 files, 2398 of 2399 tests passed; the one failure `tax-eta/test/application.test.ts > daily reconciliation` passes in isolation (run twice), so it is a load-dependent flake, not caused by this change (see leftovers) |
| dependency-cruiser (Node 24) | 1 error, 1 warning: the error is `privacy/domain/bridge.ts -> packages/domain/src/privacy/index.ts` (privacy is the other agent's; the `privacy` namespace now exists, the file only needs `@outlet/domain`). The warning is the pre-existing orphan `packages/domain/stryker.price-integrity.mjs` |
| `node tooling/api/validate-openapi.mjs` | OK, 222 operations, 118 writes, 5 public, 193 schemas |
| `node --test tooling/privacy/test/inventory.test.mjs` | 31 pass, 0 fail |

## Left over

- **Privacy bridge** (`apps/api/src/modules/privacy/domain/bridge.ts`): switch to `import { privacy } from "@outlet/domain"` with the same alias pattern; this clears the last depcruise error. The privacy module's 12 routes (docs/specs/privacy-center.md) are not yet in the DELEGATED matrix or OpenAPI because the module is mid-edit; add rows once its controllers register (a row for a route that does not exist fails the "no stale rows" test).
- **OpenAPI detail**: the new operations carry correct auth, idempotency, rate-limit, error and parameter metadata, but request and response bodies are generic closed or open objects. Field-level schemas (Zod to OpenAPI) are still to be generated; the controller Zod schemas are authoritative. Cursor and limit parameters are declared only where the controller implements them (tax documents, seller invoices, product reviews and Q&A lists).
- **Production boot**: `adapters !== in-memory-dev` still fails on purpose: Catalog and PriceIntegrity throw `NoProductionAdaptersError` in that mode (existing behaviour), and tax-eta has no real ETA portal adapter, no outbox publisher or seller-analytics audit/source and reviews classifier adapters yet. Those need real implementations, not fakes.
- **Flaky test**: `tax-eta/test/application.test.ts` daily reconciliation fails under full-suite load (`rep.rejected` 0 vs 1) but passes alone; likely order or timing in the in-memory ETA queue. Worth investigating by the tax-eta owner.
- `eta_portal` role, DPA and TIA are `unknown`/`not_started` and flagged `verify: true`.
