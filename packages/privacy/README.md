# @outlet/privacy

Consent, deletion, export, breach register and retention (PDPL, master prompt B1). Domain services over `@outlet/db`; the worker composes them (`apps/api/src/worker`).

## Retention

Two parts, both driven by `data_inventory.yaml`:

- `purgePlan(db, now)` (`retention.ts`): read-only count of rows past each `retention_policies` row (tax, analytics, support chats, OTP: tables owned by later modules are reported absent).
- `RetentionRunner` / `RetentionConsumer` (`retention-runner.ts`): the executable nightly purge of the worker job `privacy.retention` (ADR-0016, migration 0040).

| Table | Cutoff | Inventory rule |
|---|---|---|
| outbox_events | published_at older than 60 days (published rows only) | `outbox_60d` |
| dlq_messages | resolved_at older than 60 days, status replayed or discarded | `dlq_60d` |
| inbox_processed | processed_at older than 60 days | `dedup_60d` |
| attention_items | created_at older than 24 months, RESOLVED only | `ops_attention_24m` |
| notification_log | created_at older than 12 months, never `queued` | `notification_12m` |
| market_sales_daily, store_sales_daily | day older than 25 months | `sales_rollup_25m` |
| admin_dashboard_snapshots | never purged (overwritten in place) | `dashboard_snapshot_overwrite` |

How a purge is expressed: one `PurgeSpec` per table (`PURGE_SPECS`): table, rule key, period, the phrase the inventory rule text must still contain, the timestamp column and a static extra predicate. Add a table by adding a spec, the matching RLS delete policy (cutoff repeated in the policy) in a migration, and a case in `retention-runner.test.ts` and `packages/db/test/retention-rls.test.ts`.

Behaviour:

- Batched `DELETE ... WHERE ctid IN (SELECT ... LIMIT 5000) RETURNING 1`, each batch its own transaction, market-pinned, until a short batch or the time budget (default 8 s); the next hourly scheduler window continues.
- **Dry run is the default.** `WORKER_RETENTION_DRY_RUN` (worker env) is `true` unless it is exactly `false`. A dry run counts rows past the cutoff (`retention_rows_due{table}`, log with counts only) and deletes nothing. The owner flips it after reviewing the counts.
- **Fail closed.** Unreadable or unparsable inventory: every table is skipped. Rule missing, table missing from the inventory, or rule text changed: that table is skipped. Database error: that table is skipped. Each skip is an error log plus `retention_skipped{table,reason}`; nothing is deleted on doubt.
- Kill switch `workers.privacy.retention.enabled`: ui class but fail CLOSED (deletes are irreversible).
- Metrics: `retention_rows_purged{table}`, `retention_rows_due{table}`, `retention_skipped{table}` (`createRetentionMetrics`, `@outlet/observability`). Logs carry table names and counts, never row data.
