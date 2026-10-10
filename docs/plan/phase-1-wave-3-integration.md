# Phase 1 wave 3 integration report

Date: 2026-10-10. Scope: orders, returns, promotions, fulfillment, search (migrations 0019 to 0023), plus the DPO breach register routes and the Postgres 16 runner. Hard limit honoured: no PSP, ledger posting, payout or refund execution anywhere; money outcomes are outbox events and intents for the owner's F-1 checkpoint.

## What was integrated

| Item | Result |
|---|---|
| Module registration | `apps/api/src/app.module.ts` registers OrdersModule, ReturnsModule, PromotionsModule, FulfillmentModule, SearchModule. Dev (in-memory-dev, NODE_ENV=development) passes explicit DEVELOPMENT FIXTURES; `adapters !== in-memory-dev` passes only the Kysely repositories from `createPersistence` and every other port stays a boot error (fail closed). Per-module overrides exist on `AppModuleOptions` for tests. |
| Persistence | `apps/api/src/persistence.ts` builds `KyselyOrderRepository`, `KyselyReturnRepository`, `KyselyPromotionRepository`, `KyselyFulfillmentRepository`, `KyselySavedSearchRepository`; asserted in `persistence.test.ts`. |
| Domain exports | `packages/domain/src/index.ts`: `export * from "./orders"`, `export * as returns`, `export * as search` (returns and search collide with catalog names RETURN_CLASSES and CONDITIONS, which have different values, so they are namespaced like promotions). Bridges for orders, returns and search now import only `@outlet/domain` (depcruise rule no-deep-import-into-shared-package is clean for them). |
| Boundary fix | `returns/adapters/cursor.ts` moved to `returns/domain/cursor.ts` so application no longer imports adapters. |
| Migrations | 0019_orders, 0020_returns, 0021_promotions, 0022_fulfillment, 0023_search are contiguous; the chain continues 0024..0030 from other in-flight waves (30 files, all applied on PG 16). |
| OpenAPI | Wave 3 routes were already in the contract under different path parameter names; the authz matrix now compares routes with parameter names normalised. Added 7 operations that had controllers but no contract: `GET /v1/me/privacy/delete`, `GET/POST /v1/admin/privacy/breaches`, `POST /v1/admin/privacy/breaches/{id}/{triage,pdpc-notified,subjects-notified,close}`, with schemas PrivacyBreach, PrivacyBreachList, PrivacyBreachRecord, PrivacyBreachTriage. The five breach POSTs now carry `@Idempotent({ required: false })` to match the contract rule. |
| Authz matrix | `apps/api/test/authz-matrix.test.ts` has a DELEGATED table (48 routes) checked centrally for: declared authz mode equals table, route present in OpenAPI and in `docs/security/authz-matrix.md`, 401 without credentials (non-public) or a 4xx (public: courier webhook, internal evaluate), and the owning per-module suite file exists and asserts 401/403/404. Full negative cases live in those suites. `docs/security/authz-matrix.md` has a Wave 3 section and updated counts (167 contract operations, 111 registered routes). |
| Privacy | `node tooling/privacy/generate-ropa.mjs` regenerated ropa.md, processors-register.md, retention-schedule.md. Tags for orders, returns, promotions, fulfillment and search tables are complete. |
| Notifications bug (from PG 16 run) | `KyselyPushTokenRepository.upsert` now takes `pg_advisory_xact_lock(hashtextextended(token,0))` first. The runner script modelled the caller as `customer`, which cannot see another owner's row under RLS; the adapter runs as `system`, so the script now does too. |
| Tooling | eslint ignore pattern widened to `**/.stryker-tmp*/**` (stale price-integrity sandboxes produced 2251 lint errors); `packages/domain/vitest.config.ts` excludes the same sandboxes (the domain run had collected 530 files / 11,380 tests including copies). |
| Coverage baseline | `node tooling/coverage/check.mjs --update-baseline`, measured: packages/domain 97.9 lines / 90.46 branches; orders 96.69/97.26, returns 95.18/94.23, promotions 97.12/91.57, fulfillment 97.14/92.71, search 96.77/82.99. apps/api has NO DATA because one api test fails (below), so its baseline was not touched. |

## Verification (commands and results seen)

| Command | Result |
|---|---|
| `pnpm -r typecheck` | all 15 projects pass |
| `pnpm lint` | exit 0, no output |
| `pnpm i18n-check` | 184 keys, parity OK (4 identical-text warnings, pre-existing) |
| `cd apps/api && node node_modules/vitest/vitest.mjs run` | before final fixes: 111 files passed, 2 failed (3 tests). Fixed: persistence.test (search dev fixtures, 5 s timeout under load). Re-run of persistence.test.ts and app.http.test.ts: 20 passed. Not re-run in full after fixes; the remaining failure below is unchanged. |
| `node vitest run src/authz-matrix.test.ts` | 314 passed |
| `node tooling/api/validate-openapi.mjs` | OK, 167 operations, 193 schemas |
| depcruise on Node 24.21.0 (`npx -y node@24 ...dependency-cruiser.mjs packages apps`) | the five wave 3 modules are clean. 9 errors remain, all in other waves' modules: no-deep-import-into-shared-package in tax-eta, seller-analytics, reviews, referrals, privacy, price-integrity, admin bridges; application-must-not-import-adapters in seller-analytics and referrals test files |
| `bash tooling/db/run-on-postgres16.sh` | 30 migrations applied, passed=73 failed=0. Inventory storm: 100 claimed of 10,000 attempts, 0 errors; push-token race now 0 rejections |
| `node --test tooling/privacy/test/inventory.test.mjs` | FAILS: 121 untagged columns, all in tables owned by the tax-eta, admin and seller-analytics waves (admin_approval_requests, admin_elevations, eta_*, kyc_suspension_reviews, seller_analytics_*, signing_delegations, tax_*). None are wave 3 tables. |

Domain tests (`packages/domain`): 880+ tests in the earlier whole-package run, plus the 28 returns, 23 orders, 27 fulfillment, 78 promotions and 29 search tests reported by builders; promotions mutation score 90.29% was measured by the builder on Node 25.9, not Node 24.

## Open failures (not caused by wave 3, not fixed here)

1. `apps/api/src/modules/privacy/exporter-coverage.test.ts`: exportable tables without an exporter or reasoned exemption: admin_approval_requests, admin_elevations, eta_signed_documents, kyc_suspension_reviews, seller_analytics_facts, tax_documents, tax_exemption_audit. Owner: the admin, tax-eta and seller-analytics waves (they were still editing during this run).
2. Privacy inventory test and depcruise errors listed above, same owners.
3. RoPA was regenerated mid-flight; re-run `node tooling/privacy/generate-ropa.mjs` after those waves tag their columns.

## Remaining gaps and needs

- Production boot is fail-closed: with real adapters, OrdersModule needs a stores-backed StoreLookupPort; ReturnsModule needs lines, membership, history, evidence, exchangeStock and events; PromotionsModule needs a real ServiceAuthenticator; FulfillmentModule needs a SellerOrderPort, real courier bindings and a secrets-manager CourierSecretsPort; SearchModule needs the Postgres FTS port (`PostgresFtsSearchPort.create` is async), ProductFactsPort, ShopperScopePort and a directory. None of these has a production adapter yet.
- Schedulers not wired (workers app): `OrderCommands.expireUnaccepted` (24 h accept SLA), `AwbWorker.runDue`, returns sweepers (inspection auto-approve, dispute window), search indexer.
- The Nest app must be created with `{ rawBody: true }` or every courier webhook answers 503 `raw_body_unavailable`.
- Policy package lacks `promotion`, `saved_search` and `store_shipment` resource types; those modules use local rules or shared types.
- F-1 money checkpoint (owner): consumers of `seller_order.rejected` / `seller_order.cancelled` (refund_required), `return.refund_intent`, per-line promotion funding splits, COD remittance posting.
- VERIFY BEFORE LAUNCH rows to add to the register: Bosta API specifics (ten rows at the end of docs/specs/fulfillment.md), 24 h accept SLA, 48 h dispatch SLA, 30 day seller buyer-data grace, return window counting basis (24 h periods vs Cairo days), serial-returner thresholds, dual approval threshold for platform promotions.
- Mutation testing for orders, returns and fulfillment domains not configured; promotions only, on Node 25.
- Node 24 is not installed locally (engines require >=24.3); depcruise ran via `npx node@24`, everything else on Node 25.9.
