# Phase 1 wave 2: integration report (2026-10-10)

Scope: Kysely adapters for catalog, stores, wishlists, cart, sizing and notifications integrated with the
existing inventory adapter. In-memory remains the dev and test default.

## What changed in the integration
- `apps/api/src/persistence.ts`: `createPersistence(config, db?)` builds every Postgres adapter over one pool
  (`createPgDatabase`), or over an injected handle (PGlite in tests). Throws `MissingDatabaseConfigError`.
- `apps/api/src/app.module.ts`: when `config.adapters !== "in-memory-dev"` the Kysely wiring is passed to each
  module; dev boot (NODE_ENV=development, fixtures on) now passes the cart fixtures explicitly, so the new
  `MissingCartPortsError` guard no longer breaks `pnpm dev`.
- `config/env.ts`: `DATABASE_URL`, `DATABASE_POOL_MAX`, `SIZE_DEMAND_PSEUDONYM_KEY`; the first two are required when
  fixtures are off.
- `SizingModule` and `NotificationsModule` accept repository options (typed against ports, not in-memory classes).
  `StoresModule` and `CartModule` guards relax only when their production persistence is supplied. Cart still
  throws `MissingCartPortsError` without catalog, membership and platformConfig.
- Catalog test fixes: `seller_legal_identity` (B5, exactly four fields, no iban) is now asserted instead of
  forbidden; authz-matrix allow-list updated. Property test in notifications `domain.test.ts` had a wrong bound
  (10 h): on the DST-end night 23:00 EEST to 09:00 EET is 11 h; bound corrected with a comment (found by a flaky seed).
- Privacy: `size_demand_events` added to `docs/privacy/data_inventory.yaml`, RoPA regenerated.
- `.gitignore` stryker paths; `.dependency-cruiser.cjs` orphan exemption for `stryker.*.mjs`; exit checklist rows
  P0-23, P0-24 added.

## Verification (commands run, results seen)
| Command | Result |
|---|---|
| `cd apps/api && npx vitest run` | 45 files passed, 1125 tests passed |
| `cd apps/api && npx tsc --noEmit` | clean |
| `pnpm -r typecheck` | all packages Done |
| `pnpm lint` | eslint clean |
| `pnpm -r test` | all packages pass (domain 644, db 55, policy 119, outbox 79, privacy 70, mobile 49, api 1125) |
| `node --test tooling/privacy/test/inventory.test.mjs` | 31 pass, 0 fail |
| `node tooling/privacy/check-inventory.mjs` | PASS: 127 tables, 951 fields, 0 errors, 3 warnings |
| `node tooling/api/validate-openapi.mjs` | OK, 160 operations, 189 schemas |
| depcruise on Node 24 | no dependency violations (530 modules, 1796 dependencies) |

## Not verified / open
- Production boot still cannot happen: `PlatformModule`, `AuthModule` and `PrivacyModule` throw
  `NoProductionAdaptersError` (idempotency store, rate limiter, audit sink, auth stores are in-memory).
  `AppModule.register` with fixtures off builds the persistence then fails in PlatformModule (asserted in test).
- Catalog stays refused in production: stock, prices, store reader, uploads, size charts, media and event
  publisher are fixtures. Sizing uses `DevAesGcmFieldCipher` for measurements (P3); wishlists, notifications use
  fixture ports for consent, contacts and providers. These guards are intentional.
- Cart has no real catalog, membership or platformConfig ports; needs a catalog-backed `CatalogPort`.
- Adapters run as `app.role = system` (request identity is not propagated to the persistence layer), so RLS is
  not the enforcing layer on those paths. Needs request-scoped sessions before production.
- Migration 0012 and 0017 were edited in place; fine while unreleased, otherwise new expand migrations.
- PGlite is one connection: advisory locks, SKIP LOCKED, concurrent saves not exercised. Contract suites and the
  notifications frequency test must run on Postgres 16 (`tooling/db/run-on-postgres16.sh`); not run here.
- Outbox events from catalog, wishlists, cart are not yet emitted in the same transaction as writes.
- Inventory mutation score 71.91% < 80 target (ADR-0019). CI inventory-concurrency job never run on GitHub.
- Weekly `materializeAggregates` and 8-week purge of `size_demand_events` are not scheduled.
- `notification_templates_active_uq` blocks staging a future-dated template version.
