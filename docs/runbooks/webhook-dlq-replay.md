# Runbook: webhook and outbox dead letters, replay

Owner: Payments on-call. Roles: on-call engineer (read DB, run drain), Finance approver for any money-affecting replay. Sev: Sev2, Sev1 if paid orders are not being placed. Related: psp-outage.md, reconciliation-break.md.

## What exists (2026-10-11)
- PSP webhooks are stored raw first (`payment_events_raw`, unique by provider event id) then processed by a consumer; processing is idempotent, a duplicate returns "duplicate" (`apps/api/src/modules/payments/application/payments.ts`; tests `payments/test/application.test.ts` "stores verified events, answers accepted, and processes exactly once on replay").
- `drain(limit)` on the payments consumer reprocesses stored, unprocessed events; it skips events whose intent is not yet visible (`PaymentIntentNotFoundYet`).
- Outbox rows carry `dead_lettered_at`; a dead-lettered record blocks later records with the same ordering key (`apps/api/src/platform/db/outbox-store.ts`, `packages/outbox/src/ports.ts`).
- ETA submissions have an API requeue (see eta-submission-backlog.md).
- NOT available: an operator CLI or admin endpoint that calls `drain` or re-enqueues a dead-lettered outbox row; no scheduler that calls `drain`. Until built, replay is an engineer-run script against the production module graph, with a second engineer reviewing. Record that gap as a launch blocker (VERIFY owner decision).

## Detect
- Alert: webhook-to-PAID latency SLO burn (`tooling/observability`, rule `SLOFastBurnPaymentConfirmationLatency`), PSP reports delivery failures, orders stuck `PENDING_PAYMENT` while PSP shows captured.
- SQL (read only, via approved console):
```sql
select provider, count(*) from payment_events_raw where processed_at is null and received_at < now() - interval '5 minutes' group by 1;
select id, event_type, attempts, last_error from outbox where dead_lettered_at is not null order by dead_lettered_at;
```
(Column names: check `packages/db/migrations/0004`, `0008`, `0032`; VERIFY before running.)

## Triage
1. Signature failures (`signature_ok = false`): do NOT replay. Treat as attack or key rotation; see secret-rotation.md.
2. Unprocessed but verified: usually the intent was not visible yet or a consumer bug. Fix the cause first.
3. Dead-lettered outbox: read `last_error`; schema rejection means a producer bug; a transient downstream error means retry.

## Replay
1. Pause nothing; replay is idempotent (inbox dedup, `Idempotency-Key = order_group_id` at the PSP).
2. Run the drain on one node with a small limit (50), watch `duplicate` vs `processed` counts.
3. For dead-lettered outbox rows: clear `dead_lettered_at` and `next_attempt_at` for the oldest row per ordering key only after the cause is fixed; the relay then retries with backoff (`packages/outbox/src/backoff.ts`).
4. If the PSP never sent the event, fetch the transaction read-only through the PSP API and feed it through the same handler (never post ledger entries by hand).
5. Run reconciliation for the window (reconciliation-break.md) and the ledger integrity job (ledger-integrity.md).

## Verify and close
- Orders for replayed events show `PAID`; no double reservations claims (`inventory` claim is idempotent: `inventory/test/application.test.ts` "claims, then is idempotent").
- Payment succeeded after reservation expired: auto-claim or refund path handled ("expiry returns stock; a late payment auto-claims if stock remains..."); alert if above 0.1%.
- Post-mortem within 5 business days. Add the failing payload as a fixture under `payments/test`.
