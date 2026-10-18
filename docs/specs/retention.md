# Retention and purge (spec B1)

Status: implemented for the tables that exist in migrations 0001-0046. Source of truth for periods is `docs/privacy/data_inventory.yaml`; `docs/privacy/retention-schedule.md` is generated from it.

## Flow
1. `packages/domain/src/retention` builds a `RetentionPolicy` from the inventory (rule -> period, tables, on_erasure) and `verifyCoverage` proves that every rule that purges something has either purge targets or an explicit exemption, and that every migrated table of the rule is covered.
2. `apps/api/src/modules/retention/domain/catalog.ts` holds the 16 purge targets (`TARGETS`) and one disposition per rule (`DISPOSITIONS`). `rules.snapshot.ts` is the runtime copy of the periods; `test/policy.test.ts` fails when it drifts from the YAML.
3. `RunRetention.runTarget`: cutoff = now minus the rule period (calendar-aware, UTC); count eligible/held and the oldest eligible row; if not a dry run, loop `purgeBatch` (1000 rows, one short transaction each, `statement_timeout` 15 s, `FOR UPDATE SKIP LOCKED`) until a batch returns fewer rows than the batch size or 200 batches ran (status PARTIAL, finished next night).
4. Every run writes `retention_purge_runs` (rule, target, dry_run, cutoff, started, finished, status, rows purged/eligible/held, batches, oldest eligible, error code). Counts only, no row content.
5. Metrics (JSON log lines `retention.metric`, same convention as the worker gauges): the inventory counter per rule (`privacy_sessions_purged_total` and so on), `retention_eligible_rows`, `retention_held_rows`, `retention_oldest_eligible_lag_seconds`. Alert on lag growing above one day.
6. Workers: `retention.purge.<rule>` nightly at 03:01 to 03:46 Cairo, three minutes apart (16 jobs). A failed target throws, so the scheduler records the failure and the dead-man gauge alerts.

## Rules
- A row exactly at the cutoff is kept; one older is purged.
- Financial rules (`orders_tax_records`, `raw_webhooks_financial`, `stock_movement_evidence`, `delivery_records`) cannot get a cutoff later than 5 years ago; a shorter inventory period throws `FinancialRetentionError` before any SQL runs (spec: assume 5-7 years, VERIFY).
- `retention_legal_holds` (subject_type user|store, released_at null = active): every target that has an owner column skips held rows and counts them as `held`.
- Open dispute guard: `return_evidence` is purged only after the return is closed and no dispute is OPEN or UNDER_REVIEW. A reservation is purged only after its unit rows are gone (foreign key).
- Event-driven rules (period null) use the target `grace` (30 days for soft-deleted size profiles; ADR note: safe default, user already asked for deletion).
- Blob rows (return photos): the object-store delete runs before the row delete and is idempotent. Production has no object-store adapter yet, so `UnconfiguredBlobDelete` makes that target fail closed (rows stay, run FAILED, alert) instead of orphaning blobs.
- `gift_cards.recipient_contact` and `message` are nulled (not deleted) 30 days after a terminal state; the card is a ledger-linked record.
- Dry run (`PurgeRetentionJob.dryRun(rule)`) counts only and emits no purge counter.

## Targets (purged)
auth.sessions, auth.session_families, devices.stale, carts.idle (lines cascade), outbox.published, inbox.processed, idempotency.keys, reservations.resolved (+lines), inventory_units.closed, catalog_imports.finished (+errors, +products), notification_log.sent, return_evidence.closed, gift_card_attempts.old, outfits.old, size_profiles.deleted, gift_cards.recipient_contact.

## Deliberately not purged by this job
| Rule | Why |
|---|---|
| orders_tax_records | Tax records, 7 years (VERIFY). journal_entries, postings, price_events are append-only and immutable; they leave by archival or partition drop under the ledger archival design, never DELETE. Pseudonymisation after account erasure is the erasure flow. |
| raw_webhooks_financial | `payment_events_raw` has a trigger that forbids DELETE (proved in the PGlite test). Removal after 7 years needs an owner-approved migration relaxing the guard (VERIFY). |
| audit_log | Append-only and hash-chained; monthly partition detach after WORM export, checkpoints must survive. |
| consent_evidence | `consent_records` immutable by trigger; 7-year expiry by archival. |
| stock_movement_evidence, delivery_records, dsar_records | Financial or regulator evidence; horizon (5 to 7 years) is not reachable yet and the financial floor guard applies. |
| kyc_records | Only `kyc_suspension_reviews` is migrated and it is legal evidence; the KYC document tables land later. |
| account_active, user_content, budget_data, notification_requests and the rest of notification_log, browsing_state (wishlists, searches), personalization (features, feedback), queue/admission/drop rows | Erasure flow or consent withdrawal, not age. Age-based purge for the drop queue rows and `saga_instances` (no fixed terminal status set) is a documented gap. |
| analytics_events (user_events), dsar_export_artifact | Owned by `history.purge-expired-events` and `privacy.expire-exports`. |
| support_chats, live_chat, underage_block, search_queries, request_logs, staff_access, seller_access_window, affiliate_clicks, fraud tables, otp_challenges | Inventory tables are not migrated yet; the coverage test lists them as pending and fails if a table appears without a handler. |

## Fixed by this work
- Inventory: `carts` and `cart_lines` were tagged `account_active`, so the 90-day idle-cart rule (`browsing_state`) never applied to them. Re-tagged to `browsing_state`.
- Inventory: added `retention_purge_runs` and `retention_legal_holds` (migration 0046).

## Tests
`retention/application.test.ts` (boundary, holds, idempotency, batch termination, dry run, failure, tax floor), `retention/test/policy.test.ts` (inventory coverage, snapshot drift, owners exist, unsafe SQL rejected), `retention/adapters/kysely-store.pglite.test.ts` (real schema: sessions, carts, outbox, inbox, idempotency keys, gift card attempts, catalog imports, gift cards, ledger rows, plus a count/purge SQL smoke test for all 16 targets), `workers/retention-jobs.test.ts`, `packages/domain/src/retention/retention.test.ts`.
