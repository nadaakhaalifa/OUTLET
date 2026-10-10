# Wave 3: real PostgreSQL 16 verification

Date: 2026-10-10 · Server: PostgreSQL 16 (Postgres.app) · Command: `tooling/db/run-on-postgres16.sh`

## What changed
- `run-on-postgres16.sh` already globbed `packages/db/migrations/*.sql` in sorted order; it now also prints how many migrations were applied against how many files exist, starts the cluster with `max_connections=300`, and calls `tooling/db/pg16-verify.mjs` (node-postgres `Pool`) after the SQL checks. `SKIP_NODE_CHECKS=1` skips it.
- `pg16-verify.mjs` logs in as `app_login` (NOSUPERUSER, NOBYPASSRLS), does `SET LOCAL ROLE app_user` and sets `app.role` per transaction, so grants and RLS are in force. SQL shapes are copied from the Kysely adapters (cart `save`, `KyselyFrequencyStore.reserve`, `KyselyPushTokenRepository.upsert`); no module code was touched.
- The older `tooling/db/inventory-concurrency.sh` (five modes, 24 runs) is unchanged.

## Result (migrations 0001 to 0018 applied, 18 of 18 files)
60 checks passed, 1 failed.

| Check | Result |
|---|---|
| Inventory: 100 units, 10,000 reserve+claim attempts, 100 pooled connections, 2 s-class statement timeout | 100 claimed, 9,900 insufficient, 0 other, 0 client errors (no 40P01, no timeouts). 1.2 s total, reserve p50 10.7 ms, p95 15.6 ms, p99 48.4 ms. committed = claimed = 100, no leaked reservations |
| Cart: 40 concurrent `save` at version 0 | exactly 1 wins, 0 errors, 1 line, version 1 |
| Cart: 80 concurrent line inserts into one cart | exactly 50 stored, 30 rejected with 23514 (cap trigger) |
| Cart: 20 concurrent getOrCreate | one cart, no errors |
| Frequency cap 3, 60 concurrent reserves with the advisory lock | admitted 3, stored 3, 0 errors |
| Same, advisory lock removed (negative control) | admitted 60: the test can see the race, so the lock is what holds the cap |
| Push token: 20 users register the same token concurrently | 1 active row (uniqueness holds), but 19 callers got `23505` (FAIL) |
| Push token: 20 concurrent re-registrations of one (user, install) | 1 row, 0 errors |

## Bugs found (not fixed, modules are out of scope)
1. `KyselyPushTokenRepository.upsert` (`apps/api/src/modules/notifications/adapters/kysely-store.ts`): update-then-insert under READ COMMITTED. Concurrent registrations of the same token by different installs all see no active owner, then race on `notification_push_tokens_active_token_uq`; the losers throw 23505 to the caller instead of handing the token over. Data stays correct (one active row). Fix: take `pg_advisory_xact_lock(hashtextextended(token,0))` at the start of the transaction, or catch 23505 and retry once.

## Caveats
- One machine, local TCP, trust auth. Not a production load test; no PgBouncer, no network latency.
- The pool is warmed and cart/notification SQL is a transcription of the adapters, not the adapters themselves (they are TypeScript behind Kysely and run on PGlite in their own suites). Wiring the real adapters to a `pg` Kysely dialect would remove the transcription risk.
- `pg_cron` is absent in Postgres.app; sweepers were called directly.
- Migrations 0019 to 0023 were absent at the start and at the end of this run; the runner will pick them up by glob and report the applied count.
