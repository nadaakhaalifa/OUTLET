# @outlet/db

Ordered SQL migrations (expand/contract only), a TypeScript runner, a migration linter, and executable tests on PGlite.

- `migrations/NNNN_name.sql`: applied in order, checksum-verified, never edited after release. `-- no-transaction` runs statements one by one (for `CREATE INDEX CONCURRENTLY`).
- `src/runner.ts`: `loadMigrations`, `migrate`. `src/lint.ts`: `lintMigration` (drop/rename column, NOT NULL without default, non-concurrent index on large tables, destructive statements; suppress with `-- lint-allow: <rule> <reason>`).

## What the tests prove (on PGlite)
Unbalanced entries are rejected at commit; postings and entries cannot be updated, deleted or truncated; audit hash chain detects modification, removal and tail truncation (tail only against a checkpoint); outbox, inbox, idempotency, consent and RLS basics.

## NOT verified
**PGlite is not production PostgreSQL 16.** `FOR UPDATE SKIP LOCKED` was only parse-checked (no concurrent writers), `pg_cron` is absent, PgBouncer transaction-pooling behaviour was not tested, `CREATE INDEX CONCURRENTLY` fails on PGlite (the test harness strips it), and optional extensions are not loaded. Run the suite against a real Postgres 16 before launch.

## Real PostgreSQL 16
`tooling/db/run-on-postgres16.sh` applies all migrations to a throw-away PostgreSQL 16 cluster and checks the ledger, outbox, audit and RLS guarantees (44 checks). Results and PGlite differences: `docs/plan/postgres16-run.md`.

## Ledger account types
`0011_ledger_account_types.sql` is generated from the domain `ACCOUNT_TYPES` (`node tooling/db/generate-account-types-migration.mjs`, `--check` to verify). Never edit it by hand; to change the chart add a new migration. `src/ledger-owner.ts` maps domain owner kinds to persisted `owner_type` values.
