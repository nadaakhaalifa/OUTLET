# Spec: Persistence adapter foundation (A-06)

Status: Phase 1 wave 1 · Spec refs: A2.3, A2.5, A2.7, A2.8, T3, T5, T8 · ADR-0001, ADR-0020 · Data: `docs/data-model/platform.md`, migrations 0002, 0004, 0006-0009 · Code: `apps/api/src/platform/db/**`, `packages/db/src/session-context.ts`, `packages/db/src/test-database.ts`

This is infrastructure, not a feature: there are no HTTP routes and no new tables (no migration, no privacy fragment). Every module's Postgres adapter is built on it.

## Flow
1. A controller (after guards: authenticate, policy, rate limit, idempotency) calls a use case with the principal.
2. The use case runs `runner.run({ session, process, profile }, async (tx) => ...)`.
3. The runner opens a transaction, drops to `app_user`, sets `app.*` identity, `application_name`, `statement_timeout`.
4. The use case reads/writes through repositories that take `tx` (`tx.db` for the module's tables) and calls `tx.emit(event)`.
5. COMMIT persists state and outbox rows together; any throw rolls both back.
6. A relay (`KyselyOutboxStore.claimDue`, `markPublished`, ...) publishes; consumers dedupe through `KyselyInboxStore` in the same transaction as their effect (`InboxConsumer` + `runner.unitOfWork(...)`).

## Rules
- Production factory `createPgDatabase` (pg Pool, validated config, lazy connect); test factory `createPgliteDatabase`. Production connects as a LOGIN role that is a member of `app_user`, never owner or superuser.
- `session` carries `{ userId, role, storeIds, deviceId }`; build it from `dbSessionContext()` in `@outlet/policy`. Omitted session = no identity = every policy denies.
- `process` is `module.operation` lowercase, at most 63 chars (becomes `application_name`; use it in dashboards and pg_stat_activity).
- Timeout profiles (ms): `reserve` 2000 (spec 20.2), `read` 5000, `default` 10000 (T3), `relay` 15000, `batch` 60000; `statementTimeoutMs` overrides (1..600000).
- Events: `eventType` `aggregate.verb` lowercase, payload JSON only (money as string piastres), no P2/P3 data. Ordering key defaults to `aggregateType:aggregateId`.
- Money columns are `bigint`: pg returns strings; coerce with `toBigInt`, never `Number`.

## Edge cases
- Nested `run` is forbidden (PGlite deadlocks; Postgres would open an independent transaction). Pass `tx` down.
- On PGlite never use the root `Kysely` inside a callback (single connection).
- Duplicate outbox id: `DuplicateOutboxEventError`; the transaction is already aborted and rolls back.
- Invalid session/process/timeout: rejected before any transaction opens (`InvalidSessionError` / `RangeError`).
- Role elevation for outbox/inbox INSERTs is restored on success; on failure the transaction is aborted anyway.
- Replaying a record that is not dead-lettered: `InvalidReplayError`; unknown id: `UnknownOutboxEventError`.

## Data
Uses existing `users`, `consent_records`, `outbox_events` (+ `next_attempt_at`, `dead_lettered_at` from 0008), `inbox_processed`, `idempotency_keys`. Row types in `schema.ts`, exhaustive column maps `PLATFORM_COLUMNS`, drift-tested against `information_schema`. No new columns, so no `docs/privacy/fragments` file.

## API
None (no routes; nothing for the authz matrix). Public TypeScript surface (`apps/api/src/platform/db/index.ts`): `createPgDatabase`, `createPgliteDatabase`, `KyselyTransactionRunner`, `DbTx`, `KyselyOutboxStore`, `KyselyInboxStore`, `PlatformTables`, `toBigInt`, `TxOptions`.

## Events
Writes whatever the caller emits. Analytics events are out of scope here.

## Failure handling
Statement timeout raises SQLSTATE 57014 (map to 503 `Retry-After` in the Problem filter). Serialization/deadlock retry is the caller's choice (none built in; reserve path uses SKIP LOCKED, ADR-0005). Relay retry/DLQ is `@outlet/outbox` `OutboxRelay` over `KyselyOutboxStore`.

## Security & abuse (threat notes)
| Threat | Control |
|---|---|
| App connects as owner/superuser, bypassing RLS (API1/API5) | `SET LOCAL ROLE app_user` on every transaction; deployment checklist forbids owner credentials |
| Identity bleed across pooled connections | Everything `SET LOCAL`/`set_config(..., true)`; test asserts nothing survives COMMIT |
| SQL injection through session values | Values validated (lowercase uuid, closed role list, store list) and passed as bind parameters; role identifier restricted to `^[a-z_][a-z0-9_]*$` |
| Forgotten authorization filter | RLS is a second layer; repository tests include a foreign-owner case |
| Event payload leaks PII | `createOutboxRecord` is the only writer; reviewers check payloads; reference event carries no ids beyond the subject |
| Elevation to `system` abused | Confined to two adapter functions, one INSERT each; open item to replace with insert policies |

## Metrics
`application_name` split of `pg_stat_activity`; per-process p95 transaction time; outbox lag (`now - min(occurred_at) WHERE published_at IS NULL`); DLQ depth; statement-timeout count. SLO linkage: reserve p95 < 150 ms (T8).

## Acceptance (all executable in `apps/api/src/platform/db/persistence.test.ts`)
- Commit stores the state row and the outbox row; rollback leaves neither.
- RLS: foreign owner reads 0 rows, writes for another subject fail, anonymous sees nothing.
- Idempotent insert: same request id twice yields one state row, one event.
- `application_name`, `statement_timeout`, identity are set inside and absent after the transaction.
- Relay ops: ordered claim, ordering-key head blocking, DLQ, replay, retry scheduling.
- Column maps equal `information_schema`.
- NOT verified on PGlite: statement-timeout enforcement, SKIP LOCKED concurrency, PgBouncer behaviour, real `pg` pool I/O.

## How module agents plug in
1. Declare your rows: `export interface FooTable {...}`; `export type FooDb = PlatformTables & { foo: FooTable }`; add an exhaustive `Cols` map and a drift test (copy `schema.ts` and the last test in `persistence.test.ts`).
2. Write repositories taking `DbTx<FooDb>` (see `reference/consent-store.ts`). No transactions, no clock, no `Date.now` inside.
3. Write use cases taking a `KyselyTransactionRunner<FooDb>`, `Clock`, repositories (see `reference/record-consent-change.ts`). Emit events with `tx.emit`.
4. Module `forRoot`: provide `DB` (`createPgDatabase` in production; `createPgliteDatabase` over a migrated PGlite in tests), `new KyselyOutboxStore(db)`, `new KyselyTransactionRunner({ db, outbox, clock, ids })`. Keep your in-memory adapter for fast unit tests; the Kysely adapter must pass the same port contract test.
5. Tests: use `createPersistenceFixture()` (migrations 1..11 baseline). For your own tables, build the PGlite with `createTestDatabaseUpTo(<your migration number>)` from `packages/db/src/test-database.ts`; do not use `createTestDatabase` while other agents' migrations have gaps.
6. Controllers pass `session` from `dbSessionContext(actor, audience, now)`; a `null` result means 403/404 before any DB call.
7. Do not add an `any` cast around `Transaction`; if a type does not line up, use `tx.platformDb` for platform tables and `tx.db` for yours.
