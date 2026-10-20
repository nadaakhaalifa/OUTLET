# Runbook: workers

## Run
- Build the API, then `pnpm --filter @outlet/api worker` (`node dist/main.worker.js`). Run 2+ replicas; the Postgres advisory lock keeps each job single-flight. Set `DATABASE_URL` (without it the in-memory lock is single-replica only).
- Env: `WORKER_BLOCKED_CAPABILITIES=drops` pauses drop jobs (recorded `skipped_blocked`); `WORKER_EVENT_MODE=true` turns on the intraday ledger integrity job (set before a mega event, unset after).
- Shutdown: SIGTERM stops the loop, waits up to 25 s for in-flight jobs, closes the pool and the Nest context. Set the orchestrator grace period above 30 s.

## Watch
Alert on the `worker.metric` log line, `metric=worker_dead_man`:
- `consecutive_failures >= 3` on a `critical` job: page.
- `last_success_at` older than 3 cadences (26 h for daily Cairo jobs): page for critical, ticket otherwise. A job that never ran has `last_success_at=null`.
- `outcome=skipped_not_leader` on every replica for one job for longer than its timeout plus 10 s means a lock is stuck (see below).

## Triage
- `job.timeout` / `job.failure` log lines carry the error class and `retryInMs`; read the use case's own logs and metrics for detail. Backoff caps at 5 min.
- Stuck lock: `select pid, objid from pg_locks where locktype='advisory'` and map to `pg_stat_activity` (application_name `outlet-worker-locks`); terminate that backend only after confirming the owning replica is gone. The lock frees itself when the connection drops.
- Pause one job family: add its capability to `WORKER_BLOCKED_CAPABILITIES` (only `drops` is wired today). To stop anything else, scale the worker to zero; every sweeper is idempotent and catches up on restart.
- Outbox and payment-events relays are NOT started by this entrypoint yet (see docs/specs/workers.md, gap 1). Until that lands the outbox is not drained.
