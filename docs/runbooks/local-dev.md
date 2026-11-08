# Local development stack

Postgres 16.6, PgBouncer (transaction mode), Redis 7.4, Mailpit. Files: `infra/local/`. Copy `.env.example` to `.env`.

## Docker is not installed (owner's Mac, today)
`docker: command not found`. Install one of:
- `brew install --cask orbstack` (lighter), or Docker Desktop.
Then open it once so the daemon starts, and check `docker compose version`.

## Start
```
infra/local/scripts/up.sh        # docker compose up -d --wait
```
All four services should show `healthy`. Ports (127.0.0.1 only): Postgres 5432, PgBouncer 6432, Redis 6379, SMTP 1025, Mailpit UI http://127.0.0.1:8025.

## Verify (expected output)
```
infra/local/scripts/psql.sh direct -c "select current_user, version()"      # outlet_migrator, PostgreSQL 16.6
infra/local/scripts/psql.sh app -c "select current_user, rolbypassrls from pg_roles where rolname=current_user"  # outlet_app | f
infra/local/scripts/psql.sh checkout -c "show statement_timeout"            # 10s (database default; reserve path sets 2s per transaction)
infra/local/scripts/psql.sh direct -c "select extname from pg_extension order by 1"   # pg_stat_statements, pgcrypto, pg_trgm, plpgsql
infra/local/scripts/psql.sh direct -c "show shared_preload_libraries"       # pg_stat_statements,auto_explain
docker compose -f infra/local/docker-compose.yml exec redis redis-cli ping  # PONG
```
pgvector is not in the Postgres image, so it is not enabled. Add it (custom image such as pgvector/pgvector:pg16) in the migration that needs it.

## Reset
`infra/local/scripts/reset.sh` deletes the volumes and re-runs `postgres/init/*.sql`. Init scripts only run on an empty volume.

## Rules
- Migrations use `DATABASE_URL_DIRECT` (migrator). The app uses `DATABASE_URL` via PgBouncer.
- Roles (ADR-0011): `outlet_app` (request path, pools `outlet_catalog` 20 and `outlet_checkout` 10+5), `outlet_auth` (`/v1/auth/*`, `DATABASE_URL_AUTH`, pool `outlet_auth` 5), `outlet_worker` (workers and outbox relay, `DATABASE_URL_WORKER`, pool `outlet_worker` 5). Role = pool: each alias pins `user=` in `pgbouncer.ini`; never `SET ROLE` through the pooler. Roles are created by `postgres/init/001-roles.sql` (IaC in real cells); migration 0007 fails with a clear message if one is missing. After pulling 0007 on an existing volume, run `infra/local/scripts/reset.sh` so the new roles and pool aliases exist.
- Every transaction sets its context with `withDbContext` (`packages/db`): `app.ctx` (user|store|auth|worker), `app.job`, market, user/store and the auth lookup keys, all via `set_config(..., true)`.
- Inspect a role: `infra/local/scripts/psql.sh auth -c "select current_user"` (also `worker`).
- Always `SET LOCAL` inside a transaction (session settings leak in transaction pooling). See `pgbouncer/pgbouncer.ini`.

## Fallback without Docker: Postgres.app
Postgres.app 18 is installed (`psql` 18.3). Fine for running unit tests, but the CI target is Postgres 16: any version drift (planner behaviour, `pg_stat_statements` columns, removed features) must be noted in the PR. It has no PgBouncer, so pool behaviour and `SET LOCAL` leak tests are NOT covered. Apply `postgres/init/001-roles.sql` manually as a superuser.
