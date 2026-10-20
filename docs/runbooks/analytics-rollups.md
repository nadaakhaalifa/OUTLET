# Runbook: analytics rollups (seller and platform hourly tables)

Owner: Platform. Spec: `docs/specs/dashboard-foundations.md` section 6 (track 6), ADR-0045.
Alerts: `infra/observability/prometheus/rules/analytics-rollups.rules.yaml` (tests in `../tests/analytics-rollups.test.yaml`).
Alert delivery does not exist yet (launch blocker, spec section 8): until then read these by hand.

## What runs

| Job (worker) | Cadence | What it does |
|---|---|---|
| `analytics.consume-seller-events` | every minute | Applies outbox events to facts and rollups in one transaction (inbox, advisory lock per key, keys sorted) |
| `analytics.reconcile-rollups-hourly` | hourly | Recomputes the last 48 hours from facts and repairs drift (version compare-and-set; new keys under the key's advisory lock) |
| `analytics.reconcile-rollups-nightly` | 04:00 Cairo | Same over the last 35 days |
| `analytics.maintain-rollup-partitions` | 03:40 Cairo | Creates monthly partitions (six ahead), moves DEFAULT rows into a new month, drops months older than 25 months, deletes reconciliation rows older than 2 years |
| `analytics.rollup-partition-gauge` | every 5 minutes | Exports `outlet_analytics_rollup_default_partition_rows{table}` |
| `retention.purge.analytics_events` | nightly | Deletes `seller_analytics_facts` older than 25 months (5,000 rows per statement), the suppression memo, and (rule `technical_dedup`) erased keys after 31 days |

All of them are skipped while the `analytics-consumers` capability is blocked (`kill.analytics.consumers`, default blocked): events stay replayable from `outbox_events`.

## AnalyticsRollupDefaultPartitionRows (ticket)

Rows in a DEFAULT partition mean the partition job fell behind or a producer wrote an hour far in the future.
1. `SELECT * FROM analytics_rollup_default_partition_rows();`
2. Run `analytics.maintain-rollup-partitions` (or `SELECT * FROM analytics_rollup_maintain_partitions(now(), 5, 25)` as the app role). It detaches DEFAULT, creates the month, moves the rows and re-attaches in one transaction.
3. If the rows are hours years away, they are a producer bug: find them with `SELECT * FROM seller_analytics_hourly_default LIMIT 20`, fix the producer, delete the rows as the system role. The reconciler does not look outside its window.

## AnalyticsRollupMismatchHourly / Nightly (ticket / page)

The reconciler already repaired the rows it could (see `analytics_rollup_reconciliations`: `mismatches`, `corrected`, `skipped_concurrent`). A recurring mismatch is a consumer defect.
1. `SELECT scope, window_from, mismatches, corrected, skipped_concurrent, outcome FROM analytics_rollup_reconciliations ORDER BY ran_at DESC LIMIT 20;`
2. `skipped_concurrent > 0` with `corrected = 0` is normal under load: the next run rechecks.
3. A nightly mismatch after clean hourly runs usually means facts older than 48 hours changed (late events). Check `includes_late_data`, then the consumer code path that wrote the key.

## First run and backfill

Before any series flag (`release.seller_analytics.series`) is allowed, run `ReconcileRollups.backfill()` once (7-day chunks over every retained fact) and require every reconciliation row to report `ok` on a second run. Rollups hold nothing until then.

## Erasure

`forgetShopper(userKey)` runs from the privacy erasure flow before the user row is erased. If `privacy.process-deletions` parks a request with a failure from that step, fix the pseudonym key source (KMS) and let it retry; do not erase the user by hand: the shopper keys in facts could no longer be derived.
