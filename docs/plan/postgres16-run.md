# Migrations on a real PostgreSQL 16

Date: 2026-10-10 · Server: PostgreSQL 16.13 (Postgres.app) · Repeat with `tooling/db/run-on-postgres16.sh`

## How it runs
`tooling/db/run-on-postgres16.sh` creates a throw-away cluster (initdb, trust auth, `listen_addresses=127.0.0.1`, Unix sockets disabled, random free port), applies `packages/db/migrations/*.sql` in order with `psql` (one `--single-transaction` per file, autocommit for the `-- no-transaction` file), runs the checks below, then stops and deletes the cluster (`KEEP=1` leaves it running for debugging; `WORK_DIR` chooses the location, `PG_BIN` the binaries). Exit code is non-zero on any failure.

The TypeScript runner (`packages/db/src/runner.ts`) is not what applied the files here; psql was. The runner's statement splitter and checksum ledger are therefore still only exercised on PGlite.

## Result of the last run
44 checks passed, 0 failed. Migrations 0001 to 0011 all applied.

| Area | Checked on PostgreSQL 16 | Result |
|---|---|---|
| Migrations | all 11 files apply; 0009 `CREATE INDEX CONCURRENTLY` runs for real; no invalid index left behind | pass |
| 0011 | 17 account types seeded; `ledger_accounts_type_fk` validated; typo type rejected by FK | pass |
| Ledger | unbalanced entry rejected at COMMIT and leaves no rows; balanced entry commits; UPDATE, DELETE, TRUNCATE on postings and UPDATE on entries rejected; posting from a later transaction rejected; duplicate idempotency key rejected; account identity immutable; trial balance 0 | pass |
| Outbox | claim query (see below) with `FOR UPDATE SKIP LOCKED`: two concurrent sessions each claimed a disjoint batch of 2 (one held its transaction open 3 s while the other claimed); a dead-lettered head blocks a later event with the same `ordering_key`; payload immutable | pass |
| Audit chain | clean chain verifies; UPDATE rejected; modified row and removed middle row detected; 6 concurrent writers x 5 appends on one chain gave contiguous seq 1..30 and a clean verify | pass |
| RLS | login role `app_login` (NOSUPERUSER, NOBYPASSRLS, member of `app_user`, then `SET ROLE app_user`): no identity sees 0 users; customer sees own row; support sees all; customer sees no audit_log and no platform ledger accounts; UPDATE on postings is `permission denied`; INSERT into ledger_accounts fails the RLS check; `ledger_account_types` readable | pass |

The relay claim query used is the README semantics written out: due, unpublished, not dead-lettered, no earlier unpublished row with the same `ordering_key` that is dead-lettered or backing off, `ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED`. `packages/outbox/README.md` describes it in prose and contains no SQL literal, so this query is my transcription, not a shipped adapter. The outbox package has no Postgres adapter yet.

## Differences from PGlite (observed or known)
| Topic | PGlite | Real PostgreSQL 16 |
|---|---|---|
| `CREATE INDEX CONCURRENTLY` | fails ("tuple concurrently updated"); the test harness rewrites it to a plain `CREATE INDEX` | works; both outbox indexes build valid. The rewrite hides nothing for the DDL itself, but the concurrent build under write load is still untested |
| Concurrency | single connection, so `SKIP LOCKED`, advisory locks and the audit-chain locking were only parse-checked | verified with real concurrent sessions (claim disjointness, 30 concurrent audit appends) |
| Roles | one superuser connection, `SET LOCAL ROLE app_user` | real LOGIN role that is a member of `app_user`; behaviour matched, including `permission denied` and RLS `WITH CHECK` messages |
| Extensions | extensions are not loaded in tests | 0001 installed `citext, pg_trgm, pgcrypto, vector` on this server; **`pg_cron` is absent** (Postgres.app does not ship it), so 0001 logs a NOTICE and continues. Any job that needs pg_cron (reservation sweeper, retention purges) is not verified |
| Boolean text output | `true`/`false` through the driver | psql prints `t`/`f` in `-At` mode; a harness detail only |
| Unix socket path | not applicable | a socket directory under a long scratchpad path exceeds the 103-byte limit and the server will not start; the script disables Unix sockets and uses TCP on 127.0.0.1 |
| Error messages | matched by the existing tests | the same patterns (`unbalanced`, `append-only`, `immutable`, `transaction that created`, `duplicate key`) matched on both |

No behavioural difference in a guarantee was found: every constraint and trigger that PGlite enforces is also enforced by PostgreSQL 16.

## Not verified
- `pg_cron`, PgBouncer transaction pooling, partitioning, read replicas, PITR, and any managed-service variant (RDS, Cloud SQL, an Egypt-hosted provider per ADR-0002).
- Behaviour under load (the 10k concurrent reserves chaos test of spec 20.2 is not run; there is no inventory schema yet).
- The runner (`runner.ts`) against real Postgres. The `-- no-transaction` statement splitter is only tested on PGlite.
- Outbox `occurred_at` ordering caveat (transaction start vs commit time) from `packages/outbox/README.md`.
- Concurrent `CREATE INDEX CONCURRENTLY` on a populated, written-to table, and the NOT VALID then VALIDATE step of 0011 on a large `ledger_accounts` (it is small by nature).
