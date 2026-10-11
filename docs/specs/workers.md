# Workers: scheduled jobs

Status: implemented in `apps/api/src/workers/**`, entrypoint `apps/api/src/main.worker.ts` (`pnpm --filter @outlet/api worker`, runs `dist/main.worker.js`).

Before this change every sweeper and background use case existed but nothing called it. The worker boots the same Nest container as the API (no HTTP listener) and resolves each use case by its exported provider token.

## Design

- `Job` = name, cadence (`interval` or Cairo wall-clock `cairo {hour, minute, weekday?}`, DST aware through Intl), `run(ctx)`, `lockKey`, `timeoutMs`, `criticality`, optional `capability` and `enabled`.
- `Scheduler` has injected `WorkerClock`, `WorkerTimers`, `LeaderLock`, `WorkerMetrics`, `WorkerLogger`, `CapabilityGate`, random. `tick()` runs due jobs; `start()` polls; `shutdown(graceMs)` stops the loop and waits for in-flight jobs.
- Leader lock: `PgAdvisoryLeaderLock` (session `pg_try_advisory_lock` on a held pooled connection; a crashed replica drops the connection and Postgres frees the lock) and `InMemoryLeaderLock` (shared map, ttl). Every run takes the lock first, so two replicas never double-run a job. Idempotency of each use case stays the second line of defence (column below).
- Per-job timeout aborts the `AbortSignal` and records `timeout`. Failure backoff: exponential from 1 s, cap 5 min, 20% jitter, then the normal cadence resumes on success. First run and each next run get cadence jitter (10% of the interval, max 30 s).
- Dead-man metric per job: `last_success_at`, `consecutive_failures`. There is no platform metrics port yet, so `logMetrics` emits `worker.metric` JSON log lines (`worker_job_runs_total`, `worker_dead_man`). `scheduler.status()` exposes the same state. Alert threshold helper: `deadManThresholdMs` (3 cadences; 26 h for daily Cairo jobs).
- Logs: JSON lines with job name, counters, error class name only. No error messages, no ids of people.
- Kill switches: a job with `capability` whose capability is blocked records `skipped_blocked` and does not run. Source today: env `WORKER_BLOCKED_CAPABILITIES` (comma list); swap `CapabilityGate` for the flag service adapter when it is worker-readable. Only `drops` (drops.advance, waiting-room.admit) is gated. Money sweepers (refunds, redemption resume, payouts, pot close, holds) deliberately ignore sale-side kill switches: killing gift-card sales or a payment method must never strand in-flight money.
- `WORKER_EVENT_MODE=true` enables the intraday ledger integrity job.

## Jobs (37 registered from the container, plus 2 relay jobs when supplied)

| Job | Owner module | Provider token . method | Cadence | Criticality | Kill switch | Idempotency basis |
|---|---|---|---|---|---|---|
| `inventory.sweep-reservations` | inventory | `INVENTORY_SWEEP_EXPIRED.execute` | 30 s | critical | - | FOR UPDATE SKIP LOCKED batches; expired rows return to available once |
| `inventory.replenish-pools` | inventory | `INVENTORY_REPLENISH_POOLS.execute` | 1 min | important | - | tops pools up to the cap under an advisory lock |
| `orders.expire-unaccepted` | orders | `ORDER_COMMANDS.expireUnaccepted` | 1 min | critical | - | state machine CAS per order plus refund intent keys |
| `store-credit.sweep-holds` | store-credit | `CREDIT_HOLDS.sweepExpired` | 1 min | critical | - | hold state CAS; release entry keyed by hold id |
| `store-credit.expire-lots` | store-credit | `SWEEP_EXPIRED_CREDIT.execute` | 1 h | important | - | ledger entry idempotency key per lot expiry |
| `ledger.integrity.nightly` | ledger | `INTEGRITY_JOB.run` | daily 02:30 Cairo | critical | - | read-only (REPEATABLE READ snapshot); writes only alerts and the signed snapshot |
| `ledger.integrity.intraday` | ledger | `INTEGRITY_JOB.run` | 30 min | critical | - | read-only snapshot |
| `reconciliation.tick` | reconciliation | `SCHEDULE_RECONCILIATION.tick` | 5 min | critical | - | reconciliationDue consults lastNightlyKey (Cairo day) and lastIntradayAt; findings dedupe by key |
| `payouts.weekly-cycle` | payouts | `PAYOUT_COMMANDS.schedule` | daily 04:00 Cairo | critical | - | unique (store, cycle) while not CANCELLED; daily trigger so a missed day self-heals |
| `payouts.recover-orphans` | payouts | `PAYOUT_COMMANDS.recoverOrphanEntries` | 5 min | critical | - | reversal or resume keyed by payout id |
| `payouts.advance-sent` | payouts | `PAYOUT_COMMANDS.advanceSent` | 5 min | critical | - | provider idempotent by payout id; state CAS |
| `refunds.sweep` | refunds | `SWEEP_REFUNDS.execute` | 30 s | critical | - | ProcessRefund is a state machine with provider idempotency keys |
| `tax-eta.process-queue` | tax-eta | `PROCESS_SUBMISSION_QUEUE.execute` | 1 min | important | - | internal submission id; CAS to ACCEPTED/RETRY/DEAD_LETTER |
| `tax-eta.poll-statuses` | tax-eta | `POLL_SUBMISSION_STATUSES.execute` | 1 min | important | - | status read then CAS |
| `tax-eta.daily-reconciliation` | tax-eta | `RUN_DAILY_RECONCILIATION.execute` | daily 01:30 Cairo | important | - | report for a Cairo day is a pure function of stored documents |
| `subscriptions.renewal-sweep` | subscriptions | `PLUS_RENEWAL_SWEEP.execute` | 5 min | critical | - | renewal charge idempotency key = subscription + period; dunning attempt counter CAS |
| `subscriptions.recognize-revenue` | subscriptions | `PLUS_RECOGNIZE_REVENUE.execute` | daily 02:00 Cairo | important | - | ledger entry key per invoice and day |
| `gift-cards.resume-redemptions` | gift-cards | `RESUME_PENDING_REDEMPTIONS.execute` | 1 min | critical | - | redemption saga keyed by redemption id; completes or reverses once |
| `gift-cards.close-due-pots` | gift-cards | `CLOSE_DUE_POTS.execute` | 5 min | important | - | pot state CAS; unfunded refunds keyed by contribution |
| `gift-cards.expire` | gift-cards | `EXPIRE_GIFT_CARDS.execute` | 1 h | routine | - | card state CAS to EXPIRED |
| `rewards.expire-coins` | rewards | `SWEEP_REWARDS.expiry` | 1 h | routine | - | per-lot expiry entries keyed by lot id |
| `rewards.settle-pending` | rewards | `SWEEP_REWARDS.settle` | 5 min | important | - | pending coin rows move to settled once (CAS) |
| `privacy.process-exports` | privacy | `PROCESS_EXPORT.runDue` | 1 min | important | - | request state machine; artifact key is the request id |
| `privacy.expire-exports` | privacy | `EXPIRE_EXPORTS.run` | 1 h | routine | - | object delete is idempotent; state CAS to EXPIRED |
| `privacy.process-deletions` | privacy | `PROCESS_DELETIONS.runDue` | 10 min | critical | - | request state machine; erasure executors are idempotent per user |
| `reviews.sweep-qa-sla` | reviews | `SWEEP_QA_SLA.execute` | 15 min | routine | - | question state CAS |
| `reviews.moderation-backlog` | reviews | `PROCESS_MODERATION_BACKLOG.execute` | 1 min | important | - | moderation status CAS from PENDING |
| `drops.advance` | drops | `ADVANCE_DROPS.run` | 10 s | critical | drops | drop state machine, event-per-state CAS |
| `waiting-room.admit` | waiting-room | `ADMIT_FROM_QUEUE.runAll` | 5 s | critical | drops | admission tokens issued once per queue position |
| `notifications.process-due` | notifications | `PROCESS_DUE_NOTIFICATIONS.execute` | 30 s | important | - | request row CAS plus delivery log dedupe key |
| `history.sweep-clear-requests` | history | `SWEEP_CLEAR_REQUESTS.execute` | 15 min | important | - | request completes once; overdue requests reported (24h derived-feature SLA) |
| `history.rebuild-features` | history | `REBUILD_FEATURES_BATCH.execute` | 1 h | routine | - | feature rows are a pure function of events and consent |
| `history.purge-expired-events` | history | `PURGE_EXPIRED_EVENTS.execute` | daily 04:30 Cairo | important | - | delete before cutoff (25 months) |
| `fulfillment.awb-worker` | fulfillment | `AWB_WORKER.runDue` | 30 s | important | - | AWB creation idempotent by shipment id |
| `ads.post-click-spend` | ads | `POST_CLICK_SPEND.execute` | 5 min | important | - | ledger posting keyed by click id |
| `ads.end-expired-campaigns` | ads | `END_EXPIRED_CAMPAIGNS.execute` | 15 min | routine | - | campaign state CAS to ENDED |
| `hub.sweep-groups` | hub-consolidation | `SWEEP_HUB_GROUPS.execute` | 5 min | routine | - | group evaluation is a CAS on open legs |
| `outbox.relay` | platform/db + packages/outbox | `OutboxRelay.runOnce` | 2 s | critical | - | at-least-once; consumers dedupe through the inbox |
| `payments.events-relay` | composition | `createPaymentEventsRelay(...).runOnce` | 2 s | critical | - | inbox `message_id` dedupe in the same transaction |

Notes: `reconciliation.tick` runs every 5 min and `ScheduleReconciliation` decides when the 03:00 Cairo nightly and the intraday run are due (so a missed night self-heals). `payouts.weekly-cycle` triggers daily at 04:00 Cairo because `PayoutCommands.schedule` is idempotent per (store, cycle) and computes the weekly cycle itself.

## NOT scheduled, and why (gaps)

1. `outbox.relay` and `payments.events-relay` are supported by `buildJobs({extras})` but `main.worker.ts` does not supply them: the relays need the Postgres transaction store (`KyselyOutboxStore`, unit of work, inbox) and `createPaymentEventsRelay` takes `PaymentEventsToCheckout` from `composeMoney`. Neither is a Nest provider and the production adapter set does not boot yet (`NoProductionAdaptersError`). Gap owner: whoever lands the production `AppModule`; export them as providers, then pass them in `main.worker.ts`. Until then the outbox is NOT drained.
2. Price-integrity staleness (evidence older than 72 h degrades the claim): no use case exists in `price-integrity` (service has `blocks`/`recordPriceChange` only).
3. Crawler scheduler: `CrawlProduct.execute` needs (target, sku, url); the store has `listTargets(storeId)` but no "due targets" selector, and crawling is behind `kill.crawlers`. Needs a `SelectDueCrawls` use case.
4. Referral settlement: `HandleOrderClosed` is event driven (needs an order-closed message consumer through the inbox), not a sweep. Needs the outbox consumer wiring from gap 1. Capability for it would be `referral-payouts`.
5. Notifications `HandleDomainEvent` and other inbox consumers: event driven, same dependency as gap 1.
6. Retention purge jobs from `docs/privacy/retention-schedule.md`. Scheduled: `history.purge-expired-events` (analytics/history events) and `privacy.expire-exports` (`purge_dsar_exports`). No use case exists for: `purge_deleted_accounts`, `purge_expired_tax_records`, `purge_expired_kyc`, `aggregate_analytics_events`, `purge_deleted_measurements`, `purge_support_chats`, `purge_raw_webhooks`, `revoke_seller_delivery_access`, `purge_age_blocks`, `purge_audit_log_partitions`, `purge_consent_records`, `purge_expired_sessions`, `purge_stale_devices`, `purge_idle_carts`, `aggregate_search_queries`, `purge_delivery_records`, `purge_return_evidence`, `purge_user_content`, `purge_live_chat`, `purge_personalization_data`, `purge_budget_data`, `purge_fraud_signals`, `purge_notification_log`, `purge_affiliate_clicks`, `purge_gift_recipient_contacts`, `purge_request_logs`, `purge_dsar_records`, `purge_departed_staff`, `archive_delisted_catalog`, `device_local_cleanup`, `purge_technical_dedup`, `purge_resolved_reservations`, `purge_claimed_units`, `purge_stock_movements`, `purge_catalog_import_records`. (`purge_deleted_accounts` is partly covered by `privacy.process-deletions`.)
7. Modules scanned but with no sweeper use case: returns, promotions, stores, search index sync, seller-analytics, courier-aramex, resale-lane.
8. Production leader lock needs `DATABASE_URL`; without it the entrypoint falls back to the in-memory lock (single replica only) and logs `worker.in_memory_lock`.

## Tests

`src/workers/scheduler.test.ts` (fake clock): cadence, jitter, two schedulers excluded by the shared lock, timeout plus abort plus lock release, exponential backoff and reset, dead-man gauge, no PII in logs, kill-switch skip, disabled skip, graceful shutdown, no self-overlap, Cairo DST. `src/workers/registry.test.ts`: boots the in-memory `AppModule` and resolves every registered job's token and method, so a renamed token or method fails CI.
