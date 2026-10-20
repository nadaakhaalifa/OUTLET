# ADR-0020: Persistence adapters on Kysely (typing approach, unit of work, RLS session)

- Status: **Proposed** (safest default applied; Tech Lead may overrule)
- Date: 2026-10-10
- Deciders: Tech Lead
- Spec refs: A2.3, A2.5, A2.7, T3, T5 (ASVS), `docs/specs/persistence.md`, ADR-0001, ADR-0005, `packages/policy/RLS.md`

## Context

ADR-0001 chose Kysely (not an ORM) for the hexagonal API. Every Phase 1 module needs the same four things before it can persist: a typed query builder over `pg` (production) and PGlite (tests), a unit of work that commits state and outbox events atomically, the RLS session variables set per transaction, and a migrated test database. This ADR fixes the shape so modules do not each invent it.

## Decision 1: how table types are produced

| | A. Hand-written row interfaces per module | B. Generated types (`kysely-codegen`) from a migrated database |
|---|---|---|
| Source of truth | SQL migrations; interfaces drift unless checked | SQL migrations; types regenerated |
| Drift protection | Needs a test (information_schema vs exhaustive column map) | Built in, if CI regenerates and diffs |
| New dependency / tooling | None (blocked this wave: no installs) | New dev dependency, needs a live Postgres in CI or PGlite shim |
| Domain-specific types | Easy: `'pending' \| 'active'` unions, `Generated`, JSON shapes | Needs per-column overrides; enums from CHECK constraints are lost (`string`) |
| Parallel agents | Each module owns a small file; no merge conflict on one generated file | One generated file everyone touches |
| Cost | Boilerplate, review attention | Pipeline and override config |

**Chosen: A**, with a mechanical drift check. Each table has an interface plus an exhaustive `Record<keyof Row, true>` column map (`PLATFORM_COLUMNS`); a test compares it to `information_schema.columns` of the migrated database, so adding a column in SQL without the interface (or vice versa) fails CI. Modules declare `type ModuleDb = PlatformTables & TheirTables` and reuse the helper. Revisit B when the table count makes the boilerplate the bottleneck (rough trigger: more than about 60 tables or two drift incidents).

## Decision 2: unit of work and outbox

One `KyselyTransactionRunner.run(options, fn)` = one Postgres transaction. `tx.emit(event)` validates (`createOutboxRecord`, ids from the injected `IdGenerator`, time from the injected `Clock`) and inserts into `outbox_events` in the same transaction. Rejected alternative: buffering events and publishing after commit (loses events on crash; that is the dual-write problem the outbox exists to prevent).

## Decision 3: RLS session

Per transaction: `SET LOCAL ROLE app_user`, then `set_config('app.user_id'|'app.role'|'app.store_ids'|'app.device_id', v, true)`, `application_name = <business process>` and `statement_timeout = <profile>`. All transaction-local, so nothing leaks across pooled connections (PgBouncer transaction mode). Values are validated (uuid, closed role list) before they reach SQL; invalid input throws before a transaction opens.

## Consequences

- Modules never touch `pg` or raw pools; they receive `DbTx`.
- `outbox_events` and `inbox_processed` have system-only RLS (0007). Until a policy migration allows application roles to append, the adapter elevates `app.role` to `system` for the single INSERT and restores it. This is contained in two adapter functions and covered by a test that the role does not leak. **Open item (needs a migration, not owned here):** add `FOR INSERT WITH CHECK (app_role() IS NOT NULL)` policies (as `audit_log_append`) and delete the elevation.
- PGlite does not enforce `statement_timeout` (a `pg_sleep` past the limit was not interrupted) and does not exercise `SKIP LOCKED` concurrency; both are NOT verified. Run the suite against Postgres 16 (`tooling/db/run-on-postgres16.sh`) before relying on them.
- `claimDue` is a plain read: with more than one relay instance a record can be published twice (allowed, at-least-once). Add a lease before scaling the relay out.
- `apps/api` imports `@outlet/db` and `@outlet/outbox` by relative path via one file (`platform/db/deps.ts`) because the workspace dependencies are not declared yet.
